/**
 * 固定随机种子的滚动时域蒙特卡洛容量预测（移植 V1 domain/capacity.py，算法 v2）。
 *
 * 确定任务按调用方给出的真实工作量逐日精确计入；测试成败、等待校验和长期验证结果
 * 才使用概率抽样。模拟结果只形成软建议，不隐藏任务，也不会修改用户设置的每日目标。
 *
 * 算法版本记录（复习调度算法第 10 章）：
 * - capacity-monte-carlo-v1：每个候选新增数量独立完整重放全部存量 List 的随机路径。
 * - capacity-monte-carlo-v2：利用"模拟中各 List 演化相互独立"的事实，存量 List 路径
 *   只模拟一次，候选新增按单 List 路径池求和组合；同一种子下点值与 v1 不同，但联合
 *   分布完全一致。抽样流划分：存量路径用 `seed + 样本号`，候选 i 用
 *   `seed + (i+1) × 1_000_003 + 样本号`，与 V1 逐字段一致。
 *
 * 随机源说明：使用可注入种子的确定性伪随机数发生器（mulberry32），保证"相同输入 +
 * 相同算法版本 + 相同种子 → 完全相同输出"。它与 Python random（MT19937）产生的点值
 * 不同，但只影响具体抽样值，不改变任何行为契约（确定性、固定项精确、建议规则）。
 */

import { MasteryStatus, ShortTermPassCount, TaskType, TestJudgement, WordListStage } from "./enums.ts";
import { createWord, type Word } from "./entities.ts";
import {
  applyTestJudgement,
  createSchedulableList,
  createSchedulableWord,
  generateListTask,
  listSatisfiesSynchronization,
  type ListTask,
  type SchedulableList,
  type SchedulableWord,
} from "./scheduling.ts";
import { addLearningDays, daysBetweenLearningDays, type LearningDay } from "./learningDay.ts";

/** 容量算法版本常量；随 DailyPlan 持久化，升级只影响未来预测。 */
export const CAPACITY_ALGORITHM_VERSION = "capacity-monte-carlo-v2";

/** 已到期、已逾期或由真实事件锚点确定的 List 粒度工作量。 */
export interface FixedWorkload {
  readonly taskId: string;
  readonly learningDay: LearningDay;
  readonly workload: number;
}

/** 构造固定工作量并拒绝空标识与非正工作量。 */
export function createFixedWorkload(input: FixedWorkload): FixedWorkload {
  if (input.taskId.trim().length === 0) {
    throw new Error("确定任务标识不能为空");
  }
  if (input.workload <= 0) {
    throw new Error("确定任务工作量必须大于 0");
  }
  return input;
}

/** 新增一个首过 List 后用于抽样的明确先验，不参与正式调度日期计算。 */
export interface CandidateListProfile {
  readonly activeWordCount: number;
  readonly shortTermSuccessProbability: number;
  readonly waitingCheckSuccessProbability: number;
  readonly longTermSuccessProbability: number;
}

/** V1 缺省候选画像（活动词数 6，三项通过概率先验）。 */
export const DEFAULT_CANDIDATE_PROFILE: CandidateListProfile = {
  activeWordCount: 6,
  shortTermSuccessProbability: 0.76,
  waitingCheckSuccessProbability: 0.82,
  longTermSuccessProbability: 0.72,
};

/** 构造候选画像并校验概率取值范围。 */
export function createCandidateListProfile(
  input: Partial<CandidateListProfile>,
): CandidateListProfile {
  const profile: CandidateListProfile = {
    activeWordCount: input.activeWordCount ?? DEFAULT_CANDIDATE_PROFILE.activeWordCount,
    shortTermSuccessProbability:
      input.shortTermSuccessProbability ??
      DEFAULT_CANDIDATE_PROFILE.shortTermSuccessProbability,
    waitingCheckSuccessProbability:
      input.waitingCheckSuccessProbability ??
      DEFAULT_CANDIDATE_PROFILE.waitingCheckSuccessProbability,
    longTermSuccessProbability:
      input.longTermSuccessProbability ?? DEFAULT_CANDIDATE_PROFILE.longTermSuccessProbability,
  };
  if (profile.activeWordCount < 0) {
    throw new Error("候选 List 活动 Word 数量不得小于 0");
  }
  for (const probability of [
    profile.shortTermSuccessProbability,
    profile.waitingCheckSuccessProbability,
    profile.longTermSuccessProbability,
  ]) {
    if (probability < 0 || probability > 1) {
      throw new Error("通过概率必须位于 0 到 1 之间");
    }
  }
  return profile;
}

/** 一次 DailyPlan 预测的全部显式输入。 */
export interface CapacityPredictionRequest {
  readonly today: LearningDay;
  readonly targetCapacity: number;
  /** 最近实际日均完成工作量；0 表示"尚无实际能力样本"（风险容量回退到用户目标）。 */
  readonly recentActualDailyCapacity: number;
  readonly fixedWorkloads: readonly FixedWorkload[];
  readonly existingLists: readonly SchedulableList[];
  readonly overdueWorkload: number;
  readonly maximumNewLists: number;
  readonly horizonDays: number;
  readonly riskQuantile: number;
  readonly reserveWorkload: number;
  readonly sampleCount: number;
  readonly randomSeed: number;
  readonly candidateProfile: CandidateListProfile;
}

const DEFAULT_REQUEST = {
  fixedWorkloads: [] as readonly FixedWorkload[],
  existingLists: [] as readonly SchedulableList[],
  overdueWorkload: 0,
  maximumNewLists: 6,
  horizonDays: 21,
  riskQuantile: 0.85,
  reserveWorkload: 1,
  sampleCount: 300,
  randomSeed: 0,
} as const;

/** 构造预测请求并执行与 V1 一致的取值校验。 */
export function createCapacityPredictionRequest(
  input: Pick<CapacityPredictionRequest, "today" | "targetCapacity" | "recentActualDailyCapacity"> &
    Partial<Omit<CapacityPredictionRequest, keyof Pick<CapacityPredictionRequest, "today" | "targetCapacity" | "recentActualDailyCapacity">>>,
): CapacityPredictionRequest {
  const request: CapacityPredictionRequest = {
    today: input.today,
    targetCapacity: input.targetCapacity,
    recentActualDailyCapacity: input.recentActualDailyCapacity,
    fixedWorkloads: input.fixedWorkloads ?? DEFAULT_REQUEST.fixedWorkloads,
    existingLists: input.existingLists ?? DEFAULT_REQUEST.existingLists,
    overdueWorkload: input.overdueWorkload ?? DEFAULT_REQUEST.overdueWorkload,
    maximumNewLists: input.maximumNewLists ?? DEFAULT_REQUEST.maximumNewLists,
    horizonDays: input.horizonDays ?? DEFAULT_REQUEST.horizonDays,
    riskQuantile: input.riskQuantile ?? DEFAULT_REQUEST.riskQuantile,
    reserveWorkload: input.reserveWorkload ?? DEFAULT_REQUEST.reserveWorkload,
    sampleCount: input.sampleCount ?? DEFAULT_REQUEST.sampleCount,
    randomSeed: input.randomSeed ?? DEFAULT_REQUEST.randomSeed,
    candidateProfile: input.candidateProfile ?? createCandidateListProfile({}),
  };
  if (request.targetCapacity < 0 || request.recentActualDailyCapacity < 0) {
    throw new Error("目标工作量与最近实际能力不得小于 0");
  }
  if (request.overdueWorkload < 0 || request.maximumNewLists < 0) {
    throw new Error("逾期工作量和最大候选新增数不得小于 0");
  }
  if (request.horizonDays <= 0 || request.sampleCount <= 0) {
    throw new Error("预测窗口和样本数必须大于 0");
  }
  if (request.riskQuantile <= 0 || request.riskQuantile >= 1) {
    throw new Error("风险分位数必须位于 0 与 1 之间");
  }
  if (request.reserveWorkload < 0) {
    throw new Error("容量预留不得小于 0");
  }
  return request;
}

/** 一个候选新增数量的完整可解释风险指标。 */
export interface CandidateMetrics {
  readonly newListCount: number;
  readonly expectedWorkloadByDay: readonly number[];
  readonly riskQuantileWorkloadByDay: readonly number[];
  readonly overloadProbability: number;
  readonly expectedMaxBacklog: number;
  readonly riskQuantileMaxBacklog: number;
  /** 无限清空时间以 Infinity 表示；持久化方负责转成 null（V1 口径）。 */
  readonly expectedClearanceDays: number;
}

/** 容量建议与全部候选比较结果，保留目标和实际能力的分离展示。 */
export interface CapacityPrediction {
  readonly suggestedFirstPassCount: number;
  readonly targetCapacity: number;
  readonly recentActualDailyCapacity: number;
  readonly riskCapacity: number;
  readonly horizonDays: number;
  readonly riskQuantile: number;
  readonly reserveWorkload: number;
  readonly randomSeed: number;
  readonly candidates: readonly CandidateMetrics[];
  readonly algorithmVersion: string;
}

/**
 * 确定性伪随机数发生器（mulberry32，32 位状态）。
 *
 * 选择理由：实现短小、无依赖、周期 2^32 足以覆盖 300 样本 × 21 天的抽样量；
 * 种子为 32 位整数（V1 稳定种子函数恰好截取 SHA256 前 4 字节，同为 32 位）。
 * 只要求"同种子同序列"，与 Python MT19937 无兼容义务（见文件头说明）。
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 最近秩分位数：避免不同统计库版本产生插值差异（与 V1 `_quantile` 一致）。 */
function quantile(values: readonly number[], quantileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(quantileValue * ordered.length) - 1);
  const selected = ordered[index];
  // index 由 ordered.length 收敛到合法区间，防御分支只为满足严格索引检查。
  if (selected === undefined) {
    throw new Error("分位数计算索引越界");
  }
  return selected;
}

/** 读取定长负荷行中某一天的值；行长度由构造保证，越界按编程错误处理。 */
function dayValue(row: readonly number[], day: number): number {
  const value = row[day];
  if (value === undefined) {
    throw new Error(`负荷行缺少第 ${day} 天的值`);
  }
  return value;
}

/** 算术平均（对应 Python statistics.fmean）。 */
function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

/** 模拟内部只需稳定绝对时间，固定使用 UTC 上午九点（与 V1 `_day_instant` 一致）。 */
function dayInstant(day: LearningDay): string {
  return `${day}T09:00:00Z`;
}

/** 从今日真实首过构造状态 0 的候选 List；空 List 不产生后续任务。 */
function candidateSnapshot(input: {
  candidateIndex: number;
  profile: CandidateListProfile;
  today: LearningDay;
}): SchedulableList {
  const words: SchedulableWord[] = [];
  for (let wordIndex = 0; wordIndex < input.profile.activeWordCount; wordIndex += 1) {
    const word: Word = createWord({
      id: `candidate-${input.candidateIndex}-word-${wordIndex}`,
      listId: `candidate-${input.candidateIndex}`,
      originalSpelling: `candidate-${wordIndex}`,
      normalizedKey: `candidate-${wordIndex}`,
      manualMeaning: "容量模拟占位义项",
      shortTermPassCount: ShortTermPassCount.Zero,
      masteryStatus: MasteryStatus.Unmastered,
      shortTermCycleStartedAt: dayInstant(input.today),
    });
    words.push(createSchedulableWord({ word, t0Day: input.today }));
  }
  return createSchedulableList({
    listId: `candidate-${input.candidateIndex}`,
    stage: WordListStage.ShortTermSync,
    words,
  });
}

/**
 * 执行状态机后同步更新领域调度快照中的学习日锚点。
 *
 * 锚点只在真实发生变化（状态机写入了新的起点时间）时更新为当天，保持与 V1
 * `_project_result` 逐字段一致：锚点跟随 Word 的真实状态，而不是按天数推断。
 */
function projectResult(
  item: SchedulableWord,
  input: { taskType: TaskType; judgement: TestJudgement; day: LearningDay },
): SchedulableWord {
  const previous = item.word;
  const updated = applyTestJudgement(previous, {
    taskType: input.taskType,
    judgement: input.judgement,
    occurredAt: dayInstant(input.day),
  });
  if (updated.masteryStatus === MasteryStatus.Mastered) {
    return createSchedulableWord({ word: updated });
  }
  if (updated.shortTermPassCount === ShortTermPassCount.Zero) {
    const t0Changed = updated.shortTermCycleStartedAt !== previous.shortTermCycleStartedAt;
    return createSchedulableWord({
      word: updated,
      t0Day: t0Changed ? input.day : item.t0Day,
    });
  }
  if (updated.shortTermPassCount === ShortTermPassCount.One) {
    const t1Changed = updated.shortTermOneStartedAt !== previous.shortTermOneStartedAt;
    return createSchedulableWord({
      word: updated,
      t0Day: item.t0Day,
      t1Day: t1Changed ? input.day : item.t1Day,
    });
  }
  const t2Changed = updated.waitingCheckStartedAt !== previous.waitingCheckStartedAt;
  return createSchedulableWord({
    word: updated,
    t0Day: item.t0Day,
    t1Day: item.t1Day,
    t2Day: t2Changed ? input.day : item.t2Day,
  });
}

/** 把测试阶段映射到独立的通过概率先验。 */
function taskProbability(taskType: TaskType, profile: CandidateListProfile): number {
  if (taskType === TaskType.WaitingCheck) {
    return profile.waitingCheckSuccessProbability;
  }
  if (taskType === TaskType.LongTermValidation) {
    return profile.longTermSuccessProbability;
  }
  return profile.shortTermSuccessProbability;
}

/**
 * 完成当天唯一 List 测试任务：对任务覆盖的每个 Word 按通过概率抽样最终判断，
 * 并沿状态机推进调度快照（2026-10-02 口径：复习不产生任务，模拟里没有任何
 * 仅复习"完成"记账）。
 */
function completeSimulatedTask(
  snapshot: SchedulableList,
  input: {
    task: ListTask;
    day: LearningDay;
    profile: CandidateListProfile;
    randomSource: () => number;
  },
): SchedulableList {
  const demandByWord = new Map(input.task.testDemands.map((demand) => [demand.wordId, demand]));
  const updatedWords: SchedulableWord[] = [];
  for (const item of snapshot.words) {
    const demand = demandByWord.get(item.word.id);
    if (demand === undefined) {
      updatedWords.push(item);
      continue;
    }
    const probability = taskProbability(demand.taskType, input.profile);
    const judgement =
      input.randomSource() < probability ? TestJudgement.Recognized : TestJudgement.NotRecognized;
    updatedWords.push(
      projectResult(item, {
        taskType: demand.taskType,
        judgement,
        day: input.day,
      }),
    );
  }

  const updated: SchedulableList = {
    ...snapshot,
    words: updatedWords,
  };
  if (input.task.taskType === TaskType.LongTermValidation) {
    const allMastered = updated.words.every(
      (item) => item.word.masteryStatus === MasteryStatus.Mastered,
    );
    if (allMastered) {
      return { ...updated, stage: WordListStage.Mastered, synchronizedDay: null };
    }
    return { ...updated, stage: WordListStage.ShortTermSync, synchronizedDay: null };
  }
  // 模拟口径与应用层写事件口径一致：抽样后同步条件首次满足即视为当批答案写入
  // listSynchronized，整个 List 从当天进入长期验证（TS = 满足当天）。
  if (listSatisfiesSynchronization(updated)) {
    return {
      ...updated,
      stage: WordListStage.LongTermValidation,
      synchronizedDay: input.day,
    };
  }
  return updated;
}

/** 运行一个完整随机情景，只返回逐日负荷；积压与超载由调用方在组合路径后统一计算。 */
function simulateDailyLoads(
  request: CapacityPredictionRequest,
  input: {
    snapshotsInput: readonly SchedulableList[];
    fixedByDay: Map<LearningDay, number>;
    sampleSeed: number;
    firstPassLoadToday: number;
  },
): number[] {
  const randomSource = createRandom(input.sampleSeed);
  let snapshots = [...input.snapshotsInput];
  const dailyLoads: number[] = [];
  for (let offset = 0; offset < request.horizonDays; offset += 1) {
    const day = addLearningDays(request.today, offset);
    let load = input.fixedByDay.get(day) ?? 0;
    if (offset === 0) {
      load += input.firstPassLoadToday;
    }
    const nextSnapshots: SchedulableList[] = [];
    for (const snapshot of snapshots) {
      const task = generateListTask(snapshot, day);
      if (task !== null) {
        load += task.workload;
        nextSnapshots.push(
          completeSimulatedTask(snapshot, {
            task,
            day,
            profile: request.candidateProfile,
            randomSource,
          }),
        );
      } else {
        nextSnapshots.push(snapshot);
      }
    }
    snapshots = nextSnapshots;
    dailyLoads.push(load);
  }
  return dailyLoads;
}

/**
 * 沿一条逐日负荷路径递推积压，返回最大积压、预计清空天数和是否超载。
 *
 * 预测窗口结束后不伪造未来没有任务；这里只报告若不再新增负荷，当前积压至少需要
 * 的清空天数（容量为 0 且仍有积压时视为永远无法清空，返回 Infinity）。
 */
function pathMetrics(
  dailyLoads: readonly number[],
  input: { riskCapacity: number; reserveWorkload: number },
): [number, number, boolean] {
  const dailyLimit = Math.max(0, input.riskCapacity - input.reserveWorkload);
  let backlog = 0;
  let maximumBacklog = 0;
  let overloaded = false;
  for (const load of dailyLoads) {
    backlog = Math.max(0, backlog + load - input.riskCapacity);
    maximumBacklog = Math.max(maximumBacklog, backlog);
    if (load > dailyLimit) {
      overloaded = true;
    }
  }
  let clearanceDays =
    backlog === 0 || input.riskCapacity === 0
      ? 0
      : Math.ceil(backlog / input.riskCapacity);
  if (input.riskCapacity === 0 && backlog > 0) {
    clearanceDays = Number.POSITIVE_INFINITY;
  }
  return [maximumBacklog, clearanceDays, overloaded];
}

/**
 * 比较新增首过候选数并选择风险范围内能够推进最多的数量（v2 路径池复用）。
 *
 * 存量 List 的随机路径只模拟一次；每个候选新增 List 各自只模拟一条单 List 路径池；
 * 候选 k 的逐日负荷 = 存量路径 + 前 k 条候选路径之和。模拟总量从
 * "候选数 × 样本数 × 全部 List"降为"样本数 ×（存量 List + 1）"。
 */
export function predictCapacity(request: CapacityPredictionRequest): CapacityPrediction {
  // 最近实际能力只用于风险估计；目标值原样保留并单独输出，绝不静默覆盖用户设置。
  let riskCapacity = request.targetCapacity;
  if (request.recentActualDailyCapacity > 0) {
    riskCapacity = Math.min(riskCapacity, request.recentActualDailyCapacity);
  }

  const fixedByDay = new Map<LearningDay, number>();
  const orderedFixed = [...request.fixedWorkloads].sort(
    (a, b) =>
      a.learningDay !== b.learningDay
        ? a.learningDay < b.learningDay
          ? -1
          : 1
        : a.taskId < b.taskId
          ? -1
          : 1,
  );
  for (const workload of orderedFixed) {
    fixedByDay.set(workload.learningDay, (fixedByDay.get(workload.learningDay) ?? 0) + workload.workload);
  }

  const baseSnapshots = [...request.existingLists].sort((a, b) =>
    a.listId < b.listId ? -1 : a.listId > b.listId ? 1 : 0,
  );
  const basePaths: number[][] = [];
  for (let sampleIndex = 0; sampleIndex < request.sampleCount; sampleIndex += 1) {
    basePaths.push(
      simulateDailyLoads(request, {
        snapshotsInput: baseSnapshots,
        fixedByDay,
        sampleSeed: request.randomSeed + sampleIndex,
        firstPassLoadToday: 0,
      }),
    );
  }

  const candidatePools: number[][][] = [];
  for (let candidateIndex = 0; candidateIndex < request.maximumNewLists; candidateIndex += 1) {
    const snapshot = candidateSnapshot({
      candidateIndex,
      profile: request.candidateProfile,
      today: request.today,
    });
    const pool: number[][] = [];
    for (let sampleIndex = 0; sampleIndex < request.sampleCount; sampleIndex += 1) {
      pool.push(
        simulateDailyLoads(request, {
          snapshotsInput: [snapshot],
          fixedByDay: new Map(),
          // 候选流与存量流划分不同的种子段，与 V1 v2 抽样流划分逐字段一致。
          sampleSeed: request.randomSeed + (candidateIndex + 1) * 1_000_003 + sampleIndex,
          firstPassLoadToday: 1,
        }),
      );
    }
    candidatePools.push(pool);
  }

  const candidateMetrics: CandidateMetrics[] = [];
  for (let newListCount = 0; newListCount <= request.maximumNewLists; newListCount += 1) {
    const maximumBacklogs: number[] = [];
    const clearanceDays: number[] = [];
    let overloadedSamples = 0;
    const loadsBySample: number[][] = [];
    for (let sampleIndex = 0; sampleIndex < request.sampleCount; sampleIndex += 1) {
      const basePath = basePaths[sampleIndex];
      if (basePath === undefined) {
        throw new Error("存量路径样本缺失");
      }
      const loads = [...basePath];
      for (let candidateIndex = 0; candidateIndex < newListCount; candidateIndex += 1) {
        const candidatePath = candidatePools[candidateIndex]?.[sampleIndex];
        if (candidatePath === undefined) {
          throw new Error("候选路径样本缺失");
        }
        const candidateLoads = candidatePath;
        for (let day = 0; day < request.horizonDays; day += 1) {
          loads[day] = dayValue(loads, day) + dayValue(candidateLoads, day);
        }
      }
      const [maximumBacklog, clearance, overloaded] = pathMetrics(loads, {
        riskCapacity,
        reserveWorkload: request.reserveWorkload,
      });
      loadsBySample.push(loads);
      maximumBacklogs.push(maximumBacklog);
      clearanceDays.push(clearance);
      if (overloaded) {
        overloadedSamples += 1;
      }
    }
    const expectedByDay: number[] = [];
    const quantileByDay: number[] = [];
    for (let day = 0; day < request.horizonDays; day += 1) {
      expectedByDay.push(mean(loadsBySample.map((sample) => dayValue(sample, day))));
      quantileByDay.push(
        quantile(loadsBySample.map((sample) => dayValue(sample, day)), request.riskQuantile),
      );
    }
    candidateMetrics.push({
      newListCount,
      expectedWorkloadByDay: expectedByDay,
      riskQuantileWorkloadByDay: quantileByDay,
      overloadProbability: overloadedSamples / request.sampleCount,
      expectedMaxBacklog: mean(maximumBacklogs),
      riskQuantileMaxBacklog: quantile(maximumBacklogs, request.riskQuantile),
      expectedClearanceDays: mean(clearanceDays),
    });
  }

  // 专项算法规格已经明确严重积压时建议为 0；它仍是软建议，界面不得禁止用户实际首过。
  let suggestedCount: number;
  if (request.overdueWorkload >= request.targetCapacity) {
    suggestedCount = 0;
  } else {
    const allowedOverloadProbability = 1 - request.riskQuantile;
    const feasible = candidateMetrics
      .filter(
        (item) =>
          item.overloadProbability <= allowedOverloadProbability &&
          item.riskQuantileMaxBacklog <= request.reserveWorkload,
      )
      .map((item) => item.newListCount);
    suggestedCount = feasible.length > 0 ? Math.max(...feasible) : 0;
  }
  return {
    suggestedFirstPassCount: suggestedCount,
    targetCapacity: request.targetCapacity,
    recentActualDailyCapacity: request.recentActualDailyCapacity,
    riskCapacity,
    horizonDays: request.horizonDays,
    riskQuantile: request.riskQuantile,
    reserveWorkload: request.reserveWorkload,
    randomSeed: request.randomSeed,
    candidates: candidateMetrics,
    algorithmVersion: CAPACITY_ALGORITHM_VERSION,
  };
}

/** 只看今日剩余容量的对照基线，不考虑新增 List 的任何未来负荷。 */
export function simpleSubtractionSuggestion(input: {
  targetCapacity: number;
  dueWorkload: number;
  overdueWorkload: number;
  maximumNewLists: number;
}): number {
  const { targetCapacity, dueWorkload, overdueWorkload, maximumNewLists } = input;
  if (
    targetCapacity < 0 ||
    dueWorkload < 0 ||
    overdueWorkload < 0 ||
    maximumNewLists < 0
  ) {
    throw new Error("容量基线输入不得小于 0");
  }
  const remaining = targetCapacity - dueWorkload - overdueWorkload;
  return Math.min(maximumNewLists, Math.max(0, remaining));
}

/** 使用全部测试成功路径的前瞻对照，显式暴露理想路径低估风险的问题。 */
export function deterministicForwardPrediction(
  request: CapacityPredictionRequest,
): CapacityPrediction {
  const optimisticProfile = createCandidateListProfile({
    ...request.candidateProfile,
    shortTermSuccessProbability: 1.0,
    waitingCheckSuccessProbability: 1.0,
    longTermSuccessProbability: 1.0,
  });
  return predictCapacity({
    ...request,
    candidateProfile: optimisticProfile,
    sampleCount: 1,
    randomSeed: 0,
  });
}

// ---------------------------------------------------------------------------
// 输入指纹与缓存接口（复习调度算法第 10 章 v2 记录：指纹不变时直接复用已落盘计划）
// ---------------------------------------------------------------------------

/**
 * 确定性序列化：对象键排序、Set 展开为排序数组。
 *
 * 业务原因：指纹必须只由真实输入决定。Set 没有稳定遍历顺序，若直接序列化会导致
 * 同一事实状态跨进程产生不同指纹，缓存永远失效；键排序保证属性书写顺序不影响结果。
 */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (value instanceof Set) {
    return stableSerialize([...value].map(String).sort());
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
}

/** FNV-1a 32 位哈希（十六进制）：指纹只用于相等比较，不承担密码学职责。 */
function hashFingerprint(serialized: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 计算一次容量预测的输入指纹。
 *
 * 指纹覆盖模拟的全部显式输入（含算法版本）：任何真实学习行为（任务、历史能力、
 * 列表状态、候选规模、种子或设置变化）都会改变其中至少一项；指纹一致时调用方可
 * 直接复用已落盘计划，不重新模拟（跨进程重启亦然，指纹随 DailyPlan 持久化）。
 */
export function computeCapacityInputFingerprint(request: CapacityPredictionRequest): string {
  const payload = {
    algorithmVersion: CAPACITY_ALGORITHM_VERSION,
    today: request.today,
    targetCapacity: request.targetCapacity,
    recentActualDailyCapacity: request.recentActualDailyCapacity,
    fixedWorkloads: [...request.fixedWorkloads]
      .map((item) => ({ taskId: item.taskId, learningDay: item.learningDay, workload: item.workload }))
      .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)),
    existingLists: [...request.existingLists].map((list) => ({
      listId: list.listId,
      stage: list.stage,
      synchronizedDay: list.synchronizedDay,
      words: list.words.map((item) => ({
        wordId: item.word.id,
        passCount: item.word.shortTermPassCount,
        masteryStatus: item.word.masteryStatus,
        t0Day: item.t0Day,
        t1Day: item.t1Day,
        t2Day: item.t2Day,
      })),
    })),
    overdueWorkload: request.overdueWorkload,
    maximumNewLists: request.maximumNewLists,
    horizonDays: request.horizonDays,
    riskQuantile: request.riskQuantile,
    reserveWorkload: request.reserveWorkload,
    sampleCount: request.sampleCount,
    randomSeed: request.randomSeed,
    candidateProfile: request.candidateProfile,
  };
  return hashFingerprint(stableSerialize(payload));
}

/**
 * 容量预测缓存纯接口：输入指纹 → 预测结果。
 *
 * 只定义契约，不做持久化——具体落盘（DailyPlan risk_metrics 的 inputFingerprint）
 * 由应用层/持久层实现。同一种子下相同业务状态的输出必然相同，因此缓存命中不会
 * 产生与重新模拟不同的结果；用户未操作时建议值不得抖动正是靠该接口兜底。
 */
export interface CapacityPlanCache {
  /** 按输入指纹取回已计算的预测；未命中返回 undefined。 */
  get(fingerprint: string): CapacityPrediction | undefined;
  /** 记录指纹与预测结果的对应关系。 */
  set(fingerprint: string, prediction: CapacityPrediction): void;
}

/** 进程内记忆缓存实现（无持久化），供测试与简单宿主直接使用。 */
export function createInMemoryCapacityPlanCache(): CapacityPlanCache {
  const store = new Map<string, CapacityPrediction>();
  return {
    get: (fingerprint) => store.get(fingerprint),
    set: (fingerprint, prediction) => {
      store.set(fingerprint, prediction);
    },
  };
}

/** 供调度记录使用的逾期天数口径：计划日相对参考日的自然日差（不小于 0）。 */
export function overdueDaysOf(scheduledDay: LearningDay, today: LearningDay): number {
  return Math.max(0, daysBetweenLearningDays(scheduledDay, today));
}
