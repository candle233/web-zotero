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

### 1. R7b 阶段二：web 层存储迁移 PostgreSQL
- 实现 `src/web-store-pg.js`（PgWebStore）和 `src/annotations-store.js` 的 PG 版，API 与 SQLite 版一致（全部 async，调用点加 await 即兼容两者）
- 表已建好：`web_notes`（含 version 列）、`note_versions`、`web_items`、`reading_progress_web`、`formula_history`、`ai_summaries`
- **设计决策点**：PG 版标注存储——蓝图 `annotations` 表用 attachment_id/item_id 外键挂 items 表，但 items 表没数据；建议新增 `web_annotations_pg`（item_key/attachment_key 结构，与 SQLite 版同构），蓝图表留给团队版
- 验收：`DATABASE_URL=postgresql://postgres:<密码>@127.0.0.1:5432/web_zotero` 启动 → 高亮标注/笔记保存（含版本冲突）/阅读进度/公式历史/摘要缓存全部落 PG（psql 查表确认）；不设 DATABASE_URL 时 82 测试全过

### 2. R7b 阶段三：工作区 API
- `GET/POST /api/workspaces`、`GET/PATCH/DELETE /api/workspaces/:id/members`（表已建：workspaces、workspace_members）
- owner 可建工作区、拉成员、设角色；PG 模式下生效
- 验收：curl 走完建区→加成员→改角色→删成员全流程，psql 确认

### 3. S3/MinIO 预签名直传（需先部署 MinIO）
- 端点：`POST /api/attachments/:id/upload-url` 返回预签名 PUT URL
- 零依赖优先：手写 AWS SigV4（Node crypto 可实现），或引入 `@aws-sdk/client-s3`+`s3-request-presigner`（这是第一个合理的重依赖，权衡后决定）
- 验收：curl 拿 URL → 直传文件 → HEAD 确认

### 4. R8b：pgvector 生产级语义检索
- `CREATE EXTENSION vector`（schema.sql 已留注释位）；items/chunks 嵌入向量列 + HNSW 索引
- 嵌入模型三选一：a) 本地 ONNX（bge-small-zh，~100MB）；b) 复用 Pix2Text 的 transformers 环境；c) OpenAI/Ollama embedding API。先调研再定
- 替换 `src/semantic.js` 的本地 LSA 为 PG 向量检索（保留 LSA 作为无 PG 时的回退）
- 验收：语义搜索结果质量对比 LSA（同一组中文查询），检索走 `ORDER BY embedding <=> $1 LIMIT n`

### 5. R9b 完整版：真 CRDT 协同编辑
- 现状：乐观锁 + 版本历史（`note_versions` 表）已上线
- 引入 Yjs + y-websocket（或基于现有 SSE 的 y-sweet 风格 awareness），笔记多人光标/实时合并
- 这是最大的单项，先做技术验证 spike 再全量

### 6. 小项打包（一轮做完）
- `users.js` 的 `scryptSync` → 异步 `crypto.scrypt`（消除登录时 ~100ms 事件循环阻塞）
- 每用户会话数上限（如 10，超出收回最旧的）
- `src/notes-html.js` 的手写 sanitizer → `isomorphic-dompurify`（PG 模式下已可接受依赖）
- 多笔记支持：web_notes 主键改 (item_key, note_id)，UI 列表化（数据迁移：现有单笔记升级为 note_id=1）
- 批量导出：`GET /api/export/notes.md`（全部 web 笔记按条目打包）、合集级 BibTeX 合并导出
- Zotero 运行检测：SQLITE_BUSY 连续出现时 `/api/health` 返回提示"桌面端正在同步"
- EPUB 附件在线阅读（PDF.js 支持 EPUB 需换 epub.js，评估工作量）

---

## 每项完成后的固定流程
1. `npm test` 全过 + `npx tsc -p tsconfig.json --noEmit`（改了 TS 时）
2. 真实服务实测（curl 或 Playwright 浏览器），不要只信单测
3. `git add -A && git commit`（信息用英文祈使句，说清 what+why）→ `git push origin master`
4. 更新本文件：把完成项移到下方"已完成"并写提交号

## 已完成（截至 2026-08-25，提交 2db20d9）
R1–R9a 全部；R9b-lite（笔记乐观锁+版本历史+移动手势）；R7b 阶段一（PG 建库+21 表+PgUserStore+DATABASE_URL 切换）；
安全加固（登录限流/CSP/XSS 修复/恒时比较/127.0.0.1 默认绑定）；SSE 断线补发；Cookie 认证；
公式识别（Pix2Text 代理+历史）；批量导入/标签/排序/搜索直达页码/阅读统计/摘要缓存/中英文+主题/Ollama baseUrl；登录表单+键盘导航；LSA worker 线程化；健康检查+请求日志；账号自助管理。
