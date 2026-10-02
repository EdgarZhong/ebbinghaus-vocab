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
    eventRecorder, eventStore, wordContentStore, bookCatalogStore, unitOfWork,
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

  it("同一学习日内暂停可恢复；全部作答后会话完成并派生待纸书批次", () => {
    const ctx = world();
    const result = ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("abandon", "放弃"), entry("elaborate", "详尽的")] });
    ctx.clock.setInstant("2026-07-16T09:00:00Z");
    const settings = ctx.settings.getLearningDaySettings();
    const task = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: settings }).tasks[0]!;
    let session = ctx.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
    expect(session.totalCount).toBe(2);
    session = ctx.bookLearning.confirmBookTestAnswer({ sessionId: session.sessionId, expectedWordId: session.currentWord!.wordId, initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized });
    expect(session.currentPosition).toBe(1);
    ctx.bookLearning.pauseBookTest({ sessionId: session.sessionId });
    // 同一学习日内：暂停后恢复继续剩余词，仍是同一会话
    let resumed = ctx.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
    expect(resumed.sessionId).toBe(session.sessionId);
    expect(resumed.currentWord?.originalSpelling).toBe("elaborate");
    // 全部作答后会话即完成（不再转“等待纸质复习”长期存活）；待纸书批次由答案事件派生
    session = ctx.bookLearning.confirmBookTestAnswer({ sessionId: resumed.sessionId, expectedWordId: resumed.currentWord!.wordId, initialJudgement: TestJudgement.NotRecognized, finalJudgement: TestJudgement.NotRecognized });
    expect(session.status).toBe(TestSessionExecutionStatus.Completed);
    expect(getBookSessionTaskSnapshot(ctx.sessionStore.getSession(session.sessionId)!)).toEqual(task);
    const batches = ctx.bookLearning.pendingPaperReviewBatches(SPACE_ID);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.plannedDays).toEqual(["2026-07-16"]);
    expect(batches[0]!.task.listId).toBe(result.listId);
    expect(batches[0]!.task.taskType).toBe("短期测试");
    ctx.bookReview.completePaperReview({ task: batches[0]!.task, answeredPlannedDays: batches[0]!.plannedDays, learningDaySettings: settings });
    expect(ctx.bookLearning.pendingPaperReviewBatches(SPACE_ID)).toHaveLength(0);
    expect(ctx.sessionStore.getOpenListSession(result.listId)).toBeNull();
    expect(ctx.eventStore.listAllEvents().some((event) => event.eventType === "testFollowedByReviewCompleted")).toBe(true);
  });

  it("换日旧会话不阻塞：次日开始测试关闭残留会话并新建，已答词不重复测试", () => {
    const ctx = world();
    const result = ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("abandon", "放弃"), entry("elaborate", "详尽的")] });
    ctx.clock.setInstant("2026-07-16T09:00:00Z");
    const task16 = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    const first = ctx.bookLearning.startOrResumeBookTest({ taskId: task16.taskId, spaceId: SPACE_ID });
    ctx.bookLearning.confirmBookTestAnswer({ sessionId: first.sessionId, expectedWordId: first.currentWord!.wordId, initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized });
    // 换日（07-17）：未答词并入次日任务；残留开放会话绝不阻塞进入
    ctx.clock.setInstant("2026-07-17T09:00:00Z");
    const task17 = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    const second = ctx.bookLearning.startOrResumeBookTest({ taskId: task17.taskId, spaceId: SPACE_ID });
    expect(second.sessionId).not.toBe(first.sessionId);
    // abandon 已答（状态推进为仅复习需求），软件测试只剩未答的 elaborate
    expect(second.totalCount).toBe(1);
    expect(second.currentWord?.originalSpelling).toBe("elaborate");
    // 旧会话已被关闭，库中不再把它当开放会话
    expect(ctx.sessionStore.getSession(first.sessionId)?.status).toBe(TestSessionExecutionStatus.Completed);
    expect(ctx.sessionStore.getOpenListSession(result.listId)?.sessionId).toBe(second.sessionId);
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

  it("任务标识不同的同词答案仍算数；其他计划时刻的同词事件不得误跳当前会话", () => {
    const ctx = threeWordSession();
    // 匹配键 = 词 + 计划时刻，不含任务标识：任务标识漂移后旧答案必须仍能配对进度
    appendConfirmedAnswer(ctx, 0, { taskId: "另一任务" });
    const afterTaskDrift = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(afterTaskDrift.currentPosition).toBe(1);
    expect(afterTaskDrift.currentWord?.wordId).toBe(ctx.plans[1]!.wordId);
    // 计划时刻不同 = 另一轮测试，不得误算进本会话
    appendConfirmedAnswer(ctx, 1, { plannedTestAt: "2026-07-15T00:00:00.000Z" });
    const update = vi.spyOn(ctx.sessionStore, "updateSession");
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot.currentPosition).toBe(1);
    expect(snapshot.currentWord?.wordId).toBe(ctx.plans[1]!.wordId);
    expect(update).not.toHaveBeenCalled();
  });

  it("远端完成全部 Word 后会话完成并派生待纸书批次，重复开始不会被旧会话挡住", () => {
    const ctx = threeWordSession();
    ctx.plans.forEach((_, index) => appendConfirmedAnswer(ctx, index));
    expect(ctx.bookLearning.pendingPaperReviewBatches(SPACE_ID)).toHaveLength(1);
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot.currentPosition).toBe(3);
    expect(snapshot.currentWord).toBeNull();
    expect(snapshot.status).toBe(TestSessionExecutionStatus.Completed);
    // 答案推进调度后当前没有测试任务：入口如实提示"没有可开始的任务"，
    // 而不是拿旧会话状态拒绝用户。
    expect(() => ctx.bookLearning.startOrResumeBookTest({ taskId: ctx.task.taskId, spaceId: SPACE_ID })).toThrow("该 List 没有可开始的软件测试任务");
  });

  it("同一学习日内重复进入恢复同一会话，点别的 List 不会串台", () => {
    const ctx = threeWordSession();
    const resumed = ctx.bookLearning.startOrResumeBookTest({ taskId: ctx.task.taskId, spaceId: SPACE_ID });
    expect(resumed.sessionId).toBe(ctx.snapshot.sessionId);
    // 同 List 当天再次进入：仍恢复同一会话（不校验任务标识漂移）
    const again = ctx.bookLearning.startOrResumeBookTest({ taskId: ctx.task.taskId, spaceId: SPACE_ID });
    expect(again.sessionId).toBe(ctx.snapshot.sessionId);
    expect(again.currentWord?.wordId).toBe(ctx.plans[0]!.wordId);

    // 另一个 List 有自己的任务：点开始必须新建它自己的会话，而不是恢复 List 4 的
    ctx.clock.setInstant(ORIGINAL);
    ctx.bookLearning.recordFirstPass({
      spaceId: SPACE_ID, unitNumber: 1, listNumber: 5,
      entries: [entry("access", "接近"), entry("achieve", "达成")],
    });
    ctx.clock.setInstant("2026-07-16T09:00:00Z");
    const otherTask = ctx.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings(),
    }).tasks.find((item) => item.listId !== ctx.task.listId)!;
    const other = ctx.bookLearning.startOrResumeBookTest({ taskId: otherTask.taskId, spaceId: SPACE_ID });
    expect(other.sessionId).not.toBe(ctx.snapshot.sessionId);
    expect(other.totalCount).toBe(2);
    expect(other.currentWord?.originalSpelling).not.toBe(ctx.snapshot.currentWord?.originalSpelling);
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
