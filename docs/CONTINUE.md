# Web Zotero — 继续开发提示词

> 用途：把本文件内容作为新会话的提示词，按清单逐个实现剩余功能。
> 每完成一项：实现 → `npm test` 全过 → 真实服务实测 → 独立 commit + push。

---

## 项目背景（必读）

- **路径**：`C:\Users\Mechrevo\Desktop\codeback\zotero-main\web-zotero`（独立 git 仓库，远程 `https://github.com/candle233/web-zotero.git`，分支 master）
- **定位**：本地 Zotero 7 文献库的只读 Web 伴侣（Node ≥22.5，零框架，内置 `node:sqlite`；React+esbuild 仅用于 PDF 标注器和 TipTap 笔记两个 bundle）
- **架构文档**：`ARCHITECTURE.md`（含路线图 R1–R9b）、`README.md`、`db/schema.sql`
- **核心约定**：
  - Zotero 数据库**永远只读**；web 层数据在 SQLite（`data/web-data.sqlite`）或 PostgreSQL（`DATABASE_URL` 设置时）
  - 存储类：`src/users.js`（SQLite 用户）、`src/users-pg.js`（PG 用户，已实现）、`src/web-store.js`、`src/annotations-store.js`
  - 服务器单文件 `src/server.js`；前端 `public/app.js`（原生 JS）+ `src/pdf/`、`src/notes/`（React，需 `npm run build:annotator` / `build:notes`）
  - 测试：`npm test`（Node 内置 test runner + tsc 类型检查，当前 82 个全过）
  - UI 默认中文，有 `I18N` 字典（`public/app.js` 顶部），新界面字符串双语都要加
- **环境事实**：
  - PostgreSQL 18 已装（`C:/Program Files/PostgreSQL/18/`，库 `web_zotero` 已建，21 张表就绪；密码用户提供，**不要写进任何提交的文件**）
  - Pix2Text 公式识别引擎装在 `C:/Users/Mechrevo/pix2text-env`，启动：`C:/Users/Mechrevo/pix2text-env/Scripts/p2t.exe serve -l en,ch_sim -H 127.0.0.1 -p 8503`
  - 国内网络下 HuggingFace 不通，模型手动下载自 `hf-mirror.com`（已缓存到 `%APPDATA%/cnocr|cnstd|pix2text`）
  - Git Bash 环境；后台起服务用工具的 run_in_background；改完 server.js 要重启才生效

---

## 待实现功能清单（按优先级顺序，逐个做）

### 5. R9b 完整版：真 CRDT 协同编辑
- 现状：乐观锁 + 版本历史（`note_versions` 表）已上线
- 引入 Yjs + y-websocket（或基于现有 SSE 的 y-sweet 风格 awareness），笔记多人光标/实时合并
- 这是最大的单项，先做技术验证 spike 再全量

---

## 每项完成后的固定流程
1. `npm test` 全过 + `npx tsc -p tsconfig.json --noEmit`（改了 TS 时）
2. 真实服务实测（curl 或 Playwright 浏览器），不要只信单测
3. `git add -A && git commit`（信息用英文祈使句，说清 what+why）→ `git push origin master`
4. 更新本文件：把完成项移到下方"已完成"并写提交号

## 已完成（截至 2026-08-26）
- **R1–R9a 全部**：基础检索、PDF 阅读器、TipTap 笔记、标注系统、引用格式化、多用户体系（commit `2db20d9` 前完成）。
- **R7b 阶段二：Web 层存储全面迁移 PostgreSQL**（commit `433fa91`）：
  - 实现 `src/web-store-pg.js`（`PgWebStore`）与 `src/annotations-store-pg.js`（`PgWebAnnotationStore`），全面支持 `web_notes`（行级悲观锁+乐观锁并发冲突 409 检测+版本归档）、`reading_progress_web`、`formula_history`、`ai_summaries`、`web_items`、`web_annotations`。
  - `src/server.js` 与 `src/health.js` 全异步化支持双存储切换；新增 `tests/pg-stores.test.js`。
- **R7b 阶段三：工作区 API 与团队权限**（commit `caddf97`）：
  - 实现 `src/workspaces-pg.js`（`PgWorkspaceStore`），支持多工作区创建/重命名/删除与成员角色 RBAC（owner/editor/viewer）。
  - 实现 `GET/POST /api/workspaces`、`GET/PATCH/DELETE /api/workspaces/:id`、`GET/POST /api/workspaces/:id/members`、`PATCH/DELETE /api/workspaces/:id/members/:userId`。
  - 新增 `tests/workspaces.test.js` 与全流程实测。
- **S3 / MinIO 预签名直传**（commit `14458e1`）：
  - 实现零依赖 AWS SigV4 预签名上传引擎 `src/s3-storage.js`，支持 MinIO、AWS S3、Cloudflare R2。
  - 实现 `POST /api/attachments/upload-url` 与 `POST /api/items/:key/attachments/upload-url`。
  - 新增 `tests/s3-storage.test.js`。
- **R8b：PostgreSQL & pgvector 生产级语义检索**（commit `73ca959`）：
  - 实现 `src/semantic-pg.js`（`PgSemanticIndex`），支持 pgvector `vector(dim)` 列 + HNSW 索引（`vector_cosine_ops`）+ `<=>` 相似度搜索；无扩展时无缝降级 JSON 数组余弦计算。
  - 支持 OpenAI / Ollama `/v1/embeddings` API 以及内置局部 TF-IDF 哈希向量；`src/ask.js` 与 `src/server.js` 混合检索（hybridSearch/hybridRelated）全异步适配。
  - 新增 `tests/semantic-pg.test.js`。
- **小项优化包**（commit `189449b`）：
  - `users.js` 与 `users-pg.js` 升级异步 `crypto.scrypt`（`hashPasswordAsync` / `verifyPasswordAsync`），消除密码验证阻塞。
  - 每用户会话上限 `MAX_SESSIONS_PER_USER = 10`，超出自动回收最旧会话。
  - 批量导出 `GET /api/export/notes.md` 与 `GET /api/export/notes.json`（支持 collection/tag 筛选与 Markdown 格式打包）。
  - `WebStore` 与 `PgWebStore` 实现 `listAllNotes()`；增强 `src/notes-html.js` 防注入白名单；新增 `tests/optimizations.test.js`。

