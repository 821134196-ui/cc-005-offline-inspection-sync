// Sync engine. Owns the outbox, staged uploads and the online reconciliation
// loop. Design guarantees:
//
//  - one stable op id per mutation, persisted before any UI state is shown
//  - ops are delivered in creation order, batched; retries reuse the same ids
//    (server dedupes them idempotently)
//  - photos upload resumably: after a browser restart the File blob and the
//    part ledger come straight from IndexedDB, only missing parts are sent
//  - a conflict result never overwrites local intent; the op parks in
//    'conflict' until the user explicitly picks a value
import {
  kv, getEntity, listEntitiesWithState, putServerSnapshot, deleteEntity,
  enqueueOp, updateOp, deleteOpsStore, getOpsInOrder, getOpsFor,
  putUpload, getUpload, listUploads, removeUpload
} from './db.js';
import { api } from '../api.js';
import { makeOp, baseAfterOps, clone, newOpId } from './merge.js';

// S3-compatible multipart uploads require every non-final part >= 5 MiB, so
// the default chunk is 6 MiB. A small photo becomes a single (last) part.
const CHUNK_FALLBACK = 6 * 1024 * 1024;

export class SyncStore extends EventTarget {
  constructor() {
    super();
    this._syncing = false;
    this.online = navigator.onLine;
    window.addEventListener('online', () => { this.online = true; this.changed('online'); this.requestSync(); });
    window.addEventListener('offline', () => { this.online = false; this.changed('online'); });
  }

  changed(detail = 'data') {
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }

  // ---- auth ----------------------------------------------------------------
  async login(username, password) {
    const res = await api.login(username, password);
    await kv.set('token', res.token);
    await kv.set('user', { user_id: res.user_id, username: res.username, display_name: res.display_name });
    this.changed('auth');
    await this.fullSync().catch(() => {});
    this.startTicker();
    return res;
  }

  async logout() {
    await kv.del('token');
    await kv.del('user');
    this.changed('auth');
  }

  async currentUser() {
    return kv.get('user');
  }

  startTicker() {
    if (this._tick) return;
    // Opportunistic background sync: catches remote edits and finished uploads.
    this._tick = setInterval(() => { if (navigator.onLine) this.requestSync(); }, 15000);
  }

  // ---- reads ---------------------------------------------------------------
  list() { return listEntitiesWithState(); }
  entity(id) { return getEntity(id); }
  uploads() { return listUploads(); }

  // ---- local mutations -----------------------------------------------------
  // stageOp computes the correct three-way-merge base from the *projected*
  // value after earlier queued ops, so a chain of offline edits stays linear.
  async stageOp(inspectionId, field, value) {
    const ent = await getEntity(inspectionId);
    const queued = ent.ops.filter((o) => o.state !== 'applied');
    const base = baseAfterOps(ent.server ? clone(ent.server[field]) : undefined, queued, field);
    const op = makeOp({
      type: 'upsert',
      inspectionId,
      changes: { [field]: { v: clone(value), base: base === undefined ? null : base } }
    });
    await enqueueOp(op);
    this.changed();
    this.requestSync();
    return op;
  }

  async stageCreate(initial = {}) {
    const id = newOpId();
    const fields = {
      title: initial.title ?? '新巡检记录',
      status: 'draft',
      findings: '', notes: '', checked_items: [], photo_caption: '',
      ...initial
    };
    const changes = {};
    for (const [f, v] of Object.entries(fields)) changes[f] = { v: clone(v) };
    const op = makeOp({ type: 'upsert', inspectionId: id, changes });
    await enqueueOp(op);
    this.changed();
    this.requestSync();
    return id;
  }

  async stageDelete(inspectionId) {
    const op = makeOp({ type: 'delete', inspectionId, changes: {} });
    await enqueueOp(op);
    this.changed();
    this.requestSync();
  }

  // Human resolution of a same-field conflict. Produces a fresh op carrying
  // the explicitly chosen value; nothing is overwritten automatically.
  async resolveConflict(inspectionId, field, value) {
    const op = makeOp({ type: 'resolve_conflict', inspectionId, field, value: clone(value) });
    await enqueueOp(op);
    this.changed();
    this.requestSync();
  }

  // Discard local edits that the server permanently rejected (e.g. tombstoned).
  async discardOps(inspectionId) {
    const ops = await getOpsFor(inspectionId);
    for (const o of ops) await deleteOpsStore(o.op_id);
    this.changed();
  }

  // ---- photo staging + resumable upload ------------------------------------
  async stagePhoto(inspectionId, file, caption) {
    const localId = newOpId();
    const rec = {
      localId,
      inspectionId,
      file, // Blob persisted in IndexedDB across restarts
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      status: 'staged', // staged|creating|uploading|completing|completed|failed
      uploadId: null,
      attachmentId: null,
      receivedParts: [],
      attempts: 0,
      error: null,
      createdAt: Date.now()
    };
    await putUpload(rec);
    if (caption) await this.stageOp(inspectionId, 'photo_caption', caption);
    this.changed();
    this.requestSync();
    return localId;
  }

  async processUploads() {
    const recs = (await listUploads()).filter((u) => u.status !== 'completed' && u.status !== 'aborted');
    for (const rec of recs) {
      try {
        await this._uploadOne(rec);
      } catch (err) {
        // Re-read: _uploadOne persisted receivedParts after every chunk, so
        // keep the partial progress rather than the stale loop copy.
        const latest = (await getUpload(rec.localId)) || rec;
        await putUpload({
          ...latest,
          status: latest.uploadId ? 'failed' : 'staged',
          error: err.message || String(err),
          attempts: (latest.attempts || 0) + 1
        });
        this.changed('uploads');
        if (!navigator.onLine) return; // nothing else to try offline
      }
    }
  }

  async _uploadOne(rec0) {
    let rec = { ...rec0 };

    if (!rec.uploadId) {
      rec.status = 'creating';
      await putUpload(rec);
      const totalParts = Math.max(1, Math.ceil(rec.size / CHUNK_FALLBACK));
      const created = await api.createUpload({
        inspection_id: rec.inspectionId,
        filename: rec.filename,
        content_type: rec.contentType,
        size: rec.size,
        total_parts: totalParts
      });
      rec.uploadId = created.upload_id;
      rec.attachmentId = created.attachment_id;
      rec.chunkSize = created.chunk_size || CHUNK_FALLBACK;
      await putUpload(rec);
    }
    const chunkSize = rec.chunkSize || CHUNK_FALLBACK;
    const total = Math.max(1, Math.ceil(rec.size / chunkSize));

    // Ask the server which parts it actually holds (MinIO is authoritative);
    // this is what makes a restarted upload send only missing bytes.
    const st = await api.uploadStatus(rec.uploadId);
    const have = new Set(st.received_parts || []);
    rec.receivedParts = [...have].sort((a, b) => a - b);
    rec.status = 'uploading';
    await putUpload(rec);

    for (let part = 1; part <= total; part++) {
      if (have.has(part)) continue;
      const start = (part - 1) * chunkSize;
      const blob = rec.file.slice(start, Math.min(start + chunkSize, rec.size), rec.contentType);
      const buf = await blob.arrayBuffer();
      await api.putPart(rec.uploadId, part, buf);
      have.add(part);
      rec.receivedParts = [...have].sort((a, b) => a - b);
      // Persist after every part: an interruption loses at most one chunk.
      await putUpload(rec);
      this.changed('uploads');
    }

    rec.status = 'completing';
    await putUpload(rec);
    await api.completeUpload(rec.uploadId, total);
    rec.status = 'completed';
    rec.error = null;
    await putUpload(rec);
    this.changed('uploads');
  }

  // ---- main sync cycle -----------------------------------------------------
  requestSync() {
    if (this._queued) return;
    this._queued = true;
    setTimeout(() => { this._queued = false; this.fullSync(); }, 300);
  }

  async fullSync() {
    if (this._syncing || !navigator.onLine || !(await kv.get('token'))) return;
    this._syncing = true;
    this.changed('syncing');
    try {
      // 1) finish uploads so that submit-for-review never outruns attachments
      await this.processUploads();
      // 2) push queued/conflict-resolution ops in stable order
      await this.syncOps();
      // 3) pull remote state (other devices, tombstones, resolutions)
      await this.pull();
    } catch (err) {
      // surfaced per-op/per-upload; a cycle failure just retries later
      console.warn('sync cycle failed', err);
    } finally {
      this._syncing = false;
      this.changed('syncing');
    }
  }

  async syncOps() {
    const ops = (await getOpsInOrder()).filter((o) =>
      o.state === 'queued' || (o.state === 'failed' && o.retryable));
    if (ops.length === 0) return;
    let results;
    try {
      results = await api.sync(ops.map(serializeOp));
    } catch (err) {
      if (err.status === 0) return; // offline: leave queue untouched
      for (const op of ops) {
        await updateOp(op.op_id, { state: 'failed', retryable: err.status >= 500, result: { error: err.message } });
      }
      this.changed();
      return;
    }
    for (let i = 0; i < results.results.length; i++) {
      const op = ops[i];
      const r = results.results[i];
      await this._absorbResult(op, r);
      // Once a human choice lands, earlier parked conflict ops whose fields
      // are all resolved leave the conflict state (multi-field ops handled).
      if (op.type === 'resolve_conflict' && (r.status === 'applied' || r.status === 'duplicate')) {
        const stillOpen = new Set((r.inspection?.conflicts || []).map((c) => c.field));
        const prior = await getOpsFor(op.inspection_id);
        for (const p of prior) {
          if (p.state !== 'conflict' || !p.result?.conflicts) continue;
          const fields = p.result.conflicts.map((c) => c.field);
          if (fields.every((f) => !stillOpen.has(f))) {
            await updateOp(p.op_id, { state: 'applied', applied_at: Date.now() });
          }
        }
      }
    }
    this.changed();
  }

  async _absorbResult(op, r) {
    if (r.inspection) await putServerSnapshot(r.inspection);
    const patch = { result: r, last_status: r.status, attempts: op.attempts + 1 };
    switch (r.status) {
      case 'applied':
      case 'deleted':
      case 'duplicate':
        patch.state = 'applied';
        patch.applied_at = Date.now();
        break;
      case 'conflict':
        patch.state = 'conflict';
        break;
      case 'attachments_incomplete':
        patch.state = 'failed';
        patch.retryable = true; // uploads run first on the next cycle
        break;
      case 'forbidden':
      case 'invalid':
      case 'error':
      default:
        patch.state = 'failed';
        patch.retryable = false;
    }
    await updateOp(op.op_id, patch);
    if (r.status === 'deleted' && r.code === 'inspection_deleted') {
      // keep entity + op so the UI shows the rejected stale edit; nothing to
      // resurrect because we never re-send applied ops.
    }
  }

  async pull() {
    const res = await api.listInspections();
    const local = await listEntitiesWithState();
    for (const snap of res.inspections || []) {
      const ent = local.find((e) => e.id === snap.id);
      if (snap.is_deleted) {
        // Keep the tombstone snapshot so the UI can show an explicit 已删除
        // state instead of silently losing the card. The local delete op is
        // already applied server-side; prune queued ops against the tombstone.
        await putServerSnapshot(snap);
        if (ent) {
          for (const o of ent.ops) {
            if (o.state === 'applied' || o.type === 'delete') await deleteOpsStore(o.op_id);
          }
        }
        continue;
      }
      await putServerSnapshot(snap);
      if (ent) {
        // prune applied ops once the snapshot covers them
        for (const o of ent.ops) {
          if (o.state === 'applied') await deleteOpsStore(o.op_id);
        }
        // drop local upload ledger rows now represented by server attachments
        const remoteAttIds = new Set((snap.attachments || []).map((a) => a.id));
        for (const u of ent.uploads) {
          if (u.status === 'completed' && remoteAttIds.has(u.attachmentId)) await removeUpload(u.localId);
        }
      }
    }
    this.changed();
  }
}

function serializeOp(op) {
  const out = { op_id: op.op_id, type: op.type, inspection_id: op.inspection_id };
  if (op.changes) out.changes = op.changes;
  if (op.field) out.field = op.field;
  if (op.value !== undefined) out.value = op.value;
  return out;
}

export const store = new SyncStore();
