package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
)

// POST /api/uploads
// { inspection_id, filename, content_type, size, total_parts }
// Starts a MinIO multipart upload. The client owns the chunking; the server
// records every received part so an interrupted upload resumes from gaps.
func (s *Server) createUpload(w http.ResponseWriter, r *http.Request) {
	c := userFromCtx(r.Context())
	var req struct {
		InspectionID string `json:"inspection_id"`
		Filename     string `json:"filename"`
		ContentType  string `json:"content_type"`
		Size         int64  `json:"size"`
		TotalParts   int    `json:"total_parts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Filename == "" || req.TotalParts < 1 {
		writeErr(w, http.StatusBadRequest, "filename and total_parts required")
		return
	}
	if _, err := uuid.Parse(req.InspectionID); err != nil {
		writeErr(w, http.StatusBadRequest, "bad inspection id")
		return
	}
	var ownerID string
	var deleted bool
	err := s.pool.QueryRow(r.Context(),
		`SELECT owner_id, is_deleted FROM inspections WHERE id=$1`, req.InspectionID).
		Scan(&ownerID, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "inspection not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ownerID != c.UserID {
		writeErr(w, http.StatusForbidden, "not assigned to you")
		return
	}
	if deleted {
		writeErr(w, http.StatusConflict, "inspection deleted")
		return
	}

	id := uuid.NewString()
	objectKey := fmt.Sprintf("%s/%s", req.InspectionID, id)
	uploadID, err := s.store.BeginMultipart(r.Context(), objectKey, sanitizeCT(req.ContentType))
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "object store: "+err.Error())
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO attachments
		  (id, inspection_id, upload_id, filename, content_type, size, object_key, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		id, req.InspectionID, uploadID, req.Filename,
		sanitizeCT(req.ContentType), req.Size, objectKey, c.UserID); err != nil {
		_ = s.store.AbortMultipart(context.Background(), uploadID, objectKey)
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"attachment_id": id,
		"upload_id":     uploadID,
		"object_key":    objectKey,
		"chunk_size":    s.cfg.ChunkSize,
	})
}

// PUT /api/uploads/{uploadID}/parts/{partNum}  (raw bytes in body)
// Idempotent per (upload_id, part_number): re-uploading a part is a no-op that
// returns the stored ETag — safe to retry after a network failure.
func (s *Server) putPart(w http.ResponseWriter, r *http.Request) {
	c := userFromCtx(r.Context())
	uploadID := r.PathValue("uploadID")
	partNum, err := strconv.Atoi(r.PathValue("partNum"))
	if err != nil || partNum < 1 || partNum > 10000 {
		writeErr(w, http.StatusBadRequest, "bad part number")
		return
	}

	att, code, msg := s.authorizeUpload(r, uploadID, c.UserID)
	if code != 0 {
		writeErr(w, code, msg)
		return
	}
	if att.Status != "uploading" {
		writeErr(w, http.StatusConflict, "upload already "+att.Status)
		return
	}

	// Already received? Skip MinIO and replay the ETag (resume + idempotency).
	var etag string
	err = s.pool.QueryRow(r.Context(),
		`SELECT etag FROM upload_parts WHERE upload_id=$1 AND part_number=$2`,
		uploadID, partNum).Scan(&etag)
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"part": partNum, "etag": etag, "duplicate": true})
		return
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, s.cfg.ChunkSize+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	if int64(len(body)) > s.cfg.ChunkSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "part exceeds chunk size")
		return
	}
	if len(body) == 0 {
		writeErr(w, http.StatusBadRequest, "empty part")
		return
	}

	etag, err = s.store.UploadPart(r.Context(), uploadID, att.ObjectKey, partNum, body)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "object store: "+err.Error())
		return
	}
	if _, err := s.pool.Exec(r.Context(), `
		INSERT INTO upload_parts (upload_id, part_number, etag)
		VALUES ($1,$2,$3)
		ON CONFLICT (upload_id, part_number) DO NOTHING`, uploadID, partNum, etag); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"part": partNum, "etag": etag})
}

// GET /api/uploads/{uploadID} — returns received + missing parts so a resumed
// client uploads only what is absent.
func (s *Server) uploadStatus(w http.ResponseWriter, r *http.Request) {
	c := userFromCtx(r.Context())
	att, code, msg := s.authorizeUpload(r, r.PathValue("uploadID"), c.UserID)
	if code != 0 {
		writeErr(w, code, msg)
		return
	}
	dbParts := map[int]string{}
	rows, err := s.pool.Query(r.Context(),
		`SELECT part_number, etag FROM upload_parts WHERE upload_id=$1`, att.UploadID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	for rows.Next() {
		var p int
		var e string
		if err := rows.Scan(&p, &e); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		dbParts[p] = e
	}
	rows.Close()
	// Reconcile against MinIO (DB write could have committed before client saw
	// the response), so the ledger never claims a part MinIO lacks.
	minioParts, err := s.store.CompletedParts(r.Context(), att.UploadID, att.ObjectKey)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "object store: "+err.Error())
		return
	}
	received := make([]map[string]any, 0)
	for p, e := range dbParts {
		if minioParts[p] {
			received = append(received, map[string]any{"part": p, "etag": e})
		}
	}
	sort.Slice(received, func(i, j int) bool {
		return received[i]["part"].(int) < received[j]["part"].(int)
	})
	receivedNums := make([]int, 0, len(received))
	for _, p := range received {
		receivedNums = append(receivedNums, p["part"].(int))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"attachment_id":  att.ID,
		"status":         att.Status,
		"size":           att.Size,
		"received_parts": receivedNums,
		"parts":          received,
		"completed":      att.Status == "completed",
	})
}

// POST /api/uploads/{uploadID}/complete  { total_parts }
func (s *Server) completeUpload(w http.ResponseWriter, r *http.Request) {
	c := userFromCtx(r.Context())
	uploadID := r.PathValue("uploadID")
	var req struct {
		TotalParts int `json:"total_parts"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	att, code, msg := s.authorizeUpload(r, uploadID, c.UserID)
	if code != 0 {
		writeErr(w, code, msg)
		return
	}
	if att.Status == "completed" {
		writeJSON(w, http.StatusOK, map[string]any{"status": "completed", "duplicate": true, "attachment_id": att.ID})
		return
	}

	type partRow struct {
		n int
		e string
	}
	rows, err := s.pool.Query(r.Context(),
		`SELECT part_number, etag FROM upload_parts WHERE upload_id=$1 ORDER BY part_number`, uploadID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	var parts []partRow
	for rows.Next() {
		var pr partRow
		if err := rows.Scan(&pr.n, &pr.e); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		parts = append(parts, pr)
	}
	rows.Close()
	if len(parts) == 0 {
		writeErr(w, http.StatusConflict, "no parts received")
		return
	}
	// Parts must be contiguous 1..N.
	for i, pr := range parts {
		if pr.n != i+1 {
			writeErr(w, http.StatusConflict,
				fmt.Sprintf("parts not contiguous: missing part %d", i+1))
			return
		}
	}
	complete := make([]minio.CompletePart, len(parts))
	for i, pr := range parts {
		complete[i] = minio.CompletePart{PartNumber: pr.n, ETag: pr.e}
	}
	if err := s.store.CompleteMultipart(r.Context(), uploadID, att.ObjectKey, complete); err != nil {
		writeErr(w, http.StatusBadGateway, "object store: "+err.Error())
		return
	}
	if _, err := s.pool.Exec(r.Context(),
		`UPDATE attachments SET status='completed', uploaded_at=now() WHERE id=$1`, att.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "completed", "attachment_id": att.ID, "parts": len(parts),
	})
}

// GET /api/attachments/{id}/download
// GET /api/attachments/{id}/content — authenticated streaming proxy so the
// browser never talks to MinIO directly (avoids container/host hostname
// mismatches with presigned URLs).
func (s *Server) attachmentContent(w http.ResponseWriter, r *http.Request) {
	c := userFromCtx(r.Context())
	var ownerID, objectKey, filename, ct, status string
	err := s.pool.QueryRow(r.Context(), `
		SELECT i.owner_id, a.object_key, a.filename, a.content_type, a.status
		FROM attachments a JOIN inspections i ON i.id=a.inspection_id
		WHERE a.id=$1`, r.PathValue("id")).
		Scan(&ownerID, &objectKey, &filename, &ct, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ownerID != c.UserID {
		writeErr(w, http.StatusForbidden, "not assigned to you")
		return
	}
	if status != "completed" {
		writeErr(w, http.StatusConflict, "upload incomplete")
		return
	}
	obj, info, err := s.store.GetObject(r.Context(), objectKey)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "object store: "+err.Error())
		return
	}
	defer obj.Close()
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	w.Header().Set("Content-Disposition",
		"inline; filename="+strconv.Quote(filename))
	_, _ = io.Copy(w, obj)
}

func (s *Server) downloadAttachment(w http.ResponseWriter, r *http.Request) {
	c := userFromCtx(r.Context())
	var ownerID, objectKey, filename, ct, status string
	err := s.pool.QueryRow(r.Context(), `
		SELECT i.owner_id, a.object_key, a.filename, a.content_type, a.status
		FROM attachments a JOIN inspections i ON i.id=a.inspection_id
		WHERE a.id=$1`, r.PathValue("id")).
		Scan(&ownerID, &objectKey, &filename, &ct, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ownerID != c.UserID {
		writeErr(w, http.StatusForbidden, "not assigned to you")
		return
	}
	if status != "completed" {
		writeErr(w, http.StatusConflict, "upload incomplete")
		return
	}
	u, err := s.store.PresignGet(r.Context(), objectKey)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"url": u, "filename": filename, "content_type": ct,
	})
}

type attachmentMeta struct {
	ID        string
	UploadID  string
	ObjectKey string
	Status    string
	Size      int64
}

func (s *Server) authorizeUpload(r *http.Request, uploadID, userID string) (attachmentMeta, int, string) {
	var att attachmentMeta
	var owner string
	err := s.pool.QueryRow(r.Context(), `
		SELECT a.id, a.upload_id, a.object_key, a.status, a.size, i.owner_id
		FROM attachments a JOIN inspections i ON i.id=a.inspection_id
		WHERE a.upload_id=$1`, uploadID).
		Scan(&att.ID, &att.UploadID, &att.ObjectKey, &att.Status, &att.Size, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return att, http.StatusNotFound, "upload not found"
	}
	if err != nil {
		return att, http.StatusInternalServerError, err.Error()
	}
	if owner != userID {
		return att, http.StatusForbidden, "not assigned to you"
	}
	return att, 0, ""
}

func sanitizeCT(ct string) string {
	ct = strings.TrimSpace(ct)
	if ct == "" || strings.ContainsAny(ct, "\r\n") {
		return "application/octet-stream"
	}
	return ct
}
