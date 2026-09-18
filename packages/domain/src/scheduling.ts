/**
 * 可解释调度状态机与 List 粒度任务聚合（移植 V1 domain/scheduling.py）。
 *
 * 本模块只处理已经转换为学习日的确定输入，不读取系统时间、时区或数据库；应用层
 * 负责把绝对时间映射为学习日，因而同一状态、同一学习日和同一算法版本必然得到
 * 完全相同的结果。
 *
 * 状态机不变量（复习调度算法 5-9 章）：
 * - 三个日期增量始终相对同一个 T0 计算（T0+1 测试、T0+2 仅复习、T0+4 晋级测试）；
 *   达到短期通过次数 1 后由同一组增量做阶段差分（T1+1 仅复习、T1+3 晋级测试），
 *   不引入特殊参数。
 * - 短期测试失败（0 或 1）重置为 0 并以真实失败日生成新 T0；等待校验失败只降为 1
 *   并以校验日生成新 T1，绝不伪造 T0。
 * - 等待校验从 T2 起算 7 个自然日，绝不从 T0 或首过日期起算。
 * - 同步条件一旦满足，短期需求立即停止；长期验证阶段是唯一无接触例外。
 * - 逾期不生成虚拟补做任务：计划到期日保持不变并用于计算逾期程度，多个逾期需求
 *   折叠为当前唯一真实任务。
 */

import {
  DueReason,
  MasteryStatus,
  ShortTermPassCount,
  TaskType,
  TestJudgement,
  WordListStage,
  type DueReason as DueReasonType,
  type TaskType as TaskTypeType,
  type WordListStage as WordListStageType,
} from "./enums.ts";
import { addLearningDays, daysBetweenLearningDays, type LearningDay } from "./learningDay.ts";

/** 调度算法版本；随任务与重放结果持久化，供未来审计与回放。 */
export const SCHEDULER_ALGORITHM_VERSION = "scheduler-v1";

/**
 * 调度所需的 Word 最小视图。
 *
 * 领域实体 Word 结构性满足本接口；重放器只需要派生这几个字段即可参与调度，
 * 不必伪造义项等与调度无关的内容字段（结构子类型保证两种来源可混用）。
 */
export interface SchedulableWordSource {
  readonly id: string;
  readonly shortTermPassCount: ShortTermPassCount;
  readonly masteryStatus: MasteryStatus;
  readonly shortTermCycleStartedAt: string | null;
  readonly shortTermOneStartedAt: string | null;
  readonly waitingCheckStartedAt: string | null;
}

/** 把绝对时间锚点投影为学习日后的 Word 调度快照。 */
export interface SchedulableWord {
  readonly word: SchedulableWordSource;
  readonly t0Day: LearningDay | null;
  readonly t1Day: LearningDay | null;
  readonly t2Day: LearningDay | null;
}

/**
 * 构造调度快照，要求学习日锚点与 Word 当前短期状态严格对应。
 *
 * 已掌握 Word 不参与短期调度，锚点可以为空；未掌握 Word 必须提供与当前短期
 * 通过次数对应的学习日起点，否则历史不可回放。
 */
export function createSchedulableWord(input: {
  word: SchedulableWordSource;
  t0Day?: LearningDay | null;
  t1Day?: LearningDay | null;
  t2Day?: LearningDay | null;
}): SchedulableWord {
  const { word } = input;
  if (word.masteryStatus === MasteryStatus.Mastered) {
    return {
      word,
      t0Day: input.t0Day ?? null,
      t1Day: input.t1Day ?? null,
      t2Day: input.t2Day ?? null,
    };
  }
  const requiredDay =
    word.shortTermPassCount === ShortTermPassCount.Zero
      ? input.t0Day
      : word.shortTermPassCount === ShortTermPassCount.One
        ? input.t1Day
        : input.t2Day;
  if (requiredDay === null || requiredDay === undefined) {
    throw new Error("活动 Word 必须提供与当前短期通过次数对应的学习日起点");
  }
  return {
    word,
    t0Day: input.t0Day ?? null,
    t1Day: input.t1Day ?? null,
    t2Day: input.t2Day ?? null,
  };
}

/** 生成任务所需的完整 List 快照，不包含任何基础设施对象。 */
export interface SchedulableList {
  readonly listId: string;
  readonly stage: WordListStageType;
  readonly words: readonly SchedulableWord[];
  readonly synchronizedDay: LearningDay | null;
  /**
   * 已完成的仅复习需求稳定键集合。
   *
   * 仅复习不改变 Word 状态，其"完成"只能靠需求键记账：整 List 纸质复习会满足
   * 同日全部 Word 的仅复习需求，逐词逐日重放时必须据此跳过已满足的旧需求。
   */
  readonly completedReviewDemands: ReadonlySet<string>;
}

/** 构造 List 调度快照并校验阶段与 Word 唯一性。 */
export function createSchedulableList(input: {
  listId: string;
  stage: WordListStageType;
  words: readonly SchedulableWord[];
  synchronizedDay?: LearningDay | null;
  completedReviewDemands?: ReadonlySet<string>;
}): SchedulableList {
  if (input.listId.trim().length === 0) {
    throw new Error("List 标识不能为空");
  }
  if (input.stage === WordListStage.LongTermValidation && input.synchronizedDay == null) {
    throw new Error("长期验证阶段必须提供同步学习日");
  }
  const wordIds = input.words.map((item) => item.word.id);
  if (new Set(wordIds).size !== wordIds.length) {
    throw new Error("同一 List 调度快照不得包含重复 Word");
  }
  return {
    listId: input.listId,
    stage: input.stage,
    words: input.words,
    synchronizedDay: input.synchronizedDay ?? null,
    completedReviewDemands: input.completedReviewDemands ?? new Set(),
  };
}

/** 一个 Word 产生的一项尚未完成的确定到期需求。 */
export interface DueDemand {
  readonly wordId: string;
  readonly taskType: TaskTypeType;
  readonly scheduledDay: LearningDay;
  readonly reason: DueReasonType;
}

/** 稳定键用于标记不改变 Word 状态的仅复习需求已经完成。 */
export function dueDemandKey(demand: DueDemand): string {
  return `${demand.wordId}|${demand.taskType}|${demand.scheduledDay}`;
}

/** 供应用层在纸质复习完成后构造稳定的完成需求键。 */
export function reviewDemandKey(wordId: string, scheduledDay: LearningDay): string {
  return dueDemandKey({
    wordId,
    taskType: TaskType.ReviewOnly,
    scheduledDay,
    reason: DueReason.T0ReviewOnly,
  });
}

/** 界面与容量模型共同使用的唯一 List 粒度任务。 */
export interface ListTask {
  readonly listId: string;
  readonly taskType: TaskTypeType;
  readonly scheduledDay: LearningDay;
  readonly workload: number;
  readonly testDemands: readonly DueDemand[];
  readonly reviewDemands: readonly DueDemand[];
  readonly activeWordIds: readonly string[];
  /** 计划到期日相对今天的逾期天数；计划日保持不变，不因逾期改写。 */
  readonly overdueDays: number;
  readonly algorithmVersion: string;
}

export function isTaskOverdue(task: ListTask): boolean {
  return task.overdueDays > 0;
}

/** 按稳定顺序输出可直接持久化或展示的到期原因。 */
export function taskDueReasons(task: ListTask): readonly string[] {
  return [...task.testDemands, ...task.reviewDemands].map((demand) => demand.reason);
}

/** 比较到期需求的稳定排序：先按计划日，再按 Word，再按任务类型。 */
function compareDemands(
  a: DueDemand,
  b: DueDemand,
  secondary: (demand: DueDemand) => string,
): number {
  if (a.scheduledDay !== b.scheduledDay) {
    return a.scheduledDay < b.scheduledDay ? -1 : 1;
  }
  if (a.wordId !== b.wordId) {
    return a.wordId < b.wordId ? -1 : 1;
  }
  return secondary(a) < secondary(b) ? -1 : secondary(a) > secondary(b) ? 1 : 0;
}

/** 只根据当前状态生成仍然有效的测试与仅复习需求。 */
function shortTermDemands(item: SchedulableWord): DueDemand[] {
  const { word } = item;
  if (word.masteryStatus === MasteryStatus.Mastered) {
    return [];
  }
  if (word.shortTermPassCount === ShortTermPassCount.Zero) {
    if (item.t0Day === null) {
      throw new Error("短期通过次数为 0 的活动 Word 缺少 T0 学习日锚点");
    }
    return [
      {
        wordId: word.id,
        taskType: TaskType.ShortTermTest,
        scheduledDay: addLearningDays(item.t0Day, 1),
        reason: DueReason.FirstShortTermTest,
      },
      {
        wordId: word.id,
        taskType: TaskType.ReviewOnly,
        scheduledDay: addLearningDays(item.t0Day, 2),
        reason: DueReason.T0ReviewOnly,
      },
    ];
  }
  if (word.shortTermPassCount === ShortTermPassCount.One) {
    if (item.t1Day === null) {
      throw new Error("短期通过次数为 1 的活动 Word 缺少 T1 学习日锚点");
    }
    return [
      {
        wordId: word.id,
        taskType: TaskType.ReviewOnly,
        scheduledDay: addLearningDays(item.t1Day, 1),
        reason: DueReason.T1ReviewOnly,
      },
      {
        wordId: word.id,
        taskType: TaskType.ShortTermTest,
        scheduledDay: addLearningDays(item.t1Day, 3),
        reason: DueReason.PromotionTest,
      },
    ];
  }
  if (item.t2Day === null) {
    throw new Error("短期通过次数为 2 的活动 Word 缺少 T2 学习日锚点");
  }
  return [
    {
      wordId: word.id,
      taskType: TaskType.WaitingCheck,
      scheduledDay: addLearningDays(item.t2Day, 7),
      reason: DueReason.WaitingCheck,
    },
  ];
}

/**
 * 判断 List 是否满足同步条件：活动 Word 数量大于 0，且全部未掌握 Word 的
 * 短期通过次数均为 2。空 List 不同步，不进入长期验证。
 */
export function listSatisfiesSynchronization(snapshot: SchedulableList): boolean {
  const activeWords = snapshot.words.filter(
    (item) => item.word.masteryStatus === MasteryStatus.Unmastered,
  );
  return (
    activeWords.length > 0 &&
    activeWords.every((item) => item.word.shortTermPassCount === ShortTermPassCount.Two)
  );
}

/**
 * 折叠所有到期需求，返回今天唯一可见的 List 任务；当天没有任何到期需求时返回 null。
 *
 * 聚合规则（复习调度算法 5.5、8、9.1）：
 * - 任一 Word 测试到期即生成测试任务，但只测试真正到期的 Word；
 * - 任一 Word 仅复习到期即生成仅复习任务，纸质范围为全部未掌握 Word；
 * - 同日测试与仅复习合并为测试后复习，工作量固定为 2（绝不按 Word 需求相加成 3）；
 * - 已完成的仅复习需求键不再重复生成；
 * - 逾期需求保持原计划日并据此计算逾期天数，不生成虚拟补做任务。
 */
export function generateListTask(snapshot: SchedulableList, today: LearningDay): ListTask | null {
  const activeWordIds = snapshot.words
    .filter((item) => item.word.masteryStatus === MasteryStatus.Unmastered)
    .map((item) => item.word.id)
    .sort();
  if (activeWordIds.length === 0 || snapshot.stage === WordListStage.Mastered) {
    return null;
  }

  if (snapshot.stage === WordListStage.LongTermValidation) {
    if (snapshot.synchronizedDay === null) {
      throw new Error("长期验证阶段缺少同步学习日");
    }
    const scheduledDay = addLearningDays(snapshot.synchronizedDay, 7);
    if (scheduledDay > today) {
      return null;
    }
    const demands = activeWordIds.map(
      (wordId): DueDemand => ({
        wordId,
        taskType: TaskType.LongTermValidation,
        scheduledDay,
        reason: DueReason.LongTermValidation,
      }),
    );
    return {
      listId: snapshot.listId,
      taskType: TaskType.LongTermValidation,
      scheduledDay,
      workload: 2,
      testDemands: demands,
      reviewDemands: [],
      activeWordIds,
      overdueDays: Math.max(0, daysBetweenLearningDays(scheduledDay, today)),
      algorithmVersion: SCHEDULER_ALGORITHM_VERSION,
    };
  }

  // 同步条件一旦已经满足，短期需求必须立即停止；应用层会在当次测试后的纸质复习
  // 完成时正式写入同步事件和 TS，因此这里不能继续生成 T2 等待校验。
  if (listSatisfiesSynchronization(snapshot)) {
    return null;
  }

  const allDemands = snapshot.words.flatMap((item) => shortTermDemands(item));
  const dueDemands = allDemands.filter((demand) => demand.scheduledDay <= today);
  const testDemands = dueDemands
    .filter((demand) => demand.taskType !== TaskType.ReviewOnly)
    .sort((a, b) => compareDemands(a, b, (demand) => demand.taskType));
  const reviewDemands = dueDemands
    .filter(
      (demand) =>
        demand.taskType === TaskType.ReviewOnly &&
        !snapshot.completedReviewDemands.has(dueDemandKey(demand)),
    )
    .sort((a, b) => compareDemands(a, b, () => ""));
  if (testDemands.length === 0 && reviewDemands.length === 0) {
    return null;
  }

  // 只要存在任何测试需求，同日或历史逾期的仅复习都由测试后的整 List 纸质复习一并
  // 满足，因而工作量固定为 2；任务类型按等待校验优先于普通短期测试展示。
  let taskType: TaskTypeType;
  if (testDemands.length > 0) {
    taskType = testDemands.some((demand) => demand.taskType === TaskType.WaitingCheck)
      ? TaskType.WaitingCheck
      : TaskType.ShortTermTest;
  } else {
    taskType = TaskType.ReviewOnly;
  }
  const workload = testDemands.length > 0 ? 2 : 1;
  const scheduledDay = [...testDemands, ...reviewDemands]
    .map((demand) => demand.scheduledDay)
    .reduce((min, day) => (day < min ? day : min));
  return {
    listId: snapshot.listId,
    taskType,
    scheduledDay,
    workload,
    testDemands,
    reviewDemands,
    activeWordIds,
    overdueDays: Math.max(0, daysBetweenLearningDays(scheduledDay, today)),
    algorithmVersion: SCHEDULER_ALGORITHM_VERSION,
  };
}

/**
 * 应用一次最终判断，并严格维护 T0/T1/T2 的真实时间语义（复习调度算法 5.3 状态转换表）。
 *
 * occurredAt 是本次测试的真实完成时刻（带时区 ISO8601）：逾期任务的 Word 新状态
 * 起点一律使用真实完成日，绝不使用原计划日。泛型保证输入实体携带的全部字段在
 * 输出中原样保留（等价 V1 dataclasses.replace 的不可变替换语义）。
 */
export function applyTestJudgement<W extends SchedulableWordSource>(
  word: W,
  input: {
    taskType: TaskTypeType;
    judgement: TestJudgement;
    occurredAt: string;
  },
): W {
  if (word.masteryStatus === MasteryStatus.Mastered) {
    throw new Error("已掌握 Word 不得参与常规测试");
  }
  const recognized = input.judgement === TestJudgement.Recognized;
  const occurredAt = input.occurredAt;

  if (input.taskType === TaskType.ShortTermTest) {
    if (word.shortTermPassCount === ShortTermPassCount.Zero) {
      if (recognized) {
        // 0→1：生成新的 T1；T0 保持原值（同轮周期不因成功而改写）。
        return {
          ...word,
          shortTermPassCount: ShortTermPassCount.One,
          shortTermOneStartedAt: occurredAt,
          waitingCheckStartedAt: null,
        };
      }
      // 0 失败：以失败日生成新 T0，清除旧 T1/T2（产生新的短期周期起点）。
      return {
        ...word,
        shortTermCycleStartedAt: occurredAt,
        shortTermOneStartedAt: null,
        waitingCheckStartedAt: null,
      };
    }
    if (word.shortTermPassCount === ShortTermPassCount.One) {
      if (recognized) {
        // 1→2：进入等待校验，以真实作答时间生成 T2。
        return {
          ...word,
          shortTermPassCount: ShortTermPassCount.Two,
          waitingCheckStartedAt: occurredAt,
        };
      }
      // 1 失败：重置为 0 并以失败日生成新 T0。
      return {
        ...word,
        shortTermPassCount: ShortTermPassCount.Zero,
        shortTermCycleStartedAt: occurredAt,
        shortTermOneStartedAt: null,
        waitingCheckStartedAt: null,
      };
    }
    throw new Error("短期测试只能作用于短期通过次数 0 或 1");
  }

  if (input.taskType === TaskType.WaitingCheck) {
    if (word.shortTermPassCount !== ShortTermPassCount.Two) {
      throw new Error("等待校验只能作用于短期通过次数 2");
    }
    if (recognized) {
      // 等待校验成功：保持 2，并从本次校验日期重新计算 7 天（刷新 T2）。
      return { ...word, waitingCheckStartedAt: occurredAt };
    }
    // 等待校验失败：只降为 1 并以校验当天生成新 T1；旧 T0 不存在也不得伪造。
    return {
      ...word,
      shortTermPassCount: ShortTermPassCount.One,
      shortTermOneStartedAt: occurredAt,
      waitingCheckStartedAt: null,
    };
  }

  if (input.taskType === TaskType.LongTermValidation) {
    if (recognized) {
      // 长期验证成功：掌握状态只由真实结果改变。
      return { ...word, masteryStatus: MasteryStatus.Mastered };
    }
    // 长期验证失败：重置为 0，以长期验证当天生成新 T0，进入新短期周期。
    return {
      ...word,
      shortTermPassCount: ShortTermPassCount.Zero,
      masteryStatus: MasteryStatus.Unmastered,
      shortTermCycleStartedAt: occurredAt,
      shortTermOneStartedAt: null,
      waitingCheckStartedAt: null,
    };
  }
  // 仅复习不产生 Word 测试判断，也不改变任何短期状态。
  throw new Error("仅复习不产生 Word 测试判断");
}
