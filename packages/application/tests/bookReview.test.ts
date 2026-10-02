/**
 * 词书模式纸质复习完成用例测试（移植 V1 application/review_testing.py 的
 * complete_paper_review 行为口径；V2 按事件溯源重设计，事件产出口径与 V1 一致）。
 *
 * 覆盖口径：
 * - 仅复习任务 → reviewOnlyCompleted，工作量 1；
 * - 测试后复习任务（短期测试/等待校验/长期验证）→ testFollowedByReviewCompleted，
 *   工作量 2，metadata 带 answeredPlannedDays 配对键；前置校验 = 批次确有答案且未被
 *   确认过（等待纸质复习由答案事件派生，不依赖本机会话存活）；
 * - List 聚合事件与完成事件同批写入（同生共死）：全部活动词短期通过 2 → 追加
 *   listSynchronized；长期验证且全部词已掌握 → 追加 listMastered；
 * - 仅复习任务不做同步条件判定（即使全部词已通过 2 次也不触发聚合事件）；
 * - List 阶段与聚合状态由重放器从事件派生：本用例只负责在正确时机写入正确事件。
 */
import { describe, expect, it } from "vitest";

import { MasteryStatus, ShortTermPassCount, learningDayStartInstant, reviewDemandKey, replayLearningEvents } from "@ebbinghaus/domain";
import { WordListStage } from "@ebbinghaus/domain";

import { BookReviewCompletionService } from "../src/bookReview.ts";
import { deriveListTaskId } from "../src/eventRecorder.ts";
import { LearningEventRecorder } from "../src/eventRecorder.ts";
import type { PersistedListTask } from "../src/scheduling.ts";
import { ReviewTestingError } from "../src/errors.ts";
import type { WordContentRecord } from "../src/ports.ts";
import {
  FixedClock,
  InMemoryBookCatalogStore,
  InMemoryEventStore,
  InMemorySpaceStore,
  InMemoryWordContentStore,
  SequentialDeviceSeqAllocator,
  SequentialIdGenerator,
  StaticDeviceIdentity,
} from "./helpers/fakes.ts";
import { LEARNING_DAY_SETTINGS, seedSpace } from "./helpers/assemble.ts";

const CLOCK_ISO = "2026-07-15T09:00:00Z";
const SPACE_ID = "c3d4e5f6-0000-4000-8000-0000000000c1";
const LIST_ID = "list-1";
/** 完成确认时刻（ learningDay 2026-07-16）。 */
const DONE_ISO = "2026-07-16T09:00:00Z";
const DONE_ISO_MS = "2026-07-16T09:00:00.000Z";

/** 组装被测服务与全部端口假实现。 */
function buildWorld() {
  const clock = new FixedClock(CLOCK_ISO);
  const eventStore = new InMemoryEventStore();
  const wordContentStore = new InMemoryWordContentStore();
  const bookCatalogStore = new InMemoryBookCatalogStore();
  const spaceStore = new InMemorySpaceStore();
  const eventRecorder = new LearningEventRecorder({
    clock,
    idGenerator: new SequentialIdGenerator(),
    deviceIdentity: new StaticDeviceIdentity(),
    deviceSeqAllocator: new SequentialDeviceSeqAllocator(),
    readLearningDaySettings: () => LEARNING_DAY_SETTINGS,
  });
  const service = new BookReviewCompletionService({
    eventRecorder,
    eventStore,
    wordContentStore,
    bookCatalogStore,
  });
  seedSpace(spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
  return { clock, eventStore, eventRecorder, wordContentStore, bookCatalogStore, spaceStore, service };
}

type World = ReturnType<typeof buildWorld>;

/**
 * 播种一个首过 List，并把每个词推进到指定的重放状态（afterState 是重放侧权威输入）。
 * afterState 必须包含与短期通过次数匹配的周期起点（T0/T1/T2），否则重放器 fail fast。
 */
function seedList(
  world: World,
  input: {
    readonly listId?: string;
    readonly wordIds: readonly string[];
    readonly afterStates: readonly Record<string, unknown>[];
  },
): void {
  const listId = input.listId ?? LIST_ID;
  world.bookCatalogStore.addList({
    listId,
    spaceId: SPACE_ID,
    unitId: "unit-1",
    unitNumber: 1,
    listNumber: 1,
  });
  const entries: WordContentRecord[] = input.wordIds.map((wordId) => ({
    wordId,
    listId,
    spaceId: null,
    originalSpelling: `word-${wordId}`,
    normalizedKey: `word-${wordId}`,
    manualMeaning: "词义",
    meanings: [],
    removed: false,
    recordedAt: CLOCK_ISO,
  }));
  world.wordContentStore.upsertEntries(entries);
  const firstPass = world.eventRecorder.record({
    eventType: "firstPassRecorded",
    targetType: "List",
    targetId: listId,
    source: "首过预览保存",
    metadata: { workload: 1, wordCount: input.wordIds.length, draftId: `draft-${listId}` },
  });
  const answers = input.wordIds.map((wordId, index) =>
    world.eventRecorder.record({
      eventType: "testAnswered",
      targetType: "Word",
      targetId: wordId,
      source: "词书模式测试",
      metadata: {
        sessionId: "session-history",
        taskId: "task-history",
        // 批次配对键的来源：答案计划日 = 本测试约定的 07-16 学习日起始时刻。
        plannedTestAt: learningDayStartInstant("2026-07-16", LEARNING_DAY_SETTINGS).toISOString(),
        initialJudgement: "认识",
        finalJudgement: "认识",
        answerRevised: false,
        beforeState: { shortTermPassCount: 0, masteryStatus: "未掌握" },
        afterState: input.afterStates[index],
        algorithmVersion: "scheduler-v1",
      },
    }),
  );
  world.eventStore.appendEvents([firstPass, ...answers]);
}

/** 短期通过次数 1 的标准 afterState（T0=首过日 07-15，T1=同日晚些时候）。 */
function passOneAfterState(): Record<string, unknown> {
  return {
    shortTermPassCount: ShortTermPassCount.One,
    masteryStatus: MasteryStatus.Unmastered,
    t0: "2026-07-15T09:00:00.000Z",
    t1: "2026-07-15T10:00:00.000Z",
  };
}

/** 短期通过次数 2 的标准 afterState（T0=07-15，T1=07-15，T2=07-15 晋级后）。 */
function passTwoAfterState(): Record<string, unknown> {
  return {
    shortTermPassCount: ShortTermPassCount.Two,
    masteryStatus: MasteryStatus.Unmastered,
    t0: "2026-07-15T09:00:00.000Z",
    t1: "2026-07-15T10:00:00.000Z",
    t2: "2026-07-15T11:00:00.000Z",
  };
}

/** 已掌握（长期验证通过）的标准 afterState。 */
function masteredAfterState(): Record<string, unknown> {
  return {
    shortTermPassCount: ShortTermPassCount.Two,
    masteryStatus: MasteryStatus.Mastered,
    t0: "2026-07-15T09:00:00.000Z",
    t1: "2026-07-15T10:00:00.000Z",
    t2: "2026-07-15T11:00:00.000Z",
  };
}

/** 手工构造计划任务（完成用例只消费任务的类型、标识、List 与仅复习需求负载）。 */
function makeTask(input: {
  readonly listId?: string;
  readonly taskType: string;
  readonly scheduledDay: string;
  readonly workload: number;
  readonly reviewWordIds?: readonly string[];
}): PersistedListTask {
  const listId = input.listId ?? LIST_ID;
  const taskId = deriveListTaskId({
    algorithmVersion: "scheduler-v1",
    listId,
    taskType: input.taskType,
    scheduledDay: input.scheduledDay,
  });
  const reviewDemands = (input.reviewWordIds ?? []).map((wordId) => ({
    wordId,
    taskType: "仅复习",
    scheduledDay: input.scheduledDay,
    reason: "T1 + 1 仅复习",
  }));
  return {
    taskId,
    listId,
    taskType: input.taskType,
    scheduledDay: input.scheduledDay,
    workload: input.workload,
    overdueDays: 0,
    dueReason: "T1 + 1 仅复习",
    algorithmVersion: "scheduler-v1",
    payload: {
      workload: input.workload,
      overdueDays: 0,
      activeWordIds: reviewDemands.map((demand) => demand.wordId),
      testDemands: [],
      reviewDemands,
    },
  };
}

describe("仅复习任务：完成事件口径", () => {
  it("确认纸质复习产出 reviewOnlyCompleted：工作量 1、需求键稳定、无需会话前置", () => {
    const world = buildWorld();
    seedList(world, { wordIds: ["w-1"], afterStates: [passOneAfterState()] });
    world.clock.setInstant(DONE_ISO);
    // T1+1 = 07-16 的仅复习需求，完成键 = wordId|仅复习|计划日（domain 统一实现）。
    const task = makeTask({
      taskType: "仅复习",
      scheduledDay: "2026-07-16",
      workload: 1,
      reviewWordIds: ["w-1"],
    });

    world.service.completePaperReview({ task, learningDaySettings: LEARNING_DAY_SETTINGS });

    const events = world.eventStore.listAllEvents();
    const completed = events.filter((event) => event.eventType === "reviewOnlyCompleted");
    expect(completed).toHaveLength(1);
    const event = completed[0]!;
    expect(event.targetType).toBe("List");
    expect(event.targetId).toBe(LIST_ID);
    expect(event.source).toBe("纸质复习完成");
    expect(event.learningDay).toBe("2026-07-16");
    expect(event.occurredAt).toBe(DONE_ISO_MS);
    expect(event.metadata["taskId"]).toBe(task.taskId);
    expect(event.metadata["taskType"]).toBe("仅复习");
    expect(event.metadata["workload"]).toBe(1);
    expect(event.metadata["reviewDemandKeys"]).toEqual([
      reviewDemandKey("w-1", "2026-07-16"),
    ]);
  });

  it("仅复习任务不做同步条件判定：全部词通过 2 次也不产生 listSynchronized", () => {
    const world = buildWorld();
    seedList(world, { wordIds: ["w-1"], afterStates: [passTwoAfterState()] });
    world.clock.setInstant(DONE_ISO);
    const task = makeTask({
      taskType: "仅复习",
      scheduledDay: "2026-07-16",
      workload: 1,
      reviewWordIds: ["w-1"],
    });

    world.service.completePaperReview({ task, learningDaySettings: LEARNING_DAY_SETTINGS });

    const eventTypes = world.eventStore.listAllEvents().map((event) => event.eventType);
    expect(eventTypes).not.toContain("listSynchronized");
  });
});

describe("测试后复习任务：前置会话与聚合事件", () => {
  it("全部活动词短期通过 2 次：testFollowedByReviewCompleted 与 listSynchronized 同批写入", () => {
    const world = buildWorld();
    seedList(world, {
      wordIds: ["w-1", "w-2"],
      afterStates: [passTwoAfterState(), passTwoAfterState()],
    });
    world.clock.setInstant(DONE_ISO);
    const task = makeTask({ taskType: "短期测试", scheduledDay: "2026-07-16", workload: 2 });

    world.service.completePaperReview({
      task, answeredPlannedDays: ["2026-07-16"], learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    const events = world.eventStore.listAllEvents();
    expect(events.map((event) => event.eventType)).toEqual([
      "firstPassRecorded",
      "testAnswered",
      "testAnswered",
      "testFollowedByReviewCompleted",
      "listSynchronized",
    ]);
    // 完成事件与聚合事件共享同一 metadata（V1 口径），且在同一批 appendEvents 内写入。
    const completion = events.find((event) => event.eventType === "testFollowedByReviewCompleted")!;
    const synchronized = events.find((event) => event.eventType === "listSynchronized")!;
    expect(completion.metadata).toEqual(synchronized.metadata);
    expect(completion.metadata["workload"]).toBe(2);
    expect(world.eventStore.appendCallCount).toBe(2);

    // 聚合状态由重放器从事件派生：List 进入长期验证阶段且新增永久上锁。
    const replay = replayLearningEvents({
      events: world.eventStore.listAllEvents(),
      wordCatalog: world.wordContentStore.listCatalogEntries().map((entry) => ({
        wordId: entry.wordId,
        listId: entry.listId,
        spaceId: entry.spaceId,
        originalSpelling: entry.originalSpelling,
        normalizedKey: entry.normalizedKey,
      })),
    });
    const listState = replay.lists.get(LIST_ID);
    expect(listState?.stage).toBe(WordListStage.LongTermValidation);
    expect(listState?.additionsLocked).toBe(true);
    expect(listState?.synchronizedAt).toBe(DONE_ISO_MS);
  });

  it("未全部通过 2 次时只写完成事件，不追加 listSynchronized", () => {
    const world = buildWorld();
    seedList(world, {
      wordIds: ["w-1", "w-2"],
      afterStates: [passTwoAfterState(), passOneAfterState()],
    });
    world.clock.setInstant(DONE_ISO);
    const task = makeTask({ taskType: "等待校验", scheduledDay: "2026-07-16", workload: 2 });

    world.service.completePaperReview({
      task, answeredPlannedDays: ["2026-07-16"], learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    const eventTypes = world.eventStore.listAllEvents().map((event) => event.eventType);
    expect(eventTypes).toContain("testFollowedByReviewCompleted");
    expect(eventTypes).not.toContain("listSynchronized");
  });

  it("长期验证任务且全部词已掌握：追加 listMastered，List 进入已掌握阶段", () => {
    const world = buildWorld();
    seedList(world, {
      wordIds: ["w-1", "w-2"],
      afterStates: [masteredAfterState(), masteredAfterState()],
    });
    world.clock.setInstant(DONE_ISO);
    const task = makeTask({ taskType: "长期验证", scheduledDay: "2026-07-16", workload: 2 });

    world.service.completePaperReview({
      task, answeredPlannedDays: ["2026-07-16"], learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    const events = world.eventStore.listAllEvents();
    expect(events.map((event) => event.eventType)).toEqual([
      "firstPassRecorded",
      "testAnswered",
      "testAnswered",
      "testFollowedByReviewCompleted",
      "listMastered",
    ]);
    const replay = replayLearningEvents({
      events,
      wordCatalog: world.wordContentStore.listCatalogEntries().map((entry) => ({
        wordId: entry.wordId,
        listId: entry.listId,
        spaceId: entry.spaceId,
        originalSpelling: entry.originalSpelling,
        normalizedKey: entry.normalizedKey,
      })),
    });
    const listState = replay.lists.get(LIST_ID);
    expect(listState?.stage).toBe(WordListStage.Mastered);
    expect(listState?.aggregateStatus).toBe(MasteryStatus.Mastered);
  });
});

describe("前置状态校验", () => {
  it("计划任务所属 List 不存在时报错", () => {
    const world = buildWorld();
    world.clock.setInstant(DONE_ISO);
    const task = makeTask({ listId: "list-missing", taskType: "仅复习", scheduledDay: "2026-07-16", workload: 1 });

    expect(() =>
      world.service.completePaperReview({ task, learningDaySettings: LEARNING_DAY_SETTINGS }),
    ).toThrow(ReviewTestingError);
    expect(() =>
      world.service.completePaperReview({ task, learningDaySettings: LEARNING_DAY_SETTINGS }),
    ).toThrow("计划任务所属 List 不存在");
  });

  it("测试后复习缺批次、批次无答案或已确认时拒绝", () => {
    const world = buildWorld();
    seedList(world, { wordIds: ["w-1"], afterStates: [passTwoAfterState()] });
    world.clock.setInstant(DONE_ISO);
    const task = makeTask({ taskType: "短期测试", scheduledDay: "2026-07-16", workload: 2 });

    // 缺少批次计划日。
    expect(() =>
      world.service.completePaperReview({ task, learningDaySettings: LEARNING_DAY_SETTINGS }),
    ).toThrow("测试后复习缺少对应的测试批次");

    // 该 List 在指定计划日没有任何答案。
    expect(() =>
      world.service.completePaperReview({
        task, answeredPlannedDays: ["2026-07-17"], learningDaySettings: LEARNING_DAY_SETTINGS,
      }),
    ).toThrow("没有已完成的软件测试批次");

    // 正常确认后，同一批次重复确认被拒绝且不产生第二个完成事件。
    world.service.completePaperReview({
      task, answeredPlannedDays: ["2026-07-16"], learningDaySettings: LEARNING_DAY_SETTINGS,
    });
    const count = world.eventStore.listAllEvents()
      .filter((event) => event.eventType === "testFollowedByReviewCompleted").length;
    expect(() =>
      world.service.completePaperReview({
        task, answeredPlannedDays: ["2026-07-16"], learningDaySettings: LEARNING_DAY_SETTINGS,
      }),
    ).toThrow("已确认过");
    expect(world.eventStore.listAllEvents()
      .filter((event) => event.eventType === "testFollowedByReviewCompleted")).toHaveLength(count);
  });
});
