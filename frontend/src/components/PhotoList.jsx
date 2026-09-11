import React, { useEffect, useState } from 'react';
import { kv } from '../offline/db.js';
import { store } from '../offline/store.js';

const STATUS_ZH = {
  staged: '待上传（离线）', creating: '准备上传…', uploading: '分片上传中',
  completing: '合并中…', completed: '已完成', failed: '失败', aborted: '已取消'
};

// Local staged upload (File blob lives in IndexedDB, so it survives restarts).
function StagedPhoto({ rec }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(rec.file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [rec.localId]);

  const chunk = rec.chunkSize || 6 * 1024 * 1024;
  const total = Math.max(1, Math.ceil(rec.size / chunk));
  const got = rec.receivedParts?.length || 0;
  const pct = Math.round((got / total) * 100);
  const done = rec.status === 'completed';

  return (
    <div className="upload-row">
      {url ? <img className="thumb" src={url} alt="" /> : <div className="thumb" />}
      <div className="name">
        {rec.filename} <small>{(rec.size / 1024).toFixed(0)} KB · {STATUS_ZH[rec.status] || rec.status}</small>
        {!done && (
          <>
            <div className="progress"><div style={{ width: `${pct}%` }} /></div>
            <small>分片 {got}/{total} · 中断后只续传缺失分片</small>
          </>
        )}
        {rec.error && <small className="error-text">{rec.error}</small>}
      </div>
      {!done && rec.status === 'failed' && (
        <button onClick={() => store.requestSync()}>重试</button>
      )}
    </div>
  );
}

// Completed attachment already on the server: fetch through the authenticated
// proxy (token header) and render it from a local blob URL.
function ServerPhoto({ att }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let u;
    (async () => {
      try {
        const token = await kv.get('token');
        const res = await fetch(`/api/attachments/${att.id}/content`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        u = URL.createObjectURL(blob);
        if (!revoked) setUrl(u);
      } catch {
        setFailed(true);
      }
    })();
    return () => { revoked = true; if (u) URL.revokeObjectURL(u); };
  }, [att.id]);

  return (
    <div className="upload-row">
      {url && !failed ? <img className="thumb" src={url} alt="" /> : <div className="thumb" />}
      <div className="name">
        {att.filename}
        <small>{(att.size / 1024).toFixed(0)} KB · 已上传（服务器）{failed ? ' · 当前离线，暂不可预览' : ''}</small>
      </div>
    </div>
  );
}

export default function PhotoList({ ent, onPhoto, disabled }) {
  const local = ent.uploads || [];
  const remote = ent.server?.attachments || [];
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <strong style={{ flex: 1 }}>照片附件（{remote.length + local.filter((u) => u.status === 'completed').length}）</strong>
        <label className={`button-like ${disabled ? 'disabled' : ''}`}>
          <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
            disabled={disabled}
            onChange={(e) => { onPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          {disabled ? '记录已删除' : '+ 添加照片（可离线暂存）'}
        </label>
      </div>
      {local.map((rec) => <StagedPhoto key={rec.localId} rec={rec} />)}
      {remote.map((att) => <ServerPhoto key={att.id} att={att} />)}
      {local.length === 0 && remote.length === 0 && <div className="muted">暂无附件。照片会先保存在本机，联网后分片续传。</div>}
    </div>
  );
}
