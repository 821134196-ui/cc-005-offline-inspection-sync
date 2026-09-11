// End-to-end acceptance tests against a running backend.
// Run: BASE_URL=http://127.0.0.1:8080 node --test tests/api/acceptance.test.js
// Requires Postgres + MinIO wired to the backend (see docker-compose.yml).
//
// Covers: idempotent duplicates, out-of-order delivery, automatic merge of
// different fields, explicit same-field conflicts, tombstones (no
// resurrection), resumable chunked photo upload, the all-attachments gate
// before submitting for review, and cross-user authorization (client-supplied
// owner is never trusted).
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';

function uuid() {
  return crypto.randomUUID();
}
async function login(username, password = 'demo1234') {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.equal(res.status, 200, `login ${username}`);
  return (await res.json()).token;
}
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function sync(token, ops) {
  const res = await fetch(`${BASE}/api/sync`, {
    method: 'POST', headers: auth(token), body: JSON.stringify({ ops })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.results;
}
const upsert = (inspectionId, changes, type = 'upsert') => ({
  op_id: uuid(), type, inspection_id: inspectionId, changes
});
// v/base are native JSON values in the API; str() just marks intent in tests.
const str = (v) => v;

let ALICE, BOB;
test.before(async () => {
  ALICE = await login('alice');
  BOB = await login('bob');
});

test('healthz reports db + minio up', async () => {
  const res = await fetch(`${BASE}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.db, true);
  assert.equal(body.minio, true);
});

test('create via sync is owned by the token user, never the payload', async () => {
  const id = uuid();
  const op = upsert(id, { title: { v: str('越权 owner 测试') } });
  const [r] = await sync(ALICE, [op]);
  assert.equal(r.status, 'applied');
  assert.equal(r.inspection.owner_id, '11111111-1111-1111-1111-111111111111');
  // owner_id is not even an editable field
  const evil = upsert(uuid(), {
    title: { v: str('x') },
    owner_id: { v: str('22222222-2222-2222-2222-222222222222') }
  });
  const [r2] = await sync(ALICE, [evil]);
  assert.equal(r2.status, 'invalid');
});

test('duplicate delivery of the same op id is idempotent', async () => {
  const id = uuid();
  const op = upsert(id, { title: { v: str('第一次') } });
  const [first] = await sync(ALICE, [op]);
  assert.equal(first.status, 'applied');
  const revAfterFirst = first.inspection.rev;
  // identical replay, possibly much later
  const [second] = await sync(ALICE, [op]);
  assert.equal(second.status, 'duplicate');
  const res = await fetch(`${BASE}/api/inspections/${id}`, { headers: auth(ALICE) });
  const snap = await res.json();
  assert.equal(snap.title, '第一次');
  assert.equal(snap.rev, revAfterFirst, 'rev must not move on replay');
});

test('different fields changed on two devices merge automatically', async () => {
  const id = uuid();
  await sync(ALICE, [upsert(id, {
    title: { v: str('合并测试') }, findings: { v: str('') }, notes: { v: str('') }
  })]);
  // both edits start from the same server base but touch different fields
  const findingsOp = upsert(id, { findings: { v: str('设备A发现'), base: str('') } });
  const notesOp = upsert(id, { notes: { v: str('设备B备注'), base: str('') } });
  const [r1] = await sync(ALICE, [findingsOp]);
  assert.equal(r1.status, 'applied');
  const [r2] = await sync(ALICE, [notesOp]);
  assert.equal(r2.status, 'applied');
  assert.deepEqual(r2.inspection.findings, '设备A发现');
  assert.deepEqual(r2.inspection.notes, '设备B备注');
});

test('same field edited on both sides produces an explicit conflict and never auto-overwrites', async () => {
  const id = uuid();
  await sync(ALICE, [upsert(id, { title: { v: str('共享标题') } })]);
  // server edit first
  await sync(ALICE, [upsert(id, { title: { v: str('服务器版本'), base: str('共享标题') } })]);
  // stale client edit, same field, diverged
  const clientOp = upsert(id, { title: { v: str('客户端版本'), base: str('共享标题') } });
  const [cr] = await sync(ALICE, [clientOp]);
  assert.equal(cr.status, 'conflict');
  assert.equal(cr.conflicts[0].field, 'title');
  // server value untouched
  const res = await fetch(`${BASE}/api/inspections/${id}`, { headers: auth(ALICE) });
  const snap = await res.json();
  assert.equal(snap.title, '服务器版本');
  assert.equal(snap.conflicts.filter((c) => c.status === 'open').length, 1);
  // replaying the conflicting op does not change anything
  const [again] = await sync(ALICE, [clientOp]);
  assert.equal(again.status, 'duplicate');
  // human picks the client value via resolve_conflict
  const resolve = {
    op_id: uuid(), type: 'resolve_conflict', inspection_id: id,
    field: 'title', value: str('客户端版本')
  };
  const [rr] = await sync(ALICE, [resolve]);
  assert.equal(rr.status, 'applied');
  assert.equal(rr.inspection.title, '客户端版本');
  const res2 = await fetch(`${BASE}/api/inspections/${id}`, { headers: auth(ALICE) });
  const snap2 = await res2.json();
  assert.equal(snap2.conflicts.filter((c) => c.status === 'open').length, 0);
});

test('out-of-order ops do not corrupt state; late op conflicts instead of overwriting', async () => {
  const id = uuid();
  await sync(ALICE, [upsert(id, { title: { v: str('v0') } })]);
  const op1 = upsert(id, { title: { v: str('v1'), base: str('v0') } });
  const op2 = upsert(id, { title: { v: str('v2'), base: str('v1') } });
  // op2 arrives FIRST, before its parent op1
  const [early] = await sync(ALICE, [op2]);
  assert.equal(early.status, 'conflict');
  const res1 = await fetch(`${BASE}/api/inspections/${id}`, { headers: auth(ALICE) });
  assert.equal((await res1.json()).title, 'v0', 'out-of-order op must not overwrite');
  // then op1 arrives: clean fast-forward
  const [late] = await sync(ALICE, [op1]);
  assert.equal(late.status, 'applied');
  assert.equal(late.inspection.title, 'v1');
  // the conflict from the early op2 stays open for a human
  const res2 = await fetch(`${BASE}/api/inspections/${id}`, { headers: auth(ALICE) });
  assert.equal((await res2.json()).conflicts.filter((c) => c.status === 'open').length, 1);
});

test('delete uses a tombstone; a stale client coming back online cannot resurrect it', async () => {
  const id = uuid();
  await sync(ALICE, [upsert(id, { title: { v: str('将被删除') } })]);
  const del = { op_id: uuid(), type: 'delete', inspection_id: id, changes: {} };
  const [dr] = await sync(ALICE, [del]);
  assert.equal(dr.status, 'deleted');
  // delete is idempotent
  const [dr2] = await sync(ALICE, [del]);
  assert.equal(dr2.status, 'duplicate');
  // stale edit from an old client must be rejected and not resurrect the row
  const stale = upsert(id, { title: { v: str('复活攻击'), base: str('将被删除') } });
  const [sr] = await sync(ALICE, [stale]);
  assert.equal(sr.status, 'deleted');
  assert.equal(sr.code, 'inspection_deleted');
  const list = await fetch(`${BASE}/api/inspections`, { headers: auth(ALICE) }).then((r) => r.json());
  const row = list.inspections.find((i) => i.id === id);
  assert.equal(row.is_deleted, true);
});

test('user cannot sync tasks assigned to another user', async () => {
  // seeded inspection belonging to bob: a2222222-...
  const bobs = 'a2222222-0000-0000-0000-000000000001';
  const op = upsert(bobs, { notes: { v: str('alice 的越权修改'), base: str('') } });
  const [r] = await sync(ALICE, [op]);
  assert.equal(r.status, 'forbidden');
  // and it is invisible in alice's list
  const list = await fetch(`${BASE}/api/inspections`, { headers: auth(ALICE) }).then((x) => x.json());
  assert.equal(list.inspections.some((i) => i.id === bobs), false);
  // direct GET is also refused
  const g = await fetch(`${BASE}/api/inspections/${bobs}`, { headers: auth(ALICE) });
  assert.equal(g.status, 403);
  // bob himself can edit it (a real device generates its own stable op id)
  const seededNotes = '用于验证越权同步：alice 无法同步此任务';
  const bobsOp = upsert(bobs, { notes: { v: 'bob 自己的修改', base: seededNotes } });
  const [ok] = await sync(BOB, [bobsOp]);
  assert.equal(ok.status, 'applied');

  // an op id first seen under alice cannot be replayed by bob (spoof guard)
  const [collision] = await sync(BOB, [op]);
  assert.equal(collision.status, 'invalid');
  assert.equal(collision.code, 'op_id_collision');
});

test('photo upload: chunks resume, gaps block completion, and bytes reassemble', async () => {
  const id = uuid();
  await sync(ALICE, [upsert(id, { title: { v: str('照片测试') } })]);

  // S3 multipart rule: every non-final part must be >= 5 MiB.
  const MiB = 1024 * 1024;
  const parts = [Buffer.alloc(6 * MiB, 0x61), Buffer.alloc(6 * MiB, 0x62), Buffer.alloc(50 * 1024, 0x63)];
  const file = Buffer.concat(parts);

  const created = await fetch(`${BASE}/api/uploads`, {
    method: 'POST', headers: auth(ALICE),
    body: JSON.stringify({
      inspection_id: id, filename: 'photo.bin',
      content_type: 'application/octet-stream', size: file.length, total_parts: parts.length
    })
  }).then((r) => { assert.equal(r.status, 201); return r.json(); });
  const uid = created.upload_id;
  const attId = created.attachment_id;

  const put = async (n, body) => {
    const r = await fetch(`${BASE}/api/uploads/${uid}/parts/${n}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ALICE}`, 'Content-Type': 'application/octet-stream' },
      body
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  // interrupted upload: part 1 then part 3 (gap at 2)
  const p1 = await put(1, parts[0]);
  assert.ok(p1.etag);
  const p3 = await put(3, parts[2]);
  assert.ok(p3.etag);

  // part 1 retried after reconnect: idempotent, no double write
  const p1again = await put(1, parts[0]);
  assert.equal(p1again.duplicate, true);

  // status reports exactly what the server holds → client resumes only gaps
  const st = await fetch(`${BASE}/api/uploads/${uid}`, { headers: auth(ALICE) }).then((r) => r.json());
  assert.deepEqual(st.received_parts, [1, 3]);

  // completing with a gap is refused
  const bad = await fetch(`${BASE}/api/uploads/${uid}/complete`, {
    method: 'POST', headers: auth(ALICE), body: JSON.stringify({ total_parts: 3 })
  }).then((r) => r.json());
  assert.match(JSON.stringify(bad), /missing part 2/);

  // upload only the missing chunk, then complete
  await put(2, parts[1]);
  const done = await fetch(`${BASE}/api/uploads/${uid}/complete`, {
    method: 'POST', headers: auth(ALICE), body: JSON.stringify({ total_parts: 3 })
  }).then((r) => { assert.equal(r.status, 200); return r.json(); });
  assert.equal(done.status, 'completed');
  // complete is itself idempotent
  const done2 = await fetch(`${BASE}/api/uploads/${uid}/complete`, {
    method: 'POST', headers: auth(ALICE), body: JSON.stringify({ total_parts: 3 })
  }).then((r) => r.json());
  assert.equal(done2.duplicate, true);

  // bytes come back intact through the authenticated proxy
  const content = await fetch(`${BASE}/api/attachments/${attId}/content`, {
    headers: { Authorization: `Bearer ${ALICE}` }
  });
  assert.equal(content.status, 200);
  const got = Buffer.from(await content.arrayBuffer());
  assert.ok(got.equals(file), 'reassembled object must equal the original bytes');

  // bob cannot read alice's attachment
  const denied = await fetch(`${BASE}/api/attachments/${attId}/content`, {
    headers: { Authorization: `Bearer ${BOB}` }
  });
  assert.equal(denied.status, 403);

  id; // attachment id retained for next test via closure
  globalThis.__photoInspection = { id, uid, attId };
});

test('submit for review is blocked until all attachments completed', async () => {
  const { id } = globalThis.__photoInspection;
  // Start a SECOND upload on the same inspection, leave it unfinished.
  const second = Buffer.alloc(2048, 7);
  const c = await fetch(`${BASE}/api/uploads`, {
    method: 'POST', headers: auth(ALICE),
    body: JSON.stringify({
      inspection_id: id, filename: 'two.bin',
      content_type: 'application/octet-stream', size: second.length, total_parts: 1
    })
  }).then((r) => r.json());
  await fetch(`${BASE}/api/uploads/${c.upload_id}/parts/1`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ALICE}`, 'Content-Type': 'application/octet-stream' },
    body: second
  });
  // not completed yet → submission refused
  const blocked = upsert(id, { status: { v: str('submitted'), base: str('draft') } });
  const [br] = await sync(ALICE, [blocked]);
  assert.equal(br.status, 'attachments_incomplete');

  // finish the second upload, then submission succeeds
  await fetch(`${BASE}/api/uploads/${c.upload_id}/complete`, {
    method: 'POST', headers: auth(ALICE), body: JSON.stringify({ total_parts: 1 })
  });
  const okOp = upsert(id, { status: { v: str('submitted'), base: str('draft') } });
  const [ok] = await sync(ALICE, [okOp]);
  assert.equal(ok.status, 'applied');
  assert.equal(ok.inspection.status, 'submitted');
});

test('unauthenticated and bad-token requests are rejected', async () => {
  const r1 = await fetch(`${BASE}/api/inspections`);
  assert.equal(r1.status, 401);
  const r2 = await fetch(`${BASE}/api/inspections`, { headers: { Authorization: 'Bearer garbage' } });
  assert.equal(r2.status, 401);
});
