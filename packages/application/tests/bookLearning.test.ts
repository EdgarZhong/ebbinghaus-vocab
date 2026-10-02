/** 词书用户旅程：录入、补录、测试会话、答案驱动的 List 聚合事件与内容维护。 */
import { describe, expect, it, vi } from "vitest";
import { TestJudgement, replayLearningEvents } from "@ebbinghaus/domain";
import { BookLearningService, BookEntryConflictError, getBookSessionTaskSnapshot } from "../src/bookLearning.ts";
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
  seedSpace(spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "必考词" });
  settings.setActiveSpaceId(SPACE_ID);
  return { clock, eventRecorder, eventStore, wordContentStore, bookCatalogStore, sessionStore, settings, scheduling, bookLearning };
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

  it("同一学习日内暂停可恢复；全部作答后会话即完成，不产生任何复习相关事件", () => {
    const ctx = world();
    const result = ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("abandon", "放弃"), entry("elaborate", "详尽的")] });
    ctx.clock.setInstant("2026-07-16T09:00:00Z");
    const task = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    let session = ctx.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
    expect(session.totalCount).toBe(2);
    session = ctx.bookLearning.confirmBookTestAnswer({ sessionId: session.sessionId, expectedWordId: session.currentWord!.wordId, initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized });
    expect(session.currentPosition).toBe(1);
    ctx.bookLearning.pauseBookTest({ sessionId: session.sessionId });
    // 同一学习日内：暂停后恢复继续剩余词，仍是同一会话
    let resumed = ctx.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
    expect(resumed.sessionId).toBe(session.sessionId);
    expect(resumed.currentWord?.originalSpelling).toBe("elaborate");
    // 全部作答后会话即完成（2026-10-02：不存在"等待纸质复习"长期存活状态，复习入口
    // 是纯派生只读视图，无任何复习事件）。
    session = ctx.bookLearning.confirmBookTestAnswer({ sessionId: resumed.sessionId, expectedWordId: resumed.currentWord!.wordId, initialJudgement: TestJudgement.NotRecognized, finalJudgement: TestJudgement.NotRecognized });
    expect(session.status).toBe(TestSessionExecutionStatus.Completed);
    expect(getBookSessionTaskSnapshot(ctx.sessionStore.getSession(session.sessionId)!)).toEqual(task);
    expect(ctx.sessionStore.getOpenListSession(result.listId)).toBeNull();
    const eventTypes = ctx.eventStore.listAllEvents().map((event) => event.eventType);
    expect(eventTypes.filter((type) => type === "testAnswered")).toHaveLength(2);
    expect(eventTypes).not.toContain("reviewOnlyCompleted");
    expect(eventTypes).not.toContain("testFollowedByReviewCompleted");
    expect(eventTypes).not.toContain("listSynchronized");
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
    const update = vi.spyOn(ctx.sessionStore, "reconcileSession");
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

  it("60 词会话读取快照只批量查询一次活动词，并只单查当前 Word", () => {
    const ctx = world();
    const entries = Array.from({ length: 60 }, (_, index) => entry(
      `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`,
      `释义${index}`,
    ));
    ctx.bookLearning.recordFirstPass({ spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries });
    ctx.clock.setInstant("2026-07-16T09:00:00Z");
    const task = ctx.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings(),
    }).tasks[0]!;
    const listEntries = vi.spyOn(ctx.wordContentStore, "listEntriesForList");
    const getEntry = vi.spyOn(ctx.wordContentStore, "getEntry");
    const started = ctx.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
    const plannedWordIds = ctx.sessionStore.getSession(started.sessionId)!.words.map((plan) => plan.wordId);
    // 创建会话与恢复校对同样不能按待测词数逐次跨桥查询。
    expect(listEntries).toHaveBeenCalledExactlyOnceWith(task.listId);
    expect(getEntry).toHaveBeenCalledExactlyOnceWith(plannedWordIds[0]);
    listEntries.mockClear();
    getEntry.mockClear();

    // 计数从会话创建之后开始，避免首过和任务生成的仓储读取混入快照路径。
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(started.sessionId);
    expect(snapshot.totalCount).toBe(60);
    expect(snapshot.currentPosition).toBe(0);
    expect(snapshot.currentWord).toMatchObject({
      wordId: plannedWordIds[0], originalSpelling: "wordaa", manualMeaning: "v. 释义0",
    });
    expect(ctx.sessionStore.getSession(started.sessionId)!.words.map((plan) => plan.wordId)).toEqual(plannedWordIds);
    expect(listEntries).toHaveBeenCalledExactlyOnceWith(task.listId);
    expect(getEntry).toHaveBeenCalledExactlyOnceWith(plannedWordIds[0]);
  });

  it("恢复时移除已软删除及内容缺失的 Word，保留其余会话词顺序", () => {
    const ctx = threeWordSession();
    const [removed, missing, surviving] = ctx.plans;
    ctx.wordContentStore.markRemoved(removed!.wordId, ctx.clock.now().toISOString());
    const activeEntries = ctx.wordContentStore.listEntriesForList(ctx.task.listId);
    // 模拟本地内容行缺失：活动词批量查询中没有该 Word，不能让旧会话停在失效词上。
    vi.spyOn(ctx.wordContentStore, "listEntriesForList")
      .mockReturnValue(activeEntries.filter((word) => word.wordId !== missing!.wordId));
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot.totalCount).toBe(1);
    expect(snapshot.currentWord?.wordId).toBe(surviving!.wordId);
    expect(ctx.sessionStore.getSession(snapshot.sessionId)?.words.map((plan) => plan.wordId)).toEqual([surviving!.wordId]);
  });

  it("事件先移除而内容仍活动时跳过旧词，旧页面最终确认不写答案", () => {
    const ctx = threeWordSession();
    const removed = ctx.plans[0]!.wordId;
    // 内容和事件分通道拉取：先到的移除事件已足够排除旧会话中的 Word。
    ctx.eventStore.appendEvents([ctx.eventRecorder.record({
      eventType: "wordRemoved", targetType: "Word", targetId: removed,
      source: "Word 内容维护", metadata: { listId: ctx.task.listId, normalizedKey: "abandon" },
    })]);
    expect(ctx.wordContentStore.getEntry(removed)?.removed).toBe(false);
    const eventCount = ctx.eventStore.listAllEvents().length;
    const eventReads = vi.spyOn(ctx.eventStore, "listAllEvents");
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot.totalCount).toBe(2);
    expect(snapshot.currentWord?.wordId).toBe(ctx.plans[1]!.wordId);
    // 会话校对复用同次读取的事件集，不为移除检查重复读取全事件库。
    expect(eventReads).toHaveBeenCalledTimes(1);
    expect(() => ctx.bookLearning.confirmBookTestAnswer({
      sessionId: snapshot.sessionId, expectedWordId: removed,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    })).toThrow("当前 Word 已变化");
    expect(ctx.eventStore.listAllEvents()).toHaveLength(eventCount);
  });

  it("全部会话词的移除事件先到时自动完成，不伪造学习事件或更新活动时间", () => {
    const ctx = threeWordSession();
    ctx.eventStore.appendEvents(ctx.plans.map((plan) => ctx.eventRecorder.record({
      eventType: "wordRemoved", targetType: "Word", targetId: plan.wordId,
      source: "Word 内容维护", metadata: { listId: ctx.task.listId, normalizedKey: plan.wordId },
    })));
    const eventCount = ctx.eventStore.listAllEvents().length;
    expect(ctx.bookLearning.pauseBookTest({ sessionId: ctx.snapshot.sessionId }).status).toBe(TestSessionExecutionStatus.Completed);
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot).toMatchObject({ status: TestSessionExecutionStatus.Completed, totalCount: 0, currentWord: null });
    expect(ctx.sessionStore.getSession(snapshot.sessionId)?.lastActiveAt).toBe(ctx.session.lastActiveAt);
    expect(ctx.eventStore.listAllEvents()).toHaveLength(eventCount);
  });

  it("事件已移除但内容尚活动时，旧维护入口不能改内容或重复写移除事件", () => {
    const ctx = threeWordSession();
    const wordId = ctx.plans[0]!.wordId;
    ctx.eventStore.appendEvents([ctx.eventRecorder.record({
      eventType: "wordRemoved", targetType: "Word", targetId: wordId,
      source: "Word 内容维护", metadata: { listId: ctx.task.listId, normalizedKey: "abandon" },
    })]);
    const contentBefore = ctx.wordContentStore.getEntry(wordId);
    const eventCount = ctx.eventStore.listAllEvents().length;
    expect(contentBefore?.removed).toBe(false);
    expect(() => ctx.bookLearning.updateWordContent({ wordId, entry: entry("abandon", "旧页面修改") }))
      .toThrow("Word 不存在或已移除");
    expect(() => ctx.bookLearning.removeWord({ wordId, firstConfirmation: true, secondConfirmation: true }))
      .toThrow("Word 不存在或已移除");
    expect(ctx.wordContentStore.getEntry(wordId)).toEqual(contentBefore);
    expect(ctx.eventStore.listAllEvents()).toHaveLength(eventCount);
  });

  it("词书测试会话缺少 List 标识时明确拒绝读取", () => {
    const ctx = threeWordSession();
    // 普通进度更新不允许改写会话归属；直接构造错误历史快照来验证防御边界。
    const sessionId = "invalid-list-session";
    ctx.sessionStore.addSession({ ...ctx.session, sessionId, listId: null });
    expect(() => ctx.bookLearning.getBookTestSessionSnapshot(sessionId)).toThrow("词书测试会话缺少 List 标识");
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

  it("远端完成全部 Word 后会话完成；复习相关事件始终不存在，重复开始不会被旧会话挡住", () => {
    const ctx = threeWordSession();
    ctx.plans.forEach((_, index) => appendConfirmedAnswer(ctx, index));
    const snapshot = ctx.bookLearning.getBookTestSessionSnapshot(ctx.snapshot.sessionId);
    expect(snapshot.currentPosition).toBe(3);
    expect(snapshot.currentWord).toBeNull();
    expect(snapshot.status).toBe(TestSessionExecutionStatus.Completed);
    // 2026-10-02 口径：答案之外不再有复习确认事件（远端答案只写 testAnswered 族），
    // 三个词都只达到短期通过次数 1，也不满足同步条件。
    const eventTypes = ctx.eventStore.listAllEvents().map((event) => event.eventType);
    expect(eventTypes.filter((type) => type === "testAnswered")).toHaveLength(3);
    expect(eventTypes).not.toContain("testFollowedByReviewCompleted");
    expect(eventTypes).not.toContain("reviewOnlyCompleted");
    expect(eventTypes).not.toContain("listSynchronized");
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

/**
 * 答案驱动的 List 聚合事件（2026-10-02 口径，复习调度算法 7.1/7.3）：
 * listSynchronized 随使同步条件首次满足的那个词答案同一批写入，
 * listMastered 在长期验证全部词已掌握时随最后一词答案同一批写入。
 */
describe("答案驱动的 List 聚合事件", () => {
  /** 两词 List 走完整短期闭环：07-16 首测双双 0→1，07-19 晋级测试双双 1→2。 */
  function twoWordCycleToPromotion() {
    const ctx = world();
    ctx.bookLearning.recordFirstPass({
      spaceId: SPACE_ID, unitNumber: 1, listNumber: 4,
      entries: [entry("abandon", "放弃"), entry("elaborate", "详尽的")],
    });
    ctx.clock.setInstant("2026-07-16T09:00:00Z");
    const firstTask = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    const first = ctx.bookLearning.startOrResumeBookTest({ taskId: firstTask.taskId, spaceId: SPACE_ID });
    const firstPlans = ctx.sessionStore.getSession(first.sessionId)!.words;
    let session = first;
    for (const plan of firstPlans) {
      session = ctx.bookLearning.confirmBookTestAnswer({
        sessionId: session.sessionId, expectedWordId: plan.wordId,
        initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
      });
    }
    expect(session.status).toBe(TestSessionExecutionStatus.Completed);
    // 07-19（T1+3）晋级测试：两词 1→2 的第二次短期测试。
    ctx.clock.setInstant("2026-07-19T09:00:00Z");
    const promotionTask = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    const promotion = ctx.bookLearning.startOrResumeBookTest({ taskId: promotionTask.taskId, spaceId: SPACE_ID });
    return { ...ctx, promotion, promotionTask };
  }

  /** 重放出 List 阶段与同步时刻，验证聚合事件的派生效果。 */
  function replayList(ctx: ReturnType<typeof world>, listId: string) {
    return replayLearningEvents({
      events: ctx.eventStore.listAllEvents(),
      wordCatalog: ctx.wordContentStore.listCatalogEntries().map((item) => ({
        wordId: item.wordId, listId: item.listId, spaceId: item.spaceId,
        originalSpelling: item.originalSpelling, normalizedKey: item.normalizedKey,
      })),
    }).lists.get(listId);
  }

  it("没有移除事件的软移除词不阻挡有效词最后答案触发 List 同步", () => {
    const ctx = twoWordCycleToPromotion();
    const plans = ctx.sessionStore.getSession(ctx.promotion.sessionId)!.words;
    ctx.wordContentStore.markRemoved(plans[1]!.wordId, ctx.clock.now().toISOString());
    const snapshot = ctx.bookLearning.confirmBookTestAnswer({
      sessionId: ctx.promotion.sessionId, expectedWordId: plans[0]!.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(snapshot.status).toBe(TestSessionExecutionStatus.Completed);
    const synchronized = ctx.eventStore.listAllEvents().filter((event) => event.eventType === "listSynchronized");
    expect(synchronized).toHaveLength(1);
    expect(synchronized[0]?.occurredAt).toBe(ctx.clock.now().toISOString());
    expect(replayList(ctx, ctx.promotionTask.listId)?.stage).toBe("长期验证");
    // 调用补录锁查询同样经过目录重放，保留原有永久锁行为。
    expect(() => ctx.bookLearning.recordFirstPass({
      spaceId: SPACE_ID, unitNumber: 1, listNumber: 4, entries: [entry("obtain", "获得")],
    })).toThrow("新增 Word");
    expect(ctx.eventStore.listAllEvents().some((event) => event.eventType === "wordRemoved")).toBe(false);
  });

  it("最后一词使同步条件首次满足：listSynchronized 与该答案同一批写入，occurredAt = 答案时刻", () => {
    const ctx = twoWordCycleToPromotion();
    const plans = ctx.sessionStore.getSession(ctx.promotion.sessionId)!.words;
    const listId = ctx.promotionTask.listId;
    // 第一词 1→2：尚有一词为 1，不满足同步条件，不写聚合事件。
    const firstAnswer = ctx.bookLearning.confirmBookTestAnswer({
      sessionId: ctx.promotion.sessionId, expectedWordId: plans[0]!.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(firstAnswer.currentPosition).toBe(1);
    const typesAfterFirst = ctx.eventStore.listAllEvents().map((event) => event.eventType);
    expect(typesAfterFirst).not.toContain("listSynchronized");
    // 最后一词 1→2：同步条件首次满足，listSynchronized 与 testAnswered 同一批追加。
    const appendCallsBefore = ctx.eventStore.appendCallCount;
    const secondAnswer = ctx.bookLearning.confirmBookTestAnswer({
      sessionId: ctx.promotion.sessionId, expectedWordId: plans[1]!.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(secondAnswer.status).toBe(TestSessionExecutionStatus.Completed);
    // 一次 appendEvents 调用 = 同一批：答案与聚合事件同生共死。
    expect(ctx.eventStore.appendCallCount).toBe(appendCallsBefore + 1);
    const events = ctx.eventStore.listAllEvents();
    const syncEvent = events.find((event) => event.eventType === "listSynchronized")!;
    expect(syncEvent).toBeDefined();
    expect(syncEvent.targetType).toBe("List");
    expect(syncEvent.targetId).toBe(listId);
    // 该词在首轮测试也有一条答案（07-16）：取晋级轮（与同步事件同时刻）那条比对。
    const answerEvent = events.find((event) =>
      event.eventType === "testAnswered" &&
      event.targetId === plans[1]!.wordId &&
      event.occurredAt === syncEvent.occurredAt)!;
    expect(answerEvent).toBeDefined();
    expect(syncEvent.occurredAt).toBe(answerEvent.occurredAt);
    expect(syncEvent.occurredAt).toBe("2026-07-19T09:00:00.000Z");
    expect(syncEvent.metadata["taskId"]).toBe(ctx.promotionTask.taskId);
    // 重放：List 进入长期验证，同步时刻取该答案时刻（TS）。
    const list = replayList(ctx, listId);
    expect(list?.stage).toBe("长期验证");
    expect(list?.synchronizedAt).toBe(answerEvent.occurredAt);
    expect(list?.additionsLocked).toBe(true);
  });

  it("同步条件未满足时不写 listSynchronized", () => {
    const ctx = world();
    ctx.bookLearning.recordFirstPass({
      spaceId: SPACE_ID, unitNumber: 1, listNumber: 4,
      entries: [entry("abandon", "放弃"), entry("elaborate", "详尽的")],
    });
    ctx.clock.setInstant("2026-07-16T09:00:00Z");
    const task = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    const session = ctx.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
    // 只答一词（0→1）：另一词仍为 0，不满足同步条件。
    ctx.bookLearning.confirmBookTestAnswer({
      sessionId: session.sessionId, expectedWordId: session.currentWord!.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(ctx.eventStore.listAllEvents().map((event) => event.eventType)).not.toContain("listSynchronized");
  });

  it("同步后长期验证失败重新进入短期周期：只有重新首次满足时才写第二个 listSynchronized", () => {
    const ctx = twoWordCycleToPromotion();
    const plans = ctx.sessionStore.getSession(ctx.promotion.sessionId)!.words;
    for (const plan of plans) {
      ctx.bookLearning.confirmBookTestAnswer({
        sessionId: ctx.promotion.sessionId, expectedWordId: plan.wordId,
        initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
      });
    }
    expect(ctx.eventStore.listAllEvents().filter((event) => event.eventType === "listSynchronized")).toHaveLength(1);
    const listId = ctx.promotionTask.listId;

    // TS = 07-19；07-26 长期验证：一词不认识（重置为 0、List 退回短期同步），
    // 另一词认识（已掌握）。两个答案前同步条件都已满足（非首次），不写第二个事件。
    ctx.clock.setInstant("2026-07-26T09:00:00Z");
    const validationTask = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    expect(validationTask.taskType).toBe("长期验证");
    const validation = ctx.bookLearning.startOrResumeBookTest({ taskId: validationTask.taskId, spaceId: SPACE_ID });
    const validationPlans = ctx.sessionStore.getSession(validation.sessionId)!.words;
    ctx.bookLearning.confirmBookTestAnswer({
      sessionId: validation.sessionId, expectedWordId: validationPlans[0]!.wordId,
      initialJudgement: TestJudgement.NotRecognized, finalJudgement: TestJudgement.NotRecognized,
    });
    ctx.bookLearning.confirmBookTestAnswer({
      sessionId: validation.sessionId, expectedWordId: validationPlans[1]!.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(ctx.eventStore.listAllEvents().filter((event) => event.eventType === "listSynchronized")).toHaveLength(1);
    expect(ctx.eventStore.listAllEvents().map((event) => event.eventType)).not.toContain("listMastered");
    expect(replayList(ctx, listId)?.stage).toBe("短期同步");

    // 失败词的新短期周期：07-27 测试 0→1，07-30 晋级 1→2；另一词已掌握不参与。
    // 07-30 的答案使同步条件"重新首次满足"：写第二个 listSynchronized。
    ctx.clock.setInstant("2026-07-27T09:00:00Z");
    const retestTask = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    const retest = ctx.bookLearning.startOrResumeBookTest({ taskId: retestTask.taskId, spaceId: SPACE_ID });
    const retestPlans = ctx.sessionStore.getSession(retest.sessionId)!.words;
    expect(retestPlans.map((plan) => plan.wordId)).toEqual([validationPlans[0]!.wordId]);
    ctx.bookLearning.confirmBookTestAnswer({
      sessionId: retest.sessionId, expectedWordId: retestPlans[0]!.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(ctx.eventStore.listAllEvents().filter((event) => event.eventType === "listSynchronized")).toHaveLength(1);

    ctx.clock.setInstant("2026-07-30T09:00:00Z");
    const repromotionTask = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    const repromotion = ctx.bookLearning.startOrResumeBookTest({ taskId: repromotionTask.taskId, spaceId: SPACE_ID });
    const repromotionPlans = ctx.sessionStore.getSession(repromotion.sessionId)!.words;
    const appendCallsBefore = ctx.eventStore.appendCallCount;
    ctx.bookLearning.confirmBookTestAnswer({
      sessionId: repromotion.sessionId, expectedWordId: repromotionPlans[0]!.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(ctx.eventStore.appendCallCount).toBe(appendCallsBefore + 1);
    const syncEvents = ctx.eventStore.listAllEvents().filter((event) => event.eventType === "listSynchronized");
    expect(syncEvents).toHaveLength(2);
    expect(syncEvents[1]?.occurredAt).toBe("2026-07-30T09:00:00.000Z");
    // 重新同步后 List 回到长期验证（TS 取第二个同步事件的答案时刻）。
    expect(replayList(ctx, listId)?.stage).toBe("长期验证");
  });

  it("长期验证任务不写 listSynchronized；全部词掌握时 listMastered 与最后一词答案同批写入", () => {
    const ctx = twoWordCycleToPromotion();
    const plans = ctx.sessionStore.getSession(ctx.promotion.sessionId)!.words;
    for (const plan of plans) {
      ctx.bookLearning.confirmBookTestAnswer({
        sessionId: ctx.promotion.sessionId, expectedWordId: plan.wordId,
        initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
      });
    }
    // TS = 07-19；07-26 长期验证（TS + 7）测试全部未掌握词。
    ctx.clock.setInstant("2026-07-26T09:00:00Z");
    const validationTask = ctx.scheduling.refreshSpaceTasks({ spaceId: SPACE_ID, learningDaySettings: ctx.settings.getLearningDaySettings() }).tasks[0]!;
    expect(validationTask.taskType).toBe("长期验证");
    const validation = ctx.bookLearning.startOrResumeBookTest({ taskId: validationTask.taskId, spaceId: SPACE_ID });
    const validationPlans = ctx.sessionStore.getSession(validation.sessionId)!.words;
    // 第一词验证认识 → 已掌握；其余词仍未掌握：不写 listMastered，也绝不写
    // listSynchronized（同步条件在答案前已满足，非首次）。
    const firstAnswer = ctx.bookLearning.confirmBookTestAnswer({
      sessionId: validation.sessionId, expectedWordId: validationPlans[0]!.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(firstAnswer.currentPosition).toBe(1);
    let types = ctx.eventStore.listAllEvents().map((event) => event.eventType);
    expect(types).not.toContain("listMastered");
    expect(types.filter((type) => type === "listSynchronized")).toHaveLength(1);
    // 最后一词验证认识 → 全部掌握：listMastered 与该答案同一批写入。
    const appendCallsBefore = ctx.eventStore.appendCallCount;
    const secondAnswer = ctx.bookLearning.confirmBookTestAnswer({
      sessionId: validation.sessionId, expectedWordId: validationPlans[1]!.wordId,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(secondAnswer.status).toBe(TestSessionExecutionStatus.Completed);
    expect(ctx.eventStore.appendCallCount).toBe(appendCallsBefore + 1);
    types = ctx.eventStore.listAllEvents().map((event) => event.eventType);
    expect(types.filter((type) => type === "listMastered")).toHaveLength(1);
    expect(types.filter((type) => type === "listSynchronized")).toHaveLength(1);
    const list = replayList(ctx, ctx.promotionTask.listId);
    expect(list?.stage).toBe("已掌握");
    expect(list?.aggregateStatus).toBe("已掌握");
  });
});
