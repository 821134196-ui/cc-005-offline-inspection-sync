# 离线巡检系统（Offline-First Inspection PWA）

现场人员在无网络区域创建巡检记录、修改检查项、添加照片说明，网络恢复后自动同步。

- **前端**：React 18 + Vite PWA（Workbox 预缓存外壳，IndexedDB 持久化数据、操作队列和照片 Blob）
- **后端**：Go 1.22 标准库 `net/http` + pgx + minio-go，JWT 鉴权
- **数据库**：PostgreSQL 16（字段级版本谱系、操作幂等台账、墓碑、冲突表、分片账本）
- **对象存储**：MinIO（S3 兼容的分片/可续传上传）

一条命令启动全部组件：

```bash
docker compose up --build
# 前端: http://localhost:8000
# MinIO 控制台: http://localhost:9001 (minioadmin / minioadmin)
# 后端健康检查: http://localhost:8080/healthz
```

启动时自动建表迁移并写入演示数据。

## 演示账号

| 账号 | 密码 | 说明 |
| --- | --- | --- |
| `alice` | `demo1234` | 2 条分配给她的巡检任务 |
| `bob` | `demo1234` | 1 条任务，用于验证用户间越权隔离 |

## 快速体验验收点

1. 登录 alice，断网（DevTools → Network → Offline），新建记录、勾选检查项、打字、选照片。
2. **刷新页面**：PWA 外壳从 Service Worker 加载，数据从 IndexedDB 恢复，状态显示「待同步」。
3. **彻底关闭浏览器再打开**（同一浏览器 Profile）：登录态、操作队列、未传完的照片都还在。
4. 恢复网络：自动同步，状态变「已同步」；照片只续传缺失分片。
5. 冲突：两台设备（或用 API）改同一字段，后同步一方看到显式冲突面板，二选一或输入新值，服务端绝不自动覆盖。
6. 一台设备删除记录（墓碑），另一台设备的迟到修改会被拒绝，数据不会复活。
7. 用 bob 的任务做越权验证：alice 对 bob 任务的任何同步操作都得到 `forbidden`。

## 同步协议

### 操作模型

每次本地变更立即生成一个 UUID v4 作为稳定 **op_id**，连同载荷写入 IndexedDB 队列；联网后按创建顺序批量 POST 到 `/api/sync`，重试永远复用同一 op_id。

```json
{
  "ops": [
    {
      "op_id": "9b2d…",
      "type": "upsert",
      "inspection_id": "a111…",
      "changes": {
        "title": { "v": "新标题", "base": "旧标题" }
      }
    }
  ]
}
```

- **幂等**：服务端 `processed_ops` 以 op_id 为主键记录终态结果，重复投递原样回放（标记 `duplicate`），版本号不移动。op_id 与用户绑定，跨用户重放返回 `op_id_collision`。
- **三方合并**：每个可编辑字段在 `field_revs` 中保存当前值与最后写入的 op_id。
  - `base == 服务端值`：客户端基于最新状态 → 快进应用（新值与当前相同则 no-op）；
  - `base != 服务端值` 且 `v == 服务端值`：对端已改成相同值 → 自动收敛；
  - `base != 服务端值` 且 `v != 服务端值`：**同字段冲突**，服务端值保持不变，`conflicts` 表产生一条 `open` 记录，必须由人工通过 `resolve_conflict` 操作选定最终值。
  - 不同字段的两端修改互不阻塞，自动合并。
- **删除 = 墓碑**：`is_deleted=true` 软删除。删除幂等；针对已删除行的迟到 upsert 返回 `deleted/inspection_deleted`，旧客户端无法复活数据。
- **归属不可伪造**：请求中的用户身份只取自 JWT；`owner_id` 不是可编辑字段。新建记录的 owner 强制为令牌用户；非本人任务的同步返回 `forbidden`，列表/详情/附件接口同样按 owner 过滤。
- **提交审核闸门**：`status → submitted` 时服务端检查该记录没有未完成附件，否则返回 `attachments_incomplete`（该结果**不**写入幂等台账，附件传完后同一 op 可重新评估）。前端在上传未完成时禁用提交按钮。

### 照片分片续传

- `POST /api/uploads` 在 MinIO 初始化 multipart upload，创建附件元数据；
- 每 6 MiB 一个分片 `PUT /api/uploads/{uploadId}/parts/{n}`（S3 协议要求非末尾分片 ≥5 MiB；小文件单分片）；
- 服务端维护 `upload_parts` 账本并以 MinIO 为权威对账；重传同一分片直接回放 ETag（幂等）；
- `GET /api/uploads/{uploadId}` 返回已收分片，客户端只发送缺失分片，中断/浏览器重启后同样适用（照片 Blob 持久化在 IndexedDB）；
- `POST .../complete` 校验分片 1..N 连续后合并；下载走带鉴权的流式代理 `/api/attachments/{id}/content`。

## 页面状态

每张任务卡片清楚区分四种状态：**已同步**（绿）、**待同步**（黄）、**冲突**（红，列出冲突字段）、**失败**（红，可重试/放弃）；被删除的记录显示「已删除」。顶栏实时显示在线/离线/同步中。

## 目录结构

```
.
├── docker-compose.yml        # postgres + minio + minio-init + backend + frontend(nginx)
├── backend/                  # Go 服务（嵌入迁移，启动即自动 migrate + seed）
│   ├── main.go
│   ├── internal/api/         # HTTP、同步引擎、合并判定、分片上传处理器
│   ├── internal/db/          # 连接/重试、嵌入 SQL 迁移、演示种子
│   ├── internal/auth/        # JWT
│   └── internal/store/       # MinIO 封装（multipart / 对账 / 流式读取）
├── frontend/                 # React PWA
│   └── src/offline/          # IndexedDB、操作队列、三方合并基值计算、同步引擎
└── tests/
    ├── api/acceptance.test.js   # 11 个 API 级验收用例（Node 内置 fetch + test）
    └── e2e/                     # 4 个 Playwright 浏览器用例（离线刷新/重启、冲突、墓碑、续传）
```

## 测试

后端单元测试（合并判定、校验规则）：

```bash
cd backend && go test ./...
```

前端纯逻辑单测（op 投影、基值传递、状态聚合、冲突过滤）：

```bash
cd frontend && npm ci && npm test
```

API 验收测试（需要后端 + Postgres + MinIO 已运行；docker compose 启动后直接跑）：

```bash
BASE_URL=http://localhost:8080 node --test tests/api/acceptance.test.js
```

覆盖：重复投递幂等、乱序操作、不同字段自动合并、同字段显冲突与人工解决、墓碑防复活、分片续传/缺口拒绝合并/字节完整性、提交审核附件闸门、越权同步、无令牌拒绝。

浏览器端到端测试（先构建前端；用自带的零依赖静态服务器代理到后端）：

```bash
cd frontend && npm ci && npm run build
cd ../tests/e2e && npm ci && npx playwright install chromium
PORT=8090 BACKEND_URL=http://localhost:8080 npx playwright test
```

覆盖：断网后刷新、全新浏览器进程重启（持久化 Profile）后队列仍在并自动同步；同字段冲突 UI 与人工选择；服务端墓碑在客户端呈现且禁止复活；13 MiB 照片在第 2 分片中断后仅续传缺失分片并完成。

## 本地开发（不用 Docker）

- Go 后端：`DATABASE_URL=... MINIO_ENDPOINT=... go run .`（监听 :8080，自动迁移与种子）
- 前端：`cd frontend && npm run dev`（:5173，`/api` 代理到本地后端；生产则由 nginx 代理）
