/**
 * 可解释调度状态机与 List 粒度任务聚合（移植 V1 domain/scheduling.py）。
 *
 * 本模块只处理已经转换为学习日的确定输入，不读取系统时间、时区或数据库；应用层
 * 负责把绝对时间映射为学习日，因而同一状态、同一学习日和同一算法版本必然得到
 * 完全相同的结果。
 *
 * 状态机不变量（复习调度算法 5-9 章，2026-10-02 口径）：
 * - 三个日期增量始终相对同一个 T0 计算（T0+1 测试、T0+2 仅复习、T0+4 晋级测试）；
 *   达到短期通过次数 1 后由同一组增量做阶段差分（T1+1 仅复习、T1+3 晋级测试），
 *   不引入特殊参数。
 * - 短期测试失败（0 或 1）重置为 0 并以真实失败日生成新 T0；等待校验失败只降为 1
 *   并以校验日生成新 T1，绝不伪造 T0。
 * - 等待校验从 T2 起算 7 个自然日，绝不从 T0 或首过日期起算。
 * - 同步条件一旦满足，短期需求立即停止；长期验证阶段是唯一无接触例外。
 * - 复习不再是任务：调度只生成测试任务，仅复习日期只作为复习入口候选集的
 *   派生输入（dueReviewOnlyDemands），不生成任务、事件、工作量，也不做任何
 *   "完成"记账（2026-10-02 起不存在复习确认触发点）。
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
}

/** 构造 List 调度快照并校验阶段与 Word 唯一性。 */
export function createSchedulableList(input: {
  listId: string;
  stage: WordListStageType;
  words: readonly SchedulableWord[];
  synchronizedDay?: LearningDay | null;
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
  };
}

/** 一个 Word 产生的一项尚未完成的确定到期需求。 */
export interface DueDemand {
  readonly wordId: string;
  readonly taskType: TaskTypeType;
  readonly scheduledDay: LearningDay;
  readonly reason: DueReasonType;
}

/** 界面与容量模型共同使用的唯一 List 粒度任务（2026-10-02 起只有测试任务）。 */
export interface ListTask {
  readonly listId: string;
  readonly taskType: TaskTypeType;
  readonly scheduledDay: LearningDay;
  readonly workload: number;
  readonly testDemands: readonly DueDemand[];
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
  return task.testDemands.map((demand) => demand.reason);
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
 * 折叠所有到期测试需求，返回今天唯一可见的 List 测试任务；当天没有任何测试需求
 * 时返回 null（2026-10-02 口径：仅复习不再生成任务）。
 *
 * 聚合规则（复习调度算法 5.5、8、9.1）：
 * - 任一 Word 测试到期即生成测试任务，但只测试真正到期的 Word；
 * - 工作量 = 待测词数（testDemands.length）：每个已确认词最终判断计 1，未确认不计；
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
      workload: demands.length,
      testDemands: demands,
      activeWordIds,
      overdueDays: Math.max(0, daysBetweenLearningDays(scheduledDay, today)),
      algorithmVersion: SCHEDULER_ALGORITHM_VERSION,
    };
  }

  // 同步条件一旦已经满足，短期需求必须立即停止：应用层随使同步条件首次满足的
  // 测试答案同一批写入 listSynchronized 与 TS（复习调度算法 7.1，2026-10-02 口径），
  // 重放侧随后把 List 推进到长期验证，这里不能继续生成 T2 等待校验。
  if (listSatisfiesSynchronization(snapshot)) {
    return null;
  }

  const allDemands = snapshot.words.flatMap((item) => shortTermDemands(item));
  const testDemands = allDemands
    .filter((demand) => demand.taskType !== TaskType.ReviewOnly)
    .filter((demand) => demand.scheduledDay <= today)
    .sort((a, b) => compareDemands(a, b, (demand) => demand.taskType));
  if (testDemands.length === 0) {
    // 只有仅复习到期：复习页是纯浏览入口，不生成任务、工作量或事件。
    return null;
  }
  // 任务类型按等待校验优先于普通短期测试展示。
  const taskType: TaskTypeType = testDemands.some(
    (demand) => demand.taskType === TaskType.WaitingCheck,
  )
    ? TaskType.WaitingCheck
    : TaskType.ShortTermTest;
  const scheduledDay = testDemands
    .map((demand) => demand.scheduledDay)
    .reduce((min, day) => (day < min ? day : min));
  return {
    listId: snapshot.listId,
    taskType,
    scheduledDay,
    workload: testDemands.length,
    testDemands,
    activeWordIds,
    overdueDays: Math.max(0, daysBetweenLearningDays(scheduledDay, today)),
    algorithmVersion: SCHEDULER_ALGORITHM_VERSION,
  };
}

/**
 * 复习入口候选集的"当日到期的仅复习词"部分（复习调度算法 5.5 第 2 条，
 * 需求规格 6.4）。
 *
 * 口径：
 * - 只返回活动未掌握 Word 中 taskType 为仅复习、且计划日**严格等于** today 的需求；
 *   逾期（< today）的仅复习日期不再返回——不做逾期累积，直到状态推进生成新的仅复习日期；
 * - List 处于长期验证/已掌握阶段、或同步条件已满足时返回空：同步后不再有任何
 *   短期接触需求，长期验证阶段是唯一无接触例外；
 * - 返回纯派生视图片段：不持久化、不同步，调用方不得改写结果。
 */
export function dueReviewOnlyDemands(
  snapshot: SchedulableList,
  today: LearningDay,
): readonly DueDemand[] {
  if (snapshot.stage !== WordListStage.ShortTermSync) {
    return [];
  }
  if (listSatisfiesSynchronization(snapshot)) {
    return [];
  }
  return snapshot.words
    .flatMap((item) => shortTermDemands(item))
    .filter(
      (demand) =>
        demand.taskType === TaskType.ReviewOnly && demand.scheduledDay === today,
    )
    .sort((a, b) => compareDemands(a, b, () => ""));
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
