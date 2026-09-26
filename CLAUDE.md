# Ebbinghaus V2 项目总览与当前阶段看板

> 本文件保留 V2 全局交付范围、完整阶段计划、全阶段任务看板、跨阶段决策，以及当前阶段的详细执行信息。稳定项目事实见 `README.md`，通用协作规则见 `AGENTS.md`，技术选型唯一真理源是 `docs/V2迁移技术决策.md`，产品与算法语义以 `docs/需求规格.md` 和 `docs/复习调度算法.md` 为准，界面体验以 `docs/界面设计规格.md` 第 1 章划定的 v2 约束力范围为准。

## 项目使命与 V1 关系

- V2 是一次**全量技术栈迁移重构**：Python/PySide6 桌面应用 → React + TypeScript + Tauri 2（macOS 与 Android）+ Node 同步服务器 + 云端权威数据。不是渐进修补，新实现不承担历史技术债。
- 当前交付目标：**完成可直接使用的 macOS 正式桌面 App**；录入、词汇、在线词典、复习、测试与设置的用户链路和业务行为与 V1 一致。V2 已实现的森色视觉、玻璃侧栏、深色/浅色/跟随系统主题保留；云端托管已部署并用测试数据联调。
- 第一阶段不解决：本地独立模式、DataSpace、多服务器数据隔离、Cloud → Local fork、复杂账号系统。
- V1 仓库（`/Users/edgar/code/Ebbinghaus`）作为只读行为参考：其自动化测试、源码与规格约束 V2 用户链路。当前取自 V1 的 SQLite 备份只用于演练；真正的生产库尚未由用户识别。

## 完整阶段计划

| 阶段 | 状态 | 交付内容 | 质量门 |
| --- | --- | --- | --- |
| Phase 0 共享协议 | 已交付（第一轮） | `packages/protocol`：事件 schema、settings schema、Zod 校验、同步错误语义、settings LWW 冲突规则 | 协议测试三端消费通过 |
| Phase 1 云端服务器 | 已交付（第一轮） | Node + Fastify + better-sqlite3 哑服务器：push / pull / settings / health、去重、server_seq、备份 | 服务器专项测试 + 幂等/游标回归 |
| Phase 2 同步落地 | 测试数据闭环通过；生产切换待源库确认 | 内容目录、事件与设置云端同步，V1 样本迁移及新客户端全量恢复 | 正式数据迁移闭环（`AGENTS.md`）仍待执行 |
| Phase 3 新客户端基座 | 已交付（第一轮） | 客户端 SQLite Repository、outbox、sync engine、Ports/Adapters 双适配器 | 断网/恢复回归；浏览器模式完整可用 |
| Phase 4 Tauri Android 闸门 | 未开始（第一轮仅完成 macOS 骨架冒烟） | 第九章闸门清单 9 项全过（见下） | 全部通过后正式锁死 Tauri 全端 |
| Phase 5 React UI 全面迁移 | 进行中 | 按界面规格 v2 约束范围重建全部页面；领域/应用层移植 + V1 测试映射；**第二轮：视觉重构 + 移动端重设计** | Vitest/Playwright 浏览器矩阵 + 移植行为对照 |
| Phase 6 正式 App | macOS 桌面成品已构建并安装；生产切换待源库确认 | macOS 正式构建、真实 App 用户链路验收和测试云数据托管；移动端不在本轮 | 全链路验收 + 用户级验收 |

当前顺序原则（2026-09-27 用户更新）：**桌面成品与 V1 行为对齐优先**；云端用可修改的测试库验证，移动端暂缓。生产库来源确认后再执行正式切换。

## 历史阶段记录

### 第一轮自主实现（2026-09-19 夜间 → 2026-09-20 凌晨，已完成）

- 交付：仓库脚手架与首次提交；`docs/V2首轮自主判断与口径收敛.md`（A1 设置同步十四项判定、B1 LWW、C8 Goal 重置等，**待用户晨审**）；Phase 0 `packages/protocol`；Phase 1 `server/` 哑服务器；domain/application 移植（V1 152 项映射）；persistence 双运行时 + 同步引擎 + 双端联调；UI 层（外壳/Space 管理/设置 + 今日/复习/测试/首过/词汇五页，常规模式主线闭环）；Tauri 2 骨架冒烟（cargo build 通过、tauri dev 真实启动成功，插件留 Phase 4）。
- 验收记录：`docs/autonomous-runs/20260920-0130-第一轮自主实现用户级验收记录.md`。
- 环境基线：mise Node 24.21.0；pnpm 12.3.4；node-gyp 13.0.2；Rust 1.98.1（rustup + rsproxy）。
- **已知遗留（第一轮如实记录）**：词书模式逐词测试会话用例未移植，词书"测试→纸质复习确认"闭环不可达（任务行如实提示"后续更新提供"）；词书首过录入为引导占位；移动端为桌面压缩版、侧边栏恒驻。
- **第二轮审计结论（2026-09-23，见当前阶段）**：① 493 项 Vitest 中 1 项已失败——`VocabularyPage.tsx` 用 `Date.now()` 判断"今天待测试"、`display.ts formatUserDate` 用 `new Date()` 判同年，绕过注入时钟（时间炸弹，2026-09-20 后爆发）；② Playwright 56 项重跑全过属实，但移动端视口实测主内容被恒驻侧栏挤压至约半屏、文案逐字换行不可用——"测试全绿 ≠ 可用"的实证；③ 词书模式缺口记录属实。

## 当前阶段：第三轮自主实现（2026-09-26 起）——正式桌面应用、云端托管与完整用户旅程验收

- **本轮当前执行目标（2026-09-27 用户最新澄清）**：交付可直接使用的 macOS 正式桌面 App，用户旅程、操作路径、状态反馈与业务行为逐项对齐 V1；不要求视觉 1:1 复刻。V2 已有的深色、浅色和跟随系统主题，以及既有视觉方案继续保留。用 Computer Use 在真实 V2 `.app` 验收桌面主路径和失败路径。移动端及浏览器模拟手机不在本轮验收范围。
- 用户已授权：修改腾讯云服务器和 Cloudflare Tunnel 配置；服务使用 Bearer token 鉴权，不加 Cloudflare Access。用户提供的大语言模型 API 密钥只供本轮使用，不写入仓库、文档或日志。
- 数据口径（2026-09-27 用户纠正）：当前云端权威托管库、V2 本地库以及已迁入的 V1 样本都是**可修改的测试数据**。不能把 `~/Library/Application Support/Ebbinghaus/runtime/ebbinghaus.sqlite3` 或现有演练备份直接宣称为正式生产迁移源。正式生产源库待确认；正式切换时至少保留一份经核验的在线备份，原库保留。
- 用户验收修正（2026-09-26）：V2 录入保存成功不显示独立“录入完成”页面，也不出现“继续录入”按钮；留在录入页、清空当前批次、显示短暂提示，下一批可直接开始。词书草稿确认后释放其 ID，避免后续输入尝试编辑已确认草稿。
- 用户明确收敛（2026-09-26）：V2 桌面端的用户链路和业务行为必须与已经实际使用的 V1 保持一致；先逐页核对 V1 规格、源码和正式 App，再决定操作路径、状态和反馈。在线词典与词汇页完整交互属于本轮验收。用户随后明确纠正：此前对“UI/UX 一致”的理解过宽，**不要求 V1 视觉 1:1 复刻**；V2 已有的深色、浅色、跟随系统主题和视觉方案保留。
- 当前阶段结果：真实 V2 `.app` 验收、正式构建、本机安装、测试云端部署、在线备份和代码快照均已完成。正式生产数据切换待源库确认；移动端按用户要求暂缓。
- 当前进度：录入两步流程、在线词典、词汇详情与掌握、真实 DeepSeek 整理、词书逐词测试/暂停恢复/纸质复习、常规录入、设置及云同步已在真实 V2 App 走查。服务器通过 Tunnel 公开、Bearer token 鉴权，systemd 开机启动；云端与本地测试库双向同步、断网写入后恢复、V1 样本导入与新客户端全量拉取均经实测。新客户端首启默认值曾覆盖云端每日目标并触发临时错误页，已修复且空白客户端重试通过：4 个 Space、85 个词、174 条事件、18 项设置、待发送队列 0，云端每日目标仍为 10/8/8/50。根分区剩余约 18 GB（使用率 53%）。
- 已完成的最终验证：全仓 TypeScript 类型检查、Vitest 541/541、Playwright 四视口 56/56、macOS WebdriverIO 原生启动与页面导航 1/1；Computer Use 从 `/Applications/Ebbinghaus V2.app` 启动正式安装版，复核今日目标 10、云端待同步 0、词汇手录与在线释义分列。词卡隐藏快捷掌握的误触已修；纯紫色占位图标替换为森色书芽图标。服务器已并排安装并实际使用 Node 24.21.0，在线备份 `integrity_check=ok`、外键错误 0、计数 174/99/18，根分区剩余约 18 GB；系统 Node 未动。
- 当前剩余边界：正式生产源库未确认，因此未做真正的生产数据切换；移动端暂缓。WebdriverIO 的 mock 清理在退出时打印警告，但原生测试通过；正式包不启用 `wdio-test` 测试驱动，4445 端口未监听。
- 真实迁移必须严格执行 `AGENTS.md`「真实数据上云迁移闭环」：在线备份、幂等事务迁移、完整性与数量核对、两个客户端重放一致；任一步失败停止写入并保留原库及备份。

### V1 App 对照与 V2 验收状态（2026-09-27）

以下基准来自 `/Applications/Ebbinghaus.app` 的实际 Computer Use 观察，并与 V1 源码、`docs/需求规格.md` 和 `docs/界面设计规格.md` 交叉核对；V1 正式数据库仅只读观察，不做学习写入。V2 对照使用精确路径的 Tauri `.app`，避免同名旧 App 混淆。

| 用户旅程 | V1 行为基准 | V2 当前状态 | 剩余验收 |
| --- | --- | --- | --- |
| 录入成功 | 两步“输入 → 检查并保存”；保存后清空批次、留在录入页就地提示 | 真实 App 已验证词书与常规录入，成功后返回输入页；草稿 ID 释放 | 浏览器四视口回归通过 |
| 录入检查 | 可修改候选、回看原文与错误，返回修改后再保存 | 已实现并以 DeepSeek 整理 `abrogate` 的真实路径核验 | 浏览器矩阵与失败路径回归通过 |
| 词汇列表与详情 | 搜索/筛选、手录和在线释义分列、学习记录、双向掌握与移除确认 | 真实 App 已核验搜索、详情、掌握切换、记录展开和删除确认取消；深色详情可读性与词卡误触缺陷已修 | 最终安装版详情与 60 词长列表回归通过 |
| 在线词典 | 详情自动补拉并缓存；失败可重试；测试揭示后不阻断作答 | V2 平台适配、缓存和词汇/测试展示已接线，真实 App 在词汇详情与逐词测试中核验 | 不可用降级由自动化回归覆盖 |
| 设置与大语言模型 | 功能开关、连接配置、脱敏密钥与连接测试 | 本机密钥密文保存，真实 DeepSeek 整理成功；云令牌密文保存，同步状态可见 | 最终安装版显示待同步 0；服务器运行 Node 24.21.0 |
| 词书测试与纸质复习 | 逐词作答、暂停恢复、完成后确认纸质复习 | 真实 App 已完成 16 词测试并确认纸质复习，暂停/恢复的剩余词数错误已修 | 四视口自动化主路径回归通过 |
| V2 主题与视觉 | V1 视觉只用于辨认业务操作，不作复刻目标 | V2 森色主题、玻璃侧栏、双主题和跟随系统保留；森色书芽图标已进入正式包 | 全窗口截图与实机详情已复核 |

验收门：最终包完成浏览器矩阵和真实 `.app` 关键路径复核后，才称桌面 App 成品；云端演练数据不能替代正式生产库切换。

对齐顺序：①V1 用例与真实界面已锁定高风险流程；②在线词典、LLM 与安全密钥已接通；③完成最终自动化与 Computer Use 桌面验收；④核对测试云端部署与备份；⑤正式生产源库确认后再迁移。

### 第三轮执行计划与文件边界

| 任务 | 交付与独占修改范围 | 前置与验收 |
| --- | --- | --- |
| R3-1 云端完整数据协议 | `packages/protocol/src/*`、`packages/protocol/tests/*`、`server/src/*`、`server/tests/*`、`packages/persistence/src/sync/*` 及同步专项测试；新增内容目录和变更游标，含删除墓碑、冲突规则与双端收敛 | 先固定协议；协议三端兼容、离线/恢复、重复推拉测试通过。服务器继续只存储，不加入业务规则 |
| R3-2 词书用户旅程 | `packages/domain/src/*`、`packages/application/src/*`、对应测试、`app/src/pages/{FirstPassPage,TestPage,ReviewPage,VocabularyPage}.tsx` 与页面测试；实现词书录入、逐词测试、暂停恢复、纸质复习、内容维护及失败路径 | 与 R3-1 文件不交叉；浏览器模式完整闭环与规格对照 |
| R3-3 正式桌面运行时 | `app/src-tauri/*`、`app/src/composition.ts`、`app/src/main.tsx`、`app/src/services/*`、新增桌面端适配文件与测试；接入本地 SQLite、持久设备身份、密钥保护、HTTP 同步、后台恢复及同步状态 | 与 R3-1/R3-2 并行实现，协议及服务调用最终由主会话集成；重启后数据保留，断网可操作，真实 macOS 包可启动 |
| R3-4 V1 幂等迁移 | `packages/migration/` 与专项测试、`docs/服务器部署留档.md`；原始字段保持语义不变，先用备份演练 | 测试样本已完成；正式源库确认后再进行生产迁移 |
| R3-5 集成与上线 | 主会话审查 diff、完整自动化矩阵、正式 macOS 包、服务器与 Tunnel 部署 | 测试云端已上线；生产切换独立于本轮测试数据验收 |
| R3-6 完整用户级验收 | 浏览器四视口 + 正式 macOS App，Computer Use 实测完整窗口与真实交互；结果归入本阶段状态 | 全部用户行为核对预期和观察；失败回到实现轮次修复 |

### 用户旅程验收范围与完成门

1. 初装、重启、上次 Space 恢复；四个默认 Space、创建/切换/重命名/归档/恢复/空 Space 删除及非空拒绝。
2. 词书模式：空 List 与有词 List 首过、同 List 补录、批量整理与手动录入、校验与冲突处理、词内容维护、仅复习、到期/逾期逐词测试、两步作答、暂停/跨日恢复、测试后纸质复习、长期验证与掌握。
3. 常规模式：录入、内容编辑、今日优先级、测试组、两步作答、暂停恢复、朗读、积压与逾期、FSRS 保持率和设置影响。
4. 全局：词汇搜索/详情/移除、手录与在线释义隔离、词典失败/重试、LLM 成功/格式错误/网络失败与手动降级、主题/窗口/长文本/60 词滚动、键盘/触摸与错误态。
5. 数据托管：离线写入、outbox 退避、恢复同步、双端增量与幂等、设置收敛、内容目录收敛；服务器重启和客户端重启后仍一致；错误 token 拒绝，未鉴权请求不泄露数据。
6. 生产迁移（源库确认后）：V1 原库与备份不变、核心计数及事件逐条对账、云端权威库完整性、两客户端全量拉取与领域重放一致；V2 唯一写入后 V1 停写。

桌面成品完成门：相关 Vitest、Playwright 四视口、macOS 自动 E2E 通过；Computer Use 复核主路径、关键编辑态与错误态完整截图；测试云端托管和双客户端恢复通过。正式生产迁移须在源库确认后另行过 `AGENTS.md` 质量门，不能由演练结果替代。

## 历史阶段：第二轮自主实现（2026-09-23）——第一轮审计 + 表现层视觉重构

- 触发：用户明确"现在进行自主实现"，范围 = **验收第一轮真实可用性 + 重构表现层**。
- 本轮边界（用户指定）：不使用 Computer Use、不启动真实 App/安卓模拟器；表现层验收与用户级验收以 Playwright 内置浏览器四视口 + 主会话亲手截图复核为顶。不实现词书模式逐词测试会话（属应用层新功能，列入后续轮次建议，由用户决策）。
- 协作约束：同时不超过 3 个 agent；一切 review 由主会话亲自完成（独立 Review Agent 已废除）。

### 本轮设计定案（界面规格第 1 章授权设计执行方自主决策范围）

- **主题**：简约森色系"雾林晨读"。浅色 = 雾苔画布 `#EEF3EC` / 松烟墨文字 `#1C251E` / 深松主行动 `#2E5C40` / 苔痕选中 `#DCE8DC`；深色 = 夜林 `#111713` / 浅苔主行动 `#98C9A6`。全部交互色经 CSS 变量，逐色校验对比度 ≥4.5:1（规格第 16 章底线）。
- **签名元素**：液态玻璃（liquid-glass-react 1.1.1，精确版本）——桌面浮动侧栏、移动端抽屉、模态框、toast、吸底操作栏统一玻璃材质；画布层铺极轻的环境苔绿渐变，让玻璃有物可折。WebKit 降级为普通磨砂（库自身限制，如实接受）。
- **排版**：界面正文保持系统无衬线；**英文词条**（逐词测试大词、词汇卡片词条、详情标题）改用衬线谱系（New York / ui-serif / Georgia），承担"纸质词典"的视觉身份。
- **移动端重设计（不照搬桌面）**：≤900px 侧栏隐藏，顶栏 = 汉堡按钮（44×44）+ 当前 Space 胶囊；抽屉玻璃侧栏从左侧滑入，点导航/背景/Escape 关闭；词汇详情改全屏覆盖层；测试会话主操作拇指可达。
- **React 重构口径**（vercel-react-best-practices）：60 词列表卡片 memo 化、详情选中态改渲染期派生（去 effect）、函数式 setState、长列表 content-visibility、依赖直引、useMediaQuery 带 jsdom 守卫。

### 任务看板（第二轮）

- [x] R2-0a 审计取证：typecheck 干净；Vitest 492/493（词汇页时钟泄漏实锤）；Playwright 56/56 属实；移动端截图复核确认不可用（侧栏占半屏、设置页横向溢出、测试大词折行）；词书模式缺口确认（逐词测试会话与首过录入为占位，第一轮记录属实）
- [x] R2-0b 时钟泄漏修复（主会话，已验证 56/56 回绿）：`AppServices` 门面暴露注入 `clock`；`VocabularyPage`（到期判断）、`TodayPage`（今日标题）、`display.ts formatUserDate`（同年判断，签名加 `referenceNow` 参数）全部改用注入时钟
- [x] R2-1 森系令牌 + 玻璃封装（子 agent A 交付，主会话复核通过）：CSS 拆分为 `theme/{index,tokens,base,components,shell,pages}.css`（main.tsx 改引 index.css）；森色系双主题 14 组对比度实测全 ≥4.5:1（数值注释在 tokens.css）；`ui/Glass.tsx` 封装（ResizeObserver/backdrop-filter 能力检测，jsdom/旧 WebKit 降级 `.glass-fallback`；库的锚点居中模型与内联样式复位怪癖已在文件头注释收口）；`liquid-glass-react@1.1.1` 精确版本入依赖（62KiB ESM）；验证四项全绿
- [x] R2-2 外壳重构（子 agent B = agent-2 交付，**主会话已复核 diff 通过**）：桌面浮动玻璃侧栏 + 移动端（≤900px，JS `useMediaQuery("(max-width: 900px)")` 驱动、jsdom 无 matchMedia 时回桌面）顶栏 + 玻璃抽屉。约定 testid：`nav-drawer-open`（汉堡）、`nav-drawer`、`nav-drawer-backdrop`、`topbar-space`（顶栏 Space 胶囊直达 Space 管理）；关闭路径=点导航/背景罩/Escape；焦点进出管理、body 滚动锁、reduced-motion 关动画齐全；抽屉测试并入 `app/test/navigation.test.tsx`（4 用例，60/60 绿）
- [x] R2-3 页面打磨 + React 最佳实践（子 agent C = agent-4 交付，主会话已复核 diff 通过，提交 `29e9558`）：VocabCard 提取 memo + 详情可见性改渲染期派生 + 函数式 setState 等最佳实践逐条落实；Modal/Toast/`.firstpass-save-bar` 玻璃化；移动端：设置页横向溢出修复、词汇详情改覆盖层、测试会话按钮竖排、`.vocab-card` content-visibility
- [x] R2-4 测试适配（主会话）：新增 `app/e2e/nav.ts` 导航助手（按视口宽度 ≤900px 判定移动结构，非项目名）；smoke/acceptance 全部 nav-*/space-switcher/theme-* 交互收口到 `navTo`/`openSpaceManagement`/`expectActiveSpace`/`setTheme`；移动端补抽屉打开态截图键 `nav-drawer`；typecheck 干净（e2e 在 app tsconfig 覆盖内）
- [x] R2-5 集成验证（主会话）：根 typecheck（7 个 tsconfig）干净；全仓 Vitest 497/497；app 构建成功；e2e 四视口 56/56 四轮全绿；截图全量重生成。截图复核实证并修复 3 个缺陷：①入场动画期截图残影（`nav.ts` 新增 `waitAnimationsSettled`）；②设置页换日行"开始"被 `.field-input width:100%` 挤下行（`components.css` 加 `.settings-inline-row .field-input` 宽度收口）；③侧栏主题开关"跟随系统"折行（padding 收口 + nowrap）
- [x] R2-6 双端视觉验收（主会话，已完成）：逐张复核关键截图（桌面/移动 × 明/暗，玻璃材质与森色系成立、移动端无可读性问题）；Playwright MCP 在 preview 4173 亲手走查 16.1 八项双端全过（暂停恢复/两步作答/录入两步流/词汇 sheet/Space 创建/换日保存均实证）；验收记录已落档（见下）
- [x] R2-7 录入对齐 V1 术语（主会话，已完成，提交 `27a0196`）：V2 把页面叫"首过录入"不对齐——V1（`main_window.py:124`）导航统一叫"录入"，词书/常规（日常积累）共用同一入口，页标题按模式分"录入词汇/录入条目"（`ui/pages/first_pass.py:196,483`）。**口径决策**：只改用户可见命名，代码标识符（`FirstPassPage`、`routes.firstPass`、testid `nav-first-pass`）保留首轮命名（理由写在 FirstPassPage 文件头注释）；词书模式维持如实占位（应用层无用例，属后续阶段）。改动：导航 label→"录入"；无 Space 分支标题→"录入"；词书占位分支标题→"录入词汇"、占位文案修正"首过在线下书"病句并改如实引导；常规模式两步流文案本已与 V1 一致；`需求规格.md` mermaid 与 `界面设计规格.md` 7 处同步；测试与 e2e 断言同步

### 本轮状态：已完成，待用户验收（2026-09-24 凌晨）

- **验收记录**：`docs/autonomous-runs/20260924-0215-第二轮自主实现用户级验收记录.md`（含第一轮审计结论、16.1 双端走查、视觉复核、缺陷处置表、验证矩阵、遗留事项）。
- **验证终态**：根 typecheck 干净；全仓 Vitest 497/497（app 60/60）；app 构建成功；e2e 四视口 56/56 全绿且截图全量重生成；主会话 MCP 双端走查 + ReadMediaFile 逐张复核通过。
- **提交链（最新为头）**：`2c55be1` e2e 竞态修复+截图重生成 → `715e731` WebKit 注释归因 → `27a0196` R2-7 术语对齐 → `c07eaad` WebKit 降级磨砂 → `f68b5ee` 浅色抽屉修复 → `8915f71`/`51e4bb5`/`0e1495b`/`5f0cea6` 视觉缺陷修复与截图 → `29e9558` R2-3 页面打磨。
- **两个必须记住的跨阶段口径**：
  1. **WebKit 玻璃降级**：liquid-glass-react 的位移折射在 WebKit 不成立（库 README 明示 + 探针实证），`Glass.tsx` 按 UA 引擎判定降级磨砂；**macOS 正式 App（WKWebView）将呈磨砂，Phase 4/6 再评估**。
  2. **截图竞态根因**：库给 `.glass` 内联 `transition: all 0.2s`，主题翻转瞬间截图会抓到过渡中途色；`e2e/nav.ts` 的 `waitDarkGlassSettled`/`waitAnimationsSettled` 是防线，新增截图用例必须复用。
- **遗留（用户决策项）**：词书逐词测试会话/词书首过录入占位（后续阶段）；录入降级 toast"使用本地整理"与按钮"改为手动填写"措辞待统一；移动端会话按钮键盘提示可按介质隐藏（均不阻塞，详见验收记录第五节）。

### 文件修改白名单（分工隔离）

| 任务 | 独占文件 |
| --- | --- |
| R2-0b（主会话） | `app/src/composition.ts`、`app/src/pages/VocabularyPage.tsx`、`app/src/ui/display.ts` 及 formatUserDate 全部调用点、`app/test/vocabularyPage.test.tsx`（如需） |
| R2-1（子 A） | `app/src/theme/*`（新建拆分）、`app/src/ui/Glass.tsx`、`app/package.json`、`pnpm-lock.yaml`、`app/src/main.tsx`、`app/index.html` |
| R2-2（子 B） | `app/src/shell/*`、`app/src/ui/useMediaQuery.ts`、`app/src/theme/shell.css`、`app/test/navigation.test.tsx`、`app/src/App.tsx`（如需） |
| R2-3（子 C） | `app/src/pages/*`（VocabularyPage 除外，与时钟修复串行）、`app/src/ui/{Modal,EmptyState,PageShell,StepperInput}.tsx`、`app/src/shell/ToastContext.tsx`、`app/src/theme/pages.css` |
| R2-4 | `app/e2e/*`、`app/test/shellDrawer.test.tsx`（新增） |

冲突仲裁：R2-1 先建 `shell.css`/`pages.css` 骨架并收口既有样式，R2-2/R2-3 随后各自独占改写对应文件；`VocabularyPage.tsx` 先由主会话修时钟，R2-3 在其上重构。

### 本轮完成判据

1. typecheck 零错误；全仓 Vitest 全绿（含词汇页时钟修复回归）。
2. Playwright 四视口全绿；移动端全部核心路径经抽屉可达，无横向溢出。
3. 截图证据重生成，主会话逐张复核：森色系双主题、玻璃材质、移动端布局可读性（无逐字换行）。
4. 主会话亲手 Playwright 走查 16.1 八项核心任务（常规模式口径，词书缺口维持如实记录）。
5. 验收记录写入 `docs/autonomous-runs/`，审计结论与剩余风险如实汇报用户。

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

## 第一轮口径的当前落实

| 口径 | 当前实现 |
| --- | --- |
| 各设置项是否跨端同步 | 大语言模型服务配置与密钥留在本机；学习调度与功能开关按协议同步，云端权威库负责收敛 |
| LLM API Key | 不同步、每设备各配并在本机加密保存 |
| settings 冲突规则 | 最后写入获胜（Last Writer Wins，LWW）：`updated_at`、`device_id` 与规范化值确定胜者；首启默认值使用早期版本时间 |
| 服务器暴露方式 | Cloudflare Tunnel 已接通 `eb-data.edgarzhong.fyi`，服务只监听本机回环地址；Bearer token 鉴权，无 Cloudflare Access |

## 跨阶段风险

- Tauri Android 生态成熟度不足是最大技术风险；缓解：闸门测试前置（Phase 4 提前到大规模 UI 迁移前）+ 双壳逃生路线。
- 个人服务器网络质量一般；缓解：批量 + gzip + 断点续传为硬性要求，推送写后即发、拉取前台/启动触发、轮询优先。
- WebView 双引擎（macOS WKWebView / Android Chromium）视觉细节差异不可消除；缓解：双端视觉验收均为必做项。
- 领域移植行为漂移；缓解：V1 测试逐项映射改写，行为变更必须回到规格文档走用户确认。
- settings 与事件语义若在 Phase 0 定稿不慎，Phase 2 真实数据上云后修正成本高；缓解：上云迁移执行前必须用户确认方案。

## 切换前状态记录（2026-09-19 会话完成事项）

- 本仓库已解除与 V1 的 git worktree 关联并重新 `git init`（`main` 分支）。原 `v2` 分支与 V1 `main` 同指向（ab25c8e），无独立提交，分支名保留在 V1 仓库，无任何历史丢失。
- 已归档：V1 仓库 `.mimosa/`（ZCode 会话工具残留）→ V1 `.archive/mimosa-hook-state`；本仓库 `.claude/plans/` 与两份 V1 历史验收报告（`正式启用前验收报告.md`、`用户验收报告.md`）→ 本仓库 `.archive/`。
- `docs/V2迁移技术决策.md` 已按用户 2026-09-19 定稿落盘（含 2026-09-09 规划会话确认的同步工程要求附录）；2026-09-10 曾授权 v2 设计自主决策，2026-09-26 用户明确以 V1 正式桌面应用为界面验收基准，该旧授权对 macOS 桌面端不再适用。
- 三份核心文档已按 V2 重写；`data/README.md` 仍为 V1 口径，待 Phase 2 重写。
- 旧 Python 参考副本（`src/`、`tests/`、`packaging/`、`scripts/`、`pyproject.toml`、`uv.lock`、`img/`）已经用户确认于 2026-09-19 移入 `.archive/`；V1 仓库为行为规格与迁移源码的唯一参考。
- `.gitignore` 已追加 Node/Rust/Tauri/server 运行时忽略项；`.archive/`、`data/*` 延续忽略。
