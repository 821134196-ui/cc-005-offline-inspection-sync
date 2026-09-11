import { openDB } from 'idb';
import { clone } from './merge.js';

const DB_NAME = 'inspection-offline';
const DB_VERSION = 1;

// Stores:
//   kv        — session token / current user / last pull cursor
//   entities  — inspection id -> latest server snapshot (or null if only local)
//   ops       — outbox: op_id -> { ...op, state, attempts, result, inspection_id, created_at }
//   uploads   — upload_id -> resumable upload state incl. the local photo Blob
//
// Photo File/Blob values are structured-cloneable, so IndexedDB keeps the bytes
// across a full browser restart; the multipart ledger lets an upload resume
// with only the missing parts afterwards.
export function openDatabase() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('kv');
      db.createObjectStore('entities');
      const ops = db.createObjectStore('ops', { keyPath: 'op_id' });
      ops.createIndex('created_at', 'created_at');
      ops.createIndex('inspection_id', 'inspection_id');
      ops.createIndex('state', 'state');
      const ups = db.createObjectStore('uploads', { keyPath: 'localId' });
      ups.createIndex('inspectionId', 'inspectionId');
      ups.createIndex('status', 'status');
    }
  });
}

let dbp;
export function db() {
  dbp ||= openDatabase();
  return dbp;
}

// ---- kv ---------------------------------------------------------------------
export const kv = {
  async get(key) {
    return (await db()).get('kv', key);
  },
  async set(key, value) {
    await (await db()).put('kv', value, key);
  },
  async del(key) {
    await (await db()).delete('kv', key);
  }
};

// ---- entities ---------------------------------------------------------------
export async function getEntity(id) {
  const d = await db();
  const [server, ops, uploads] = await Promise.all([
    d.get('entities', id),
    d.getAllFromIndex('ops', 'inspection_id', id),
    d.getAllFromIndex('uploads', 'inspectionId', id)
  ]);
  ops.sort((a, b) => a.created_at - b.created_at);
  return { id, server, ops, uploads };
}

export async function listEntitiesWithState() {
  const d = await db();
  const [servers, allOps, allUps] = await Promise.all([
    d.getAll('entities'),
    d.getAll('ops'),
    d.getAll('uploads')
  ]);
  const byId = new Map();
  for (const s of servers) {
    byId.set(s.id, { id: s.id, server: s, ops: [], uploads: [] });
  }
  for (const op of allOps) {
    if (!byId.has(op.inspection_id)) {
      byId.set(op.inspection_id, { id: op.inspection_id, server: null, ops: [], uploads: [] });
    }
    byId.get(op.inspection_id).ops.push(op);
  }
  for (const u of allUps) {
    if (!byId.has(u.inspectionId)) {
      byId.set(u.inspectionId, { id: u.inspectionId, server: null, ops: [], uploads: [] });
    }
    byId.get(u.inspectionId).uploads.push(u);
  }
  const out = [...byId.values()];
  for (const e of out) e.ops.sort((a, b) => a.created_at - b.created_at);
  // newest server activity first, local-only rows after
  return out.sort((a, b) => {
    const ta = a.server?.updated_at ? Date.parse(a.server.updated_at) : 0;
    const tb = b.server?.updated_at ? Date.parse(b.server.updated_at) : 0;
    if (tb !== ta) return tb - ta;
    return (b.ops[0]?.created_at || 0) - (a.ops[0]?.created_at || 0);
  });
}

export async function putServerSnapshot(snap) {
  await (await db()).put('entities', clone(snap), snap.id);
}

export async function deleteEntity(id) {
  const d = await db();
  const tx = d.transaction(['entities', 'ops', 'uploads'], 'readwrite');
  await tx.objectStore('entities').delete(id);
  const ops = await tx.objectStore('ops').index('inspection_id').getAllKeys(id);
  await Promise.all(ops.map((k) => tx.objectStore('ops').delete(k)));
  const ups = await tx.objectStore('uploads').index('inspectionId').getAllKeys(id);
  await Promise.all(ups.map((k) => tx.objectStore('uploads').delete(k)));
  await tx.done;
}

// ---- ops --------------------------------------------------------------------
export async function enqueueOp(op) {
  await (await db()).put('ops', { attempts: 0, ...op });
}

export async function updateOp(op_id, patch) {
  const d = await db();
  const existing = await d.get('ops', op_id);
  if (!existing) return;
  await d.put('ops', { ...existing, ...patch });
}

export async function deleteOpsStore(op_id) {
  await (await db()).delete('ops', op_id);
}

export async function getOpsInOrder() {
  const ops = await (await db()).getAllFromIndex('ops', 'created_at');
  return ops;
}

export async function getOpsFor(inspectionId) {
  const ops = await (await db()).getAllFromIndex('ops', 'inspection_id', inspectionId);
  return ops.sort((a, b) => a.created_at - b.created_at);
}

// ---- uploads ----------------------------------------------------------------
export async function putUpload(rec) {
  await (await db()).put('uploads', rec);
}

export async function getUpload(localId) {
  return (await db()).get('uploads', localId);
}

export async function listUploads() {
  return (await db()).getAll('uploads');
}

export async function removeUpload(localId) {
  await (await db()).delete('uploads', localId);
}

// Wipe everything except optionally the session (used by logout).
export async function wipeData(keepSession = true) {
  const d = await db();
  const session = keepSession
    ? { token: await d.get('kv', 'token'), user: await d.get('kv', 'user') }
    : null;
  const tx = d.transaction(['kv', 'entities', 'ops', 'uploads'], 'readwrite');
  await Promise.all(['kv', 'entities', 'ops', 'uploads'].map((s) => tx.objectStore(s).clear()));
  await tx.done;
  if (session) {
    if (session.token) await d.put('kv', session.token, 'token');
    if (session.user) await d.put('kv', session.user, 'user');
  }
}
