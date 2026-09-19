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

## 当前阶段：Phase 0 + Phase 1 + 客户端后端迁移 + UI 层（第一轮自主实现，2026-09-19 夜间连续执行）

- **Goal 已由用户中途重置（2026-09-20 凌晨）**：UI 层纳入本轮交付；唯一不做的是 Computer Use 用户验收与云端实际部署；其余完成一切能完成的。UI 表现层验收用 Playwright 内置浏览器 + 视觉复核闭环，用户级验收以浏览器走查第 16.1 节核心任务替代 Computer Use（详见判断文件 C8）。

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
- [x] 设置同步口径 triage + `docs/V2首轮自主判断与口径收敛.md` 成稿（A1 十四项判定、A2 Space 级设置走 settings KV、B1 LWW、C6 额度中断绕行、C8 Goal 重置等，待晨审）
- [x] Phase 0：仓库脚手架 + `packages/protocol`（c6e71f1；类型退化缺陷修复 08393de）
- [x] Phase 1：`server/` 哑服务器全项（d531b4e；46 测试含幂等/游标/gzip/备份/架构守卫）
- [x] Phase 1：服务端本地运行 + localhost 系统测试（并入 M5 集成套件：真实 listen、健康、备份、断线恢复；部署留档见 `docs/服务器部署留档.md`）
- [x] 客户端后端移植 domain（a7b3969；V1 152 项映射全绿）
- [x] 客户端后端移植 application（src 13 模块 + 部分测试已交付 2482fad；剩余测试模块后台分支进行中：scheduling/capacityPlanning/regularLearning/entryOrganizing/bookReview/dashboard/架构守卫）
- [x] 客户端持久化集成：repository/outbox/sync engine + SQLite/内存双运行时（a5ecdf6；仓储单元 + 真实服务器集成 13 项）
- [x] 双端联调：`packages/persistence/tests/sync.integration.test.ts` 覆盖双客户端收敛、幂等、断线恢复、游标推进、settings LWW 收敛、gzip、备份（进程内双实例形态）
- [ ] UI 层（新增范围，C8）：UI-1 脚手架/外壳/Space 管理页/设置页/Testing Library/Playwright 冒烟（后台分支进行中）→ UI-2 剩余页面接线 → Playwright 三视口截图 + 视觉复核闭环 → 浏览器用户级验收（16.1 八项核心任务）
- [ ] Stretch：Tauri 工程骨架与插件接线冒烟（Rust 1.98.1 已经 rsproxy 装好，待 UI 稳定后执行）

### 第一轮执行状态（2026-09-19 夜间 → 2026-09-20 凌晨）

- 环境：mise Node 24.21.0；pnpm 12.3.4（npm -g，npmmirror）；`.npmrc` 固定 npmmirror；node-gyp 13.0.2（better-sqlite3 本地编译）；Rust 1.98.1（rustup + rsproxy 镜像）。
- 提交链：eee20df → c6e71f1（M1）→ d531b4e（M2）→ a7b3969（M3）→ 08393de（protocol 类型修复）→ e8ef21a / 962c418（文档与部署留档）→ 2482fad（M4 部分 + 集成修复）→ a5ecdf6（M5 持久化与同步引擎）。
- 测试基线：protocol 64 + domain 152 + server 46 + application 84（4 模块）+ persistence 19 = 全仓 365 项全绿（另有 application 后台分支新增测试持续并入，见 2482fad 后续提交）。
- 集成修复（主会话）：设置写入单调时钟护栏（同毫秒 LWW 值序反转缺陷）、Space 级设置缺省回退校验、默认 Space id 改确定性 UUIDv4、SqliteOutbox 时钟注入、applyPulledEvents 幂等落地。
- 协作形态：额度中断后主会话亲自补齐 M5；恢复后以"主会话 + ≤2 后台分支"并行推进（用户约束：同时不超过 3 个 agent）。

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
