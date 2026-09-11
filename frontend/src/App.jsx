import React, { useEffect, useState } from 'react';
import { useStore } from './offline/useStore.js';
import { store } from './offline/store.js';
import { totalBadge, localView, entityStatus } from './offline/merge.js';
import StatusBadge from './components/StatusBadge.jsx';
import InspectionView from './components/InspectionView.jsx';

export const FIELD_ZH = {
  title: '标题', status: '审核状态', findings: '检查发现',
  notes: '备注', checked_items: '检查项', photo_caption: '照片说明'
};
export const STATUS_ZH = { draft: '草稿', submitted: '已提交审核', approved: '已通过', rejected: '已驳回' };

export default function App() {
  const { user } = useStore();
  const [openId, setOpenId] = useState(null);

  if (!user) return <Login />;
  if (openId) return <InspectionView id={openId} onBack={() => setOpenId(null)} />;
  return <List onOpen={setOpenId} />;
}

function Login() {
  const [username, setUsername] = useState('alice');
  const [password, setPassword] = useState('demo1234');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await store.login(username.trim(), password);
    } catch (e2) {
      setErr(e2.status === 0 ? '当前离线：登录需要网络，恢复后重试' : e2.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-card">
      <h2>离线巡检系统</h2>
      <p>演示账号：alice / demo1234（另有 bob / demo1234，用于验证越权隔离）</p>
      <form onSubmit={submit}>
        <div className="field">
          <label>用户名</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </div>
        <div className="field">
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {err && <div className="toast-error">{err}</div>}
        <button className="primary" disabled={busy} style={{ width: '100%' }}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}

function List({ onOpen }) {
  const { tick, online, syncing } = useStore();
  const [entities, setEntities] = useState([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    store.list().then((es) => alive && setEntities(es));
    return () => { alive = false; };
  }, [tick]);

  const counts = totalBadge(entities);
  async function create() {
    setCreating(true);
    const id = await store.stageCreate();
    setCreating(false);
    onOpen(id);
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>巡检任务</h1>
        <span className={`badge ${online ? 'net-on' : 'net-off'}`}>
          <span className="dot" />{online ? (syncing ? '同步中' : '在线') : '离线'}
        </span>
        <button onClick={() => store.requestSync()} disabled={!online}>立即同步</button>
        <button onClick={() => store.logout()}>退出</button>
      </div>
      <div className="content">
        <div className="summary">
          <span className="pill">已同步 {counts.synced}</span>
          <span className="pill">待同步 {counts.pending}</span>
          <span className="pill" style={{ color: counts.conflict ? '#fecaca' : undefined }}>冲突 {counts.conflict}</span>
          <span className="pill" style={{ color: counts.failed ? '#fecaca' : undefined }}>失败 {counts.failed}</span>
        </div>
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="primary" onClick={create} disabled={creating}>{creating ? '创建中…' : '+ 新建巡检记录（可离线）'}</button>
        </div>
        <div className="cards">
          {entities.map((ent) => <TaskCard key={ent.id} ent={ent} onOpen={() => onOpen(ent.id)} />)}
          {entities.length === 0 && <div className="muted">暂无任务。断网也可以新建，联网后自动同步。</div>}
        </div>
      </div>
    </div>
  );
}

function TaskCard({ ent, onOpen }) {
  const status = ent.server?.is_deleted ? 'deleted' : entityStatus(ent);
  const view = localView(ent);
  const conflictFields = new Set(
    ent.ops.flatMap((o) => (o.state === 'conflict' ? (o.result?.conflicts || []) : []))
      .map((c) => c.field)
  );
  const uploading = ent.uploads.filter((u) => u.status !== 'completed' && u.status !== 'aborted').length;
  return (
    <div className="card" onClick={onOpen} role="button" tabIndex={0}>
      <div className="row" style={{ alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <h3>{view.title || '未命名巡检'} {ent.server?.is_deleted && <span className="muted">（服务器上已删除）</span>}</h3>
          <div className="meta">
            <span>状态：{STATUS_ZH[view.status] || view.status}</span>
            <span>rev {ent.server?.rev ?? '—'}</span>
            {uploading > 0 && <span style={{ color: '#fde68a' }}>附件上传中 {uploading}</span>}
            {conflictFields.size > 0 && (
              <span style={{ color: '#fca5a5' }}>冲突字段：{[...conflictFields].map((f) => FIELD_ZH[f] || f).join('、')}</span>
            )}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>
    </div>
  );
}
