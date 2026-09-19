/**
 * 容量规划用例：固定种子蒙特卡洛预测 + 输入指纹缓存
 * （移植 V1 application/capacity_planning.py，按 AGENTS.md 固定交互改造为两段式）。
 *
 * 两段式语义（AGENTS.md："显示最近缓存结果、后台更新、完成后刷新"是今日页固定
 * 交互，不得改成阻塞式计算）：
 * - `getTodaysCapacityView`：纯读路径——只返回最近一次落盘/内存缓存的计划与是否
 *   过期标记，**绝不运行蒙特卡洛**（打开今日的同步路径）；
 * - `refreshTodaysPlan`：更新路径——计算全部输入与指纹，命中指纹直接复用落盘结果，
 *   未命中才真正模拟并落盘；组合根/界面在后台调用它，完成后重新取视图刷新界面。
 *
 * 与 V1 的差异（如实记录）：
 * - V1 `rebuild_today` 在指纹未命中时同步重算蒙特卡洛（打开今日可能阻塞秒级），
 *   V2 按架构铁律拆成上述两段；指纹算法与"命中即复用落盘结果"的行为保持一致。
 * - 指纹 = domain `computeCapacityInputFingerprint`（覆盖全部模拟输入）再叠加
 *   Space、当日实际首过数与实际完成量（V1 指纹字段超集的等价实现），保证任何
 *   真实学习行为都会改变指纹。
 * - 稳定种子从 V1 的 SHA-256 截断改为 FNV-1a（应用层禁止直接调用 crypto）：
 *   种子值与 V1 不同，但只决定抽样流起点，不改变任何行为契约（确定性、固定项
 *   精确、建议规则，见 domain/capacity.ts 随机源说明）。
 */

import {
  computeCapacityInputFingerprint,
  createCapacityPredictionRequest,
  createCandidateListProfile,
  predictCapacity,
  type CandidateMetrics,
  type CapacityPredictionRequest,
  type LearningDaySettings,
} from "@ebbinghaus/domain";
import { resolveLearningDay, type LearningDay } from "@ebbinghaus/domain";
import type {
  CapacityCandidatePayload,
  DailyPlanRecord,
  DailyPlanStore,
  DueSnapshot,
  DueTaskSnapshot,
  LearningEventStore,
  RiskMetrics,
  WordContentStore,
} from "./ports.ts";
import type { BookCatalogStore, Clock } from "./ports.ts";
import { hashTextFnv1a } from "./eventRecorder.ts";
import type { SchedulingService } from "./scheduling.ts";

/** 容量常量（V1 capacity_planning.py 原值）。 */
const CAPACITY_HISTORY_DAYS = 14;
const CAPACITY_HORIZON_DAYS = 21;
const CAPACITY_RISK_QUANTILE = 0.85;
const CAPACITY_SAMPLE_COUNT = 300;
const CAPACITY_MAXIMUM_NEW_LISTS = 6;

/** 今日看板展示的可解释容量输出（字段与 V1 CapacityPlanSnapshot 一一对应）。 */
export interface CapacityPlanSnapshot {
  readonly targetCapacity: number;
  readonly recentActualDailyWorkload: number | null;
  readonly recentActualSampleCount: number;
  readonly dueWorkload: number;
  readonly overdueWorkload: number;
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
  readonly algorithmVersion: string;
}

/** 今日容量视图：缓存快照 + 是否过期（两段式语义的读侧输出）。 */
export interface TodaysCapacityView {
  /** 最近一次落盘的计划快照；本 Space 当天从未计算过时为 null。 */
  readonly snapshot: CapacityPlanSnapshot | null;
  /** true 表示输入已变化、展示值过期，组合根应触发 refreshTodaysPlan 后刷新。 */
  readonly stale: boolean;
}

/** 容量规划用例依赖。 */
export interface CapacityPlanningServiceDeps {
  readonly clock: Clock;
  readonly eventStore: LearningEventStore;
  readonly wordContentStore: WordContentStore;
  readonly bookCatalogStore: BookCatalogStore;
  readonly dailyPlanStore: DailyPlanStore;
  readonly scheduling: SchedulingService;
}

/** 一次刷新/读取的显式输入（目标来自 Space 级每日目标设置，由调用方读取传入）。 */
export interface CapacityPlanInput {
  readonly spaceId: string;
  readonly targetCapacity: number;
  readonly learningDaySettings: LearningDaySettings;
}

/** 进程内指纹缓存：Space → (指纹, 已落盘计划)。 */
interface MemoryCacheEntry {
  readonly fingerprint: string;
  readonly plan: DailyPlanRecord;
}

export class CapacityPlanningService {
  private readonly deps: CapacityPlanningServiceDeps;
  private readonly planCache = new Map<string, MemoryCacheEntry>();

  constructor(deps: CapacityPlanningServiceDeps) {
    this.deps = deps;
  }

  /**
   * 读侧：返回今日最近缓存视图，绝不运行蒙特卡洛。
   * 无落盘计划时 snapshot=null 且 stale=true（当天从未计算过，必须触发后台刷新）；
   * 有落盘计划但指纹不匹配时返回旧值且 stale=true；匹配时 stale=false。
   */
  getTodaysCapacityView(input: CapacityPlanInput): TodaysCapacityView {
    const today = resolveLearningDay(this.deps.clock.now(), input.learningDaySettings);
    const gathered = this.gatherInputs({ ...input, today });
    const cached = this.planCache.get(input.spaceId);
    if (cached !== undefined && cached.fingerprint === gathered.fingerprint) {
      return { snapshot: snapshotOf(cached.plan), stale: false };
    }
    const stored = this.deps.dailyPlanStore.get({ learningDay: today, spaceId: input.spaceId });
    if (stored === null) {
      return { snapshot: null, stale: true };
    }
    const stale = stored.riskMetrics.inputFingerprint !== gathered.fingerprint;
    if (!stale) {
      this.planCache.set(input.spaceId, { fingerprint: gathered.fingerprint, plan: stored });
    }
    return { snapshot: snapshotOf(stored), stale };
  }

  /**
   * 更新侧：计算输入与指纹，命中（内存或落盘）直接复用，未命中才模拟并落盘。
   * 固定种子保证同一事实状态的建议不抖动；落盘后从存储读回构造快照，保证展示值
   * 与历史审计值不存在内存分叉（V1 口径）。
   */
  refreshTodaysPlan(input: CapacityPlanInput): CapacityPlanSnapshot {
    const today = resolveLearningDay(this.deps.clock.now(), input.learningDaySettings);
    const gathered = this.gatherInputs({ ...input, today });
    const cached = this.planCache.get(input.spaceId);
    if (cached !== undefined && cached.fingerprint === gathered.fingerprint) {
      return snapshotOf(cached.plan);
    }
    const stored = this.deps.dailyPlanStore.get({ learningDay: today, spaceId: input.spaceId });
    if (stored !== null && stored.riskMetrics.inputFingerprint === gathered.fingerprint) {
      // 跨进程重启时内存缓存为空；落盘计划指纹相同说明上次写入后没有任何真实
      // 学习行为改变输入，直接复用，避免每天首次启动都重新跑秒级模拟（V1 口径）。
      this.planCache.set(input.spaceId, { fingerprint: gathered.fingerprint, plan: stored });
      return snapshotOf(stored);
    }

    const prediction = predictCapacity(gathered.request);
    const selected = prediction.candidates[prediction.suggestedFirstPassCount];
    if (selected === undefined) {
      throw new Error("容量预测候选缺失，无法构造每日计划");
    }
    const dueSnapshot: DueSnapshot = {
      dueWorkload: gathered.dueWorkload,
      overdueWorkload: gathered.overdueWorkload,
      tasks: [...gathered.taskSnapshots].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
      candidateActiveWordCount: gathered.candidateActiveWordCount,
    };
    const riskMetrics: RiskMetrics = {
      recentActualDailyWorkload: gathered.recentActual,
      recentActualSampleCount: gathered.sampleCount,
      historyWindowDays: CAPACITY_HISTORY_DAYS,
      riskCapacity: prediction.riskCapacity,
      riskQuantile: prediction.riskQuantile,
      reserveWorkload: prediction.reserveWorkload,
      sampleCount: CAPACITY_SAMPLE_COUNT,
      randomSeed: prediction.randomSeed,
      inputFingerprint: gathered.fingerprint,
      selectedCandidate: candidatePayload(selected),
      candidates: prediction.candidates.map(candidatePayload),
    };
    const plan: DailyPlanRecord = {
      learningDay: today,
      spaceId: input.spaceId,
      targetCapacity: input.targetCapacity,
      dueSnapshot,
      suggestedFirstPassCount: prediction.suggestedFirstPassCount,
      actualFirstPassCount: gathered.actualFirstPassCount,
      actualCompletedWorkload: gathered.actualCompletedWorkload,
      predictionWindowDays: prediction.horizonDays,
      riskMetrics,
      algorithmVersion: prediction.algorithmVersion,
    };
    this.deps.dailyPlanStore.upsert(plan);
    const persisted = this.deps.dailyPlanStore.get({ learningDay: today, spaceId: input.spaceId });
    if (persisted === null) {
      throw new Error("DailyPlan 写入后无法恢复");
    }
    this.planCache.set(input.spaceId, { fingerprint: gathered.fingerprint, plan: persisted });
    return snapshotOf(persisted);
  }

  // ---------------------------------------------------------------------------
  // 输入收集与指纹
  // ---------------------------------------------------------------------------

  /**
   * 收集一次预测所需的全部输入：开放任务、历史能力、列表投影、候选画像、稳定
   * 种子、当日实际完成。任何真实学习行为都会改变其中至少一项（V1 rebuild_today 口径）。
   */
  private gatherInputs(input: CapacityPlanInput & { readonly today: LearningDay }): {
    readonly request: CapacityPredictionRequest;
    readonly fingerprint: string;
    readonly dueWorkload: number;
    readonly overdueWorkload: number;
    readonly taskSnapshots: readonly DueTaskSnapshot[];
    readonly recentActual: number | null;
    readonly sampleCount: number;
    readonly candidateActiveWordCount: number;
    readonly actualFirstPassCount: number;
    readonly actualCompletedWorkload: number;
  } {
    const { today } = input;
    const projectedLists = this.deps.scheduling.projectSpaceLists({
      spaceId: input.spaceId,
      learningDaySettings: input.learningDaySettings,
    });
    const listIds = new Set(this.deps.bookCatalogStore.listListsForSpace(input.spaceId).map((record) => record.listId));

    // 开放任务只统计该 Space 内 PENDING/IN_PROGRESS 口径的任务——任务在 V2 是派生态，
    // 这里直接以"当日及之前仍未完成的派生任务"为开放集合（完成事实由事件承载）。
    const refresh = this.deps.scheduling.refreshSpaceTasks({
      spaceId: input.spaceId,
      learningDaySettings: input.learningDaySettings,
    });
    const taskSnapshots: DueTaskSnapshot[] = refresh.tasks.map((task) => ({
      taskId: task.taskId,
      listId: task.listId,
      taskType: task.taskType,
      learningDay: task.scheduledDay,
      workload: task.workload,
      dueReason: task.dueReason,
      status: "待处理",
    }));
    let dueWorkload = 0;
    let overdueWorkload = 0;
    for (const task of refresh.tasks) {
      if (task.scheduledDay < today) {
        overdueWorkload += task.workload;
      } else if (task.scheduledDay === today) {
        dueWorkload += task.workload;
      }
    }

    const recentPlans = this.deps.dailyPlanStore.listRecent({
      spaceId: input.spaceId,
      beforeDay: today,
      limit: CAPACITY_HISTORY_DAYS,
    });
    const sampleCount = recentPlans.length;
    const recentActual =
      sampleCount > 0
        ? recentPlans.reduce((sum, plan) => sum + plan.actualCompletedWorkload, 0) / sampleCount
        : null;
    // 模型以 0 表示"尚无实际能力样本"，此时风险容量回退到用户目标；界面仍用 null
    // 和样本数 0 明确展示未知，绝不把目标伪装成真实能力（V1 口径）。
    const modelRecentActual = recentActual === null ? 0 : recentActual;

    // 候选画像：活动词数取各 List 未掌握词数的均值（至少 1；无活动 List 时回退 6）。
    const activeCounts = projectedLists
      .map((list) => list.words.filter((word) => word.word.masteryStatus === "未掌握").length)
      .filter((count) => count > 0);
    const candidateActiveWordCount =
      activeCounts.length > 0 ? Math.max(1, Math.round(mean(activeCounts))) : 6;
    const reserve = Math.max(1, Math.ceil(input.targetCapacity * 0.15));
    const randomSeed = stableSeed(input.spaceId, today);
    const actuals = this.actualsForDay({ learningDay: today, listIds });

    const request = createCapacityPredictionRequest({
      today,
      targetCapacity: input.targetCapacity,
      recentActualDailyCapacity: modelRecentActual,
      existingLists: projectedLists,
      overdueWorkload,
      maximumNewLists: CAPACITY_MAXIMUM_NEW_LISTS,
      horizonDays: CAPACITY_HORIZON_DAYS,
      riskQuantile: CAPACITY_RISK_QUANTILE,
      reserveWorkload: reserve,
      sampleCount: CAPACITY_SAMPLE_COUNT,
      randomSeed,
      candidateProfile: createCandidateListProfile({
        activeWordCount: candidateActiveWordCount,
      }),
    });
    return {
      request,
      fingerprint: this.inputFingerprint(input.spaceId, actuals, request),
      dueWorkload,
      overdueWorkload,
      taskSnapshots,
      recentActual,
      sampleCount,
      candidateActiveWordCount,
      actualFirstPassCount: actuals.actualFirstPassCount,
      actualCompletedWorkload: actuals.actualCompletedWorkload,
    };
  }

  /**
   * 指纹 = domain 全输入指纹 ⊕ Space 与当日实际完成量。
   * V1 指纹覆盖模拟全部输入 + 当日实际；domain 指纹已覆盖模拟输入（含算法版本），
   * 这里叠加实际完成量与 Space，保证任何真实学习行为都会使指纹变化。
   */
  private inputFingerprint(
    spaceId: string,
    actuals: { readonly actualFirstPassCount: number; readonly actualCompletedWorkload: number },
    request: CapacityPredictionRequest,
  ): string {
    const domainFingerprint = computeCapacityInputFingerprint(request);
    const suffix = `${domainFingerprint}|${spaceId}|${actuals.actualFirstPassCount}|${actuals.actualCompletedWorkload}`;
    return hashTextFnv1a(suffix).toString(16).padStart(8, "0");
  }

  /**
   * 从 List 粒度完成事实计算首过数和正式工作量，忽略词条级辅助事件。
   * 工作量事件集 = firstPassRecorded / reviewOnlyCompleted / testFollowedByReviewCompleted，
   * 目标必须是本 Space 的 List（V1 _actuals_for_day 口径）。
   */
  private actualsForDay(input: {
    readonly learningDay: LearningDay;
    readonly listIds: ReadonlySet<string>;
  }): { readonly actualFirstPassCount: number; readonly actualCompletedWorkload: number } {
    const workloadEventTypes = new Set([
      "firstPassRecorded",
      "reviewOnlyCompleted",
      "testFollowedByReviewCompleted",
    ]);
    let firstPassCount = 0;
    let completedWorkload = 0;
    for (const event of this.deps.eventStore.listAllEvents()) {
      if (event.learningDay !== input.learningDay || !workloadEventTypes.has(event.eventType)) {
        continue;
      }
      if (event.eventType !== "firstPassRecorded" && !input.listIds.has(event.targetId)) {
        // List 级完成事件的目标是 List；条目级首过只看学习日。
        continue;
      }
      if (event.eventType === "firstPassRecorded") {
        firstPassCount += 1;
      }
      const workload = event.metadata["workload"];
      if (typeof workload !== "number" || !Number.isInteger(workload) || workload < 0) {
        throw new Error("完成事件工作量无效");
      }
      completedWorkload += workload;
    }
    return { actualFirstPassCount: firstPassCount, actualCompletedWorkload: completedWorkload };
  }
}

/** 使用稳定摘要而非进程随机化生成可跨重启复现的种子（V1 _stable_seed 等价实现）。 */
function stableSeed(spaceId: string, learningDay: LearningDay): number {
  return hashTextFnv1a(`capacity-monte-carlo-v2|${spaceId}|${learningDay}`);
}

/** 数值均值。 */
function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 把无限清空时间转成 JSON null，避免写入非标准 Infinity（V1 _candidate_payload 口径）。 */
function candidatePayload(candidate: CandidateMetrics): CapacityCandidatePayload {
  return {
    newListCount: candidate.newListCount,
    expectedWorkloadByDay: [...candidate.expectedWorkloadByDay],
    riskQuantileWorkloadByDay: [...candidate.riskQuantileWorkloadByDay],
    overloadProbability: candidate.overloadProbability,
    expectedMaxBacklog: candidate.expectedMaxBacklog,
    riskQuantileMaxBacklog: candidate.riskQuantileMaxBacklog,
    expectedClearanceDays: Number.isFinite(candidate.expectedClearanceDays)
      ? candidate.expectedClearanceDays
      : null,
  };
}

/** 从落盘计划构造看板快照（字段语义与 V1 _snapshot 一致）。 */
function snapshotOf(plan: DailyPlanRecord): CapacityPlanSnapshot {
  const selected = plan.riskMetrics.selectedCandidate;
  return {
    targetCapacity: plan.targetCapacity,
    recentActualDailyWorkload: plan.riskMetrics.recentActualDailyWorkload,
    recentActualSampleCount: plan.riskMetrics.recentActualSampleCount,
    dueWorkload: plan.dueSnapshot.dueWorkload,
    overdueWorkload: plan.dueSnapshot.overdueWorkload,
    remainingCapacity: Math.max(
      0,
      plan.targetCapacity - plan.dueSnapshot.dueWorkload - plan.dueSnapshot.overdueWorkload,
    ),
    suggestedFirstPassCount: plan.suggestedFirstPassCount,
    riskCapacity: plan.riskMetrics.riskCapacity,
    predictionWindowDays: plan.predictionWindowDays,
    riskQuantilePercent: Math.round(plan.riskMetrics.riskQuantile * 100),
    reserveWorkload: plan.riskMetrics.reserveWorkload,
    overloadProbability: selected.overloadProbability,
    expectedMaxBacklog: selected.expectedMaxBacklog,
    riskQuantileMaxBacklog: selected.riskQuantileMaxBacklog,
    expectedClearanceDays: selected.expectedClearanceDays,
    riskWorkloadByDay: [...selected.riskQuantileWorkloadByDay],
    algorithmVersion: plan.algorithmVersion,
  };
}
