/**
 * 领域枚举：需求规格与复习调度算法中具有封闭取值集合的业务概念。
 *
 * 值使用中文正式术语字符串（与 V1 StrEnum、协议 metadata 已知值域一致），
 * 标识符使用对应英文正式术语，保证代码命名与 `docs/需求规格.md` 核心概念表
 * 一一对应。禁止在本表之外引入同义别名。
 */

/** 学习模式：Space 创建后不可切换（需求规格 3）。 */
export const LearningMode = {
  Book: "词书模式",
  Regular: "常规模式",
} as const;
export type LearningMode = (typeof LearningMode)[keyof typeof LearningMode];

/** 三个首次启动默认 Space 的词频板块来源标识；自定义 Space 使用 null。 */
export const SpaceKind = {
  Required: "必考词",
  Common: "常考词",
  Occasional: "偶考词",
} as const;
export type SpaceKind = (typeof SpaceKind)[keyof typeof SpaceKind];

/** 未掌握 Word 在短期同步阶段唯一允许的三个状态值。 */
export const ShortTermPassCount = {
  Zero: 0,
  One: 1,
  Two: 2,
} as const;
export type ShortTermPassCount = 0 | 1 | 2;

/** Word 是否已经通过长期验证的二值状态（词书模式）；常规模式为可逆软掌握。 */
export const MasteryStatus = {
  Unmastered: "未掌握",
  Mastered: "已掌握",
} as const;
export type MasteryStatus = (typeof MasteryStatus)[keyof typeof MasteryStatus];

/** List 在短期同步、长期验证和完成后的唯一阶段。 */
export const WordListStage = {
  ShortTermSync: "短期同步",
  LongTermValidation: "长期验证",
  Mastered: "已掌握",
} as const;
export type WordListStage = (typeof WordListStage)[keyof typeof WordListStage];

/** 内部计划任务类型；界面仍按 List 聚合为复习或测试入口。 */
export const TaskType = {
  ReviewOnly: "仅复习",
  ShortTermTest: "短期测试",
  WaitingCheck: "等待校验",
  LongTermValidation: "长期验证",
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

/** 调度器对每个 Word 到期需求给出的稳定、可持久化原因（与 V1 DueReason 逐字一致）。 */
export const DueReason = {
  FirstShortTermTest: "T0 + 1 第一次短期测试",
  T0ReviewOnly: "T0 + 2 仅复习",
  SecondShortTermTest: "T0 + 4 第二次短期测试",
  T1ReviewOnly: "T1 + 1 仅复习",
  PromotionTest: "T1 + 3 晋级测试",
  WaitingCheck: "T2 + 7 等待校验",
  LongTermValidation: "同步后 7 天长期验证",
} as const;
export type DueReason = (typeof DueReason)[keyof typeof DueReason];

/** 逐词测试初判和最终判断唯一允许的两个结果。 */
export const TestJudgement = {
  Recognized: "认识",
  NotRecognized: "不认识",
} as const;
export type TestJudgement = (typeof TestJudgement)[keyof typeof TestJudgement];

/** 短期通过次数的封闭值域校验（协议层只校验整数，值域合法性属于领域职责）。 */
export function isShortTermPassCount(value: unknown): value is ShortTermPassCount {
  return value === 0 || value === 1 || value === 2;
}

/** 掌握状态的封闭值域校验。 */
export function isMasteryStatus(value: unknown): value is MasteryStatus {
  return value === MasteryStatus.Unmastered || value === MasteryStatus.Mastered;
}
