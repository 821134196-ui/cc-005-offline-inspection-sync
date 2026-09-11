// Browser-level acceptance tests. Run after `npm run build` in frontend/ and
// with the Go backend + Postgres + MinIO up:
//
//   PORT=8090 BACKEND_URL=http://127.0.0.1:8080 npx playwright test
//
// Covers: offline edits survive a page refresh AND a full browser restart
// (persistent profile + IndexedDB), a same-field conflict surfaces explicit
// UI and is resolved by a human choice, a server tombstone blocks resurrection,
// and a photo upload interrupted mid-multipart resumes with only the missing
// chunk.
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BACKEND_URL || 'http://127.0.0.1:8080';
const APP = 'http://127.0.0.1:8090';

async function apiToken(username = 'alice', password = 'demo1234') {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  return (await res.json()).token;
}

async function apiSync(token, ops) {
  const res = await fetch(`${BASE}/api/sync`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops })
  });
  return (await res.json()).results;
}

const uid = () => crypto.randomUUID();

async function login(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '离线巡检系统' })).toBeVisible();
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '巡检任务' })).toBeVisible();
}

async function createRecord(page, title) {
  await page.getByRole('button', { name: /新建巡检记录/ }).click();
  await expect(page.getByText(/检查项/).first()).toBeVisible();
  const titleInput = page.locator('.field', { hasText: '标题' }).locator('input');
  await titleInput.fill(title);
  await titleInput.evaluate((el) => el.blur());
  await page.getByRole('button', { name: '← 返回' }).click();
}

async function waitBadge(page, title, badge) {
  const card = page.locator('.card', { hasText: title });
  await expect(card.getByText(badge)).toBeVisible({ timeout: 20000 });
}

test('offline edits survive a page refresh AND a full browser restart, then sync', async () => {
  const profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pw-profile-'));
  const title = `离线重启测试 ${Date.now()}`;
  const findings = `检查发现 ${Date.now()}`;
  const launch = async () => {
    const ctx = await chromium.launchPersistentContext(profile, { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await ctx.newPage();
    return { ctx, page };
  };

  // --- session 1: log in while online, let the shell install the SW ---
  {
    const { ctx, page } = await launch();
    await login(page);
    await page.evaluate(async () => {
      if (navigator.serviceWorker) await navigator.serviceWorker.ready;
    });

    await ctx.setOffline(true);
    // the UI reflects the offline state
    await expect(page.locator('.badge.net-off')).toBeVisible();

    await createRecord(page, title);
    await waitBadge(page, title, '待同步');

    // offline page refresh: app shell comes from the service worker, data
    // from IndexedDB — no network involved
    await page.reload();
    await expect(page.locator('.badge.net-off')).toBeVisible();
    await expect(page.locator('.card', { hasText: title })).toBeVisible();
    await waitBadge(page, title, '待同步');
    await ctx.close();
  }

  // --- session 2: fresh "browser" process, same on-disk profile ---
  {
    const { ctx, page } = await launch();
    await ctx.setOffline(true);
    await page.goto('/');
    // login session + outbox both survived the restart, and the app shell
    // loads fully offline from the installed service worker
    await expect(page.locator('.badge.net-off')).toBeVisible();
    await expect(page.getByRole('heading', { name: '巡检任务' })).toBeVisible();
    await expect(page.locator('.card', { hasText: title })).toBeVisible();
    await waitBadge(page, title, '待同步');

    // open it and add a finding while still offline
    await page.locator('.card', { hasText: title }).click();
    const findingsBox = page.locator('.field', { hasText: '检查发现' }).locator('textarea');
    await findingsBox.fill(findings);
    await findingsBox.evaluate((el) => el.blur());
    await page.getByRole('button', { name: '← 返回' }).click();
    await waitBadge(page, title, '待同步');

    // reconnect: queued ops (stable ids persisted across restart) auto-sync
    await ctx.setOffline(false);
    await page.getByRole('button', { name: '立即同步' }).click();
    await waitBadge(page, title, '已同步');

    // hard online reload: the record really landed on the server
    await page.reload();
    await expect(page.locator('.card', { hasText: title })).toBeVisible();
    await waitBadge(page, title, '已同步');
    await ctx.close();
  }
});

test('same-field conflict shows explicit UI; human choice resolves it', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);

  const t0 = `冲突记录 ${Date.now()}`;
  const serverVal = `${t0} [服务器改]`;
  const clientVal = `${t0} [本机改]`;
  await createRecord(page, t0);
  await waitBadge(page, t0, '已同步');

  // go offline, then a SECOND device (API) edits the same title field
  await ctx.setOffline(true);
  const token = await apiToken();
  const list = await (await fetch(`${BASE}/api/inspections`, {
    headers: { Authorization: `Bearer ${token}` }
  })).json();
  const rec = list.inspections.find((i) => i.title === t0);
  expect(rec, 'server should have the synced record').toBeTruthy();
  const [serverEdit] = await apiSync(token, [{
    op_id: uid(), type: 'upsert', inspection_id: rec.id,
    changes: { title: { v: serverVal, base: t0 } }
  }]);
  expect(serverEdit.status).toBe('applied');

  // stale local edit of the SAME field, based on the old value
  await page.locator('.card', { hasText: t0 }).click();
  const titleInput = page.locator('.field', { hasText: '标题' }).locator('input');
  await titleInput.fill(clientVal);
  await titleInput.evaluate((el) => el.blur());

  // reconnect → explicit sync → explicit conflict, server value never silently overwritten
  await ctx.setOffline(false);
  await page.getByRole('button', { name: '⟳' }).click();
  const conflict = page.locator('.conflict-box', { hasText: '标题' });
  await expect(conflict).toBeVisible({ timeout: 20000 });
  await expect(conflict).toContainText(serverVal);
  await expect(conflict).toContainText(clientVal);

  // human picks THIS device's value
  await conflict.locator('.opt').nth(1).click();
  await expect(page.getByText('已同步')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.field', { hasText: '标题' }).locator('input')).toHaveValue(clientVal);

  // and the server agrees
  const detail = await (await fetch(`${BASE}/api/inspections/${rec.id}`, {
    headers: { Authorization: `Bearer ${token}` }
  })).json();
  expect(detail.title).toBe(clientVal);
  expect(detail.conflicts.filter((c) => c.status === 'open')).toHaveLength(0);
  await browser.close();
});

test('server-side tombstone stops a stale client from resurrecting the record', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);

  const t0 = `墓碑记录 ${Date.now()}`;
  await createRecord(page, t0);
  await waitBadge(page, t0, '已同步');

  const token = await apiToken();
  const list = await (await fetch(`${BASE}/api/inspections`, {
    headers: { Authorization: `Bearer ${token}` }
  })).json();
  const rec = list.inspections.find((i) => i.title === t0);

  // another device deletes it (tombstone on the server)
  const [del] = await apiSync(token, [{
    op_id: uid(), type: 'delete', inspection_id: rec.id, changes: {}
  }]);
  expect(del.status).toBe('deleted');

  // this device pulls the tombstone
  await page.getByRole('button', { name: '立即同步' }).click();
  const card = page.locator('.card', { hasText: t0 });
  await expect(card.locator('.badge.deleted')).toBeVisible({ timeout: 20000 });
  await card.click();
  await expect(page.getByText(/已在服务器上被删除/)).toBeVisible();

  // the stale local edit cannot bring it back: force a sync and confirm it
  // stays deleted on the server
  const findingsBox = page.locator('.field', { hasText: '检查发现' }).locator('textarea');
  await expect(findingsBox).toBeDisabled();
  const check = await (await fetch(`${BASE}/api/inspections/${rec.id}`, {
    headers: { Authorization: `Bearer ${token}` }
  })).json();
  expect(check.is_deleted).toBe(true);
  await browser.close();
});

test('photo upload interrupted mid-multipart resumes only missing chunks', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);

  const t0 = `附件续传 ${Date.now()}`;
  await createRecord(page, t0);
  await waitBadge(page, t0, '已同步');
  await page.locator('.card', { hasText: t0 }).click();

  // 13 MiB pseudo-JPEG → three 6 MiB parts (last one small)
  const bytes = Buffer.alloc(13 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
  let part2Blocked = true;
  await ctx.route(/\/parts\/2$/, async (route) => {
    if (part2Blocked) return route.abort();
    return route.continue();
  });

  await page.locator('input[type=file]').setInputFiles({
    name: 'big.jpg', mimeType: 'image/jpeg', buffer: bytes
  });

  // part 1 lands, part 2 fails: UI shows the interrupted partial progress
  await expect(page.getByText(/分片 1\/3/)).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('失败')).toBeVisible({ timeout: 20000 });

  // network heals; a manual sync resumes and sends ONLY the missing chunks.
  part2Blocked = false;
  await page.getByRole('button', { name: '重试' }).first().click();
  // completion is followed by pull, which swaps the local row for the server
  // attachment record — wait for the server-backed photo to appear.
  await expect(page.getByText(/已上传（服务器）/)).toBeVisible({ timeout: 60000 });
  await browser.close();
});
