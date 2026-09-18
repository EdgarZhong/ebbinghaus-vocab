/**
 * @ebbinghaus/domain 统一出口。
 *
 * 纯领域层：实体、值对象、状态机、调度规则与纯计算。依赖边界（架构守卫测试强制）：
 * - 禁止 import react、DOM API、@tauri-apps/*、Node 专属模块（fs/path/http/os…）、
 *   网络客户端；唯一运行时依赖是 @ebbinghaus/protocol（共享协议）与 ts-fsrs（常规
 *   模式 FSRS 运行时，纯算法库）。
 * - 禁止读取系统当前时间：一切"现在"经 clock.ts 的可注入 Clock 提供；所有时间
 *   计算都是显式输入的纯函数。
 * - 禁止 Math.random：蒙特卡洛使用固定种子的确定性伪随机源（capacity.ts）。
 *
 * 模块导航：
 * - clock.ts：可注入时钟端口。
 * - learningDay.ts：学习日解析与日历运算。
 * - enums.ts：封闭值域业务枚举（正式术语唯一来源）。
 * - entities.ts：Space/Unit/List/Word 实体与构造不变量、测试改判与会话进度规则。
 * - meanings.ts：结构化手录义项、正式词性与语音别名规范化。
 * - entryFormat.ts / firstPass.ts / entryOrganizing.ts：录入解析纯逻辑。
 * - scheduling.ts：T0/T1/T2 短期状态机、等待校验、同步条件、统一调度与逾期。
 * - capacity.ts：capacity-monte-carlo-v2 容量预测与缓存接口。
 * - fsrsRegular.ts：常规模式 FSRS 调度、积压跨卡排序、测试组切分、软掌握派生。
 * - replayer.ts：学习事件确定性重放器。
 * - settings.ts：学习调度设置模型与默认值。
 */

export * from "./clock.ts";
export * from "./learningDay.ts";
export * from "./enums.ts";
export * from "./entities.ts";
export * from "./meanings.ts";
export * from "./entryFormat.ts";
export * from "./entryOrganizing.ts";
export * from "./firstPass.ts";
export * from "./scheduling.ts";
export * from "./capacity.ts";
export * from "./fsrsRegular.ts";
export * from "./replayer.ts";
export * from "./settings.ts";
