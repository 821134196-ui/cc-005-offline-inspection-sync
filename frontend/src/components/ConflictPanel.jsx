import React, { useState } from 'react';
import { FIELD_ZH } from '../App.jsx';

// Explicit human-in-the-loop conflict UI. Shows the server value and this
// device's value side by side; nothing is sent until the user picks one (or
// types a replacement). The chosen value goes through a resolve_conflict op.
export default function ConflictPanel({ conflict, onChoose }) {
  const [custom, setCustom] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const field = conflict.field;

  const preview = (raw) => {
    if (raw === undefined || raw === null) return '—';
    try {
      const v = JSON.parse(raw);
      if (typeof v === 'string') return v;
      return JSON.stringify(v, null, 2);
    } catch {
      return String(raw);
    }
  };

  const isText = (() => {
    try { return typeof JSON.parse(conflict.server_value) === 'string'; } catch { return false; }
  })();

  return (
    <div className="conflict-box">
      <h4>⚠️ 字段「{FIELD_ZH[field] || field}」存在冲突 — 需要人工选择，系统不会自动覆盖</h4>
      <div className="choice">
        <div className="opt" role="button" tabIndex={0} onClick={() => onChoose(conflict.server_value)}>
          <div className="who">服务器版本（其他设备的修改）</div>
          <pre>{preview(conflict.server_value)}</pre>
        </div>
        <div className="opt" role="button" tabIndex={0} onClick={() => onChoose(conflict.client_value)}>
          <div className="who">本机版本（待同步）</div>
          <pre>{preview(conflict.client_value)}</pre>
        </div>
      </div>
      {isText && (
        <div style={{ marginTop: 10 }}>
          {!showCustom ? (
            <button onClick={() => setShowCustom(true)}>改为输入新内容…</button>
          ) : (
            <div className="row">
              <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="输入最终采用的内容" autoFocus />
              <button className="primary" onClick={() => onChoose(JSON.stringify(custom))}>采用新内容</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
