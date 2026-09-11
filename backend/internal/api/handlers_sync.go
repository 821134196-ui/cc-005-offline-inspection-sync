package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// POST /api/sync  { "ops": [...] }
// Operations are applied strictly in request order, each in its own
// transaction. Each op is idempotent by op_id (processed_ops ledger),
// supports three-way field merge, records explicit same-field conflicts, and
// never lets a client-chosen owner influence authorization.
func (s *Server) sync(w http.ResponseWriter, r *http.Request) {
	claims := userFromCtx(r.Context())
	var req SyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid sync body")
		return
	}
	if len(req.Ops) == 0 {
		writeJSON(w, http.StatusOK, SyncResponse{Results: []OpResult{}})
		return
	}
	results := make([]OpResult, 0, len(req.Ops))
	for _, op := range req.Ops {
		res := s.applyOp(r, claims.UserID, op)
		results = append(results, res)
	}
	writeJSON(w, http.StatusOK, SyncResponse{Results: results})
}

func (s *Server) applyOp(r *http.Request, userID string, op Op) OpResult {
	ctx := r.Context()

	if _, err := uuid.Parse(op.OpID); err != nil {
		return OpResult{OpID: op.OpID, Status: "invalid", Code: "bad_op_id", Message: "op_id must be a UUID"}
	}
	switch op.Type {
	case "upsert", "delete", "resolve_conflict":
	default:
		return OpResult{OpID: op.OpID, Status: "invalid", Code: "unknown_type", Message: "unknown op type"}
	}
	if _, err := uuid.Parse(op.InspectionID); err != nil {
		return OpResult{OpID: op.OpID, Status: "invalid", Code: "bad_inspection_id"}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return OpResult{OpID: op.OpID, Status: "error", Message: err.Error()}
	}
	defer tx.Rollback(ctx)

	// Serialize concurrent deliveries of the same op id.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", op.OpID); err != nil {
		return OpResult{OpID: op.OpID, Status: "error", Message: err.Error()}
	}

	// Idempotency: replay the stored outcome verbatim. An op id first seen
	// under another user never replays here (UUID collision / spoof attempt).
	var stored []byte
	err = tx.QueryRow(ctx, `SELECT result FROM processed_ops WHERE op_id=$1 AND user_id=$2`,
		op.OpID, userID).Scan(&stored)
	if err == nil {
		var prev OpResult
		if json.Unmarshal(stored, &prev) == nil {
			prev.Status = markDuplicate(prev.Status)
			return prev
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return OpResult{OpID: op.OpID, Status: "error", Message: err.Error()}
	}
	var other int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM processed_ops WHERE op_id=$1 AND user_id<>$2`,
		op.OpID, userID).Scan(&other); err != nil {
		return OpResult{OpID: op.OpID, Status: "error", Message: err.Error()}
	}
	if other > 0 {
		return OpResult{OpID: op.OpID, Status: "invalid", Code: "op_id_collision",
			Message: "op id already used by another user"}
	}

	res, err := s.applyOpTx(r, tx, userID, op)
	if err != nil {
		_ = tx.Rollback(ctx)
		return OpResult{OpID: op.OpID, Status: "error", Message: err.Error()}
	}

	// Only terminal outcomes enter the idempotency ledger. Transient ones
	// (notably attachments_incomplete) must be re-evaluated on retry once the
	// blocking upload finishes, rather than replaying a stale failure.
	if !isLedgeredStatus(res.Status) {
		_ = tx.Rollback(ctx)
		return res
	}

	payload, _ := json.Marshal(res)
	if _, err := tx.Exec(ctx,
		`INSERT INTO processed_ops (op_id, user_id, result) VALUES ($1,$2,$3)`,
		op.OpID, userID, string(payload)); err != nil {
		return OpResult{OpID: op.OpID, Status: "error", Message: "ledger: " + err.Error()}
	}
	if err := tx.Commit(ctx); err != nil {
		return OpResult{OpID: op.OpID, Status: "error", Message: err.Error()}
	}
	return res
}

// isLedgeredStatus reports whether an outcome is terminal and must be replayed
// verbatim if the same op id shows up again.
func isLedgeredStatus(status string) bool {
	switch status {
	case "applied", "deleted", "conflict", "forbidden", "invalid":
		return true
	default:
		return false
	}
}

// markDuplicate preserves the semantic status while exposing replay to clients.
func markDuplicate(status string) string {
	if status == "applied" || status == "deleted" || status == "conflict" {
		return "duplicate"
	}
	return status
}

type fieldRev struct {
	value []byte
	opID  string
}

func (s *Server) applyOpTx(r *http.Request, tx pgx.Tx, userID string, op Op) (OpResult, error) {
	ctx := r.Context()
	result := OpResult{OpID: op.OpID}

	if op.Type == "resolve_conflict" {
		return s.applyResolve(ctx, tx, userID, op)
	}

	// Load inspection row (if present) with a row lock.
	var (
		ownerID   string
		isDeleted bool
		rev       int64
	)
	err := tx.QueryRow(ctx,
		`SELECT owner_id, is_deleted, rev FROM inspections WHERE id=$1 FOR UPDATE`,
		op.InspectionID).Scan(&ownerID, &isDeleted, &rev)
	created := false
	if errors.Is(err, pgx.ErrNoRows) {
		if op.Type == "delete" {
			// Deleting something that never existed: trivially idempotent.
			result.Status = "deleted"
			return result, nil
		}
		// CREATE path: ownership is taken from the token, never the payload.
		if err := validateChanges(op.Changes, true); err != nil {
			result.Status = "invalid"
			result.Code = "validation"
			result.Message = err.Error()
			return result, nil
		}
		if err := s.createInspection(ctx, tx, userID, op); err != nil {
			return result, err
		}
		created = true
	} else if err != nil {
		return result, err
	} else {
		// Authorization: users may only sync tasks assigned to them.
		if ownerID != userID {
			result.Status = "forbidden"
			result.Code = "not_assigned"
			result.Message = "inspection is assigned to another user"
			return result, nil
		}
		if isDeleted {
			if op.Type == "delete" {
				result.Status = "deleted"
				return result, nil
			}
			// Tombstone blocks resurrection by stale clients coming back online.
			result.Status = "deleted"
			result.Code = "inspection_deleted"
			result.Message = "inspection was deleted; edit rejected"
			return result, nil
		}
		if op.Type != "delete" {
			if err := validateChanges(op.Changes, false); err != nil {
				result.Status = "invalid"
				result.Code = "validation"
				result.Message = err.Error()
				return result, nil
			}
		}
	}

	if op.Type == "delete" {
		if _, err := tx.Exec(ctx,
			`UPDATE inspections SET is_deleted=TRUE, rev=rev+1, updated_at=now() WHERE id=$1`,
			op.InspectionID); err != nil {
			return result, err
		}
		result.Status = "deleted"
		return result, nil
	}

	// Submit guard: all attachments must be completed before review.
	if ch, ok := op.Changes["status"]; ok {
		var status string
		if err := json.Unmarshal(ch.V, &status); err == nil && status == "submitted" {
			var incomplete int
			if err := tx.QueryRow(ctx,
				`SELECT count(*) FROM attachments
				 WHERE inspection_id=$1 AND status <> 'completed'`, op.InspectionID).
				Scan(&incomplete); err != nil {
				return result, err
			}
			if incomplete > 0 {
				result.Status = "attachments_incomplete"
				result.Code = "attachments_incomplete"
				result.Message = fmt.Sprintf("%d attachment(s) not fully uploaded", incomplete)
				return result, nil
			}
		}
	}

	// Load current field lineage.
	revs := map[string]fieldRev{}
	rows, err := tx.Query(ctx,
		`SELECT field, value, op_id FROM field_revs WHERE inspection_id=$1 FOR UPDATE`,
		op.InspectionID)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var f, oid string
		var v []byte
		if err := rows.Scan(&f, &v, &oid); err != nil {
			rows.Close()
			return result, err
		}
		revs[f] = fieldRev{value: v, opID: oid}
	}
	rows.Close()

	applied := created
	var openConflicts []ConflictDTO
	for field, ch := range op.Changes {
		cur, exists := revs[field]
		if !exists {
			// New field on an existing row (defensive; create path covers all fields).
			if err := writeField(ctx, tx, op.InspectionID, field, ch.V, op.OpID, true); err != nil {
				return result, err
			}
			applied = true
			continue
		}
		switch classifyField(cur.value, ch.V, ch.Base) {
		case verdictApply:
			if err := writeField(ctx, tx, op.InspectionID, field, ch.V, op.OpID, false); err != nil {
				return result, err
			}
			applied = true
		case verdictConflict:
			// True concurrent edit of the same field → explicit conflict.
			// Server value is NEVER overwritten without a human choice.
			cf, err := s.recordConflict(ctx, tx, op, field, cur, ch)
			if err != nil {
				return result, err
			}
			openConflicts = append(openConflicts, cf)
		case verdictNoop:
			// base==server and v==server, or v already equals server: convergence.
		}
	}

	if applied && !created {
		if _, err := tx.Exec(ctx,
			`UPDATE inspections SET rev=rev+1, updated_at=now() WHERE id=$1`,
			op.InspectionID); err != nil {
			return result, err
		}
	}

	if len(openConflicts) > 0 {
		result.Status = "conflict"
		result.Conflicts = openConflicts
	} else {
		result.Status = "applied"
	}
	snap, err := s.loadDTO(ctx, tx, op.InspectionID, userID)
	if err != nil {
		return result, err
	}
	result.Inspection = snap
	return result, nil
}

func (s *Server) createInspection(ctx context.Context, tx pgx.Tx, userID string, op Op) error {
	defaults := map[string]json.RawMessage{
		"title":         mustJSON(""),
		"status":        mustJSON("draft"),
		"findings":      mustJSON(""),
		"notes":         mustJSON(""),
		"checked_items": mustJSON([]any{}),
		"photo_caption": mustJSON(""),
	}
	for f, ch := range op.Changes {
		defaults[f] = ch.V
	}
	title := decodeStr(defaults["title"])
	if title == "" {
		title = "新巡检记录"
		defaults["title"] = mustJSON(title)
	}
	itemsJSON := string(defaults["checked_items"])
	if _, err := tx.Exec(ctx, `
		INSERT INTO inspections (id, owner_id, title, status, findings, notes, checked_items, photo_caption)
		VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
		op.InspectionID, userID, title,
		decodeStr(defaults["status"]), decodeStr(defaults["findings"]),
		decodeStr(defaults["notes"]), itemsJSON, decodeStr(defaults["photo_caption"]),
	); err != nil {
		return err
	}
	for f, v := range defaults {
		if _, err := tx.Exec(ctx, `
			INSERT INTO field_revs (inspection_id, field, value, op_id)
			VALUES ($1,$2,$3::jsonb,$4)`,
			op.InspectionID, f, string(v), op.OpID); err != nil {
			return err
		}
	}
	return nil
}

// writeField updates both the denormalized column and the field revision lineage.
func writeField(ctx context.Context, tx pgx.Tx, inspectionID, field string, v json.RawMessage, opID string, insert bool) error {
	switch field {
	case "checked_items":
		if _, err := tx.Exec(ctx,
			`UPDATE inspections SET checked_items=$2::jsonb WHERE id=$1`,
			inspectionID, string(v)); err != nil {
			return err
		}
	case "title", "status", "findings", "notes", "photo_caption":
		if _, err := tx.Exec(ctx,
			fmt.Sprintf(`UPDATE inspections SET %s=$2 WHERE id=$1`, field),
			inspectionID, decodeStr(v)); err != nil {
			return err
		}
	default:
		return fmt.Errorf("field %s not writable", field)
	}
	if insert {
		_, err := tx.Exec(ctx, `
			INSERT INTO field_revs (inspection_id, field, value, op_id)
			VALUES ($1,$2,$3::jsonb,$4)`, inspectionID, field, string(v), opID)
		return err
	}
	_, err := tx.Exec(ctx, `
		UPDATE field_revs SET value=$3::jsonb, op_id=$4, updated_at=now()
		WHERE inspection_id=$1 AND field=$2`, inspectionID, field, string(v), opID)
	return err
}

// recordConflict opens (or refreshes) the single open conflict for a field.
func (s *Server) recordConflict(ctx context.Context, tx pgx.Tx, op Op, field string, cur fieldRev, ch FieldChange) (ConflictDTO, error) {
	var (
		cfID                 string
		serverVal, clientVal []byte
		serverOp, clientOp   string
		cStatus              string
		createdAt            time.Time
	)
	err := tx.QueryRow(ctx, `
		SELECT id, server_value, client_value, server_op_id, client_op_id, status, created_at
		FROM conflicts
		WHERE inspection_id=$1 AND field=$2 AND status='open'`,
		op.InspectionID, field).
		Scan(&cfID, &serverVal, &clientVal, &serverOp, &clientOp, &cStatus, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		newID := uuid.NewString()
		row := tx.QueryRow(ctx, `
			INSERT INTO conflicts
			  (id, inspection_id, field, server_value, client_value, server_op_id, client_op_id)
			VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
			RETURNING id, server_value, client_value, server_op_id, client_op_id, created_at`,
			newID, op.InspectionID, field, string(cur.value), string(ch.V), cur.opID, op.OpID)
		dto := ConflictDTO{Field: field, Status: "open"}
		if err := row.Scan(&dto.ID, &dto.ServerValue, &dto.ClientValue, &dto.ServerOpID, &dto.ClientOpID, &dto.CreatedAt); err != nil {
			return dto, err
		}
		return dto, nil
	}
	if err != nil {
		return ConflictDTO{}, err
	}
	// Open conflict already exists: refresh the pending client choice if the
	// client edited again; keep the server value untouched.
	if !equalJSON(clientVal, ch.V) || clientOp != op.OpID {
		if _, err := tx.Exec(ctx, `
			UPDATE conflicts SET client_value=$3::jsonb, client_op_id=$4
			WHERE id=$1`, cfID, field, string(ch.V), op.OpID); err != nil {
			return ConflictDTO{}, err
		}
		clientVal = ch.V
		clientOp = op.OpID
	}
	return ConflictDTO{
		ID: cfID, Field: field, Status: "open",
		ServerValue: serverVal, ClientValue: clientVal,
		ServerOpID: serverOp, ClientOpID: clientOp,
		CreatedAt: createdAt,
	}, nil
}

func (s *Server) applyResolve(ctx context.Context, tx pgx.Tx, userID string, op Op) (OpResult, error) {
	result := OpResult{OpID: op.OpID}
	if !editableFields[op.Field] {
		result.Status = "invalid"
		result.Code = "bad_field"
		return result, nil
	}
	var ownerID string
	err := tx.QueryRow(ctx, `SELECT owner_id FROM inspections WHERE id=$1 FOR UPDATE`,
		op.InspectionID).Scan(&ownerID)
	if errors.Is(err, pgx.ErrNoRows) {
		result.Status = "invalid"
		result.Code = "not_found"
		return result, nil
	} else if err != nil {
		return result, err
	}
	if ownerID != userID {
		result.Status = "forbidden"
		result.Code = "not_assigned"
		return result, nil
	}

	// The human explicitly chose op.value. Verify an open conflict exists and
	// settle it; write the chosen value into the field, advancing lineage.
	var conflictID string
	err = tx.QueryRow(ctx, `
		SELECT id FROM conflicts
		WHERE inspection_id=$1 AND field=$2 AND status='open'
		FOR UPDATE`, op.InspectionID, op.Field).Scan(&conflictID)
	if errors.Is(err, pgx.ErrNoRows) {
		result.Status = "invalid"
		result.Code = "no_open_conflict"
		result.Message = "no open conflict for this field"
		return result, nil
	} else if err != nil {
		return result, err
	}
	if err := writeField(ctx, tx, op.InspectionID, op.Field, op.Value, op.OpID, false); err != nil {
		return result, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conflicts
		   SET status='resolved', resolved_value=$2::jsonb, resolved_at=now()
		 WHERE id=$1`, conflictID, string(op.Value)); err != nil {
		return result, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE inspections SET rev=rev+1, updated_at=now() WHERE id=$1`, op.InspectionID); err != nil {
		return result, err
	}
	result.Status = "applied"
	snap, err := s.loadDTO(ctx, tx, op.InspectionID, userID)
	if err != nil {
		return result, err
	}
	result.Inspection = snap
	return result, nil
}

func validateChanges(changes map[string]FieldChange, creating bool) error {
	if len(changes) == 0 {
		return fmt.Errorf("changes required")
	}
	for field, ch := range changes {
		if !editableFields[field] {
			return fmt.Errorf("field %q is not editable", field)
		}
		if len(ch.V) == 0 {
			return fmt.Errorf("field %q: missing value", field)
		}
		if !creating && len(ch.Base) == 0 {
			return fmt.Errorf("field %q: missing base for merge", field)
		}
	}
	if v, ok := changes["status"]; ok {
		var st string
		if err := json.Unmarshal(v.V, &st); err != nil || !validStatus[st] {
			return fmt.Errorf("invalid status")
		}
	}
	return nil
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func decodeStr(b json.RawMessage) string {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return ""
	}
	return s
}
