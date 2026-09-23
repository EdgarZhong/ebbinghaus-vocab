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
| Phase 0 共享协议 | 已交付（第一轮） | `packages/protocol`：事件 schema、settings schema、Zod 校验、同步错误语义、settings LWW 冲突规则 | 协议测试三端消费通过 |
| Phase 1 云端服务器 | 已交付（第一轮） | Node + Fastify + better-sqlite3 哑服务器：push / pull / settings / health、去重、server_seq、备份 | 服务器专项测试 + 幂等/游标回归 |
| Phase 2 同步落地 | 部分（第一轮完成双端联调） | 最小同步客户端/测试 Harness；**把真实学习数据真正送上云端**（未做，需用户参与上云） | 真实数据迁移闭环（`AGENTS.md`）+ 双端重放一致 |
| Phase 3 新客户端基座 | 已交付（第一轮） | 客户端 SQLite Repository、outbox、sync engine、Ports/Adapters 双适配器 | 断网/恢复回归；浏览器模式完整可用 |
| Phase 4 Tauri Android 闸门 | 未开始（第一轮仅完成 macOS 骨架冒烟） | 第九章闸门清单 9 项全过（见下） | 全部通过后正式锁死 Tauri 全端 |
| Phase 5 React UI 全面迁移 | 进行中 | 按界面规格 v2 约束范围重建全部页面；领域/应用层移植 + V1 测试映射；**第二轮：视觉重构 + 移动端重设计** | Vitest/Playwright 浏览器矩阵 + 移植行为对照 |
| Phase 6 正式 App | 未开始 | macOS + Android 正式构建、真实数据切换、V1 退役评估 | 全链路验收 + 用户级验收 |

当前顺序原则：**服务器优先**；"真实数据先托管在云端"比"先把新 UI 画完"优先。

## 历史阶段记录

### 第一轮自主实现（2026-09-19 夜间 → 2026-09-20 凌晨，已完成）

- 交付：仓库脚手架与首次提交；`docs/V2首轮自主判断与口径收敛.md`（A1 设置同步十四项判定、B1 LWW、C8 Goal 重置等，**待用户晨审**）；Phase 0 `packages/protocol`；Phase 1 `server/` 哑服务器；domain/application 移植（V1 152 项映射）；persistence 双运行时 + 同步引擎 + 双端联调；UI 层（外壳/Space 管理/设置 + 今日/复习/测试/首过/词汇五页，常规模式主线闭环）；Tauri 2 骨架冒烟（cargo build 通过、tauri dev 真实启动成功，插件留 Phase 4）。
- 验收记录：`docs/autonomous-runs/20260920-0130-第一轮自主实现用户级验收记录.md`。
- 环境基线：mise Node 24.21.0；pnpm 12.3.4；node-gyp 13.0.2；Rust 1.98.1（rustup + rsproxy）。
- **已知遗留（第一轮如实记录）**：词书模式逐词测试会话用例未移植，词书"测试→纸质复习确认"闭环不可达（任务行如实提示"后续更新提供"）；词书首过录入为引导占位；移动端为桌面压缩版、侧边栏恒驻。
- **第二轮审计结论（2026-09-23，见当前阶段）**：① 493 项 Vitest 中 1 项已失败——`VocabularyPage.tsx` 用 `Date.now()` 判断"今天待测试"、`display.ts formatUserDate` 用 `new Date()` 判同年，绕过注入时钟（时间炸弹，2026-09-20 后爆发）；② Playwright 56 项重跑全过属实，但移动端视口实测主内容被恒驻侧栏挤压至约半屏、文案逐字换行不可用——"测试全绿 ≠ 可用"的实证；③ 词书模式缺口记录属实。

## 当前阶段：第二轮自主实现（2026-09-23）——第一轮审计 + 表现层视觉重构

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
- [ ] R2-3 页面打磨 + React 最佳实践（子 agent C：**agent-3 曾被叫停且未写入任何文件；用户睡前指示重派并给足审美授权，现以 agent-4 重跑中**）：VocabCard 提取 memo + 详情可见性改渲染期派生 + 函数式 setState 等最佳实践逐条落实；Modal/Toast/`.firstpass-save-bar` 玻璃化；移动端：设置页横向溢出修复、词汇详情改覆盖层、测试会话按钮竖排、`.vocab-card` content-visibility。**审美授权口径（用户原话）**：充分发挥审美、不被过往文档和视觉样式束缚，但用户路径（路由/testid/术语/交互流程）绝不魔改；测试文件不得修改
- [x] R2-4 测试适配（主会话）：新增 `app/e2e/nav.ts` 导航助手（按视口宽度 ≤900px 判定移动结构，非项目名）；smoke/acceptance 全部 nav-*/space-switcher/theme-* 交互收口到 `navTo`/`openSpaceManagement`/`expectActiveSpace`/`setTheme`；移动端补抽屉打开态截图键 `nav-drawer`；typecheck 干净（e2e 在 app tsconfig 覆盖内）
- [ ] R2-5 集成验证（主会话）：typecheck + 全仓 Vitest + build + e2e 四视口全绿；截图全量重生成
- [ ] R2-6 双端视觉验收（主会话）：逐张复核关键截图（桌面/移动 × 明/暗）+ Playwright 亲手走查 16.1 八项（常规模式口径，词书缺口维持如实记录）+ 验收记录落档 `docs/autonomous-runs/`

### 续跑锚点（会话压缩/重启后从这里恢复）

1. 已提交快照（9568722→78043ce 共 6 个）：时钟修复 → typecheck 链条补齐（**根 typecheck 现已覆盖全部 7 个 tsconfig：根+protocol+domain+application+persistence+server+app**，此前 application/persistence/app 三处漏检）→ 主题令牌+Glass → 外壳重构 → docs → e2e 适配。Glass.tsx 的 4 个类型错误已修（CSS.supports 重载改直接调用；LiquidGlass 类型按 CJS 命名空间形态取 .default）。
2. 当前在跑：agent-4（R2-3，后台），白名单 = pages/*、ui/{Modal,EmptyState,PageShell,StepperInput}、ToastContext、theme/{pages,components}.css（tokens.css 只许新增结构令牌）。完成后主会话复核 diff 再进 R2-5。
3. 子 agent 均被禁止跑 e2e/build（防端口与 dist 争抢）；其自证不替代主会话复核 diff 与重跑全部验证。
4. R2-5 起 e2e 预期变化：compact（800×600，≤900 也走移动结构）与 mobile 项目全部导航经抽屉；截图全量重生成（旧截图已失效，工作区遗留的截图改动是审计期重跑残留，直接覆盖）。
5. 视觉待验收：玻璃侧栏/抽屉真实渲染、`.main-area` 透明后页面落在环境渐变上的可读性、R2-3 页面级玻璃化效果，需 R2-5/R2-6 截图目检。

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

## 待确认口径（第一轮自主收敛，仍待用户晨审）

| 口径 | 用户已给的倾向 |
| --- | --- |
| 各设置项是否跨端同步 | 大语言模型服务配置不同步；学习调度相关设置倾向同步；同步项以云端为唯一权威 |
| LLM API Key | 不同步、每设备各配 |
| settings 冲突规则 | 建议默认 LWW（值 + `updated_at` + `device_id`） |
| 服务器暴露方式 | 维持 Cloudflare Tunnel，代码只认 Base URL；线上 Tunnel/SSH 配置未动 |

## 跨阶段风险

- Tauri Android 生态成熟度不足是最大技术风险；缓解：闸门测试前置（Phase 4 提前到大规模 UI 迁移前）+ 双壳逃生路线。
- 个人服务器网络质量一般；缓解：批量 + gzip + 断点续传为硬性要求，推送写后即发、拉取前台/启动触发、轮询优先。
- WebView 双引擎（macOS WKWebView / Android Chromium）视觉细节差异不可消除；缓解：双端视觉验收均为必做项。
- 领域移植行为漂移；缓解：V1 测试逐项映射改写，行为变更必须回到规格文档走用户确认。
- settings 与事件语义若在 Phase 0 定稿不慎，Phase 2 真实数据上云后修正成本高；缓解：上云迁移执行前必须用户确认方案。

## 切换前状态记录（2026-09-19 会话完成事项）

- 本仓库已解除与 V1 的 git worktree 关联并重新 `git init`（`main` 分支）。原 `v2` 分支与 V1 `main` 同指向（ab25c8e），无独立提交，分支名保留在 V1 仓库，无任何历史丢失。
- 已归档：V1 仓库 `.mimosa/`（ZCode 会话工具残留）→ V1 `.archive/mimosa-hook-state`；本仓库 `.claude/plans/` 与两份 V1 历史验收报告（`正式启用前验收报告.md`、`用户验收报告.md`）→ 本仓库 `.archive/`。
- `docs/V2迁移技术决策.md` 已按用户 2026-09-19 定稿落盘（含 2026-09-09 规划会话确认的同步工程要求附录）；`docs/需求规格.md` 与 `docs/界面设计规格.md` 中"v2 起设计执行方自主决策"的修订（2026-09-10 规划轮产物）保留为现状。
- 三份核心文档已按 V2 重写；`data/README.md` 仍为 V1 口径，待 Phase 2 重写。
- 旧 Python 参考副本（`src/`、`tests/`、`packaging/`、`scripts/`、`pyproject.toml`、`uv.lock`、`img/`）已经用户确认于 2026-09-19 移入 `.archive/`；V1 仓库为行为规格与迁移源码的唯一参考。
- `.gitignore` 已追加 Node/Rust/Tauri/server 运行时忽略项；`.archive/`、`data/*` 延续忽略。
