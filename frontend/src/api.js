// Thin fetch wrapper. All calls are authenticated with the token in IndexedDB;
// every error is normalized to { status, code, message }.
import { kv } from './offline/db.js';

class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, { body, raw, headers = {} } = {}) {
  const token = await kv.get('token');
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    if (raw) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (networkErr) {
    throw new ApiError(0, 'network unavailable', { offline: !navigator.onLine });
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json.error || `HTTP ${res.status}`, json);
  return json;
}

export const api = {
  ApiError,
  login(username, password) {
    return request('POST', '/api/auth/login', { body: { username, password } });
  },
  me() {
    return request('GET', '/api/me');
  },
  listInspections() {
    return request('GET', '/api/inspections');
  },
  getInspection(id) {
    return request('GET', `/api/inspections/${id}`);
  },
  sync(ops) {
    return request('POST', '/api/sync', { body: { ops } });
  },
  createUpload(payload) {
    return request('POST', '/api/uploads', { body: payload });
  },
  uploadStatus(uploadId) {
    return request('GET', `/api/uploads/${uploadId}`);
  },
  putPart(uploadId, part, bytes) {
    return request('PUT', `/api/uploads/${uploadId}/parts/${part}`, {
      body: bytes,
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  },
  completeUpload(uploadId, totalParts) {
    return request('POST', `/api/uploads/${uploadId}/complete`, { body: { total_parts: totalParts } });
  }
};
