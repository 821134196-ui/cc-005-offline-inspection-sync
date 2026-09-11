import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../offline/useStore.js';
import { store } from '../offline/store.js';
import { localView, openConflicts, entityStatus } from '../offline/merge.js';
import StatusBadge from './StatusBadge.jsx';
import ConflictPanel from './ConflictPanel.jsx';
import PhotoList from './PhotoList.jsx';
import { FIELD_ZH, STATUS_ZH } from '../App.jsx';

// Uncontrolled input that is keyed (by the parent) on the last known synced
// value, so external changes (conflict resolution, other device) remount it
// while normal typing never loses focus.
function DebouncedField({ field, value, onEdit, multiline, disabled }) {
  const t = useRef(null);
  const common = {
    defaultValue: value ?? '',
    disabled,
    onChange: (e) => {
      clearTimeout(t.current);
      t.current = setTimeout(() => onEdit(field, e.target.value), 600);
    },
    onBlur: (e) => {
      clearTimeout(t.current);
      if (e.target.value !== (value ?? '')) onEdit(field, e.target.value);
    }
  };
  return multiline ? <textarea {...common} /> : <input {...common} />;
}

export default function InspectionView({ id, onBack }) {
  const { tick } = useStore();
  const [ent, setEnt] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [submitErr, setSubmitErr] = useState('');

  useEffect(() => {
    let alive = true;
    store.entity(id).then((e) => alive && setEnt(e));
    return () => { alive = false; };
  }, [tick, id]);

  const view = useMemo(() => (ent ? localView(ent) : null), [ent]);
  if (!ent || !view) return <div className="app"><div className="content">加载中…</div></div>;

  const status = ent.server?.is_deleted ? 'deleted' : entityStatus(ent);
  const conflicts = openConflicts(ent);
  const failedOps = ent.ops.filter((o) => o.state === 'failed');
  const deleted = !!ent.server?.is_deleted;
  const uploadsPending = ent.uploads.some((u) => u.status !== 'completed' && u.status !== 'aborted');

  async function toggleItem(item) {
    const items = (view.checked_items || []).map((it) => (it.id === item.id ? { ...it, ok: !it.ok } : it));
    await store.stageOp(id, 'checked_items', items);
  }
  async function commentItem(item, comment) {
    const items = (view.checked_items || []).map((it) => (it.id === item.id ? { ...it, comment } : it));
    await store.stageOp(id, 'checked_items', items);
  }
  async function addCheck() {
    const label = prompt('检查项名称？');
    if (!label) return;
    const items = [...(view.checked_items || []), { id: crypto.randomUUID(), label, ok: false, comment: '' }];
    await store.stageOp(id, 'checked_items', items);
  }
  async function changeStatus(s) {
    if (s === 'submitted' && uploadsPending) {
      // Client-side gate; the server enforces the same rule authoritatively.
      setSubmitErr('附件尚未全部上传完成，不能提交审核。请等待上传或联网后续传。');
      return;
    }
    setSubmitErr('');
    await store.stageOp(id, 'status', s);
  }
  async function onPhoto(file) {
    if (file) await store.stagePhoto(id, file, view.photo_caption || '');
  }
  async function remove() {
    await store.stageDelete(id);
    onBack();
  }

  // Key text fields on the *server* value: a conflict resolution or another
  // device remounts them with fresh content, while local queued edits leave the
  // key (and focus) untouched.
  const skey = (f) => (deleted ? 'del:' : '') + f + '=' + (ent.server?.[f] ?? '__local__');

  return (
    <div className="app">
      <div className="topbar">
        <button className="back" onClick={onBack}>← 返回</button>
        <h1 style={{ fontSize: 15 }}>{view.title || '未命名巡检'}</h1>
        <button onClick={() => store.requestSync()} title="立即同步">⟳</button>
        <StatusBadge status={status} />
      </div>
      <div className="content">
        {deleted && (
          <div className="toast-error">
            该记录已在服务器上被删除（墓碑）。本地的迟到修改不会同步，也不会让数据复活。
            <button className="danger" style={{ marginLeft: 10 }} onClick={() => store.discardOps(id).then(onBack)}>
              放弃本地修改
            </button>
          </div>
        )}
        {conflicts.map((c) => (
          <ConflictPanel key={c.id || c.field} conflict={c} inspectionId={id}
            onChoose={(v) => store.resolveConflict(id, c.field, v)} />
        ))}
        {failedOps.map((o) => (
          <div key={o.op_id} className="toast-error">
            操作 {o.op_id.slice(0, 8)} 失败：{o.result?.message || o.result?.error || o.last_status}
            {o.retryable && <button style={{ marginLeft: 10 }} onClick={() => store.requestSync()}>重试</button>}
            <button style={{ marginLeft: 8 }} onClick={() => store.discardOps(id)}>放弃</button>
          </div>
        ))}
        {submitErr && <div className="toast-error">{submitErr}</div>}

        <div className="card">
          <div className="field">
            <label>{FIELD_ZH.title}</label>
            <DebouncedField key={skey('title')} field="title" value={view.title}
              onEdit={(f, v) => store.stageOp(id, f, v)} disabled={deleted} />
          </div>
          <div className="field">
            <label>{FIELD_ZH.status}</label>
            <div className="row">
              <select value={view.status} disabled={deleted} onChange={(e) => changeStatus(e.target.value)}>
                {Object.entries(STATUS_ZH).map(([k, zh]) => <option key={k} value={k}>{zh}</option>)}
              </select>
              <button className="primary" disabled={deleted || uploadsPending}
                title={uploadsPending ? '附件未完成' : ''}
                onClick={() => changeStatus('submitted')}>
                提交审核{uploadsPending ? '（附件未完成）' : ''}
              </button>
            </div>
          </div>
          <div className="field">
            <label>{FIELD_ZH.findings}</label>
            <DebouncedField key={skey('findings')} field="findings" value={view.findings} multiline
              onEdit={(f, v) => store.stageOp(id, f, v)} disabled={deleted} />
          </div>
          <div className="field">
            <label>{FIELD_ZH.notes}</label>
            <DebouncedField key={skey('notes')} field="notes" value={view.notes} multiline
              onEdit={(f, v) => store.stageOp(id, f, v)} disabled={deleted} />
          </div>
          <div className="field">
            <label>{FIELD_ZH.photo_caption}</label>
            <DebouncedField key={skey('photo_caption')} field="photo_caption" value={view.photo_caption}
              onEdit={(f, v) => store.stageOp(id, f, v)} disabled={deleted} />
          </div>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <strong style={{ flex: 1 }}>
              检查项（{view.checked_items?.filter((i) => i.ok).length || 0}/{view.checked_items?.length || 0} 合格）
            </strong>
            <button onClick={addCheck} disabled={deleted}>+ 添加检查项</button>
          </div>
          {(view.checked_items || []).map((item) => (
            <div className="check-item" key={item.id}>
              <input type="checkbox" checked={!!item.ok} disabled={deleted} onChange={() => toggleItem(item)} />
              <div className="body">
                <div>{item.label}</div>
                <input type="text" placeholder="问题说明（可选）" defaultValue={item.comment} disabled={deleted}
                  onBlur={(e) => { if (e.target.value !== item.comment) commentItem(item, e.target.value); }} />
              </div>
            </div>
          ))}
          {(!view.checked_items || view.checked_items.length === 0) && <div className="muted">暂无检查项</div>}
        </div>

        <PhotoList ent={ent} onPhoto={onPhoto} disabled={deleted} />

        <div className="card">
          <div className="row">
            <div className="muted" style={{ flex: 1 }}>
              删除采用墓碑：其他设备会收到删除事件，旧设备重新上线也无法复活该记录。
            </div>
            {!confirmDelete
              ? <button className="danger" disabled={deleted} onClick={() => setConfirmDelete(true)}>删除记录</button>
              : (
                <>
                  <button className="danger" onClick={remove}>确认删除</button>
                  <button onClick={() => setConfirmDelete(false)}>取消</button>
                </>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}
