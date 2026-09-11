import React from 'react';

const LABELS = {
  synced: '已同步',
  pending: '待同步',
  conflict: '冲突',
  failed: '失败',
  deleted: '已删除'
};

export default function StatusBadge({ status }) {
  return (
    <span className={`badge ${status}`}>
      <span className="dot" />
      {LABELS[status] || status}
    </span>
  );
}
