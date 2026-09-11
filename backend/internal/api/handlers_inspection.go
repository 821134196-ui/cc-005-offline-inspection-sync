package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// GET /api/inspections — only rows owned by the caller. Tombstones included so
// a client can learn about remote deletions and drop local copies.
func (s *Server) listInspections(w http.ResponseWriter, r *http.Request) {
	c := userFromCtx(r.Context())
	rows, err := s.pool.Query(r.Context(), `
		SELECT id, owner_id, title, status, findings, notes, checked_items,
		       photo_caption, is_deleted, rev, updated_at,
		       (SELECT COALESCE(array_agg(field), '{}') FROM conflicts cf
		          WHERE cf.inspection_id=i.id AND cf.status='open'),
		       (SELECT count(*) FROM attachments a
		          WHERE a.inspection_id=i.id AND a.status<>'completed')
		FROM inspections i WHERE owner_id=$1
		ORDER BY updated_at DESC`, c.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	out := make([]InspectionDTO, 0)
	for rows.Next() {
		d, err := scanInspectionWithAggregates(rows)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		out = append(out, d)
	}
	if err := s.fillAttachments(r.Context(), out); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.fillOpenConflicts(r.Context(), out); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"inspections": out})
}

// fillOpenConflicts bulk-loads unresolved conflict rows for a page of DTOs so
// list responses carry everything the UI needs to render a conflict state.
func (s *Server) fillOpenConflicts(ctx context.Context, dtos []InspectionDTO) error {
	if len(dtos) == 0 {
		return nil
	}
	ids := make([]string, len(dtos))
	byID := map[string]*InspectionDTO{}
	for i := range dtos {
		ids[i] = dtos[i].ID
		byID[dtos[i].ID] = &dtos[i]
	}
	rows, err := s.pool.Query(ctx, `
		SELECT inspection_id, id, field, server_value, client_value,
		       server_op_id, client_op_id, status, created_at
		FROM conflicts WHERE inspection_id = ANY($1) AND status='open'
		ORDER BY created_at`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var inspID string
		var cf ConflictDTO
		if err := rows.Scan(&inspID, &cf.ID, &cf.Field, &cf.ServerValue, &cf.ClientValue,
			&cf.ServerOpID, &cf.ClientOpID, &cf.Status, &cf.CreatedAt); err != nil {
			return err
		}
		if dto, ok := byID[inspID]; ok {
			dto.Conflicts = append(dto.Conflicts, cf)
		}
	}
	return nil
}

// fillAttachments bulk-loads attachment rows (incl. received part numbers) for
// a page of inspection DTOs, avoiding N+1 queries.
func (s *Server) fillAttachments(ctx context.Context, dtos []InspectionDTO) error {
	if len(dtos) == 0 {
		return nil
	}
	ids := make([]string, len(dtos))
	byID := map[string]*InspectionDTO{}
	for i := range dtos {
		ids[i] = dtos[i].ID
		byID[dtos[i].ID] = &dtos[i]
	}
	rows, err := s.pool.Query(ctx, `
		SELECT a.inspection_id, a.id, a.filename, a.content_type, a.size, a.status, a.upload_id,
		       COALESCE(p.parts, '{}')
		FROM attachments a
		LEFT JOIN (
			SELECT upload_id, array_agg(part_number ORDER BY part_number) AS parts
			FROM upload_parts GROUP BY upload_id
		) p ON p.upload_id = a.upload_id
		WHERE a.inspection_id = ANY($1) ORDER BY a.created_at`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var inspID string
		var a AttachmentDTO
		if err := rows.Scan(&inspID, &a.ID, &a.Filename, &a.ContentType, &a.Size,
			&a.Status, &a.UploadID, &a.ReceivedParts); err != nil {
			return err
		}
		if dto, ok := byID[inspID]; ok {
			dto.Attachments = append(dto.Attachments, a)
		}
	}
	return nil
}

func (s *Server) getInspection(w http.ResponseWriter, r *http.Request) {
	c := userFromCtx(r.Context())
	id := r.PathValue("id")
	dto, code, msg := s.fetchOne(r.Context(), id, c.UserID)
	if code != 0 {
		writeErr(w, code, msg)
		return
	}
	att, err := s.attachmentsFor(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	conf, err := s.conflictsFor(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	dto.Attachments = att
	dto.Conflicts = conf
	writeJSON(w, http.StatusOK, dto)
}

func (s *Server) fetchOne(ctx context.Context, id, userID string) (InspectionDTO, int, string) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, owner_id, title, status, findings, notes, checked_items,
		       photo_caption, is_deleted, rev, updated_at
		FROM inspections WHERE id=$1`, id)
	dto, err := scanInspection(row)
	if err == pgx.ErrNoRows {
		return dto, http.StatusNotFound, "not found"
	}
	if err != nil {
		return dto, http.StatusInternalServerError, err.Error()
	}
	if dto.OwnerID != userID {
		return dto, http.StatusForbidden, "not assigned to you"
	}
	return dto, 0, ""
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanInspection(sc rowScanner) (InspectionDTO, error) {
	var d InspectionDTO
	err := sc.Scan(&d.ID, &d.OwnerID, &d.Title, &d.Status, &d.Findings,
		&d.Notes, &d.CheckedItems, &d.PhotoCaption, &d.IsDeleted, &d.Rev, &d.UpdatedAt)
	d.Attachments = []AttachmentDTO{}
	d.Conflicts = []ConflictDTO{}
	return d, err
}

func scanInspectionWithAggregates(sc rowScanner) (InspectionDTO, error) {
	var d InspectionDTO
	err := sc.Scan(&d.ID, &d.OwnerID, &d.Title, &d.Status, &d.Findings,
		&d.Notes, &d.CheckedItems, &d.PhotoCaption, &d.IsDeleted, &d.Rev, &d.UpdatedAt,
		&d.OpenConflictFields, &d.PendingAttachments)
	d.Attachments = []AttachmentDTO{}
	d.Conflicts = []ConflictDTO{}
	return d, err
}

// loadDTO builds the snapshot embedded in op results using a tx.
func (s *Server) loadDTO(ctx context.Context, tx pgx.Tx, id, userID string) (*InspectionDTO, error) {
	row := tx.QueryRow(ctx, `
		SELECT id, owner_id, title, status, findings, notes, checked_items,
		       photo_caption, is_deleted, rev, updated_at
		FROM inspections WHERE id=$1 AND owner_id=$2`, id, userID)
	d, err := scanInspection(row)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx,
		`SELECT id, filename, content_type, size, status, upload_id
		 FROM attachments WHERE inspection_id=$1 ORDER BY created_at`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a AttachmentDTO
		if err := rows.Scan(&a.ID, &a.Filename, &a.ContentType, &a.Size, &a.Status, &a.UploadID); err != nil {
			return nil, err
		}
		a.ReceivedParts = []int{}
		d.Attachments = append(d.Attachments, a)
	}
	crows, err := tx.Query(ctx, `
		SELECT id, field, server_value, client_value, server_op_id, client_op_id, status, created_at
		FROM conflicts WHERE inspection_id=$1 AND status='open' ORDER BY created_at`, id)
	if err != nil {
		return nil, err
	}
	defer crows.Close()
	for crows.Next() {
		var cf ConflictDTO
		if err := crows.Scan(&cf.ID, &cf.Field, &cf.ServerValue, &cf.ClientValue,
			&cf.ServerOpID, &cf.ClientOpID, &cf.Status, &cf.CreatedAt); err != nil {
			return nil, err
		}
		d.Conflicts = append(d.Conflicts, cf)
	}
	return &d, nil
}

func (s *Server) attachmentsFor(ctx context.Context, inspectionID string) ([]AttachmentDTO, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.id, a.filename, a.content_type, a.size, a.status, a.upload_id,
		       COALESCE(p.parts, '{}')
		FROM attachments a
		LEFT JOIN (
			SELECT upload_id, array_agg(part_number ORDER BY part_number) AS parts
			FROM upload_parts GROUP BY upload_id
		) p ON p.upload_id = a.upload_id
		WHERE a.inspection_id=$1 ORDER BY a.created_at`, inspectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AttachmentDTO{}
	for rows.Next() {
		var a AttachmentDTO
		if err := rows.Scan(&a.ID, &a.Filename, &a.ContentType, &a.Size,
			&a.Status, &a.UploadID, &a.ReceivedParts); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

func (s *Server) conflictsFor(ctx context.Context, inspectionID string) ([]ConflictDTO, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, field, server_value, client_value, server_op_id, client_op_id,
		       status, created_at, resolved_at
		FROM conflicts WHERE inspection_id=$1 ORDER BY created_at DESC`, inspectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ConflictDTO{}
	for rows.Next() {
		var cf ConflictDTO
		var resolvedAt *time.Time
		if err := rows.Scan(&cf.ID, &cf.Field, &cf.ServerValue, &cf.ClientValue,
			&cf.ServerOpID, &cf.ClientOpID, &cf.Status, &cf.CreatedAt, &resolvedAt); err != nil {
			return nil, err
		}
		cf.ResolvedAt = resolvedAt
		out = append(out, cf)
	}
	return out, nil
}

// POST /api/conflicts/{id}/resolve — convenience endpoint for conflict
// resolution outside the op pipeline; internally it builds a resolve op so the
// same ledger/merge guarantees apply.
func (s *Server) resolveConflict(w http.ResponseWriter, r *http.Request) {
	c := userFromCtx(r.Context())
	var req struct {
		InspectionID string          `json:"inspection_id"`
		Field        string          `json:"field"`
		Value        json.RawMessage `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad body")
		return
	}
	op := Op{
		OpID:         uuid.NewString(),
		Type:         "resolve_conflict",
		InspectionID: req.InspectionID,
		Field:        req.Field,
		Value:        req.Value,
	}
	// Verify conflict id belongs to the caller's inspection.
	var owner string
	err := s.pool.QueryRow(r.Context(), `
		SELECT i.owner_id FROM conflicts cf JOIN inspections i ON i.id=cf.inspection_id
		WHERE cf.id=$1`, r.PathValue("id")).Scan(&owner)
	if err != nil {
		writeErr(w, http.StatusNotFound, "conflict not found")
		return
	}
	if owner != c.UserID {
		writeErr(w, http.StatusForbidden, "not assigned to you")
		return
	}
	res := s.applyOp(r, c.UserID, op)
	writeJSON(w, http.StatusOK, res)
}
