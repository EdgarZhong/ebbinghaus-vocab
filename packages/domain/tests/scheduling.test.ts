/**
 * 调度状态机、List 聚合与逾期行为的固定日期回归测试
 * （映射 V1 tests/unit/domain/test_scheduling.py，逐函数对应）。
 *
 * 全部锚点固定在 2026 年 7 月的 UTC 时刻与同一时区学习日，不依赖真实时间。
 */
import { describe, expect, it } from "vitest";

import { createWord, type Word } from "../src/entities.ts";
import {
  DueReason,
  MasteryStatus,
  ShortTermPassCount,
  TaskType,
  TestJudgement,
  WordListStage,
} from "../src/enums.ts";
import {
  SCHEDULER_ALGORITHM_VERSION,
  applyTestJudgement,
  createSchedulableList,
  createSchedulableWord,
  generateListTask,
  listSatisfiesSynchronization,
  type SchedulableWord,
} from "../src/scheduling.ts";

/** 固定在 UTC 上午九点，避免测试隐式依赖本机时区或当前时间。 */
function instant(day: number): string {
  return `2026-07-${String(day).padStart(2, "0")}T09:00:00Z`;
}

function day(anchorDay: number): string {
  return `2026-07-${String(anchorDay).padStart(2, "0")}`;
}

/** 按当前短期状态只设置有业务意义的锚点，方便明确断言时间不变量。 */
function word(
  wordId: string,
  passCount: ShortTermPassCount,
  options: { anchorDay: number; masteryStatus?: MasteryStatus },
): Word {
  const masteryStatus = options.masteryStatus ?? MasteryStatus.Unmastered;
  return createWord({
    id: wordId,
    listId: "list-1",
    originalSpelling: wordId,
    normalizedKey: wordId,
    manualMeaning: "测试义项",
    shortTermPassCount: passCount,
    masteryStatus,
    shortTermCycleStartedAt: passCount === ShortTermPassCount.Zero ? instant(options.anchorDay) : null,
    shortTermOneStartedAt: passCount === ShortTermPassCount.One ? instant(options.anchorDay) : null,
    waitingCheckStartedAt: passCount === ShortTermPassCount.Two ? instant(options.anchorDay) : null,
  });
}

/** 把测试构造器中的绝对锚点显式投影为同一 UTC 学习日。 */
function projection(target: Word, anchorDay: number): SchedulableWord {
  const anchor = day(anchorDay);
  return createSchedulableWord({
    word: target,
    t0Day: target.shortTermPassCount === ShortTermPassCount.Zero ? anchor : null,
    t1Day: target.shortTermPassCount === ShortTermPassCount.One ? anchor : null,
    t2Day: target.shortTermPassCount === ShortTermPassCount.Two ? anchor : null,
  });
}

describe("短期状态机：T0/T1/T2 真实时间语义", () => {
  it("两次认识依次完成 0→1→2，T1/T2 使用真实作答时间且不改写原 T0", () => {
    const original = word("abandon", ShortTermPassCount.Zero, { anchorDay: 15 });
    const afterFirst = applyTestJudgement(original, {
      taskType: TaskType.ShortTermTest,
      judgement: TestJudgement.Recognized,
      occurredAt: instant(16),
    });
    const afterSecond = applyTestJudgement(afterFirst, {
      taskType: TaskType.ShortTermTest,
      judgement: TestJudgement.Recognized,
      occurredAt: instant(19),
    });

    expect(afterFirst.shortTermPassCount).toBe(ShortTermPassCount.One);
    expect(afterFirst.shortTermCycleStartedAt).toBe(instant(15));
    expect(afterFirst.shortTermOneStartedAt).toBe(instant(16));
    expect(afterSecond.shortTermPassCount).toBe(ShortTermPassCount.Two);
    expect(afterSecond.shortTermCycleStartedAt).toBe(instant(15));
    expect(afterSecond.shortTermOneStartedAt).toBe(instant(16));
    expect(afterSecond.waitingCheckStartedAt).toBe(instant(19));
  });

  it.each([ShortTermPassCount.Zero, ShortTermPassCount.One] as const)(
    "短期状态 %s 测试失败从真实失败日开始新周期，并清除旧 T1/T2",
    (initialCount) => {
      const failed = applyTestJudgement(
        word("difficult", initialCount, { anchorDay: 15 }),
        {
          taskType: TaskType.ShortTermTest,
          judgement: TestJudgement.NotRecognized,
          occurredAt: instant(18),
        },
      );
      expect(failed.shortTermPassCount).toBe(ShortTermPassCount.Zero);
      expect(failed.shortTermCycleStartedAt).toBe(instant(18));
      expect(failed.shortTermOneStartedAt).toBeNull();
      expect(failed.waitingCheckStartedAt).toBeNull();
    },
  );

  it("等待校验失败以当天生成 T1，旧 T0 不存在也不得被伪造", () => {
    const failed = applyTestJudgement(word("elaborate", ShortTermPassCount.Two, { anchorDay: 15 }), {
      taskType: TaskType.WaitingCheck,
      judgement: TestJudgement.NotRecognized,
      occurredAt: instant(22),
    });
    expect(failed.shortTermPassCount).toBe(ShortTermPassCount.One);
    expect(failed.shortTermCycleStartedAt).toBeNull();
    expect(failed.shortTermOneStartedAt).toBe(instant(22));
    expect(failed.waitingCheckStartedAt).toBeNull();
  });

  it("等待校验成功保持 2 并以校验当天刷新 T2，其余状态起点不动", () => {
    const target = word("steady", ShortTermPassCount.Two, { anchorDay: 15 });
    const passed = applyTestJudgement(target, {
      taskType: TaskType.WaitingCheck,
      judgement: TestJudgement.Recognized,
      occurredAt: instant(23),
    });
    expect(passed.shortTermPassCount).toBe(ShortTermPassCount.Two);
    expect(passed.waitingCheckStartedAt).toBe(instant(23));
    // 夹具只设置 T2（状态 2 的对应锚点）；等待校验成功不得改写其它锚点。
    expect(passed.shortTermOneStartedAt).toBe(target.shortTermOneStartedAt);
    expect(passed.shortTermCycleStartedAt).toBe(target.shortTermCycleStartedAt);
  });

  it("长期验证成功才掌握；失败回到 0 并以真实验证日生成新 T0", () => {
    const target = word("validate", ShortTermPassCount.Two, { anchorDay: 15 });
    const mastered = applyTestJudgement(target, {
      taskType: TaskType.LongTermValidation,
      judgement: TestJudgement.Recognized,
      occurredAt: instant(26),
    });
    const failed = applyTestJudgement(target, {
      taskType: TaskType.LongTermValidation,
      judgement: TestJudgement.NotRecognized,
      occurredAt: instant(26),
    });
    expect(mastered.masteryStatus).toBe(MasteryStatus.Mastered);
    expect(failed.masteryStatus).toBe(MasteryStatus.Unmastered);
    expect(failed.shortTermPassCount).toBe(ShortTermPassCount.Zero);
    expect(failed.shortTermCycleStartedAt).toBe(instant(26));
  });

  it("短期测试不能作用于状态 2；等待校验只能作用于状态 2；已掌握词不得再测试", () => {
    expect(() =>
      applyTestJudgement(word("two", ShortTermPassCount.Two, { anchorDay: 15 }), {
        taskType: TaskType.ShortTermTest,
        judgement: TestJudgement.Recognized,
        occurredAt: instant(16),
      }),
    ).toThrow(/短期测试只能作用于/);
    expect(() =>
      applyTestJudgement(word("one", ShortTermPassCount.One, { anchorDay: 15 }), {
        taskType: TaskType.WaitingCheck,
        judgement: TestJudgement.Recognized,
        occurredAt: instant(16),
      }),
    ).toThrow(/等待校验只能作用于/);
    const masteredWord = word("done", ShortTermPassCount.Two, {
      anchorDay: 15,
      masteryStatus: MasteryStatus.Mastered,
    });
    expect(() =>
      applyTestJudgement(masteredWord, {
        taskType: TaskType.ShortTermTest,
        judgement: TestJudgement.Recognized,
        occurredAt: instant(16),
      }),
    ).toThrow(/已掌握 Word 不得参与常规测试/);
  });
});

describe("统一调度：日期增量、List 聚合与逾期折叠", () => {
  it("T0 增量按固定起点计算；不同 Word 的测试和仅复习同日只生成一个工作量 2 任务", () => {
    const snapshot = createSchedulableList({
      listId: "list-1",
      stage: WordListStage.ShortTermSync,
      words: [
        projection(word("test-due", ShortTermPassCount.Zero, { anchorDay: 16 }), 16),
        projection(word("review-due", ShortTermPassCount.One, { anchorDay: 16 }), 16),
      ],
    });
    const task = generateListTask(snapshot, day(17));

    expect(task).not.toBeNull();
    expect(task?.taskType).toBe(TaskType.ShortTermTest);
    expect(task?.workload).toBe(2);
    expect(task?.scheduledDay).toBe(day(17));
    expect(task?.testDemands.map((demand) => demand.wordId)).toEqual(["test-due"]);
    expect(task?.reviewDemands.map((demand) => demand.wordId)).toEqual(["review-due"]);
    expect(taskDueReasonsOf(task)).toEqual([
      DueReason.FirstShortTermTest,
      DueReason.T1ReviewOnly,
    ]);
    expect(task?.algorithmVersion).toBe(SCHEDULER_ALGORITHM_VERSION);
  });

  it("多日未打开时保留最早计划日并折叠为当前唯一任务，不生成虚拟补做任务", () => {
    const snapshot = createSchedulableList({
      listId: "list-1",
      stage: WordListStage.ShortTermSync,
      words: [projection(word("overdue", ShortTermPassCount.Zero, { anchorDay: 15 }), 15)],
    });
    const task = generateListTask(snapshot, day(20));

    expect(task).not.toBeNull();
    expect(task?.scheduledDay).toBe(day(16));
    expect(task?.overdueDays).toBe(4);
    expect(task?.overdueDays).toBeGreaterThan(0);
    expect(task?.testDemands).toHaveLength(1);
    expect(task?.reviewDemands).toHaveLength(1);
    expect(task?.workload).toBe(2);
  });

  it("空 List 不满足同步条件且永远没有后续任务", () => {
    const snapshot = createSchedulableList({
      listId: "empty",
      stage: WordListStage.ShortTermSync,
      words: [],
    });
    expect(listSatisfiesSynchronization(snapshot)).toBe(false);
    expect(generateListTask(snapshot, day(30))).toBeNull();
  });

  it("全部活动 Word 达到 2 后立即停止短期任务，只有 TS 满 7 天才生成长期验证", () => {
    const shortSnapshot = createSchedulableList({
      listId: "list-1",
      stage: WordListStage.ShortTermSync,
      words: [projection(word("ready", ShortTermPassCount.Two, { anchorDay: 15 }), 15)],
    });
    const waitingSnapshot = createSchedulableList({
      listId: "list-1",
      stage: WordListStage.LongTermValidation,
      words: shortSnapshot.words,
      synchronizedDay: day(19),
    });

    expect(listSatisfiesSynchronization(shortSnapshot)).toBe(true);
    expect(generateListTask(shortSnapshot, day(30))).toBeNull();
    expect(generateListTask(waitingSnapshot, day(25))).toBeNull();
    const validation = generateListTask(waitingSnapshot, day(27));
    expect(validation).not.toBeNull();
    expect(validation?.taskType).toBe(TaskType.LongTermValidation);
    expect(validation?.workload).toBe(2);
    expect(validation?.scheduledDay).toBe(day(26));
    expect(validation?.overdueDays).toBe(1);
  });

  it("已完成的仅复习需求键不再重复生成任务需求", () => {
    const reviewWord = projection(word("reviewed", ShortTermPassCount.Zero, { anchorDay: 15 }), 15);
    const snapshot = createSchedulableList({
      listId: "list-1",
      stage: WordListStage.ShortTermSync,
      words: [reviewWord],
      completedReviewDemands: new Set(["reviewed|仅复习|2026-07-17"]),
    });
    // T0+2 仅复习（07-17）已完成；T0+1 测试（07-16）已过但仍到期——折叠为测试任务。
    const task = generateListTask(snapshot, day(17));
    expect(task).not.toBeNull();
    expect(task?.testDemands).toHaveLength(1);
    expect(task?.reviewDemands).toHaveLength(0);
    expect(task?.workload).toBe(2);
  });
});

/** 取任务到期原因的稳定顺序输出（与 ListTask.dueReasons 对应）。 */
function taskDueReasonsOf(task: ReturnType<typeof generateListTask>): string[] {
  if (task === null) {
    return [];
  }
  return [...task.testDemands, ...task.reviewDemands].map((demand) => demand.reason);
}
