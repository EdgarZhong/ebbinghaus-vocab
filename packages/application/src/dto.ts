/**
 * 界面与用例之间的稳定视图快照（移植 V1 TaskItemSnapshot / ReviewWordSnapshot /
 * TestSessionSnapshot / DashboardSnapshot）。
 *
 * 快照是不可变 DTO：字段一经构造不再变化，UI 每次重绘都取新快照；禁止在快照上
 * 承载可变执行状态。快照中的中文枚举值与领域枚举逐字一致。
 */

import type { LearningMode, StructuredMeaning, TaskType, TestJudgement } from "@ebbinghaus/domain";
import type { TestSessionExecutionStatus } from "./ports.ts";

/** 纸质复习展开和测试答案页共同使用的只读词条内容。 */
export interface ReviewWordSnapshot {
  readonly wordId: string;
  readonly originalSpelling: string;
  readonly manualMeaning: string;
  /** 展示层按义项附上用法；可选以兼容既有会话快照与测试夹具。 */
  readonly meanings?: readonly StructuredMeaning[];
}

/**
 * 任务页使用的执行入口快照。
 *
 * 词书模式：List 粒度任务（unitNumber/listNumber 为纸质词书定位）；常规模式：
 * 当日到期测试组（listNumber 承载组序号，listId 为空串）。`taskId` 是稳定引用键：
 * 词书模式为派生任务标识（deriveListTaskId），常规模式为
 * `regular-group|<spaceId>|<学习日>|<组序号>`。
 */
export interface TaskItemSnapshot {
  readonly taskId: string;
  readonly listId: string;
  readonly unitNumber: number;
  readonly listNumber: number;
  readonly taskType: TaskType;
  readonly dueReason: string;
  readonly workload: number;
  readonly overdueDays: number;
  readonly completedCount: number;
  readonly totalCount: number;
  readonly sessionStatus: TestSessionExecutionStatus | null;
  readonly activeWords: readonly ReviewWordSnapshot[];
}

/** 逐词测试页每次重绘所需的稳定视图快照。 */
export interface TestSessionSnapshot {
  readonly sessionId: string;
  readonly taskId: string;
  readonly status: TestSessionExecutionStatus;
  readonly currentPosition: number;
  readonly totalCount: number;
  readonly currentWord: ReviewWordSnapshot | null;
  /** 常规模式承载组序号；词书模式由调度任务提供。 */
  readonly unitNumber: number | null;
  readonly listNumber: number | null;
}

/**
 * 今日看板稳定数据；任务入口和容量解释均通过同一快照呈现。
 *
 * `capacityStale` 是 V2 新增的两段式容量语义标记（AGENTS.md 固定交互）：为 true
 * 表示展示的是最近缓存结果、输入已变化，组合根应触发后台刷新完成后重取快照。
 * 2026-10-02 口径：任务列表只含测试任务（复习不再是任务），不再单独统计复习数。
 */
export interface DashboardSnapshot {
  readonly targetCapacity: number;
  readonly recentActualDailyWorkload: number | null;
  readonly recentActualSampleCount: number;
  readonly overdueWorkload: number;
  readonly dueWorkload: number;
  readonly remainingCapacity: number;
  readonly suggestedFirstPassCount: number;
  readonly riskCapacity: number;
  readonly predictionWindowDays: number;
  readonly riskQuantilePercent: number;
  readonly reserveWorkload: number;
  readonly overloadProbability: number;
  readonly expectedMaxBacklog: number;
  readonly riskQuantileMaxBacklog: number;
  readonly expectedClearanceDays: number | null;
  readonly riskWorkloadByDay: readonly number[];
  readonly capacityAlgorithmVersion: string;
  readonly capacityStale: boolean;
  readonly tasks: readonly TaskItemSnapshot[];
  readonly learningMode: LearningMode;
}

/** 测试页任务列表快照（看板与测试页共用同一数据源的模式分发结果）。 */
export interface TaskItemsPage {
  readonly learningMode: LearningMode;
  readonly tasks: readonly TaskItemSnapshot[];
}

/** 测试判断的初判/终判组合（改判方向校验由用例执行）。 */
export interface TestAnswerInput {
  readonly initialJudgement: TestJudgement;
  readonly finalJudgement: TestJudgement;
}
