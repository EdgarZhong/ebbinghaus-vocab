# Ebbinghaus V2

Ebbinghaus V2 是个人自用英语学习/记忆管理客户端的全量技术栈迁移仓库：把 V1（Python/PySide6 桌面应用）迁移为 **React + TypeScript + Tauri 2（macOS 与 Android）客户端 + Node 同步服务器 + 云端权威数据**。产品交互与逻辑骨架不变，UI 视觉按新设计执行。

V1 仓库位于 `/Users/edgar/code/Ebbinghaus`，自 2026-09 起转为**只读行为规格、算法参考和数据迁移来源**，保持正式使用、不再承担新功能；本仓库不继承其历史技术债。

## 产品定位（继承自 V1 的稳定产品事实）

- 面向约 6000 词规模的纸质考研英语词书；每个 List 固定 60 词，软件只录入首过筛出的重点 Word。
- 首次运行提供"必考词、常考词、偶考词"三个默认 Space；Space 是两种模式共同且可多实例的最外层数据隔离边界，学习模式创建后不可变。
- 词书模式层级 `Space → Unit → List → Word`，以 List 为纸质复习和工作量单位；常规模式层级 `Space → 条目`，条目级 FSRS 调度。
- 手录释义是学习主数据；在线词典只是可失败的补充来源，网络失败不得阻塞核心学习流程。
- 术语与行为细节以 `docs/需求规格.md` 为唯一真理源。

## 最终技术栈（已确认定稿，禁止重新选型）

完整决策、理由、禁止事项与逃生路线见 `docs/V2迁移技术决策.md`（唯一真理源）。

```text
React + TypeScript + Vite
           │
        Tauri 2
      ┌────┴────┐
    macOS     Android
           │
    Client SQLite（完整本地副本）
           │
     Sync Engine（outbox + server_seq 游标）
           │
     HTTP Sync API
           │
 Node + Fastify + SQLite（云端权威数据，哑服务器）
```

锁定版本：TypeScript 6.0.2；React / React DOM 19.2.8；Vite 8.2.2；Tauri core 2.11.5 / CLI 2.11.4 / API 2.11.1；plugin-sql 2.4.1、plugin-http 2.6.0、plugin-stronghold 2.3.2、plugin-notification 2.4.0；Rust 1.98.1（禁用 1.98.0）；ts-fsrs 5.4.2；Node.js 24.21.0 LTS；Fastify 5.12.3；better-sqlite3 13.0.3；Zod 4.5.4；Vitest 5.0.0；pnpm 12.3.4。依赖使用精确版本并提交 `pnpm-lock.yaml`。

## 架构原则（稳定口径）

- **云端数据库是权威副本；客户端 SQLite 是完整本地副本 + 工作数据库；React UI 永远直接访问本地数据**。禁止 `React → HTTP → Server → DB` 的读路径；断网只是同步暂停，不是模式切换。
- **服务器保持"哑"**：只做鉴权、schema 校验、`event_id` 去重、分配 `server_seq`、存储、增量查询、settings 存储和备份；所有业务规则（FSRS、调度、容量、词书、首过）都在客户端。
- `server_seq` 只是同步游标；领域重放按 `occurredAt → deviceSeq → deviceId/eventId` 排序。
- React 页面禁止直接 import Tauri API；平台能力经 Ports/Adapters（`BrowserTestAdapter` / `TauriProductionAdapter`）注入，浏览器模式与 Tauri 模式共用同一套业务逻辑。
- 分层依赖：`ui → application → domain`；`packages/protocol` 由客户端与服务器共享；server 与客户端仅通过 HTTP 协议耦合。

## 目标目录结构

> 工程形态为 **pnpm workspace monorepo**。以下为迁移目标骨架（建议形态）；Phase 0/1 脚手架落地时如需调整，必须回写本节。

```text
Ebbinghaus-v2/
├── README.md / AGENTS.md / CLAUDE.md   # 三份核心文档
├── docs/                               # 规格与技术决策（见文档索引）
├── package.json / pnpm-workspace.yaml  # pnpm workspace 根（依赖精确版本，lock 文件随源提交）
├── tsconfig.base.json / tsconfig.json  # 共享 TS 基线（NodeNext + 全严格）与根级配置
├── vitest.config.ts                    # Vitest 根聚合（projects 模式，各包自带配置）
├── packages/
│   ├── protocol/                       # 已落地（2026-09-19）：同步协议、事件 schema、Zod 定义（双端共享）
│   ├── domain/                         # 纯 TS 领域层：状态机、FSRS、容量预测（禁 DOM/Node/Tauri 依赖）
│   ├── application/                    # 用例编排与端口定义（Repository、SyncEngine、LLM、词典）
│   └── persistence/                    # Repository/Outbox/SyncEngine 的 Node 适配实现（2026-09-19 C2 判断新增）
├── app/
│   ├── src/                            # React UI（Vite 浏览器模式可独立运行）
│   └── src-tauri/                      # Tauri 平台壳（macOS / Android）
├── server/                             # Node + Fastify + better-sqlite3 同步服务器
└── .archive/                           # 废弃文件归档（不进版本控制）
```

> workspace 成员声明为 `packages/*`、`server`、`app`（`server`/`app` 目录落地前被 pnpm 忽略）。
> 内部包策略：各包 `exports` 直接指向 `src/*.ts` 源码，不预编译、不引入 bundler，Vitest 与
> Node 24（type stripping）直接消费 TS 源码；`typecheck` 对各包 tsconfig 逐个 `tsc --noEmit` 检查。

随仓库复制带入的 V1 Python 工程副本（`src/`、`tests/`、`packaging/`、`scripts/`、`pyproject.toml`、`uv.lock`、`img/`）已于 2026-09-19 确认移入 `.archive/`，不参与 V2 工程与版本控制；行为规格、算法参考和迁移源码一律以 V1 仓库（`/Users/edgar/code/Ebbinghaus`）为准。

## 数据边界

- 正式学习数据当前仍在 V1（本机 SQLite）。V2 在 Phase 2 完成真实数据上云前，不接管任何正式数据。
- V2 开发期的一切数据库（客户端、服务器）都是独立开发/测试库；客户端正式 SQLite 位于各平台应用数据目录（Tauri path API 解析），服务器数据库位于 server 运行目录；仓库内不得提交任何数据库文件、密钥或个人数据。
- 仓库 `data/` 目录当前只承载 V1 口径的说明文件，待 Phase 2 重写为 V2 数据边界。

## 运行环境与开发命令

- Node.js 24.21.0 LTS（mise 管理）、pnpm 12.3.4（根 `package.json` 的 `packageManager` 锁定）、Rust 1.98.1（rustup 固定）。
- 依赖安装：`rtk pnpm install`（镜像源已在 `.npmrc` 固定为 npmmirror；依赖一律精确版本，`pnpm-lock.yaml` 随源码提交）。
- 测试：`rtk pnpm test`（根 Vitest 以 projects 模式聚合各包 `vitest.config.ts`）。
- 类型检查：`rtk pnpm typecheck`（根级与各包 tsconfig 逐个 `tsc --noEmit` 检查；新增包时在根 `package.json` 的 typecheck 脚本追加）。
- Shell 命令统一加 `rtk` 前缀；长输出 Git 命令用 `git --no-pager`。
- React UI（浏览器模式一等公民）：
  - 开发服务：`rtk pnpm --filter @ebbinghaus/app dev`（Vite，脱离 Tauri 壳完整运行）；
  - 构建：`rtk pnpm --filter @ebbinghaus/app build`；
  - Testing Library：`rtk pnpm test`（与各包一起由根 Vitest 聚合）；
  - Playwright 浏览器矩阵（构建产物 + 三视口截图）：`rtk pnpm --filter @ebbinghaus/app e2e`。
- 同步服务器（本地）：`rtk pnpm server:start`（CLI `--db= --token= --port=`，缺省 127.0.0.1:8787）、在线备份 `rtk pnpm server:backup`；部署口径见 `docs/服务器部署留档.md`。
- Tauri 构建（Phase 4 起启用）以 `docs/V2迁移技术决策.md` 第六章为准。

## 重要文档索引

| 内容描述 | 文件路径 |
| --- | --- |
| 稳定项目定位、架构、目录和入口 | `README.md` |
| 通用开发规范、协作约束、开发测试闭环 | `AGENTS.md` |
| 当前阶段目标、任务看板、动态决策 | `CLAUDE.md` |
| **V2 技术栈迁移最终决策（选型、版本、同步、阶段计划、禁止事项）** | `docs/V2迁移技术决策.md` |
| 完整产品需求、交互规则、数据边界和验收标准（v1 继承，术语唯一真理源） | `docs/需求规格.md` |
| 界面信息架构、交互语义与可用性底线（v2 起约束力范围见其第 1 章） | `docs/界面设计规格.md` |
| 记忆科学依据、调度模型、容量与逾期算法（v2 移植目标） | `docs/复习调度算法.md` |
| 录入整理故障报告、基础日志设计与整理校验机制整改口径（v1 行为规格参考） | `docs/录入整理故障报告与日志设计.md` |
| 同步服务器本地运行与上云部署蓝本（本轮仅留档，未执行远端操作） | `docs/服务器部署留档.md` |
| 自主执行轮次记录 | `docs/autonomous-runs/` |

## 代码规范与开发测试闭环

- 通用代码规范、文件与 Git 安全规则、V2 开发测试 SOP 见 `AGENTS.md`。
- 当前阶段、任务看板、待确认口径和风险见 `CLAUDE.md`。
