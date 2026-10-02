/**
 * @ebbinghaus/application 统一出口。
 *
 * 应用层：用例编排、事务边界、DTO 与外部能力端口。依赖边界（架构守卫测试强制）：
 * - 允许依赖 @ebbinghaus/domain（纯领域计算）与 @ebbinghaus/protocol（共享协议）；
 * - 禁止 import react 等 UI 框架、@tauri-apps/*、Node 专属模块、网络客户端、
 *   better-sqlite3 等具体基础设施——一切外部能力经 ports.ts 的端口接口注入；
 * - 禁止 Math.random、Date.now、无参 new Date() 与直接调用 crypto：时间经 Clock、
 *   标识经 IdGenerator、设备序号经 DeviceSeqAllocator（ports.ts）。
 *
 * 模块导航：
 * - ports.ts：全部外部能力端口（M5 持久化/同步阶段的实现合同）。
 * - errors.ts：应用层统一错误类型（用户可读中文文案）。
 * - eventRecorder.ts：学习事件唯一产生入口（协议校验 + 学习日投影）+ 稳定任务标识。
 * - entryOrganizing.ts：两种模式共用的智能整理用例与确认条目。
 * - llmConfiguration.ts：LLM 服务配置（设备本地）的解析、脱敏与保存用例。
 * - settingsFacade.ts：同步设置与设备本地设置的统一门面（A1 口径）。
 * - spaceManagement.ts：Space 生命周期用例 + 首次启动默认数据。
 * - scheduling.ts：词书模式任务派生（事件重放 → 调度投影 → 任务）。
 * - capacityPlanning.ts：两段式容量规划（缓存读 + 后台刷新）。
 * - regularLearning.ts：常规模式录入、到期分组、朗读复习与测试会话闭环。
 * - bookLearning.ts：词书模式录入、逐词测试会话与 Word 内容维护。
 * - reviewCandidates.ts：词书模式复习入口候选集只读查询（纯派生视图，无写路径）。
 * - dashboard.ts：今日看板（模式分发 + 容量视图 + 每日目标）。
 * - dto.ts：界面与用例之间的稳定视图快照。
 */

export * from "./ports.ts";
export * from "./errors.ts";
export * from "./eventRecorder.ts";
export * from "./entryOrganizing.ts";
export * from "./llmConfiguration.ts";
export * from "./settingsFacade.ts";
export * from "./spaceManagement.ts";
export * from "./scheduling.ts";
export * from "./capacityPlanning.ts";
export * from "./regularLearning.ts";
export * from "./bookLearning.ts";
export * from "./reviewCandidates.ts";
export * from "./bookDrafts.ts";
export * from "./vocabularyMastery.ts";
export * from "./dictionary.ts";
export * from "./dashboard.ts";
export * from "./dto.ts";
