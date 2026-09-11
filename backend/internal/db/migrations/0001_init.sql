-- Inspection sync schema
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL
);

-- Field-level revision lineage for optimistic merge / conflict detection.
-- Every mutable field of an inspection is tracked separately.
CREATE TABLE IF NOT EXISTS field_revs (
    inspection_id UUID NOT NULL,
    field         TEXT NOT NULL,
    value         JSONB NOT NULL,
    op_id         UUID NOT NULL,         -- operation that last wrote this field server-side
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (inspection_id, field)
);

CREATE TABLE IF NOT EXISTS inspections (
    id            UUID PRIMARY KEY,
    owner_id      UUID NOT NULL REFERENCES users(id),
    title         TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'draft',   -- draft|submitted|approved|rejected
    findings      TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    checked_items JSONB NOT NULL DEFAULT '[]'::jsonb,
    photo_caption TEXT NOT NULL DEFAULT '',
    is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,  -- tombstone
    rev           BIGINT NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inspections_owner ON inspections(owner_id);

CREATE TABLE IF NOT EXISTS conflicts (
    id             UUID PRIMARY KEY,
    inspection_id  UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
    field          TEXT NOT NULL,
    server_value   JSONB NOT NULL,
    client_value   JSONB NOT NULL,
    server_op_id   UUID NOT NULL,
    client_op_id   UUID NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open',   -- open|resolved
    resolved_value JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_conflicts_inspection ON conflicts(inspection_id, status);
-- At most one unresolved conflict per field; later conflicting writes reference it.
CREATE UNIQUE INDEX IF NOT EXISTS conflicts_one_open_per_field
    ON conflicts (inspection_id, field) WHERE status = 'open';

-- Idempotency log: one row per operation ID ever accepted.
CREATE TABLE IF NOT EXISTS processed_ops (
    op_id      UUID PRIMARY KEY,
    user_id    UUID NOT NULL,
    result     JSONB NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments (
    id            UUID PRIMARY KEY,
    inspection_id UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
    upload_id     TEXT NOT NULL UNIQUE,
    filename      TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    size          BIGINT NOT NULL,
    object_key    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'uploading', -- uploading|completed|failed
    created_by    UUID NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    uploaded_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_attachments_insp ON attachments(inspection_id);

-- Multipart upload part ledger (drives resumable uploads).
CREATE TABLE IF NOT EXISTS upload_parts (
    upload_id   TEXT NOT NULL,
    part_number INT  NOT NULL,
    etag        TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (upload_id, part_number)
);
