package api

import (
	"encoding/json"
	"reflect"
	"time"
)

// Editable fields are the only columns a client op may touch. owner_id is
// deliberately absent: ownership always comes from the JWT.
var editableFields = map[string]bool{
	"title": true, "status": true, "findings": true,
	"notes": true, "checked_items": true, "photo_caption": true,
}

var validStatus = map[string]bool{
	"draft": true, "submitted": true, "approved": true, "rejected": true,
}

// FieldChange carries the new value plus the base value the client last
// observed from the server. Base is what makes three-way merge possible.
type FieldChange struct {
	V    json.RawMessage `json:"v"`
	Base json.RawMessage `json:"base"`
}

type Op struct {
	OpID         string                 `json:"op_id"`
	Type         string                 `json:"type"` // upsert|delete|resolve_conflict
	InspectionID string                 `json:"inspection_id"`
	Changes      map[string]FieldChange `json:"changes"`
	Field        string                 `json:"field"` // resolve_conflict
	Value        json.RawMessage        `json:"value"` // resolve_conflict
	TS           time.Time              `json:"ts,omitempty"`
}

type SyncRequest struct {
	Ops []Op `json:"ops"`
}

type ConflictDTO struct {
	ID            string          `json:"id"`
	Field         string          `json:"field"`
	ServerValue   json.RawMessage `json:"server_value"`
	ClientValue   json.RawMessage `json:"client_value"`
	ServerOpID    string          `json:"server_op_id,omitempty"`
	ClientOpID    string          `json:"client_op_id,omitempty"`
	Status        string          `json:"status"`
	ResolvedValue json.RawMessage `json:"resolved_value,omitempty"`
	CreatedAt     time.Time       `json:"created_at"`
	ResolvedAt    *time.Time      `json:"resolved_at,omitempty"`
}

type AttachmentDTO struct {
	ID            string `json:"id"`
	Filename      string `json:"filename"`
	ContentType   string `json:"content_type"`
	Size          int64  `json:"size"`
	Status        string `json:"status"`
	UploadID      string `json:"upload_id,omitempty"`
	ReceivedParts []int  `json:"received_parts"`
	URL           string `json:"url,omitempty"`
}

type InspectionDTO struct {
	ID           string          `json:"id"`
	OwnerID      string          `json:"owner_id"`
	Title        string          `json:"title"`
	Status       string          `json:"status"`
	Findings     string          `json:"findings"`
	Notes        string          `json:"notes"`
	CheckedItems json.RawMessage `json:"checked_items"`
	PhotoCaption string          `json:"photo_caption"`
	IsDeleted    bool            `json:"is_deleted"`
	Rev          int64           `json:"rev"`
	UpdatedAt    time.Time       `json:"updated_at"`
	Attachments  []AttachmentDTO `json:"attachments"`
	Conflicts    []ConflictDTO   `json:"conflicts"`
	// Aggregates for list view.
	OpenConflictFields []string `json:"open_conflict_fields"`
	PendingAttachments int      `json:"pending_attachments"`
}

// OpResult is persisted in processed_ops and returned verbatim on replay,
// which is what makes delivery idempotent.
type OpResult struct {
	OpID       string         `json:"op_id"`
	Status     string         `json:"status"` // applied|duplicate|conflict|forbidden|deleted|attachments_incomplete|invalid
	Code       string         `json:"code,omitempty"`
	Message    string         `json:"message,omitempty"`
	Conflicts  []ConflictDTO  `json:"conflicts,omitempty"`
	Inspection *InspectionDTO `json:"inspection,omitempty"`
}

type SyncResponse struct {
	Results []OpResult `json:"results"`
}

type fieldVerdict int

const (
	verdictNoop fieldVerdict = iota
	verdictApply
	verdictConflict
)

// classifyField is the pure three-way-merge decision for one field:
//
//	base == server            -> the client saw current server state.
//	  v == server             -> no-op (converges)
//	  otherwise               -> fast-forward apply
//	base != server AND v == server -> another client's edit already landed and
//	  this edit converges to the same value -> no-op
//	otherwise                  -> same field changed on both sides -> conflict
func classifyField(server, v, base json.RawMessage) fieldVerdict {
	if equalJSON(base, server) {
		if equalJSON(v, server) {
			return verdictNoop
		}
		return verdictApply
	}
	if equalJSON(v, server) {
		return verdictNoop
	}
	return verdictConflict
}

func equalJSON(a, b json.RawMessage) bool {
	var va, vb any
	if err := json.Unmarshal(a, &va); err != nil {
		return false
	}
	if err := json.Unmarshal(b, &vb); err != nil {
		return false
	}
	return reflect.DeepEqual(va, vb)
}
