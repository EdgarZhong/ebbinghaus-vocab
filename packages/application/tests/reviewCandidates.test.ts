/**
 * 词书模式复习入口候选集只读查询测试（需求规格 6.4、复习调度算法 5.5，
 * 2026-10-02 口径）。
 *
 * 候选公式：每 List 候选 = 当日到期的仅复习词 ∪ 今天完成测试的词
 *           − 当日测试任务中未答词（防泄答案）
 *
 * 覆盖场景：
 * - 当日待测且未测的词不进入候选集（防泄答案）；
 * - 今日完成测试的词进入候选集（含逾期测试任务今天完成）；
 * - 当日到期的仅复习词进入候选集，且当天不产生任何任务；
 * - 昨日（逾期）的仅复习词不进入候选集，不做逾期累积；
 * - 同一词多项需求（仅复习到期 + 今日已测）只计一次；
 * - 候选集为纯派生只读视图：查询本身不产生任何事件写入。
 */
import { describe, expect, it } from "vitest";

import { BookLearningService } from "../src/bookLearning.ts";
import { ReviewCandidatesService } from "../src/reviewCandidates.ts";
import { ConfirmedEntry } from "../src/entryOrganizing.ts";
import { LearningEventRecorder } from "../src/eventRecorder.ts";
import { SchedulingService } from "../src/scheduling.ts";
import { SettingsService } from "../src/settingsFacade.ts";
import { TestJudgement } from "@ebbinghaus/domain";
import {
  FixedClock, InMemoryBookCatalogStore, InMemoryDeviceLocalStore, InMemoryEventStore,
  InMemorySpaceStore, InMemorySyncedSettingsStore, InMemoryTestSessionStore,
  InMemoryWordContentStore, SequentialDeviceSeqAllocator, SequentialIdGenerator,
  StaticDeviceIdentity,
} from "./helpers/fakes.ts";
import { LEARNING_DAY_SETTINGS, seedSpace } from "./helpers/assemble.ts";

const SPACE_ID = "space-book-review";
const T0_ISO = "2026-07-13T09:00:00Z";

function entry(term: string, definition: string): ConfirmedEntry {
  return new ConfirmedEntry(term, [{ partOfSpeech: "v.", definition, usage: null }]);
}

function buildWorld() {
  const clock = new FixedClock(T0_ISO);
  const idGenerator = new SequentialIdGenerator();
  const eventStore = new InMemoryEventStore();
  const wordContentStore = new InMemoryWordContentStore();
  const bookCatalogStore = new InMemoryBookCatalogStore();
  const spaceStore = new InMemorySpaceStore();
  const sessionStore = new InMemoryTestSessionStore();
  const settings = new SettingsService({
    syncedSettings: new InMemorySyncedSettingsStore(), deviceLocal: new InMemoryDeviceLocalStore(),
    clock, deviceIdentity: new StaticDeviceIdentity(),
  });
  const eventRecorder = new LearningEventRecorder({
    clock, idGenerator, deviceIdentity: new StaticDeviceIdentity(),
    deviceSeqAllocator: new SequentialDeviceSeqAllocator(),
    readLearningDaySettings: () => settings.getLearningDaySettings(),
  });
  const scheduling = new SchedulingService({ clock, eventStore, wordContentStore, bookCatalogStore });
  const unitOfWork = { run(write: () => void): void { write(); } };
  const bookLearning = new BookLearningService({
    clock, idGenerator, eventRecorder, eventStore, wordContentStore,
    bookCatalogStore, spaceStore, sessionStore, settings, scheduling, unitOfWork,
  });
  const reviewCandidates = new ReviewCandidatesService({
    clock, eventStore, wordContentStore, bookCatalogStore, scheduling,
  });
  seedSpace(spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "必考词" });
  settings.setActiveSpaceId(SPACE_ID);
  return {
    clock, eventRecorder, eventStore, wordContentStore, bookCatalogStore,
    sessionStore, settings, scheduling, bookLearning, reviewCandidates,
  };
}

type World = ReturnType<typeof buildWorld>;

/** 在指定 List 录入词并返回词标识（首过时刻 = 调用前拨好的时钟）。 */
function recordList(world: World, listNumber: number, terms: string[]): string[] {
  const result = world.bookLearning.recordFirstPass({
    spaceId: SPACE_ID, unitNumber: 1, listNumber,
    entries: terms.map((term) => entry(term, `${term} 释义`)),
  });
  return result.words.map((word) => word.wordId);
}

/** 经真实测试会话确认当前到期词（写 testAnswered 事件）。返回会话完成态。 */
function answerDueWords(world: World): void {
  const settings = world.settings.getLearningDaySettings();
  const task = world.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: settings }).tasks[0];
  if (task === undefined) throw new Error("测试前置：当天没有到期任务");
  let session = world.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
  const plans = world.sessionStore.getSession(session.sessionId)!.words;
  for (const plan of plans) {
    session = world.bookLearning.confirmBookTestAnswer({
      sessionId: session.sessionId, expectedWordId: plan.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
  }
}

/** 直接追加一条历史测试答案事件（afterState 为权威派生输入，免走完整会话）。 */
function seedAnswer(world: World, wordId: string, atIso: string, afterState: Record<string, unknown>): void {
  world.clock.setInstant(atIso);
  const event = world.eventRecorder.record({
    eventType: "testAnswered", targetType: "Word", targetId: wordId,
    source: "词书模式测试", occurredAt: world.clock.now(),
    metadata: {
      sessionId: "session-history", taskId: "task-history",
      initialJudgement: "认识", finalJudgement: "认识", answerRevised: false,
      beforeState: {}, afterState, algorithmVersion: "scheduler-v1",
    },
  });
  world.eventStore.appendEvents([event]);
}

/** 候选集按 List 分组转 Map，便于逐 List 断言。 */
function candidatesByList(world: World): Map<string, readonly string[]> {
  return new Map(
    world.reviewCandidates
      .bookReviewCandidates({ spaceId: SPACE_ID, learningDaySettings: LEARNING_DAY_SETTINGS })
      .map((group) => [group.listId, group.wordIds]),
  );
}

describe("复习候选集：今天完成测试的词", () => {
  it("当日待测且未测的词不进入候选集（防泄答案）；今天测完后进入候选集", () => {
    const world = buildWorld();
    // T0 = 07-13；今天 07-14：T0+1 测试到期（也仅有测试到期）。
    const wordId = recordList(world, 1, ["abandon"])[0]!;
    world.clock.setInstant("2026-07-14T09:00:00Z");

    // 未测：词在今天测试任务中且没有今日答案 → 扣除 → 候选为空。
    expect(candidatesByList(world).size).toBe(0);
    expect(world.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: LEARNING_DAY_SETTINGS }).tasks).toHaveLength(1);

    // 今天完成测试：进入候选集（同日测试任务已答，不在扣除集内）。
    answerDueWords(world);
    const candidates = candidatesByList(world);
    expect(candidates.size).toBe(1);
    expect([...candidates.values()]).toEqual([[wordId]]);
  });

  it("逾期测试任务在今天完成：词按最终答案的学习日计入今天候选", () => {
    const world = buildWorld();
    // T0 = 07-13；今天 07-16：测试需求 07-14 逾期 2 天，仅复习需求 07-15 已逾期。
    const wordId = recordList(world, 1, ["abandon"])[0]!;
    world.clock.setInstant("2026-07-16T09:00:00Z");

    // 未答前： today's task contains the word but unanswered → excluded.
    expect(candidatesByList(world).size).toBe(0);
    answerDueWords(world);
    const candidates = candidatesByList(world);
    expect([...candidates.values()]).toEqual([[wordId]]);
  });

  it("同一词仅复习到期且今天已测：候选只计一次", () => {
    const world = buildWorld();
    // T0 = 07-14；今天 07-16：测试需求 07-15 逾期，仅复习需求 T0+2 = 07-16 当日到期。
    const wordId = recordList(world, 1, ["abandon"])[0]!;
    world.clock.setInstant("2026-07-16T09:00:00Z");
    answerDueWords(world);
    const candidates = candidatesByList(world);
    expect([...candidates.values()]).toEqual([[wordId]]);
  });
});

describe("复习候选集：当日到期的仅复习词", () => {
  it("当日到期的仅复习词进入候选集，且当天不产生任何任务", () => {
    const world = buildWorld();
    const wordId = recordList(world, 1, ["abandon"])[0]!;
    // 首过当天傍晚通过第一次短期测试：T1 = 07-13，仅复习 T1+1 = 07-14 当日到期，
    // 晋级测试 T1+3 = 07-16 尚未到期。
    seedAnswer(world, wordId, "2026-07-13T10:00:00Z", {
      shortTermPassCount: 1, masteryStatus: "未掌握",
      t0: "2026-07-13T09:00:00.000Z", t1: "2026-07-13T10:00:00.000Z",
    });
    world.clock.setInstant("2026-07-14T09:00:00Z");

    expect(world.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: LEARNING_DAY_SETTINGS }).tasks).toHaveLength(0);
    expect([...candidatesByList(world).values()]).toEqual([[wordId]]);
  });

  it("昨日（逾期）的仅复习词不进入候选集：不做逾期累积", () => {
    const world = buildWorld();
    const wordId = recordList(world, 1, ["abandon"])[0]!;
    seedAnswer(world, wordId, "2026-07-13T10:00:00Z", {
      shortTermPassCount: 1, masteryStatus: "未掌握",
      t0: "2026-07-13T09:00:00.000Z", t1: "2026-07-13T10:00:00.000Z",
    });
    // 仅复习日期 07-14 已过：今天 07-15 候选为空，直到 07-16 晋级测试到期。
    world.clock.setInstant("2026-07-15T09:00:00Z");
    expect(candidatesByList(world).size).toBe(0);
    world.clock.setInstant("2026-07-16T09:00:00Z");
    // 晋级测试到期（未测）：词在今日测试任务中且未答 → 仍不进候选集。
    expect(candidatesByList(world).size).toBe(0);
    answerDueWords(world);
    expect([...candidatesByList(world).values()]).toEqual([[wordId]]);
  });

  it("多 List 按 List 分组输出，互不影响", () => {
    const world = buildWorld();
    const wordA = recordList(world, 1, ["abandon"])[0]!;
    const wordB = recordList(world, 2, ["elaborate"])[0]!;
    // 两词都通过第一次短期测试：T1 = 07-13，仅复习 07-14 当日到期。
    seedAnswer(world, wordA, "2026-07-13T10:00:00Z", {
      shortTermPassCount: 1, masteryStatus: "未掌握",
      t0: "2026-07-13T09:00:00.000Z", t1: "2026-07-13T10:00:00.000Z",
    });
    seedAnswer(world, wordB, "2026-07-13T10:00:00Z", {
      shortTermPassCount: 1, masteryStatus: "未掌握",
      t0: "2026-07-13T09:00:00.000Z", t1: "2026-07-13T10:00:00.000Z",
    });
    world.clock.setInstant("2026-07-14T09:00:00Z");

    const listA = world.bookCatalogStore.getListByNumber(world.bookCatalogStore.getUnitByNumber(SPACE_ID, 1)!.id, 1)!;
    const listB = world.bookCatalogStore.getListByNumber(world.bookCatalogStore.getUnitByNumber(SPACE_ID, 1)!.id, 2)!;
    const candidates = candidatesByList(world);
    expect(candidates.get(listA.listId)).toEqual([wordA]);
    expect(candidates.get(listB.listId)).toEqual([wordB]);
  });
});

describe("复习候选集：只读视图语义", () => {
  it("查询本身不产生任何事件写入（不持久化、不同步、无写路径）", () => {
    const world = buildWorld();
    const wordId = recordList(world, 1, ["abandon"])[0]!;
    seedAnswer(world, wordId, "2026-07-13T10:00:00Z", {
      shortTermPassCount: 1, masteryStatus: "未掌握",
      t0: "2026-07-13T09:00:00.000Z", t1: "2026-07-13T10:00:00.000Z",
    });
    world.clock.setInstant("2026-07-14T09:00:00Z");
    const eventCount = world.eventStore.listAllEvents().length;
    const appendCalls = world.eventStore.appendCallCount;

    const groups = world.reviewCandidates.bookReviewCandidates({
      spaceId: SPACE_ID, learningDaySettings: LEARNING_DAY_SETTINGS,
    });
    expect(groups.length).toBe(1);
    expect(world.eventStore.listAllEvents()).toHaveLength(eventCount);
    expect(world.eventStore.appendCallCount).toBe(appendCalls);
  });
});
