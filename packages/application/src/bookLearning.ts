/**
 * 词书模式录入、逐词测试和 Word 内容维护用例。
 *
 * 词书业务事实仍由不可变事件承载，目录只保存 Unit/List/Word 身份与内容；一次操作
 * 涉及目录与事件时统一经 UnitOfWork 提交，保证云同步观察不到半次录入。测试会话
 * 是设备本地执行游标，记录启动任务快照：作答改变调度状态或跨学习日
 * 后仍可完成同一次测试和对应纸质复习。
 */

import {
  applyTestJudgement,
  createStudyUnit,
  dedupeMeanings,
  formatStructuredMeanings,
  learningDayStartInstant,
  MasteryStatus,
  normalizeEntryKey,
  replayLearningEvents,
  TestJudgement,
  type TestJudgement as TestJudgementType,
} from "@ebbinghaus/domain";
import { ConfirmedEntry, type ConflictingWord, type WordConflictResolution } from "./entryOrganizing.ts";
import { ReviewTestingError } from "./errors.ts";
import type { TestSessionSnapshot } from "./dto.ts";
import type { LearningEventRecorder } from "./eventRecorder.ts";
import type {
  ApplicationEvent,
  BookCatalogStore,
  Clock,
  IdGenerator,
  LearningEventStore,
  SessionWordPlan,
  SpaceStore,
  TestSessionRecord,
  TestSessionStore,
  UnitOfWork,
  WordContentRecord,
  WordContentStore,
} from "./ports.ts";
import { TestSessionExecutionStatus } from "./ports.ts";
import type { PersistedListTask, SchedulingService } from "./scheduling.ts";
import { replayWordStates } from "./scheduling.ts";
import type { SettingsService } from "./settingsFacade.ts";

export class BookEntryConflictError extends ReviewTestingError {
  readonly conflicts: readonly ConflictingWord[];
  constructor(conflicts: readonly ConflictingWord[]) {
    super("本次录入与该 List 已有词条冲突，请逐条选择处理方式");
    this.name = "BookEntryConflictError";
    this.conflicts = conflicts;
  }
}

export interface BookLearningServiceDeps {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly eventRecorder: LearningEventRecorder;
  readonly eventStore: LearningEventStore;
  readonly wordContentStore: WordContentStore;
  readonly bookCatalogStore: BookCatalogStore;
  readonly spaceStore: SpaceStore;
  readonly sessionStore: TestSessionStore;
  readonly settings: SettingsService;
  readonly scheduling: SchedulingService;
  readonly unitOfWork: UnitOfWork;
}

/** 从会话持久化状态取回启动时的任务，不依赖后来可能变更的派生任务。 */
export function getBookSessionTaskSnapshot(session: TestSessionRecord): PersistedListTask | null {
  return session.learningMode === "词书模式" ? session.taskSnapshot ?? null : null;
}

export class BookLearningService {
  constructor(private readonly deps: BookLearningServiceDeps) {}

  /**
   * 首次录入与同 List 补录共用入口。空 List 必须由调用方明确确认；同批重复需先
   * 在可编辑预览中处理，绝不自动吞并。已存在词条冲突必须逐条选择覆盖或跳过。
   */
  recordFirstPass(input: {
    readonly spaceId: string;
    readonly unitNumber: number;
    readonly listNumber: number;
    readonly entries: readonly ConfirmedEntry[];
    readonly confirmEmptyList?: boolean;
    readonly conflictResolutions?: readonly WordConflictResolution[];
  }): { readonly listId: string; readonly words: readonly WordContentRecord[] } {
    this.requireBookSpace(input.spaceId);
    if (!Number.isSafeInteger(input.unitNumber) || input.unitNumber < 1 || !Number.isSafeInteger(input.listNumber) || input.listNumber < 1) {
      throw new ReviewTestingError("Unit 和 List 编号必须是正整数");
    }
    if (input.entries.length === 0 && input.confirmEmptyList !== true) {
      throw new ReviewTestingError("保存空 List 前必须明确确认没有重点 Word");
    }
    const candidates = new Map<string, ConfirmedEntry>();
    for (const entry of input.entries) {
      const key = normalizeEntryKey(entry.term);
      if (candidates.has(key)) {
        throw new ReviewTestingError(`本次录入包含重复词条“${entry.term}”，请在预览中合并义项后保存`);
      }
      candidates.set(key, entry);
    }
    const unit = this.deps.bookCatalogStore.getUnitByNumber(input.spaceId, input.unitNumber);
    const existingList = unit === null ? null : this.deps.bookCatalogStore.getListByNumber(unit.id, input.listNumber);
    if (existingList !== null && input.entries.length > 0 && this.listAdditionsLocked(existingList.listId)) {
      throw new ReviewTestingError("List 已满足同步条件，新增 Word 功能永久锁定");
    }
    const existingByKey = new Map(
      (existingList === null ? [] : this.deps.wordContentStore.listEntriesForList(existingList.listId))
        .map((word) => [word.normalizedKey, word]),
    );
    const resolutions = new Map((input.conflictResolutions ?? []).map((item) => [item.normalizedKey, item]));
    const conflicts: ConflictingWord[] = [];
    for (const [key, entry] of candidates) {
      const existing = existingByKey.get(key);
      if (existing !== undefined && !resolutions.has(key)) {
        conflicts.push({
          normalizedKey: key, existingWordId: existing.wordId,
          existingSpelling: existing.originalSpelling, incomingSpelling: entry.term,
          existingMeanings: existing.meanings, existingManualMeaning: existing.manualMeaning,
          incomingMeanings: entry.meanings,
        });
      }
    }
    if (conflicts.length > 0) {
      throw new BookEntryConflictError(conflicts);
    }
    const now = this.deps.clock.now();
    const nowIso = now.toISOString();
    const unitId = unit?.id ?? this.deps.idGenerator.nextId();
    const listId = existingList?.listId ?? this.deps.idGenerator.nextId();
    const events: ApplicationEvent[] = [];
    const created: WordContentRecord[] = [];
    const removed: string[] = [];
    const skipped: string[] = [];
    for (const [key, entry] of candidates) {
      const existing = existingByKey.get(key);
      const decision = resolutions.get(key);
      if (existing !== undefined && decision?.removeExisting === false) {
        skipped.push(key);
        continue;
      }
      if (existing !== undefined && decision?.removeExisting === true) {
        removed.push(key);
        events.push(this.deps.eventRecorder.record({
          eventType: "wordRemoved", targetType: "Word", targetId: existing.wordId,
          source: "首过冲突处理", occurredAt: now,
          metadata: { listId, normalizedKey: key, reason: "重复录入冲突，用户选择从 List 中删除" },
        }));
      }
      const meanings = dedupeMeanings(entry.meanings);
      created.push({
        wordId: this.deps.idGenerator.nextId(), listId, spaceId: null,
        originalSpelling: entry.term, normalizedKey: key,
        manualMeaning: formatStructuredMeanings(meanings), meanings,
        removed: false, recordedAt: nowIso,
      });
    }
    // 首过事件只初始化本次真正录入的词；后续补录不能继承最初首过日期。
    events.push(this.deps.eventRecorder.record({
      eventType: "firstPassRecorded", targetType: "List", targetId: listId,
      source: "首过预览保存", occurredAt: now,
      metadata: { workload: 1, wordCount: created.length, wordIds: created.map((word) => word.wordId), removedExistingWords: removed, skippedIncomingWords: skipped },
    }));
    this.deps.unitOfWork.run(() => {
      if (unit === null) {
        this.deps.bookCatalogStore.addUnit(createStudyUnit({ id: unitId, spaceId: input.spaceId, number: input.unitNumber }));
      }
      if (existingList === null) {
        this.deps.bookCatalogStore.addList({ listId, spaceId: input.spaceId, unitId, unitNumber: input.unitNumber, listNumber: input.listNumber });
      }
      for (const key of removed) {
        const old = existingByKey.get(key);
        if (old !== undefined) this.deps.wordContentStore.markRemoved(old.wordId, nowIso);
      }
      this.deps.wordContentStore.upsertEntries(created);
      this.deps.eventStore.appendEvents(events);
    });
    return { listId, words: created };
  }

  /** 开始或恢复词书 List 测试，跨日恢复仍使用原会话的 Word 与任务快照。 */
  startOrResumeBookTest(input: { readonly taskId: string; readonly spaceId: string }): TestSessionSnapshot {
    this.requireBookSpace(input.spaceId);
    const now = this.deps.clock.now();
    const nowIso = now.toISOString();
    for (const list of this.deps.bookCatalogStore.listListsForSpace(input.spaceId)) {
      const stored = this.deps.sessionStore.getOpenListSession(list.listId);
      // 只重基准当前任务；其他开放 List 的事件扫描与本次恢复无关。
      if (stored === null || stored.taskId !== input.taskId) continue;
      const open = this.reconcileBookSession(stored);
      if (open.status === TestSessionExecutionStatus.WaitingForPaperReview) {
        throw new ReviewTestingError("软件测试已完成，请先完成纸质复习");
      }
      if (open.status === TestSessionExecutionStatus.Paused) {
        const resumed = { ...open, status: TestSessionExecutionStatus.InProgress, lastActiveAt: nowIso };
        const event = this.deps.eventRecorder.record({ eventType: "testSessionResumed", targetType: "TestSession", targetId: open.sessionId, source: "词书模式测试", occurredAt: now, metadata: { taskId: input.taskId } });
        this.deps.unitOfWork.run(() => { this.deps.eventStore.appendEvents([event]); this.deps.sessionStore.updateSession(resumed); });
        return this.snapshot(resumed);
      }
      return this.snapshot(open);
    }
    const settings = this.deps.settings.getLearningDaySettings();
    const refreshed = this.deps.scheduling.refreshSpaceTasks({ spaceId: input.spaceId, learningDaySettings: settings });
    const task = refreshed.tasks.find((item) => item.taskId === input.taskId);
    if (task === undefined || task.taskType === "仅复习") {
      throw new ReviewTestingError("该 List 没有可开始的软件测试任务");
    }
    if (this.deps.sessionStore.getOpenListSession(task.listId) !== null) {
      throw new ReviewTestingError("该 List 存在属于其他任务的未完成测试会话");
    }
    if (task.payload.testDemands.length === 0) {
      throw new ReviewTestingError("测试任务缺少到期 Word 快照");
    }
    const words: SessionWordPlan[] = task.payload.testDemands.map((demand) => {
      const content = this.deps.wordContentStore.getEntry(demand.wordId);
      if (content === null || content.removed) throw new ReviewTestingError("测试任务包含不存在的 Word");
      if (demand.taskType !== "短期测试" && demand.taskType !== "等待校验" && demand.taskType !== "长期验证") {
        throw new ReviewTestingError("测试任务的到期类型无效");
      }
      return {
        wordId: demand.wordId,
        plannedTestAt: learningDayStartInstant(demand.scheduledDay, settings).toISOString(),
        taskType: demand.taskType,
      };
    });
    const session: TestSessionRecord = {
      sessionId: this.deps.idGenerator.nextId(), learningMode: "词书模式", spaceId: null,
      listId: task.listId, learningDay: refreshed.learningDay, groupOrdinal: null,
      taskId: task.taskId, taskSnapshot: task, words, currentPosition: 0,
      status: TestSessionExecutionStatus.InProgress, answeredWordIds: [],
      startedAt: nowIso, lastActiveAt: nowIso,
    };
    this.deps.sessionStore.addSession(session);
    return this.snapshot(session);
  }

  /** 页面或任务行读取同一份事件收敛后的本地会话快照，避免仅靠本机旧游标显示进度。 */
  getBookTestSessionSnapshot(sessionId: string): TestSessionSnapshot {
    return this.snapshot(this.reconcileBookSession(this.requireSession(sessionId)));
  }

  /**
   * “点错了”只调整这台设备的未答词顺序：已答前缀保持不变，当前 Word 放到队尾。
   * 不写学习事件；下次轮到该 Word 时页面重新初判。先收敛远端答案并核对 Word
   * 身份，避免同步恰好推进页面时把新词错误地暂缓。
   */
  deferBookTestWord(input: { readonly sessionId: string; readonly expectedWordId: string }): TestSessionSnapshot {
    const session = this.reconcileBookSession(this.requireSession(input.sessionId));
    if (session.status !== TestSessionExecutionStatus.InProgress) throw new ReviewTestingError("测试会话当前不能暂缓 Word");
    const current = session.words[session.currentPosition];
    if (current?.wordId !== input.expectedWordId) throw new ReviewTestingError("当前 Word 已变化，请重新查看测试卡片后作答");
    // 暂缓的目的，是先测另一道待测词；若它已经是唯一未答词，重排后屏幕仍会是它，
    // 违背“点错了后立即进入下一词”的承诺，因此此时拒绝暂缓，由界面说明原因。
    if (session.currentPosition >= session.words.length - 1) {
      throw new ReviewTestingError("这是最后一个待测 Word，没有下一词可先测");
    }
    const deferred: TestSessionRecord = {
      ...session,
      words: [...session.words.slice(0, session.currentPosition), ...session.words.slice(session.currentPosition + 1), current],
      lastActiveAt: this.deps.clock.now().toISOString(),
    };
    // 队列顺序是本机执行状态；专用端口只改顺序，避免 SQLite 的普通进度更新静默丢弃暂缓结果。
    this.deps.sessionStore.reorderSessionWords(deferred);
    return this.snapshot(deferred);
  }

  /** 两步作答的最终确认；初判只在界面暂存，写入的始终是最终判断。 */
  confirmBookTestAnswer(input: { readonly sessionId: string; readonly expectedWordId: string; readonly initialJudgement: TestJudgementType; readonly finalJudgement: TestJudgementType }): TestSessionSnapshot {
    if (input.initialJudgement === TestJudgement.NotRecognized && input.finalJudgement === TestJudgement.Recognized) {
      throw new ReviewTestingError("初判不认识不得改回认识");
    }
    // 拉取可能发生在初判与最终点击之间，必须先重基准再核对页面原本展示的 Word。
    const session = this.reconcileBookSession(this.requireSession(input.sessionId));
    const current = session.words[session.currentPosition];
    if (current?.wordId !== input.expectedWordId) throw new ReviewTestingError("当前 Word 已变化，请重新查看测试卡片后作答");
    if (session.status !== TestSessionExecutionStatus.InProgress) throw new ReviewTestingError("测试会话当前不能提交答案");
    if (current === undefined || current.taskType === undefined) throw new ReviewTestingError("测试会话当前 Word 不存在");
    if (session.answeredWordIds.includes(current.wordId)) throw new ReviewTestingError("当前 Word 已经确认过结果");
    const state = replayWordStates(this.deps).get(current.wordId);
    if (state === undefined || state.removed) throw new ReviewTestingError("当前测试 Word 不存在");
    const now = this.deps.clock.now();
    const before = { shortTermPassCount: state.shortTermPassCount, masteryStatus: state.masteryStatus, t0: state.t0, t1: state.t1, t2: state.t2 };
    const changed = applyTestJudgement({
      id: current.wordId, shortTermPassCount: state.shortTermPassCount,
      masteryStatus: state.masteryStatus, shortTermCycleStartedAt: state.t0,
      shortTermOneStartedAt: state.t1, waitingCheckStartedAt: state.t2,
    }, { taskType: current.taskType, judgement: input.finalJudgement, occurredAt: now.toISOString() });
    const after = {
      shortTermPassCount: changed.shortTermPassCount, masteryStatus: changed.masteryStatus,
      t0: changed.shortTermCycleStartedAt, t1: changed.shortTermOneStartedAt,
      t2: changed.waitingCheckStartedAt,
    };
    const task = getBookSessionTaskSnapshot(session);
    if (task === null) throw new ReviewTestingError("测试会话缺少启动任务快照");
    const metadata = {
      sessionId: session.sessionId, taskId: task.taskId, plannedTestAt: current.plannedTestAt,
      initialJudgement: input.initialJudgement, finalJudgement: input.finalJudgement,
      answerRevised: input.initialJudgement !== input.finalJudgement,
      beforeState: before, afterState: after, algorithmVersion: task.algorithmVersion,
    };
    const events: ApplicationEvent[] = [this.deps.eventRecorder.record({ eventType: "testAnswered", targetType: "Word", targetId: current.wordId, source: "词书模式测试", occurredAt: now, metadata })];
    if (input.initialJudgement !== input.finalJudgement) events.push(this.deps.eventRecorder.record({ eventType: "answerRevised", targetType: "Word", targetId: current.wordId, source: "词书模式测试", occurredAt: now, metadata }));
    if (before.shortTermPassCount !== after.shortTermPassCount) events.push(this.deps.eventRecorder.record({ eventType: "shortTermPassCountChanged", targetType: "Word", targetId: current.wordId, source: "词书模式测试", occurredAt: now, metadata }));
    if (current.taskType === "长期验证") events.push(this.deps.eventRecorder.record({ eventType: "longTermValidationCompleted", targetType: "Word", targetId: current.wordId, source: "词书模式测试", occurredAt: now, metadata }));
    if (after.masteryStatus === MasteryStatus.Mastered) events.push(this.deps.eventRecorder.record({ eventType: "wordMastered", targetType: "Word", targetId: current.wordId, source: "词书模式测试", occurredAt: now, metadata }));
    const nextPosition = session.currentPosition + 1;
    const advanced: TestSessionRecord = {
      ...session, currentPosition: nextPosition,
      answeredWordIds: [...session.answeredWordIds, current.wordId],
      lastActiveAt: now.toISOString(),
      status: nextPosition === session.words.length ? TestSessionExecutionStatus.WaitingForPaperReview : TestSessionExecutionStatus.InProgress,
    };
    this.deps.unitOfWork.run(() => { this.deps.eventStore.appendEvents(events); this.deps.sessionStore.updateSession(advanced); });
    return this.snapshot(advanced);
  }

  /** 暂停只保存已确认进度，未提交的初判由页面丢弃。 */
  pauseBookTest(input: { readonly sessionId: string }): TestSessionSnapshot {
    const session = this.reconcileBookSession(this.requireSession(input.sessionId));
    if (session.status !== TestSessionExecutionStatus.InProgress) throw new ReviewTestingError("只有进行中的测试会话可以暂停");
    const now = this.deps.clock.now();
    const paused = { ...session, status: TestSessionExecutionStatus.Paused, lastActiveAt: now.toISOString() };
    const event = this.deps.eventRecorder.record({ eventType: "testSessionPaused", targetType: "TestSession", targetId: session.sessionId, source: "词书模式测试", occurredAt: now, metadata: { taskId: session.taskId } });
    this.deps.unitOfWork.run(() => { this.deps.eventStore.appendEvents([event]); this.deps.sessionStore.updateSession(paused); });
    return this.snapshot(paused);
  }

  /** 从本设备开放会话提取等待纸质复习的任务；测试完成后派生任务变化不影响入口。 */
  pendingPaperReviewTasks(spaceId: string): readonly PersistedListTask[] {
    return this.deps.bookCatalogStore.listListsForSpace(spaceId).flatMap((list) => {
      const stored = this.deps.sessionStore.getOpenListSession(list.listId);
      const session = stored === null ? null : this.reconcileBookSession(stored);
      const task = session?.status === TestSessionExecutionStatus.WaitingForPaperReview ? getBookSessionTaskSnapshot(session) : null;
      return task === null ? [] : [task];
    });
  }

  /** 同一 Word 上修改显示拼写和义项，保留全部学习历史；改规范键需二次确认。 */
  updateWordContent(input: { readonly wordId: string; readonly entry: ConfirmedEntry; readonly firstConfirmation?: boolean; readonly secondConfirmation?: boolean }): WordContentRecord {
    const current = this.requireWord(input.wordId);
    const key = normalizeEntryKey(input.entry.term);
    if (key !== current.normalizedKey && (!input.firstConfirmation || !input.secondConfirmation)) {
      throw new ReviewTestingError("修改英文词条需要连续完成两次明确确认");
    }
    const peers = current.listId === null
      ? this.deps.wordContentStore.listEntriesForSpace(current.spaceId ?? "")
      : this.deps.wordContentStore.listEntriesForList(current.listId);
    if (peers.some((word) => word.wordId !== current.wordId && word.normalizedKey === key)) {
      throw new ReviewTestingError("当前范围已有相同英文词条");
    }
    const now = this.deps.clock.now();
    const meanings = dedupeMeanings(input.entry.meanings);
    const updated = { ...current, originalSpelling: input.entry.term, normalizedKey: key, manualMeaning: formatStructuredMeanings(meanings), meanings, recordedAt: now.toISOString() };
    const event = this.deps.eventRecorder.record({ eventType: "wordContentUpdated", targetType: current.listId === null ? "条目" : "Word", targetId: current.wordId, source: "Word 内容维护", occurredAt: now, metadata: { normalizedKey: key } });
    this.deps.unitOfWork.run(() => { this.deps.eventStore.appendEvents([event]); this.deps.wordContentStore.upsertEntries([updated]); });
    return updated;
  }

  /** 软移除需要双重确认；保留内容墓碑和事件以便同步与历史审计。 */
  removeWord(input: { readonly wordId: string; readonly firstConfirmation: boolean; readonly secondConfirmation: boolean }): void {
    if (!input.firstConfirmation || !input.secondConfirmation) throw new ReviewTestingError("该操作必须连续完成两次明确确认");
    const current = this.requireWord(input.wordId);
    const now = this.deps.clock.now();
    const event = this.deps.eventRecorder.record({
      eventType: "wordRemoved", targetType: current.listId === null ? "条目" : "Word",
      targetId: current.wordId, source: "Word 内容维护", occurredAt: now,
      metadata: { ...(current.listId === null ? {} : { listId: current.listId }), ...(current.spaceId === null ? {} : { spaceId: current.spaceId }), normalizedKey: current.normalizedKey },
    });
    this.deps.unitOfWork.run(() => { this.deps.eventStore.appendEvents([event]); this.deps.wordContentStore.markRemoved(current.wordId, now.toISOString()); });
  }

  private snapshot(session: TestSessionRecord): TestSessionSnapshot {
    const plan = session.words[session.currentPosition];
    const content = plan === undefined ? null : this.deps.wordContentStore.getEntry(plan.wordId);
    if (plan !== undefined && content === null) throw new ReviewTestingError("测试会话当前 Word 不存在");
    const list = session.listId === null ? null : this.deps.bookCatalogStore.getList(session.listId);
    return {
      sessionId: session.sessionId, taskId: session.taskId ?? "", status: session.status,
      currentPosition: session.currentPosition, totalCount: session.words.length,
      currentWord: content === null ? null : { wordId: content.wordId, originalSpelling: content.originalSpelling, manualMeaning: content.manualMeaning, meanings: content.meanings },
      unitNumber: list?.unitNumber ?? null,
      listNumber: list?.listNumber ?? null,
    };
  }

  /**
   * 本地会话只是执行位置；已确认作答事件才是跨端事实。按任务、Word 和计划时刻三者
   * 同时匹配，避免把另一轮同词测试误算进当前会话。稳定分区保留已答与未答各自的原顺序，
   * 因而远端只回答中间词时，当前位置仍指向真正的首个未答 Word。
   */
  private reconcileBookSession(session: TestSessionRecord): TestSessionRecord {
    if (session.status === TestSessionExecutionStatus.Completed) return session;
    const confirmed = new Set(
      this.deps.eventStore.listAllEvents()
        .filter((event) => event.eventType === "testAnswered" && event.targetType === "Word" && event.metadata["taskId"] === session.taskId)
        .map((event) => `${event.targetId}\u0000${String(event.metadata["plannedTestAt"])}`),
    );
    const locallyAnswered = new Set(session.answeredWordIds);
    const isAnswered = (plan: SessionWordPlan): boolean =>
      locallyAnswered.has(plan.wordId) || confirmed.has(`${plan.wordId}\u0000${plan.plannedTestAt}`);
    const answered = session.words.filter(isAnswered);
    const remaining = session.words.filter((plan) => !isAnswered(plan));
    const words = [...answered, ...remaining];
    const answeredWordIds = answered.map((plan) => plan.wordId);
    const currentPosition = answered.length;
    const status = remaining.length === 0 ? TestSessionExecutionStatus.WaitingForPaperReview : session.status;
    const changed = currentPosition !== session.currentPosition || status !== session.status
      || words.some((plan, index) => plan !== session.words[index])
      || answeredWordIds.length !== session.answeredWordIds.length
      || answeredWordIds.some((wordId, index) => wordId !== session.answeredWordIds[index]);
    if (!changed) return session;
    // 投影更新不制造新的学习事实，也不刷新 lastActiveAt；同步仍只传输用户确认的事件。
    const reconciled = { ...session, words, answeredWordIds, currentPosition, status };
    this.deps.sessionStore.updateSession(reconciled);
    return reconciled;
  }

  private requireBookSpace(spaceId: string): void {
    const space = this.deps.spaceStore.getSpace(spaceId);
    if (space === null || space.learningMode !== "词书模式") throw new ReviewTestingError("当前 Space 不是词书模式");
  }

  private requireSession(sessionId: string): TestSessionRecord {
    const session = this.deps.sessionStore.getSession(sessionId);
    if (session === null || session.learningMode !== "词书模式") throw new ReviewTestingError("词书模式测试会话不存在");
    return session;
  }

  private requireWord(wordId: string): WordContentRecord {
    const word = this.deps.wordContentStore.getEntry(wordId);
    if (word === null || word.removed) throw new ReviewTestingError("Word 不存在或已移除");
    return word;
  }

  private listAdditionsLocked(listId: string): boolean {
    const replay = replayLearningEvents({
      events: this.deps.eventStore.listAllEvents(),
      wordCatalog: this.deps.wordContentStore.listCatalogEntries().map((word) => ({
        wordId: word.wordId, listId: word.listId, spaceId: word.spaceId,
        originalSpelling: word.originalSpelling, normalizedKey: word.normalizedKey,
      })),
    });
    return replay.lists.get(listId)?.additionsLocked ?? false;
  }
}
