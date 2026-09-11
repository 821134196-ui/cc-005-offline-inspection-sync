// Stable identifier generation. Every local mutation gets one UUID at creation
// time and keeps it across retries, browser restarts and deduplication.
export function newOpId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // RFC4122 v4 fallback (non-secure contexts / old engines)
  const b = new Uint8Array(16);
  (globalThis.crypto?.getRandomValues || ((x) => x))(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

export const clone = (v) =>
  typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));

export const FIELDS = ['title', 'status', 'findings', 'notes', 'checked_items', 'photo_caption'];

export function makeOp({ type, inspectionId, changes, field, value }) {
  return {
    op_id: newOpId(),
    type, // upsert | delete | resolve_conflict
    inspection_id: inspectionId,
    changes, // { field: { v, base } }
    field, // resolve_conflict
    value, // resolve_conflict
    created_at: Date.now(),
    state: 'queued' // queued | conflict | failed | applied (applied kept briefly then pruned)
  };
}

// Project one op onto a local field state. Used to render the working copy and
// to compute each later op's base while the device is offline.
export function applyOpToState(state, op) {
  if (op.type === 'delete') return { ...state, __deleted: true };
  if (op.type === 'upsert') {
    const out = { ...state };
    for (const [f, ch] of Object.entries(op.changes || {})) out[f] = clone(ch.v);
    return out;
  }
  if (op.type === 'resolve_conflict') {
    return { ...state, [op.field]: clone(op.value) };
  }
  return state;
}

// Local working view = last server snapshot with all queued/conflict/failed
// ops replayed on top. Failed ops stay visible so the user sees their intent.
export function localView(entity) {
  let state = entity.server
    ? clone(entity.server)
    : { id: entity.id, title: '', status: 'draft', findings: '', notes: '', checked_items: [] };
  for (const op of entity.ops || []) {
    if (op.state === 'applied') continue;
    state = applyOpToState(state, op);
  }
  return state;
}

// Effective base for a new edit: the value the server would see if every queued
// op before this one were replayed, so a chain of offline edits merges correctly.
export function baseAfterOps(serverValue, ops, field) {
  let v = serverValue;
  for (const op of ops) {
    if (op.state === 'applied') continue;
    if (op.type === 'upsert' && op.changes?.[field]) v = clone(op.changes[field].v);
    if (op.type === 'resolve_conflict' && op.field === field) v = clone(op.value);
  }
  return v;
}

// Aggregate sync status for one task card. Explicit precedence makes the
// four UI states unambiguous.
export function entityStatus({ server, ops, uploads }) {
  const active = (ops || []).filter((o) => o.state !== 'applied');
  if (active.some((o) => o.state === 'conflict')) return 'conflict';
  if (active.some((o) => o.state === 'failed')) return 'failed';
  if ((uploads || []).some((u) => u.status !== 'completed' && u.status !== 'aborted')) return 'pending';
  if (active.length > 0) return 'pending';
  if (!server) return 'pending';
  return 'synced';
}

export function totalBadge(entities) {
  const counts = { synced: 0, pending: 0, conflict: 0, failed: 0 };
  for (const e of entities) {
    if (e.server?.is_deleted) continue;
    counts[entityStatus(e)]++;
  }
  return counts;
}

// Open conflicts for an entity: candidate conflicts found in parked op
// results, intersected with what the server still reports as open — so a
// resolved conflict disappears as soon as pull brings the fresh snapshot.
export function openConflicts(entity) {
  const ops = entity.ops || [];
  const serverOpen = new Set((entity.server?.conflicts || []).map((c) => c.field));
  const map = new Map();
  for (const op of ops) {
    if (op.state !== 'conflict') continue;
    for (const c of op.result?.conflicts || []) {
      if (!serverOpen.has(c.field)) continue;
      // prefer the freshest server-provided conflict record
      const serverRec = (entity.server?.conflicts || []).find((x) => x.field === c.field);
      map.set(c.field, { ...c, ...(serverRec || {}) });
    }
  }
  return [...map.values()];
}
