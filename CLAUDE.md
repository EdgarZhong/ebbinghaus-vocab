# Ebbinghaus V2 项目总览与当前阶段看板

> 本文件保留 V2 全局交付范围、完整阶段计划、全阶段任务看板、跨阶段决策，以及当前阶段的详细执行信息。稳定项目事实见 `README.md`，通用协作规则见 `AGENTS.md`，技术选型唯一真理源是 `docs/V2迁移技术决策.md`，产品与算法语义以 `docs/需求规格.md` 和 `docs/复习调度算法.md` 为准，界面体验以 `docs/界面设计规格.md` 第 1 章划定的 v2 约束力范围为准。

## 项目使命与 V1 关系

- V2 是一次**全量技术栈迁移重构**：Python/PySide6 桌面应用 → React + TypeScript + Tauri 2（macOS 与 Android）+ Node 同步服务器 + 云端权威数据。不是渐进修补，新实现不承担历史技术债。
- 首要开发目标：**先实现云端数据托管和同步，让真实软件尽快可以使用云端权威数据**；新 UI 全面迁移排在同步链路稳定之后。
- 第一阶段不解决：本地独立模式、DataSpace、多服务器数据隔离、Cloud → Local fork、复杂账号系统。
- V1 仓库（`/Users/edgar/code/Ebbinghaus`）保持正式使用与只读参考：行为规格 = 其 387 项自动化测试与三份规格文档；数据迁移来源 = 其正式 SQLite；V1 自身继续只修阻塞性缺陷。

## 完整阶段计划

| 阶段 | 状态 | 交付内容 | 质量门 |
| --- | --- | --- | --- |
| Phase 0 共享协议 | 未开始 | `packages/protocol`：事件 schema、settings schema、Zod 校验、同步错误语义、settings 冲突规则定稿 | 协议测试三端（协议包/客户端/服务器）消费通过 |
| Phase 1 云端服务器 | 未开始 | Node + Fastify + better-sqlite3 哑服务器：push / pull / settings / health、去重、server_seq、备份 | 服务器专项测试 + 幂等/游标回归 |
| Phase 2 同步落地 | 未开始 | 最小同步客户端/测试 Harness；**把真实学习数据真正送上云端**；push、pull、幂等、断线、恢复、cursor、backup 全验证 | 真实数据迁移闭环（`AGENTS.md`）+ 双端重放一致 |
| Phase 3 新客户端基座 | 未开始 | 客户端 SQLite Repository、outbox、sync engine、Ports/Adapters 双适配器 | 断网/恢复回归；浏览器模式完整可用 |
| Phase 4 Tauri Android 闸门 | 未开始 | 第九章闸门清单 9 项全过（见下） | 全部通过后正式锁死 Tauri 全端 |
| Phase 5 React UI 全面迁移 | 未开始 | 按界面规格 v2 约束范围重建全部页面；领域/应用层移植 + V1 测试映射 | Vitest/Playwright 浏览器矩阵 + 移植行为对照 |
| Phase 6 正式 App | 未开始 | macOS + Android 正式构建、真实数据切换、V1 退役评估 | 全链路验收 + 用户级验收 |

当前顺序原则：**服务器优先**；"真实数据先托管在云端"比"先把新 UI 画完"优先。

## 当前阶段：Phase 0 + Phase 1 + 客户端后端迁移（第一轮自主实现，2026-09-19 夜间执行）

- 启动条件：用户已在 V2 工作区发起第一轮自主实现；本仓库为独立 Git 仓库（`main`，尚未产生首次提交）。**本轮无 grill-me 环节**：agent 自主收敛口径并执行，全部判断写入 `docs/V2首轮自主判断与口径收敛.md` 供用户晨审；晨审前不得把新口径改写进三份继承规格。
- 首轮任务优先级：
  1. **设置同步口径 triage（最先做）**：枚举 V1 全部设置项，逐项判定「跨端同步 / 设备本地」。用户已定调：大语言模型服务配置（Base URL/模型/API Key/思考开关）不同步、每设备各配；凡涉及学习调度的设置倾向同步；凡判定同步者以云端为唯一权威数据源。
  2. Phase 0：`packages/protocol`（事件 + settings + push/pull/settings API 契约，Zod schema 与 TS 类型）。
  3. Phase 1：`server/` 哑同步服务器 + 云端权威库 schema；服务端全程在本地 localhost 运行与系统测试。**本轮禁止任何上云部署与远端服务器操作**（部署脚本与说明可作为留档产出，但不得连接服务器）；上云部署与 Tunnel 暴露为后续轮次、需用户参与。
  4. 客户端后端迁移：`packages/domain`、`packages/application` 以 V1 行为为规格移植（V1 387 项测试逐项映射改写 Vitest；调度状态机、List 聚合、FSRS 映射、容量预测、事件模型优先，整理器 v3 移植可后置）。
  5. 客户端持久化与集成（必做）：repository、outbox、sync engine、SQLite 适配与 Ports/Adapters（`BrowserTestAdapter` / `TauriProductionAdapter`）完整接线；Node 侧以测试适配器完成集成测试。
  6. 双端联调（必做）：本地真实 server + 双客户端实例验证 push/pull 收敛、幂等去重、断线恢复、游标推进、settings 收敛。
  7. Stretch：Tauri 工程骨架与插件接线冒烟（占位页面，不做任何 UI 开发）。
- 工程形态：**pnpm workspace monorepo**（`packages/protocol`、`packages/domain`、`packages/application`、`app/`、`server/`）。
- 明确不做：React UI（位于最后阶段，本轮不要求完整用户验收）；除此之外的自动化测试必须完整做好并通过。不改继承规格口径；不创建远端仓库、不推送；不上云部署。
- 技术栈与版本、同步语义、API 范围以 `docs/V2迁移技术决策.md` 为准，不得重新选型。

### Phase 0 完成定义

- `packages/protocol` 提供事件、settings、请求/响应的 Zod schema 与 TypeScript 类型，客户端与服务器共同消费。
- 同步字段至少包含：`eventId`、`deviceId`、`deviceSeq`、`occurredAt`、`serverSeq`；明确 `serverSeq` 仅为同步游标。
- settings 冲突规则定稿（建议 LWW：值 + `updated_at` + `device_id`，见"待确认口径"）。
- 协议包自身测试通过，且被一个最小服务器桩和一个最小客户端桩双向消费验证。

### Phase 1 完成定义

- API 保持 `POST /sync/push`、`GET /sync/pull?after_seq=`、`GET/PUT /settings`、`GET /health` 范围内；Bearer access token 鉴权。
- `event_id` 幂等去重、`server_seq` 分配、增量查询、gzip、备份脚本就绪；服务器零业务逻辑。
- 服务器测试覆盖：重复 push 幂等、乱序上传、游标推进、schema 拒绝、备份恢复。

### 任务看板（第一轮）

- [x] 首次 Git 提交（文档基线）
- [x] 设置同步口径 triage + `docs/V2首轮自主判断与口径收敛.md` 成稿（2026-09-19 夜完成初稿：A1 十四项逐项判定、A2 Space 级设置走 settings KV、B1 LWW 以 deviceId 字典序 tie-break 等，待晨审）
- [ ] Phase 0：仓库脚手架（pnpm workspace、TypeScript 6.0.2、Vitest 5.0.0、精确版本锁定）
- [ ] Phase 0：事件/settings/API schema 与排序规则定稿（settings 体现 triage 结果）
- [ ] Phase 1：Fastify 服务器骨架 + push/pull/settings/health + 云端权威库 schema
- [ ] Phase 1：去重、server_seq、增量查询、gzip、备份
- [ ] Phase 1：服务器专项测试全绿
- [ ] Phase 1：服务端本地运行 + localhost 系统测试（健康检查、备份、断线恢复冒烟）；部署脚本仅本地留档，不上云
- [ ] 客户端后端移植：domain/application（V1 测试映射，核心调度与事件模型优先）
- [ ] 客户端持久化集成：repository/outbox/sync engine + SQLite 适配 + 双适配器接线（集成测试全绿）
- [ ] 双端联调：本地真实 server 双客户端收敛、幂等、断线恢复、settings 收敛
- [ ] Stretch：Tauri 工程骨架与插件接线冒烟（占位页面，无 UI 开发）

### 第一轮执行状态（2026-09-19 夜间）

- 环境已就绪：mise 装 Node 24.21.0；pnpm 12.3.4 经 npm -g（npmmirror 镜像）安装；项目 `.npmrc` 固定 npmmirror registry（GitHub API 限流绕行，详见判断文件 C1）。
- 口径收敛：`docs/V2首轮自主判断与口径收敛.md` 已成稿，A1 设置 triage 已定稿并作为 protocol settings schema 的直接输入。
- 执行结构：M1 脚手架+protocol → M2 server ∥ M3 domain → M4 application → M5 persistence → M6 双端联调；每个里程碑单独 commit，主会话亲自 review 每个 subagent 分支的 diff 与测试证据。

### 闸门测试清单（Phase 4，来自技术决策第七章）

1. macOS + Android 创建并迁移 SQLite；2. 批量读写；3. 连接真实 Cloudflare Tunnel Server；4. push/pull/outbox；5. 后台 → 前台恢复；6. 长 TextArea；7. 60 词列表滚动；8. 容量预测；9. Android release APK。

## 跨阶段决策（摘要）

完整口径见 `docs/V2迁移技术决策.md`，此处只列最容易走偏的执行决策：

| 决策 | 结论 |
| --- | --- |
| 数据架构 | 云端权威 + 客户端完整副本；React 只读本地；禁止 React→HTTP→Server→DB |
| 服务器边界 | 哑服务器，零业务规则；better-sqlite3，不引入 PostgreSQL |
| 同步去中心化 | 不引入 PowerSync / Zero / Electric / RxDB；事件 append-only + outbox + 游标 |
| 领域重放排序 | `occurredAt → deviceSeq → deviceId/eventId`，禁用 `serverSeq` 排序 |
| 容量预测 | 第一版纯 TS，固定 seed + 算法版本 + 缓存；超 1 秒才局部下沉 Rust |
| UI 架构 | 浏览器模式一等公民；Tauri 只是平台壳，页面禁直接调 Tauri API |
| Android 逃生路线 | 仅当闸门测试持续失败才启用 macOS=Tauri + Android=Capacitor；React/Domain/Protocol/Sync 不重写 |

## 待确认口径（本轮由自主实现先行收敛，晨审定稿）

以下口径本轮不再走会话确认：agent 按用户给定倾向自主判断并写入 `docs/V2首轮自主判断与口径收敛.md`，用户晨审通过后才并入正式规格。

| 口径 | 用户已给的倾向 |
| --- | --- |
| 各设置项是否跨端同步 | 大语言模型服务配置不同步；学习调度相关设置倾向同步；同步项以云端为唯一权威 |
| LLM API Key | 不同步、每设备各配 |
| settings 冲突规则 | 建议默认 LWW（值 + `updated_at` + `device_id`） |
| 服务器暴露方式 | 维持 Cloudflare Tunnel，代码只认 Base URL；线上 Tunnel/SSH 配置本轮禁改 |

## 跨阶段风险

- Tauri Android 生态成熟度不足是最大技术风险；缓解：闸门测试前置（Phase 4 提前到大规模 UI 迁移前）+ 双壳逃生路线。
- 个人服务器网络质量一般；缓解：批量 + gzip + 断点续传为硬性要求，推送写后即发、拉取前台/启动触发、轮询优先。
- WebView 双引擎（macOS WKWebView / Android Chromium）视觉细节差异不可消除；缓解：双端视觉验收均为必做项。
- 领域移植行为漂移；缓解：V1 测试逐项映射改写，行为变更必须回到规格文档走用户确认。
- settings 与事件语义若在 Phase 0 定稿不慎，Phase 2 真实数据上云后修正成本高；缓解：上云迁移执行前必须用户确认方案。

## 切换前状态记录（2026-09-19 会话完成事项）

- 本仓库已解除与 V1 的 git worktree 关联并重新 `git init`（`main` 分支，无提交）。原 `v2` 分支与 V1 `main` 同指向（ab25c8e），无独立提交，分支名保留在 V1 仓库，无任何历史丢失。
- 已归档：V1 仓库 `.mimosa/`（ZCode 会话工具残留）→ V1 `.archive/mimosa-hook-state`；本仓库 `.claude/plans/` 与两份 V1 历史验收报告（`正式启用前验收报告.md`、`用户验收报告.md`）→ 本仓库 `.archive/`。
- `docs/V2迁移技术决策.md` 已按用户 2026-09-19 定稿落盘（含 2026-09-09 规划会话确认的同步工程要求附录）；`docs/需求规格.md` 与 `docs/界面设计规格.md` 中"v2 起设计执行方自主决策"的修订（2026-09-10 规划轮产物）保留为现状。
- 三份核心文档已按 V2 重写；`data/README.md` 仍为 V1 口径，待 Phase 2 重写。
- 旧 Python 参考副本（`src/`、`tests/`、`packaging/`、`scripts/`、`pyproject.toml`、`uv.lock`、`img/`）已经用户确认于 2026-09-19 移入 `.archive/`；V1 仓库为行为规格与迁移源码的唯一参考。
- `.gitignore` 已追加 Node/Rust/Tauri/server 运行时忽略项；`.archive/`、`data/*` 延续忽略。
