/** 词书用户旅程：录入、补录、测试会话、纸质复习与内容维护。 */
import { describe, expect, it } from "vitest";
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
  return { clock, eventStore, wordContentStore, bookCatalogStore, sessionStore, settings, scheduling, bookLearning, bookReview };
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
    session = ctx.bookLearning.confirmBookTestAnswer({ sessionId: session.sessionId, initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized });
    expect(session.currentPosition).toBe(1);
    ctx.bookLearning.pauseBookTest({ sessionId: session.sessionId });
    ctx.clock.setInstant("2026-07-17T09:00:00Z");
    session = ctx.bookLearning.startOrResumeBookTest({ taskId: task.taskId, spaceId: SPACE_ID });
    expect(session.currentWord?.originalSpelling).toBe("elaborate");
    session = ctx.bookLearning.confirmBookTestAnswer({ sessionId: session.sessionId, initialJudgement: TestJudgement.NotRecognized, finalJudgement: TestJudgement.NotRecognized });
    expect(session.status).toBe(TestSessionExecutionStatus.WaitingForPaperReview);
    expect(getBookSessionTaskSnapshot(ctx.sessionStore.getSession(session.sessionId)!)).toEqual(task);
    expect(ctx.bookLearning.pendingPaperReviewTasks(SPACE_ID)).toEqual([task]);
    ctx.bookReview.completePaperReview({ task, learningDaySettings: ctx.settings.getLearningDaySettings() });
    expect(ctx.sessionStore.getOpenListSession(result.listId)).toBeNull();
    expect(ctx.eventStore.listAllEvents().some((event) => event.eventType === "testFollowedByReviewCompleted")).toBe(true);
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
