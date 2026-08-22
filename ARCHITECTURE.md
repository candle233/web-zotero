# Web Zotero — 技术架构与开发蓝图

Web Zotero 是本地 Zotero 文献库的远程网页伴侣系统：在电脑与手机浏览器中随时查看论文、全文检索、阅读 PDF、记录笔记、导出引文，并内置 AI 辅助阅读。本文档给出完整的技术栈选型、前后端解耦架构、数据流拓扑、API 路由规范与敏捷路线图，并说明当前仓库的实现状态与目标架构的映射关系。

---

## 1. 推荐技术栈选型与理由

| 模块 | 推荐选型 | 关键考量 | 当前仓库状态 |
| --- | --- | --- | --- |
| 前端框架 | Next.js (React) + TypeScript + Tailwind CSS + Radix UI | 现代化 UI、强类型、SSR/SSG 性能、Radix 提供无障碍组件原语 | 当前为零构建 vanilla JS + PWA（`public/`），PDF 批注组件已按 React + TS 实现（`src/pdf/`），可通过 esbuild 产物渐进接入 |
| PDF 引擎 | PDF.js + 自定义 Canvas/TextLayer + 归一化批注覆盖层 | 性能稳定，坐标映射完全可控，批注样式可定制 | `src/pdf/PdfAnnotationViewer.tsx` 已实现（pdfjs-dist） |
| 富文本笔记 | TipTap / Lexical | 块级编辑、双向链接文献与批注引用 | TipTap 已接入（R7）：`/notes` 富文本编辑页（`src/notes/notes-entry.tsx`），服务端白名单净化（`src/notes-html.js`）+ `web_notes.content_html` 列；双向链接/批注引用待 R9 |
| 元数据与引文 | citeproc-js + CSL 样式生态（Citation.js 可选） | 兼容 Zotero 庞大的 CSL 样式库；DOI 内容协商直接获取 CSL-JSON | `src/metadata.js`（DOI/arXiv/BibTeX/ISBN 解析 + CSL-JSON 双向转换）与 `src/citation-service.js`（citeproc-js，apa/ieee/nature/gb-t-7714-2015 × en-US/zh-CN，含降级格式化器） |
| 后端 | Node.js（原生 `node:http`，演进至 Next.js API Routes / Fastify） | 零依赖、单进程、SQLite 直读本地 Zotero 库；规模扩大后按模块拆分 | `src/server.js` |
| 数据库 | PostgreSQL + Prisma/Drizzle（生产）；SQLite（单机只读伴侣） | 强事务、JSONB、内置 FTS（tsvector/GIN）与 pgvector 语义检索 | 目标 Schema 见 `db/schema.sql`；当前直读 Zotero SQLite + 自建 FTS 索引（`src/search.js`） |
| 对象存储 | S3 / MinIO / Cloudflare R2，预签名 URL 直传 | 低成本保存 PDF 附件，浏览器直传直读，减轻应用服务器带宽 | 当前直接流式托管本地 PDF（Range 请求支持），迁移路径见 §6 |

> 选型总原则：**单人远程访问场景优先零依赖部署（当前实现）**；**多用户/团队协作场景按本蓝图演进（db/schema.sql + 对象存储 + Next.js）**。两套形态共享同一套 API 契约（§4）与前端组件。

---

## 2. 系统架构图与数据流拓扑

### 2.1 前后端解耦架构

```
┌───────────────────────────── 客户端（电脑 / 手机浏览器, PWA） ─────────────────────────────┐
│  UI 层    库浏览(app.js) │ PDF 阅读器+批注(PdfAnnotationViewer.tsx) │ AI 面板 │ 离线缓存(sw.js) │
│  逻辑层   纯函数坐标变换(coordinates.ts) │ 状态(zustand*) │ 引文预览                                  │
└──────────────────────────────────────────┬───────────────────────────────────────────────┘
                          REST/JSON（Bearer token） │ PDF Range 流
┌──────────────────────────────────────────▼───────────────────────────────────────────────┐
│                                   应用服务层 (Node.js)                                     │
│  ┌────────────┐ ┌────────────┐ ┌──────────────┐ ┌───────────────┐ ┌────────────────────┐ │
│  │ 文库服务    │ │ 检索服务    │ │ 元数据/引文服务 │ │ AI 阅读服务    │ │ 健康/离线服务       │ │
│  │ zotero-db  │ │ search.js  │ │ metadata.js  │ │ local-ai.js   │ │ health/offline.js  │ │
│  │            │ │ (FTS 索引) │ │ citation-    │ │ (OpenAI 优先, │ │                    │ │
│  │            │ │            │ │ service.js   │ │  本地降级)     │ │                    │ │
│  └─────┬──────┘ └─────┬──────┘ └──────┬───────┘ └───────┬───────┘ └────────────────────┘ │
│        │              │               │                 │                                  │
│  ┌─────▼──────────────▼───────────────▼─────────────────▼──────────────────────────────┐ │
│  │ 数据访问层: Zotero SQLite(只读) │ web-data.sqlite(笔记/进度) │ 文件系统(存储桶或 S3)  │ │
│  └─────────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
外部依赖: https://doi.org (CSL-JSON 内容协商) → Crossref 回退 │ arXiv Atom API │ OpenLibrary(ISBN) │ OpenAI API
```

### 2.2 数据流拓扑

1. **读取流**：浏览器 → `GET /api/items` → Zotero SQLite（只读镜像查询）→ JSON 列表 → 客户端虚拟列表；PDF 经 `GET /api/items/:key/files/:attach`（支持 HTTP Range）流式传输给 PDF.js。
2. **批注流**：TextLayer 文本选区 → `coordinates.ts` 将 CSS 像素选区框反演为 PDF 用户空间、再按 `viewport.viewBox` 归一化为 `[x,y,w,h]∈[0,1]⁴` → `POST /api/items/:key/annotations`（目标架构写入 PostgreSQL `annotations` 表）→ 任何缩放/旋转下 `normalizedToViewportRect` 无损重映射渲染。
3. **元数据摄取流**：用户输入 DOI/arXiv/BibTeX/ISBN → `detectIdentifier` 分类 → DOI 走 `https://doi.org/{doi}`（`Accept: application/vnd.citationstyles.csl+json`）失败回退 Crossref；arXiv 解析 Atom XML；BibTeX 本地解析 → 统一为 CSL-JSON → `cslJsonToItem` 映射为内部 Item → 落库。
4. **引文流**：内部 Item → `itemToCslJson` → citeproc-js（CSL 样式 + locale）→ Bibliography HTML / in-text citation → 前端实时预览、导出。
5. **AI 流**：`POST /api/ai/summarize` → 读取 Zotero 全文缓存（`.zotero-ft-cache`）→ 有 `OPENAI_API_KEY` 走大模型，失败或未配置时降级为本地抽取式摘要（关键词 + 关键句），永不 5xx 阻塞用户。
6. **索引流**：启动/手动触发 `POST /api/index/rebuild` → 提取 PDF 全文 → 写入 FTS 索引 → `GET /api/search?q=` 命中元数据与全文。

---

## 3. 核心模块划分

| 模块 | 目录/文件 | 职责 |
| --- | --- | --- |
| 库与条目 | `src/zotero-db.js` | 只读查询 Zotero SQLite：条目、作者、分类树、附件、批注 |
| 全文检索 | `src/search.js` | SQLite FTS5 索引与查询（目标架构为 PG tsvector/GIN） |
| 元数据摄取 | `src/metadata.js` | 标识符识别、DOI/arXiv/BibTeX/ISBN 解析、CSL-JSON ↔ 内部模型双向转换 |
| 引文引擎 | `src/citation-service.js` | citeproc-js 集成、样式/语言加载、批量 Bibliography 与 in-text 输出、降级格式化 |
| PDF 批注 | `src/pdf/` | 坐标归一化数学（`coordinates.ts`）、批注覆盖层（`AnnotationLayer.tsx`）、阅读器容器（`PdfAnnotationViewer.tsx`） |
| AI 阅读 | `src/local-ai.js` | OpenAI 摘要 + 本地抽取式降级 |
| 笔记与进度 | `src/web-store.js` | Web 端笔记、阅读进度持久化 |
| 导出 | `src/citation.js`、`src/annotation-export.js` | BibTeX/CSV/JSON 导出；批注 Markdown/CSV 导出 |
| 运维 | `src/health.js`、`src/offline.js` | 健康监控、离线副本管理 |

---

## 4. API 路由规范（RESTful）

约定：JSON 载荷；`WEB_PASSWORD` 启用时除 `/api/auth` 外均需 `Authorization: Bearer <token>`；错误统一 `{ "error": string }` + 语义状态码（400 参数 / 401 认证 / 404 不存在 / 409 冲突 / 413 过大 / 422 不可解析 / 503 上游不可用）。

### 已实现
| 方法 | 路由 | 说明 |
| --- | --- | --- |
| GET | `/api/items?q=&collection=` | 条目列表，标题/作者过滤与分类过滤 |
| GET | `/api/items/:key/detail` | 条目详情（元数据、分类、附件、桌面笔记） |
| GET | `/api/items/:key/export.{json,csv,bib,txt}` | 导出 JSON/CSV/BibTeX/APA 文本 |
| GET | `/api/items/:key/files/:attachmentKey` | PDF 字节流（Range 支持） |
| GET | `/api/items/:key/files/:attachmentKey/text` | 提取文本缓存 |
| GET/POST | `/api/items/:key/notes` | Web 笔记读写 |
| GET | `/api/items/:key/desktop-notes` | 桌面端笔记 |
| GET | `/api/items/:key/annotations?format=md|csv` | Zotero 桌面批注导出 |
| GET | `/api/items/:key/related` | 相关文献推荐 |
| POST | `/api/items/:key/files/:attachmentKey/offline` | 保存离线副本 |
| GET/POST | `/api/items/:key/progress` | 阅读进度 |
| GET | `/api/collections` | 分类树 |
| GET | `/api/search?q=&limit=` | 全文检索 |
| POST | `/api/index/rebuild?force=1` | 重建索引 |
| POST | `/api/ai/summarize` `{itemKey}` | AI 摘要（provider: openai/local） |
| GET | `/api/plugins` | 桌面插件兼容清单 |
| POST | `/api/auth` `{password}` | 认证 |
| GET | `/api/health` | 健康状态 |

### 本轮新增
| 方法 | 路由 | 请求 → 响应 |
| --- | --- | --- |
| POST | `/api/metadata/resolve` | `{input: "10.1145/…\|arXiv:2401.…\|@article{…}\|ISBN"}` → `{source, identifierType, item, csl}`；识别失败 400，上游失败 502 |
| GET | `/api/citations/styles` | `{styles: [{id, title, locales}], locales}` |
| POST | `/api/citations/format` | `{items: InternalItem[]\|CSL-JSON[], style: "apa"\|"ieee"\|"nature"\|"gb-t-7714-2015", lang: "en-US"\|"zh-CN", mode: "bibliography"\|"in-text"}` → `{engine, style, lang, entries: [{id, html}]}` |

### R7 新增（本地多用户协作形态，零依赖 SQLite）
| 方法 | 路由 | 请求 → 响应 / 说明 |
| --- | --- | --- |
| POST | `/api/auth` | 多用户：`{email, password}` → `{token, user}`（30 天有效，SHA-256 哈希存储）；单密码模式：`{password}` → `{ok, token}` |
| GET | `/api/me` | 当前主体：`{mode: "users"\|"legacy"\|"open", user: {email, displayName, role}\|null}` |
| GET/POST | `/api/users` | owner 专用：列出 / 创建账户（scrypt 密码，首账户强制 owner） |
| PATCH/DELETE | `/api/users/:id` | owner 专用：改角色/密码（末位 owner 保护 409）、软删除（吊销会话） |
| GET | `/api/annotations?itemKey=&attachmentKey=` | Web 批注列表（含作者邮箱，按页码排序） |
| POST | `/api/annotations` | `{itemKey, attachmentKey, pageIndex, rects, color?, comment?, quote?}` → 归一化坐标校验/夹取后落库，作者=当前用户 |
| PATCH/DELETE | `/api/annotations/:id` | 作者或 owner 可改颜色/备注、可删除；他人 403 |
| GET/POST | `/api/items/:key/notes` | POST 新增 `{html}` 富文本载荷：服务端白名单净化（`src/notes-html.js`）后存 `content_html`，同时维护纯文本列 |
| GET | `/api/search?q=&mode=lexical\|semantic\|hybrid&limit=` | R8a：混合检索（FTS bm25 + LSA 余弦，归一化后 0.45/0.55 加权），语义索引未就绪时回退 lexical；响应含 `semantic` 状态 |
| POST | `/api/ai/ask` `{itemKey?, question}` | R8a：RAG 问答 → `{provider, question, answer, passages[]}`；LSA+词面混合检索 top-4 段落，OpenAI 可用时生成式作答（带 [n] 引用），否则本地抽取式句子排序作答 |
| GET | `/api/events` | R9a：SSE 实时事件流（`text/event-stream`，25s 心跳，`?token=` 鉴权）——批注 created/updated/deleted 事件带完整载荷与操作者邮箱，广播至所有已连接页面；服务关闭时统一销毁连接 |
| GET | `/api/items/:key/mentions` | R9a：笔记反链——扫描全部 Web 笔记中 `[[该条目标题]]` 的出现，返回来源条目与时间 |

角色门禁：`owner > editor > viewer`；viewer 仅读（含只读 POST：metadata/resolve、citations/format、ai/summarize），写操作 403；用户管理仅 owner。

### 目标架构追加（团队版，见 db/schema.sql）
`/api/workspaces`、`/api/workspaces/:id/members`、`/api/attachments/:id/upload-url`（预签名直传）、`/api/annotations`（POST 归一化坐标批注 `rects_json`）、`/api/items/batch-import`（BibTeX/RIS 批量）。

---

## 5. 阶段性敏捷路线图

| 阶段 | 主题 | 交付 | 状态 |
| --- | --- | --- | --- |
| R1 MVP | 远程访问 | 认证、条目/分类浏览、PDF 流式阅读、Web 笔记、代码审查 + 提交 | ✅ |
| R2 | 引文与桌面数据 | BibTeX/CSV/JSON 导出、桌面笔记读取 | ✅ |
| R3 | 可观测性 | `/api/health`、索引时间戳 | ✅ |
| R4 | 批注 | 桌面批注浏览与 Markdown/CSV 导出 | ✅ |
| R5 | 智能 | 相关文献推荐、AI 摘要（OpenAI + 本地降级）、离线副本/PWA | ✅ |
| R6 | 规格化交付（本轮） | 架构蓝图、PostgreSQL Schema、PDF.js 归一化批注组件、DOI/arXiv/BibTeX 元数据管线 + citeproc-js 引文服务 | ✅ |
| R7a 协作基础（本轮） | 多用户 + 富文本 + 批注持久化（零依赖 SQLite 形态） | users/sessions/角色（scrypt + 令牌哈希）、`/api/users` 管理、TipTap 富文本笔记（`/notes` + 服务端净化）、`/api/annotations` 归一化批注持久化（作者/权限）、批注器同步服务端、CLI `npm run add-user` | ✅ |
| R7b 协作版基础设施 | 按 `db/schema.sql` 迁移 PG + Prisma、S3/MinIO 预签名直传、多用户工作区隔离（workspace_members） | 计划 |
| R8a 语义检索（本轮） | 零依赖本地形态 | `src/semantic.js`：中英文分词（拉丁词 + CJK 二元组）→ 分块 TF-IDF → 子空间迭代截断 SVD（k=64，确定性种子）→ 语义空间持久化 `data/semantic-index.sqlite`；`/api/search?mode=lexical\|semantic\|hybrid`（bm25 × LSA 余弦归一化混合）、related 升级为混合排序、`POST /api/ai/ask` RAG 问答（LSA+词面混合检索 → OpenAI 生成 / 本地抽取式降级）；随 `/api/index/rebuild` 自动重建 | ✅ |
| R7c 元数据/引文 UI（本轮） | 管线接入界面 | 侧栏「按标识符查询」面板（DOI/arXiv/ISBN/BibTeX → 元数据卡片 + 来源徽标 + 摘要，多条目 BibTeX 批量解析）；共享 CSL 引文预览组件（样式 apa/ieee/nature/gb-t-7714-2015 × 语言 en-US/zh-CN × bibliography/in-text 切换、citeproc HTML 悬挂缩进渲染、一键复制、降级警告）；条目详情内嵌同一引文面板；doi.org JATS 摘要标记清理 | ✅ |
| R8b 语义检索 | pgvector 嵌入、语义相关文献、AI 问答（RAG over 全文） | 依赖 R7b 的 PG 基础设施；嵌入模型 + HNSW 索引替代本地 LSA | 计划 |
| R9a 实时协作基础（本轮） | SSE 实时批注同步 + 笔记双向链接 | `/api/events` SSE 事件总线（`src/events.js`，零依赖 node:http 长连接 + 心跳 + 关闭清理）；批注器 EventSource 订阅远端变更（serverId 回显去重、断线自动重连）；TipTap `[[文献]]` 插入面板 + 条目详情 wiki 链接渲染 + `/mentions` 反链面板；批注器/笔记编辑器移动端适配 | ✅ |
| R9b 实时协作深化 | CRDT 笔记、移动端手势批注优化、笔记并发编辑合并 | 计划 |

---

## 6. 存储演进说明

- 当前：PDF 直接从 Zotero `storage/` 目录流式读取（支持 Range），Web 数据（笔记/进度/离线清单）存 `data/web-data.sqlite`。
- 目标：附件写入 S3/MinIO（`attachments.file_key` 即对象键），上传走预签名 URL 直传，读取走预签名 GET 或 CDN；`md5_hash` 用于秒传去重，`file_size` 配额管理。
- 迁移脚本策略：对 Zotero storage 逐附件计算 MD5 → PUT 对象 → 写 `attachments` 行 → 保留本地文件直至校验完成。

## 7. 安全基线

- 认证三形态（R7）：`users`（每人账户：scrypt 密码哈希 + 30 天 Bearer 会话令牌，库中只存令牌 SHA-256）、`legacy`（共享 `WEB_PASSWORD`，owner 权限）、`open`（未配置凭据，仅限可信网络）；角色门禁 owner/editor/viewer，末位 owner 删除/降级保护。
- 富文本笔记服务端白名单净化（`src/notes-html.js`）：危险元素整块移除、未知标签解包、除校验后的 `<a href>` 外属性全清，前端渲染仍按文本处理。
- 静态文件路径穿越防护（`serveFile` 前缀校验）、`X-Content-Type-Options: nosniff`、JSON 端点 `Cache-Control: no-store`。
- 对外上游调用（doi.org/Crossref/arXiv/OpenLibrary/OpenAI）均设超时与错误包裹，失败降级、不阻塞主流程。
