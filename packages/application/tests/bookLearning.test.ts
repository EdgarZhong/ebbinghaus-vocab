/** 词书用户旅程：录入、补录、测试会话、纸质复习与内容维护。 */
import { describe, expect, it, vi } from "vitest";
import { TestJudgement, replayLearningEvents } from "@ebbinghaus/domain";
import { BookLearningService, BookEntryConflictError, getBookSessionTaskSnapshot } from "../src/bookLearning.ts";
import { BookReviewCompletionService } from "../src/bookReview.ts";
import { ConfirmedEntry } from "../src/entryOrganizing.ts";
import { LearningEventRecorder } from "../src/eventRecorder.ts";
import { SchedulingService } from "../src/scheduling.ts";
import { SettingsService } from "../src/settingsFacade.ts";
import { TestSessionExecutionStatus } from "../src/ports.ts";
import {
  FixedClock, InMemoryBookCatalogStore, InMemoryDeviceLocalStore, InMemoryEventStore,
  InMemorySpaceStore, InMemorySyncedSettingsStore, InMemoryTestSessionStore,
  InMemoryWordContentStore, SequentialDeviceSeqAllocator, SequentialIdGenerator,
  StaticDeviceIdentity,
} from "./helpers/fakes.ts";
import { seedSpace } from "./helpers/assemble.ts";

const SPACE_ID = "e1e2e3e4-0000-4000-8000-000000000011";
const ORIGINAL = "2026-07-15T09:00:00Z";

function entry(term: string, definition: string): ConfirmedEntry {
  return new ConfirmedEntry(term, [{ partOfSpeech: "v.", definition, usage: null }]);
}

function world() {
  const clock = new FixedClock(ORIGINAL);
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
  const bookReview = new BookReviewCompletionService({
    eventRecorder, eventStore, wordContentStore, bookCatalogStore, sessionStore, unitOfWork,
  });
  seedSpace(spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "必考词" });
  settings.setActiveSpaceId(SPACE_ID);
  return { clock, eventRecorder, eventStore, wordContentStore, bookCatalogStore, sessionStore, settings, scheduling, bookLearning, bookReview };
}

/** 固定三词与同一任务快照，远端事件必须以启动时的计划时刻匹配，不能靠当前调度结果猜测。 */
function threeWordSession() {
  const ctx = world();
  ctx.bookLearning.recordFirstPass({
    spaceId: SPACE_ID, unitNumber: 1, listNumber: 4,
    entries: [entry("abandon", "放弃"), entry("elaborate", "详尽的"), entry("obtain", "获得")],
  });
  ctx.clock.setInstant("2026-07-16T09:00:00Z");
  const task = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
  const snapshot = ctx.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
  const session = ctx.sessionStore.getSession(snapshot.sessionId)!;
  return { ...ctx, task, snapshot, session, plans: session.words };
}

/** 模拟另一设备拉取后写入本地事件库；只有最终确认事件才可推进开放会话。 */
function appendConfirmedAnswer(
  ctx: ReturnType<typeof threeWordSession>, planIndex: number,
  overrides: { taskId?: string; plannedTestAt?: string } = {},
): void {
  const plan = ctx.plans[planIndex]!;
  ctx.eventStore.appendEvents([ctx.eventRecorder.record({
    eventType: "testAnswered", targetType: "Word", targetId: plan.wordId,
    source: "词书模式测试", occurredAt: ctx.clock.now(),
    metadata: {
      sessionId: "远端测试会话",
      taskId: overrides.taskId ?? ctx.task.taskId,
      plannedTestAt: overrides.plannedTestAt ?? plan.plannedTestAt,
      initialJudgement: TestJudgement.Recognized,
      finalJudgement: TestJudgement.Recognized,
      answerRevised: false,
      beforeState: { shortTermPassCount: 0, masteryStatus: "未掌握", t0: ORIGINAL, t1: null, t2: null },
      afterState: { shortTermPassCount: 1, masteryStatus: "未掌握", t0: ORIGINAL, t1: ctx.clock.now().toISOString(), t2: null },
      algorithmVersion: ctx.task.algorithmVersion,
    },
  })]);
}

describe("词书模式完整学习链", () => {
  it("空 List 必须明确确认；首次保存登记 Unit/List/Word 与首过事件", () => {
    const ctx = world();
    expect(() => ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [] })).toThrow("明确确认");
    const result = ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("abandon", "放弃")] });
    expect(ctx.bookCatalogStore.getList(result.listId)?.listNumber).toBe(4);
    expect(result.words).toHaveLength(1);
    const event = ctx.eventStore.listAllEvents().find((item) => item.eventType === "firstPassRecorded");
    expect(event?.metadata["wordIds"]).toEqual([result.words[0]?.wordId]);
    ctx.clock.setInstant("2026-07-16T09:00:00Z");
    expect(ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]?.taskType).toBe("短期测试");
  });

  it("同 List 补录保持原词 T0，并以补录日给新词生成独立 T0", () => {
    const ctx = world();
    const first = ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("abandon", "放弃")] });
    ctx.clock.setInstant("2026-07-18T09:00:00Z");
    const second = ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("elaborate", "详尽的")] });
    expect(second.listId).toBe(first.listId);
    const replay = replayLearningEvents({
      events: ctx.eventStore.listAllEvents(),
      wordCatalog: ctx.wordContentStore.listCatalogEntries().map((item) => ({
        wordId: item.wordId, listId: item.listId, spaceId: item.spaceId,
        originalSpelling: item.originalSpelling, normalizedKey: item.normalizedKey,
      })),
    });
    expect(replay.words.get(first.words[0]!.wordId)?.t0).toBe("2026-07-15T09:00:00.000Z");
    expect(replay.words.get(second.words[0]!.wordId)?.t0).toBe("2026-07-18T09:00:00.000Z");
  });

  it("已有词冲突不写入，用户选择跳过或覆盖后才保存", () => {
    const ctx = world();
    const first = ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("abandon", "放弃")] });
    const input = { spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("abandon", "抛弃")] };
    const count = ctx.eventStore.listAllEvents().length;
    expect(() => ctx.bookLearning.recordFirstPass(input)).toThrow(BookEntryConflictError);
    expect(ctx.eventStore.listAllEvents()).toHaveLength(count);
    const replaced = ctx.bookLearning.recordFirstPass({ ...input, conflictResolutions: [{ normalizedKey: "abandon", removeExisting: true }] });
    expect(ctx.wordContentStore.getEntry(first.words[0]!.wordId)?.removed).toBe(true);
    expect(replaced.words[0]?.manualMeaning).toContain("抛弃");
    expect(ctx.eventStore.listAllEvents().some((event) => event.eventType === "wordRemoved")).toBe(true);
  });

  it("到期逐词测试可暂停跨日恢复，全部作答后完成纸质复习并关闭会话", () => {
    const ctx = world();
    const result = ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("abandon", "放弃"), entry("elaborate", "详尽的")] });
    ctx.clock.setInstant("2026-07-16T09:00:00Z");
    const task = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    let session = ctx.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
    expect(session.totalCount).toBe(2);
    session = ctx.bookLearning.confirmBookTestAnswer({ sessionId: session.sessionId, expectedWordId: session.currentWord!.wordId, initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized });
    expect(session.currentPosition).toBe(1);
    ctx.bookLearning.pauseBookTest({ sessionId: session.sessionId });
    ctx.clock.setInstant("2026-07-17T09:00:00Z");
    session = ctx.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
    expect(session.currentWord?.originalSpelling).toBe("elaborate");
    session = ctx.bookLearning.confirmBookTestAnswer({ sessionId: session.sessionId, expectedWordId: session.currentWord!.wordId, initialJudgement: TestJudgement.NotRecognized, finalJudgement: TestJudgement.NotRecognized });
    expect(session.status).toBe(TestSessionExecutionStatus.WaitingForPaperReview);
    expect(getBookSessionTaskSnapshot(ctx.sessionStore.getSession(session.sessionId)!)).toEqual(task);
    expect(ctx.bookLearning.pendingPaperReviewTasks(SPACE_ID)).toEqual([task]);
    ctx.bookReview.completePaperReview({ task, learningDaySettings: ctx.settings.getLearningDaySettings() });
    expect(ctx.sessionStore.getOpenListSession(result.listId)).toBeNull();
    expect(ctx.eventStore.listAllEvents().some((event) => event.eventType === "testFollowedByReviewCompleted")).toBe(true);
  });

  it("远端确认首词后，开放会话快照只收敛一次且不产生同步事件", () => {
    const ctx = threeWordSession();
    appendConfirmedAnswer(ctx, 0);
    const eventCount = ctx.eventStore.listAllEvents().length;
    const update = vi.spyOn(ctx.sessionStore, "updateSession");
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot.currentPosition).toBe(1);
    expect(snapshot.currentWord?.wordId).toBe(ctx.plans[1]!.wordId);
    expect(ctx.sessionStore.getSession(snapshot.sessionId)?.answeredWordIds).toEqual([ctx.plans[0]!.wordId]);
    expect(ctx.eventStore.listAllEvents()).toHaveLength(eventCount);
    ctx.bookLearning.getBookTestSessionSnapshot(snapshot.sessionId);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("点错了只把本机当前 Word 移到队尾，其他词答完后仍要重新测试", () => {
    const ctx = threeWordSession();
    const eventCount = ctx.eventStore.listAllEvents().length;
    let snapshot = ctx.bookLearning.deferBookTestWord({
      sessionId: ctx.snapshot.sessionId, expectedWordId: ctx.plans[0]!.wordId,
    });
    expect(snapshot.currentWord?.wordId).toBe(ctx.plans[1]!.wordId);
    expect(snapshot.currentPosition).toBe(0);
    expect(ctx.sessionStore.getSession(snapshot.sessionId)?.words.map((plan) => plan.wordId)).toEqual([
      ctx.plans[1]!.wordId, ctx.plans[2]!.wordId, ctx.plans[0]!.wordId,
    ]);
    expect(ctx.eventStore.listAllEvents()).toHaveLength(eventCount);
    // 队列是本机持久会话的一部分；重新读取不会回到原始词序，也不会误计完成。
    expect(ctx.bookLearning.getBookTestSessionSnapshot(snapshot.sessionId).currentWord?.wordId).toBe(ctx.plans[1]!.wordId);
    for (const wordId of [ctx.plans[1]!.wordId, ctx.plans[2]!.wordId]) {
      snapshot = ctx.bookLearning.confirmBookTestAnswer({
        sessionId: snapshot.sessionId, expectedWordId: wordId,
        initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
      });
    }
    expect(snapshot.currentWord?.wordId).toBe(ctx.plans[0]!.wordId);
    expect(snapshot.status).toBe(TestSessionExecutionStatus.InProgress);
  });

  it("只剩一个未答 Word 时拒绝点错暂缓，避免下一题仍是当前词", () => {
    const ctx = threeWordSession();
    let snapshot = ctx.snapshot;
    for (const plan of ctx.plans.slice(0, 2)) {
      snapshot = ctx.bookLearning.confirmBookTestAnswer({
        sessionId: snapshot.sessionId, expectedWordId: plan.wordId,
        initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
      });
    }
    const eventCount = ctx.eventStore.listAllEvents().length;
    expect(() => ctx.bookLearning.deferBookTestWord({
      sessionId: snapshot.sessionId, expectedWordId: ctx.plans[2]!.wordId,
    })).toThrow("这是最后一个待测 Word，没有下一词可先测");
    const latest = ctx.bookLearning.getBookTestSessionSnapshot(snapshot.sessionId);
    expect(latest.currentWord?.wordId).toBe(ctx.plans[2]!.wordId);
    expect(latest.currentPosition).toBe(2);
    expect(latest.status).toBe(TestSessionExecutionStatus.InProgress);
    expect(ctx.eventStore.listAllEvents()).toHaveLength(eventCount);
  });

  it("远端非连续作答稳定移到已答前缀，当前 Word 保持首个未答词", () => {
    const ctx = threeWordSession();
    appendConfirmedAnswer(ctx, 1);
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot.currentPosition).toBe(1);
    expect(snapshot.currentWord?.wordId).toBe(ctx.plans[0]!.wordId);
    expect(ctx.sessionStore.getSession(snapshot.sessionId)?.words.map((plan) => plan.wordId)).toEqual([
      ctx.plans[1]!.wordId, ctx.plans[0]!.wordId, ctx.plans[2]!.wordId,
    ]);
    expect(ctx.bookLearning.startOrResumeBookTest({ taskId: ctx.task.taskId, spaceId: SPACE_ID }).currentWord?.wordId).toBe(ctx.plans[0]!.wordId);
  });

  it("本机已答首词与远端已答末词合并后，只留下中间 Word 待答", () => {
    const ctx = threeWordSession();
    const local = ctx.bookLearning.confirmBookTestAnswer({
      sessionId: ctx.snapshot.sessionId, expectedWordId: ctx.plans[0]!.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(local.currentPosition).toBe(1);
    appendConfirmedAnswer(ctx, 2);
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot.currentPosition).toBe(2);
    expect(snapshot.currentWord?.wordId).toBe(ctx.plans[1]!.wordId);
    expect(ctx.sessionStore.getSession(snapshot.sessionId)?.answeredWordIds).toEqual([ctx.plans[0]!.wordId, ctx.plans[2]!.wordId]);
  });

  it("本机初判后远端确认旧 Word，第二步须拒绝旧身份且不写本机答案", () => {
    const ctx = threeWordSession();
    const oldWordId = ctx.snapshot.currentWord!.wordId;
    appendConfirmedAnswer(ctx, 0);
    const eventCount = ctx.eventStore.listAllEvents().length;
    expect(() => ctx.bookLearning.confirmBookTestAnswer({
      sessionId: ctx.snapshot.sessionId, expectedWordId: oldWordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    })).toThrow("当前 Word 已变化");
    expect(ctx.eventStore.listAllEvents()).toHaveLength(eventCount);
    expect(ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId).currentWord?.wordId).toBe(ctx.plans[1]!.wordId);
  });

  it("其他任务或计划时刻的同词事件不得误跳当前会话", () => {
    const ctx = threeWordSession();
    appendConfirmedAnswer(ctx, 0, { taskId: "另一任务" });
    appendConfirmedAnswer(ctx, 1, { plannedTestAt: "2026-07-15T00:00:00.000Z" });
    const update = vi.spyOn(ctx.sessionStore, "updateSession");
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot.currentPosition).toBe(0);
    expect(snapshot.currentWord?.wordId).toBe(ctx.plans[0]!.wordId);
    expect(update).not.toHaveBeenCalled();
  });

  it("远端完成全部 Word 后，开放会话转入等待纸质复习并阻止重复启动", () => {
    const ctx = threeWordSession();
    ctx.plans.forEach((_, index) => appendConfirmedAnswer(ctx, index));
    expect(ctx.bookLearning.pendingPaperReviewTasks(SPACE_ID)).toEqual([ctx.task]);
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot.currentPosition).toBe(3);
    expect(snapshot.currentWord).toBeNull();
    expect(snapshot.status).toBe(TestSessionExecutionStatus.WaitingForPaperReview);
    expect(() => ctx.bookLearning.startOrResumeBookTest({ taskId: ctx.task.taskId, spaceId: SPACE_ID })).toThrow("请先完成纸质复习");
  });

  it("暂停和恢复前均收敛远端结果，未完成时分别保留暂停与进行中状态", () => {
    const ctx = threeWordSession();
    appendConfirmedAnswer(ctx, 0);
    const paused = ctx.bookLearning.pauseBookTest({ sessionId: ctx.snapshot.sessionId });
    expect(paused.status).toBe(TestSessionExecutionStatus.Paused);
    expect(paused.currentWord?.wordId).toBe(ctx.plans[1]!.wordId);
    appendConfirmedAnswer(ctx, 1);
    const resumed = ctx.bookLearning.startOrResumeBookTest({ taskId: ctx.task.taskId, spaceId: SPACE_ID });
    expect(resumed.status).toBe(TestSessionExecutionStatus.InProgress);
    expect(resumed.currentPosition).toBe(2);
    expect(resumed.currentWord?.wordId).toBe(ctx.plans[2]!.wordId);
  });

  it("内容维护保留 Word 身份与学习历史，变更标题和移除必须双重确认", () => {
    const ctx = world();
    const first = ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("abandon", "放弃")] });
    const wordId = first.words[0]!.wordId;
    const updated = ctx.bookLearning.updateWordContent({ wordId, entry: entry("abandon", "抛弃") });
    expect(updated.wordId).toBe(wordId);
    expect(() => ctx.bookLearning.updateWordContent({ wordId, entry: entry("abandonment", "放弃") })).toThrow("两次明确确认");
    expect(() => ctx.bookLearning.removeWord({ wordId, firstConfirmation: true, secondConfirmation: false })).toThrow("两次明确确认");
    ctx.bookLearning.removeWord({ wordId, firstConfirmation: true, secondConfirmation: true });
    expect(ctx.wordContentStore.getEntry(wordId)?.removed).toBe(true);
    expect(ctx.eventStore.listAllEvents().filter((event) => event.targetId === wordId).map((event) => event.eventType)).toEqual(["wordContentUpdated", "wordRemoved"]);
  });
});
