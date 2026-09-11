import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newOpId, makeOp, applyOpToState, localView, baseAfterOps, entityStatus, totalBadge, openConflicts
} from '../src/offline/merge.js';

test('newOpId returns stable-shaped uuid v4', () => {
  const id = newOpId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(newOpId(), id);
});

test('a chain of offline edits projects correctly and carries forward the base', () => {
  const server = { id: 'x', title: 'a', notes: '', checked_items: [] };
  const op1 = makeOp({ type: 'upsert', inspectionId: 'x', changes: { title: { v: 'b', base: 'a' } } });
  const op2 = makeOp({ type: 'upsert', inspectionId: 'x', changes: { title: { v: 'c', base: 'b' } } });
  const ops = [op1, op2].map((o) => ({ ...o, state: 'queued' }));

  const view = localView({ id: 'x', server, ops });
  assert.equal(view.title, 'c');

  // base for a further edit equals the last queued value, not the server value
  const ops2 = ops.map(({ state, ...rest }) => rest);
  assert.equal(baseAfterOps(server.title, ops2, 'title'), 'c');
});

test('different-field offline edits merge into the same view', () => {
  const server = { id: 'x', title: 't', findings: '', notes: 'n', checked_items: [] };
  const ops = [
    { ...makeOp({ type: 'upsert', inspectionId: 'x', changes: { findings: { v: 'f1', base: '' } } }), state: 'queued' },
    { ...makeOp({ type: 'upsert', inspectionId: 'x', changes: { notes: { v: 'n2', base: 'n' } } }), state: 'queued' }
  ];
  const view = localView({ id: 'x', server, ops });
  assert.equal(view.findings, 'f1');
  assert.equal(view.notes, 'n2');
  assert.equal(view.title, 't');
});

test('delete op projects a tombstone locally', () => {
  const view = applyOpToState({ id: 'x', title: 't' }, makeOp({ type: 'delete', inspectionId: 'x', changes: {} }));
  assert.equal(view.__deleted, true);
});

test('entityStatus precedence: conflict > failed > pending > synced', () => {
  const base = (ops, uploads = []) => ({
    id: 'x',
    server: { id: 'x', title: 't', is_deleted: false },
    ops, uploads
  });
  assert.equal(entityStatus(base([])), 'synced');
  assert.equal(entityStatus(base([{ state: 'queued' }])), 'pending');
  assert.equal(entityStatus(base([{ state: 'failed', retryable: false }, { state: 'queued' }])), 'failed');
  assert.equal(entityStatus(base([{ state: 'conflict' }, { state: 'failed' }])), 'conflict');
  assert.equal(entityStatus(base([], [{ status: 'uploading' }])), 'pending');
  assert.equal(entityStatus(base([], [{ status: 'completed' }])), 'synced');
});

test('totalBadge counts only live entities', () => {
  const counts = totalBadge([
    { server: { is_deleted: false }, ops: [] },
    { server: { is_deleted: false }, ops: [{ state: 'queued' }] },
    { server: { is_deleted: true }, ops: [] }
  ]);
  assert.deepEqual(counts, { synced: 1, pending: 1, conflict: 0, failed: 0 });
});

test('openConflicts only returns conflicts the server still holds open', () => {
  const entity = {
    id: 'x',
    server: { conflicts: [{ id: 'c1', field: 'title', status: 'open' }] },
    ops: [{
      state: 'conflict',
      result: { conflicts: [
        { id: 'c1', field: 'title' },
        { id: 'c2', field: 'notes' } // already resolved server-side after pull
      ] }
    }]
  };
  const open = openConflicts(entity);
  assert.equal(open.length, 1);
  assert.equal(open[0].field, 'title');
});

test('resolve_conflict op projects the human choice', () => {
  const op = makeOp({ type: 'resolve_conflict', inspectionId: 'x', field: 'title', value: 'chosen' });
  const view = applyOpToState({ title: 'server' }, op);
  assert.equal(view.title, 'chosen');
});
