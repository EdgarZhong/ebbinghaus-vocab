/**
 * 学习事件重放器测试（V2 新增能力，无 V1 测试对应）。
 *
 * 固化以下行为：领域重放排序、首过词 T0 初始化、afterState 派生、同步与长期验证
 * 阶段推进、软移除、常规模式条目派生与确定性重放。输入模拟"已经过 protocol
 * schema 校验"的事件形态（运行时约束由重放器防御校验兜底）。
 */
import { describe, expect, it } from "vitest";

import { MasteryStatus, TestJudgement, WordListStage } from "../src/enums.ts";
import { generateListTask } from "../src/scheduling.ts";
import {
  REPLAYER_ALGORITHM_VERSION,
  replayLearningEvents,
  schedulableListsFromReplay,
  type ReplayableLearningEvent,
} from "../src/replayer.ts";

const DEVICE_A = "00000000-0000-4000-8000-00000000000a";
const DEVICE_B = "00000000-0000-4000-8000-00000000000b";

let seqCounter = 0;

/** 构造协议校验后形态的事件（字段最小集 + metadata）。 */
function makeEvent(input: {
  eventType: string;
  targetType: string;
  targetId: string;
  occurredAt: string;
  learningDay: string;
  metadata: unknown;
  deviceId?: string;
  deviceSeq?: number;
}): ReplayableLearningEvent {
  seqCounter += 1;
  return {
    eventId: `event-${seqCounter.toString().padStart(4, "0")}`,
    eventType: input.eventType,
    targetType: input.targetType,
    targetId: input.targetId,
    occurredAt: input.occurredAt,
    learningDay: input.learningDay,
    source: "测试",
    deviceId: input.deviceId ?? DEVICE_A,
    deviceSeq: input.deviceSeq ?? seqCounter,
    metadata: input.metadata,
  };
}

const SETTINGS = { timezoneName: "Asia/Shanghai", rolloverTime: "04:00" };

describe("事件重放器：词书模式", () => {
  it("首过事件 + 词内容登记表 → List 创建，登记词以首过时刻进入短期通过次数 0", () => {
    const result = replayLearningEvents({
      events: [
        makeEvent({
          eventType: "firstPassRecorded",
          targetType: "List",
          targetId: "list-1",
          occurredAt: "2026-07-15T09:00:00Z",
          learningDay: "2026-07-15",
          metadata: { workload: 1, wordCount: 2 },
        }),
      ],
      wordCatalog: [
        {
          wordId: "w-1",
          listId: "list-1",
          spaceId: null,
          originalSpelling: "abandon",
          normalizedKey: "abandon",
        },
        {
          wordId: "w-2",
          listId: "list-1",
          spaceId: null,
          originalSpelling: "elaborate",
          normalizedKey: "elaborate",
        },
      ],
    });

    expect(result.algorithmVersion).toBe(REPLAYER_ALGORITHM_VERSION);
    const list = result.lists.get("list-1");
    expect(list?.stage).toBe(WordListStage.ShortTermSync);
    expect(list?.firstPassedAt).toBe("2026-07-15T09:00:00Z");
    expect(list?.additionsLocked).toBe(false);
    expect(list?.wordIds).toEqual(["w-1", "w-2"]);
    for (const wordId of ["w-1", "w-2"]) {
      const word = result.words.get(wordId);
      expect(word?.shortTermPassCount).toBe(0);
      expect(word?.t0).toBe("2026-07-15T09:00:00Z");
      expect(word?.masteryStatus).toBe(MasteryStatus.Unmastered);
    }
  });

  it("逐词测试事件以 afterState 为权威派生输入，状态机语义与调度器一致", () => {
    const result = replayLearningEvents({
      events: [
        makeEvent({
          eventType: "testAnswered",
          targetType: "Word",
          targetId: "w-1",
          occurredAt: "2026-07-16T09:00:00Z",
          learningDay: "2026-07-16",
          metadata: {
            sessionId: "s-1",
            initialJudgement: "认识",
            finalJudgement: "认识",
            answerRevised: false,
            beforeState: { shortTermPassCount: 0, masteryStatus: "未掌握", t0: "2026-07-15T09:00:00Z", t1: null, t2: null },
            afterState: { shortTermPassCount: 1, masteryStatus: "未掌握", t0: "2026-07-15T09:00:00Z", t1: "2026-07-16T09:00:00Z", t2: null },
            algorithmVersion: "scheduler-v1",
          },
        }),
      ],
    });

    const word = result.words.get("w-1");
    expect(word?.shortTermPassCount).toBe(1);
    expect(word?.t0).toBe("2026-07-15T09:00:00Z");
    expect(word?.t1).toBe("2026-07-16T09:00:00Z");
    expect(word?.lastJudgement).toBe(TestJudgement.Recognized);
    expect(word?.cumulativeRecognizedCount).toBe(1);
  });

  it("listSynchronized 推进 List 阶段并永久锁定新增；listMastered 记录聚合掌握", () => {
    const result = replayLearningEvents({
      events: [
        makeEvent({
          eventType: "listSynchronized",
          targetType: "List",
          targetId: "list-1",
          occurredAt: "2026-07-20T09:00:00Z",
          learningDay: "2026-07-20",
          metadata: { taskId: "task-1", taskType: "短期测试", workload: 2, reviewDemandKeys: [] },
        }),
        makeEvent({
          eventType: "listMastered",
          targetType: "List",
          targetId: "list-1",
          occurredAt: "2026-07-28T09:00:00Z",
          learningDay: "2026-07-28",
          metadata: { taskId: "task-2", taskType: "长期验证", workload: 2, reviewDemandKeys: [] },
        }),
      ],
    });

    expect(result.lists.get("list-1")?.stage).toBe(WordListStage.Mastered);
    expect(result.lists.get("list-1")?.synchronizedAt).toBe("2026-07-20T09:00:00Z");
    expect(result.lists.get("list-1")?.additionsLocked).toBe(true);
    expect(result.lists.get("list-1")?.aggregateStatus).toBe(MasteryStatus.Mastered);
  });

  it("纸质复习完成事件收集仅复习需求键，调度投影据此跳过已满足需求", () => {
    const result = replayLearningEvents({
      events: [
        makeEvent({
          eventType: "reviewOnlyCompleted",
          targetType: "List",
          targetId: "list-1",
          occurredAt: "2026-07-17T09:00:00Z",
          learningDay: "2026-07-17",
          metadata: {
            taskId: "task-1",
            taskType: "仅复习",
            workload: 1,
            reviewDemandKeys: ["w-1|仅复习|2026-07-17", "w-2|仅复习|2026-07-17"],
          },
        }),
      ],
      wordCatalog: [
        { wordId: "w-1", listId: "list-1", spaceId: null, originalSpelling: "a", normalizedKey: "a" },
        { wordId: "w-2", listId: "list-1", spaceId: null, originalSpelling: "b", normalizedKey: "b" },
      ],
    });

    expect(result.lists.get("list-1")?.completedReviewDemandKeys).toEqual([
      "w-1|仅复习|2026-07-17",
      "w-2|仅复习|2026-07-17",
    ]);
  });

  it("wordAdded 以事件时刻初始化新周期；wordRemoved 软移除且历史保留", () => {
    const result = replayLearningEvents({
      events: [
        makeEvent({
          eventType: "wordAdded",
          targetType: "Word",
          targetId: "w-new",
          occurredAt: "2026-07-18T09:00:00Z",
          learningDay: "2026-07-18",
          metadata: { listId: "list-1", normalizedKey: "novel" },
        }),
        makeEvent({
          eventType: "wordRemoved",
          targetType: "Word",
          targetId: "w-new",
          occurredAt: "2026-07-19T09:00:00Z",
          learningDay: "2026-07-19",
          metadata: { listId: "list-1", normalizedKey: "novel" },
        }),
      ],
    });

    const word = result.words.get("w-new");
    expect(word?.listId).toBe("list-1");
    expect(word?.normalizedKey).toBe("novel");
    expect(word?.t0).toBe("2026-07-18T09:00:00Z");
    expect(word?.removed).toBe(true);
    expect(result.lists.get("list-1")?.wordIds).toContain("w-new");
  });

  it("事件乱序输入时按 protocol 领域重放排序重放，结果与有序输入完全一致", () => {
    const lateUpload = makeEvent({
      eventType: "testAnswered",
      targetType: "Word",
      targetId: "w-1",
      occurredAt: "2026-07-16T09:00:00Z",
      learningDay: "2026-07-16",
      deviceId: DEVICE_B,
      deviceSeq: 9,
      metadata: {
        sessionId: "s-1",
        initialJudgement: "认识",
        finalJudgement: "认识",
        answerRevised: false,
        beforeState: { shortTermPassCount: 0 },
        afterState: { shortTermPassCount: 1, t1: "2026-07-16T09:00:00Z" },
        algorithmVersion: "scheduler-v1",
      },
    });
    const earlier = makeEvent({
      eventType: "firstPassRecorded",
      targetType: "List",
      targetId: "list-1",
      occurredAt: "2026-07-15T09:00:00Z",
      learningDay: "2026-07-15",
      metadata: { workload: 1, wordCount: 1 },
    });

    const shuffled = replayLearningEvents({
      events: [lateUpload, earlier],
      wordCatalog: [
        { wordId: "w-1", listId: "list-1", spaceId: null, originalSpelling: "a", normalizedKey: "a" },
      ],
    });
    const ordered = replayLearningEvents({
      events: [earlier, lateUpload],
      wordCatalog: [
        { wordId: "w-1", listId: "list-1", spaceId: null, originalSpelling: "a", normalizedKey: "a" },
      ],
    });

    expect(shuffled.words.get("w-1")).toEqual(ordered.words.get("w-1"));
    expect(shuffled.words.get("w-1")?.shortTermPassCount).toBe(1);
  });

  it("重放状态可投影为调度快照并按统一调度生成任务（T0+1 测试到期）", () => {
    const result = replayLearningEvents({
      events: [
        makeEvent({
          eventType: "firstPassRecorded",
          targetType: "List",
          targetId: "list-1",
          occurredAt: "2026-07-15T09:00:00Z",
          learningDay: "2026-07-15",
          metadata: { workload: 1, wordCount: 1 },
        }),
      ],
      wordCatalog: [
        { wordId: "w-1", listId: "list-1", spaceId: null, originalSpelling: "abandon", normalizedKey: "abandon" },
      ],
    });

    const snapshots = schedulableListsFromReplay(result, SETTINGS);
    expect(snapshots).toHaveLength(1);
    const task = generateListTask(snapshots[0]!, "2026-07-16");
    expect(task?.taskType).toBe("短期测试");
    expect(task?.testDemands.map((demand) => demand.wordId)).toEqual(["w-1"]);
    expect(task?.workload).toBe(2);
  });

  it("afterState 携带非法短期通过次数时立即失败，绝不静默采用脏数据", () => {
    expect(() =>
      replayLearningEvents({
        events: [
          makeEvent({
            eventType: "testAnswered",
            targetType: "Word",
            targetId: "w-1",
            occurredAt: "2026-07-16T09:00:00Z",
            learningDay: "2026-07-16",
            metadata: {
              sessionId: "s-1",
              initialJudgement: "认识",
              finalJudgement: "认识",
              answerRevised: false,
              beforeState: {},
              afterState: { shortTermPassCount: 5 },
              algorithmVersion: "scheduler-v1",
            },
          }),
        ],
      }),
    ).toThrow(/shortTermPassCount/);
  });
});

describe("事件重放器：常规模式条目", () => {
  it("条目派生到期时间与掌握状态；累计认识次数只在最终确认事件上累加", () => {
    const testAnswered = makeEvent({
      eventType: "testAnswered",
      targetType: "Word",
      targetId: "e-1",
      occurredAt: "2026-07-16T09:00:00Z",
      learningDay: "2026-07-16",
      metadata: {
        sessionId: "s-1",
        groupOrdinal: 1,
        wordId: "e-1",
        workload: 1,
        initialJudgement: "认识",
        finalJudgement: "认识",
        answerRevised: false,
        beforeState: { dueAt: "2026-07-16T00:00:00Z", masteryStatus: "未掌握" },
        afterState: { dueAt: "2026-07-26T09:00:00Z", masteryStatus: "未掌握", nextIntervalDays: 10 },
        algorithmVersion: "fsrs-ts-5.4.2-regular-v1",
      },
    });
    const answerRevised = makeEvent({
      eventType: "answerRevised",
      targetType: "Word",
      targetId: "e-1",
      occurredAt: "2026-07-16T09:00:00Z",
      learningDay: "2026-07-16",
      metadata: { ...(testAnswered.metadata as Record<string, unknown>) },    });

    const result = replayLearningEvents({ events: [testAnswered, answerRevised] });

    const entry = result.words.get("e-1");
    expect(entry?.regularDueAt).toBe("2026-07-26T09:00:00Z");
    expect(entry?.regularNextIntervalDays).toBe(10);
    expect(entry?.lastJudgement).toBe(TestJudgement.Recognized);
    // 改判审计事件与最终确认共享同一 metadata，重复应用必须被排除。
    expect(entry?.cumulativeRecognizedCount).toBe(1);
  });

  it("不认识不增加累计认识次数；重放按 Space 聚合常规条目视图", () => {
    const result = replayLearningEvents({
      events: [
        makeEvent({
          eventType: "testAnswered",
          targetType: "Word",
          targetId: "e-1",
          occurredAt: "2026-07-16T09:00:00Z",
          learningDay: "2026-07-16",
          metadata: {
            sessionId: "s-1",
            initialJudgement: "不认识",
            finalJudgement: "不认识",
            answerRevised: false,
            beforeState: {},
            afterState: { dueAt: "2026-07-17T09:00:00Z", masteryStatus: "未掌握", nextIntervalDays: 1 },
            algorithmVersion: "fsrs-ts-5.4.2-regular-v1",
          },
        }),
      ],
      wordCatalog: [
        { wordId: "e-1", listId: null, spaceId: "space-1", originalSpelling: "phrase", normalizedKey: "phrase" },
      ],
    });

    expect(result.words.get("e-1")?.cumulativeRecognizedCount).toBe(0);
    expect(result.spaces.get("space-1")?.entryIds).toEqual(["e-1"]);
    expect(result.spaces.get("space-1")?.listIds).toEqual([]);
  });
});
