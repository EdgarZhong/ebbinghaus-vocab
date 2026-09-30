/**
 * 常规模式的条目录入、FSRS 到期分组、测试会话与朗读复习用例
 * （移植 V1 application/regular_learning.py，按 V2 事件溯源架构重设计）。
 *
 * 职责与口径：
 * - **录入**：整个 Space 内不允许重复录入——与既有条目规范键冲突时必须由用户逐条
 *   选择"覆盖"（软移除旧条目后录入新条目，先写 wordRemoved 不可变事件）或"本次
 *   不录入"，未覆盖全部冲突前拒绝写入；同一批次内重复词条自动合并义项（保持
 *   首次出现顺序）。每个条目从下一个学习日开始参与测试（规格 11.7）。
 * - **到期分组**：当日到期条目按领域跨卡排序（规格 11.1 四段固定比较键，由
 *   domain sortRegularDueWords 固化）切分为每组 N 条的当日临时入口；组只是当天
 *   的显示切分，不具有持久化学习语义。
 * - **朗读复习**：当日录入的条目组成只读朗读分组，从不进入 FSRS 测试候选。
 * - **测试闭环**：常规模式无 List 与计划任务，会话以当日到期测试组为单位；每次
 *   确认立即调用 FSRS（认识→Good、不认识→Again，两档封闭映射）并产出协议事件
 *   （testAnswered + answerRevised 改判审计）；软掌握是可逆派生状态（间隔 ≥100 天
 *   标记、低于阈值自动恢复），由 domain deriveRegularMasteryAfterReview 固化。
 * - 会话是设备本地执行状态（不同步、不重放）；事件先写、状态后进的顺序在事务内
 *   保持与 V1 一致。
 *
 * 移植缺口（如实记录）：V1 的"手动标记不认识/已掌握"入口产出
 * wordManuallyMarkedUnmastered/Mastered 事件，但该两类事件未收录于需求规格 7.2
 * 与 V2 协议枚举（判断文件 B8 已列晨审关注），本用例暂不实现这两个入口，
 * 待晨审定夺扩枚举后补齐。
 */

import {
  addLearningDays,
  learningDayStartInstant,
  dedupeMeanings,
  deriveRegularMasteryAfterReview,
  formatStructuredMeanings,
  FsrsRegularScheduler,
  nextIntervalDaysBetween,
  normalizeEntryKey,
  resolveLearningDay,
  sortRegularDueWords,
  splitRegularTestGroups,
  TestJudgement,
  type LearningDay,
  type ReplayedWordState,
  type RegularDueWord,
  type StructuredMeaning,
  type TestJudgement as TestJudgementType,
} from "@ebbinghaus/domain";
import type {
  ApplicationEvent,
  Clock,
  FsrsCardRecord,
  FsrsCardStore,
  IdGenerator,
  LearningEventStore,
  SpaceStore,
  TestSessionRecord,
  TestSessionStore,
  WordContentRecord,
  WordContentStore,
} from "./ports.ts";
import { TestSessionExecutionStatus } from "./ports.ts";
import type { LearningEventRecorder } from "./eventRecorder.ts";
import type { SettingsService } from "./settingsFacade.ts";
import { ConfirmedEntry, type ConflictingWord, type WordConflictResolution } from "./entryOrganizing.ts";
import { SpaceEntryConflictError } from "./errors.ts";
import type { ReviewWordSnapshot, TaskItemSnapshot, TestSessionSnapshot } from "./dto.ts";
import { replayWordStates } from "./scheduling.ts";

/** 常规模式 Space 内录入门派生的候选（合并同批重复词条后的形态）。 */
interface MergedEntryCandidate {
  readonly originalSpelling: string;
  readonly normalizedKey: string;
  readonly meanings: readonly StructuredMeaning[];
}

/** 仅在当前学习日有效的展示分组，不具有持久化学习语义（V1 RegularTestGroup）。 */
export interface RegularTestGroup {
  readonly ordinal: number;
  readonly learningDay: LearningDay;
  readonly wordIds: readonly string[];
}

export interface RegularLearningServiceDeps {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly eventRecorder: LearningEventRecorder;
  readonly eventStore: LearningEventStore;
  readonly wordContentStore: WordContentStore;
  readonly spaceStore: SpaceStore;
  readonly sessionStore: TestSessionStore;
  readonly fsrsCardStore: FsrsCardStore;
  readonly settings: SettingsService;
  /** 常规模式固定策略调度器（领域纯计算封装，构造注入便于测试替换）。 */
  readonly scheduler: FsrsRegularScheduler;
}

export class RegularLearningService {
  private readonly deps: RegularLearningServiceDeps;

  constructor(deps: RegularLearningServiceDeps) {
    this.deps = deps;
  }

  // ---------------------------------------------------------------------------
  // 录入
  // ---------------------------------------------------------------------------

  /**
   * 保存确认后的条目；每个条目从下一个学习日开始参与测试。
   * 返回本次新录入的条目内容记录（覆盖与跳过的决策见事件 metadata）。
   */
  recordEntries(input: {
    readonly spaceId: string;
    readonly entries: readonly ConfirmedEntry[];
    readonly conflictResolutions?: readonly WordConflictResolution[];
  }): readonly WordContentRecord[] {
    this.requireRegularSpace(input.spaceId);
    if (input.entries.length === 0) {
      throw new Error("请至少确认一个条目");
    }
    const merged = this.mergeSameBatchEntries(input.entries);
    const now = this.deps.clock.now();
    const nowIso = now.toISOString();
    // 目标保持率按 Space 保存；录入时落库的调度器快照必须与后续 review 使用同一保持率。
    const desiredRetention = this.spaceDesiredRetention(input.spaceId);
    const resolutionByKey = new Map(
      (input.conflictResolutions ?? []).map((resolution) => [resolution.normalizedKey, resolution]),
    );
    const removedExisting: string[] = [];
    const skippedIncoming: string[] = [];
    const created: WordContentRecord[] = [];

    const existingByKey = new Map(
      this.deps.wordContentStore
        .listEntriesForSpace(input.spaceId)
        .map((entry) => [entry.normalizedKey, entry]),
    );
    // 未覆盖全部冲突前拒绝写入：冲突必须逐条交由用户决定，禁止静默覆盖学习数据。
    const unhandled: ConflictingWord[] = [];
    for (const candidate of merged) {
      const existing = existingByKey.get(candidate.normalizedKey);
      if (existing !== undefined && !resolutionByKey.has(candidate.normalizedKey)) {
        unhandled.push({
          normalizedKey: candidate.normalizedKey,
          existingWordId: existing.wordId,
          existingSpelling: existing.originalSpelling,
          incomingSpelling: candidate.originalSpelling,
          existingMeanings: existing.meanings,
          existingManualMeaning: existing.manualMeaning,
          incomingMeanings: candidate.meanings,
        });
      }
    }
    if (unhandled.length > 0) {
      throw new SpaceEntryConflictError("本次录入与当前 Space 已有条目冲突，请逐条选择处理方式", unhandled);
    }

    const events: ApplicationEvent[] = [];
    for (const candidate of merged) {
      const existing = existingByKey.get(candidate.normalizedKey);
      const resolution = resolutionByKey.get(candidate.normalizedKey);
      if (existing !== undefined && resolution !== undefined) {
        if (resolution.removeExisting) {
          // 先写不可变移除事件再软移除，与内容维护语义保持一致。
          events.push(
            this.deps.eventRecorder.record({
              eventType: "wordRemoved",
              targetType: "条目",
              targetId: existing.wordId,
              source: "录入冲突处理",
              occurredAt: now,
              metadata: {
                spaceId: input.spaceId,
                normalizedKey: existing.normalizedKey,
                reason: "重复录入冲突，用户选择覆盖",
              },
            }),
          );
          this.deps.wordContentStore.markRemoved(existing.wordId, nowIso);
          removedExisting.push(existing.normalizedKey);
        } else {
          skippedIncoming.push(candidate.normalizedKey);
          continue;
        }
      }
      const wordId = this.deps.idGenerator.nextId();
      const meanings = [...candidate.meanings];
      const record: WordContentRecord = {
        wordId,
        listId: null,
        spaceId: input.spaceId,
        originalSpelling: candidate.originalSpelling,
        normalizedKey: candidate.normalizedKey,
        manualMeaning: formatStructuredMeanings(meanings),
        meanings,
        removed: false,
        recordedAt: nowIso,
      };
      this.deps.wordContentStore.upsertEntries([record]);
      const cardJson = this.deps.scheduler.newCardSnapshotJson({ createdAt: nowIso });
      const card: FsrsCardRecord = {
        wordId,
        cardJson,
        dueAt: FsrsRegularScheduler.cardDueAt(cardJson),
        schedulerJson: this.deps.scheduler.schedulerSnapshotJson({ desiredRetention }),
        algorithmVersion: this.deps.scheduler.algorithmVersion,
        libraryVersion: this.deps.scheduler.libraryVersion,
        updatedAt: nowIso,
        // 新卡处于 Learning 状态，无最终判断历史，累计认识次数为 0。
        cardState: "Learning",
        cumulativeRecognizedCount: 0,
        lastFinalJudgement: null,
      };
      this.deps.fsrsCardStore.upsert(card);
      events.push(
        this.deps.eventRecorder.record({
          eventType: "firstPassRecorded",
          targetType: "条目",
          targetId: wordId,
          source: "常规模式录入",
          occurredAt: now,
          metadata: {
            workload: 1,
            removedExistingWords: [...removedExisting],
            skippedIncomingWords: [...skippedIncoming],
          },
        }),
      );
      created.push(record);
    }
    this.deps.eventStore.appendEvents(events);
    return created;
  }

  /** 合并同一批次内的重复词条：规范键相同者义项并集去重，顺序保持首次出现。 */
  private mergeSameBatchEntries(entries: readonly ConfirmedEntry[]): MergedEntryCandidate[] {
    const merged = new Map<string, MergedEntryCandidate>();
    for (const entry of entries) {
      const normalizedKey = normalizeEntryKey(entry.term);
      const existing = merged.get(normalizedKey);
      if (existing === undefined) {
        merged.set(normalizedKey, {
          originalSpelling: entry.term,
          normalizedKey,
          meanings: [...entry.meanings],
        });
        continue;
      }
      // 义项并集去重保持首次出现顺序（对应 Python dict.fromkeys）。
      merged.set(normalizedKey, {
        ...existing,
        meanings: dedupeMeanings([...existing.meanings, ...entry.meanings]),
      });
    }
    return [...merged.values()];
  }

  // ---------------------------------------------------------------------------
  // 到期分组与朗读复习
  // ---------------------------------------------------------------------------

  /** 把当前到期条目以稳定顺序切成每组 N 条的当天临时入口。 */
  dueGroups(input: { readonly spaceId: string }): readonly RegularTestGroup[] {
    this.requireRegularSpace(input.spaceId);
    const now = this.deps.clock.now();
    const learningDay = this.learningDayOf(now);
    const dueEntries = this.dueRegularEntries(input.spaceId, learningDay, now.toISOString());
    return this.groupsFromEntries(dueEntries, learningDay, input.spaceId);
  }

  /** 返回当日录入的只读朗读分组；它们从不进入 FSRS 测试候选。 */
  recordedTodayReviewGroups(input: { readonly spaceId: string }): readonly RegularTestGroup[] {
    this.requireRegularSpace(input.spaceId);
    const now = this.deps.clock.now();
    const learningDay = this.learningDayOf(now);
    const settings = this.deps.settings.getLearningDaySettings();
    const states = replayWordStates(this.deps);
    const contents = this.deps.wordContentStore.listEntriesForSpace(input.spaceId);
    const recordedToday = contents
      .map((content) => ({ content, state: states.get(content.wordId) }))
      .filter((item): item is { content: WordContentRecord; state: ReplayedWordState } =>
        item.state !== undefined &&
        item.state.t0 !== null &&
        resolveLearningDay(new Date(item.state.t0), settings) === learningDay,
      )
      // 稳定排序：录入时刻早者在前，同刻按 Word 标识。
      .sort((a, b) =>
        a.state.t0 !== b.state.t0
          ? Date.parse(a.state.t0 as string) - Date.parse(b.state.t0 as string)
          : a.content.wordId < b.content.wordId
            ? -1
            : a.content.wordId > b.content.wordId
              ? 1
              : 0,
      );
    return this.groupsFromEntries(
      recordedToday.map((item) => item.content.wordId),
      learningDay,
      input.spaceId,
    );
  }

  /** 当日到期条目（含资格与到期双重过滤）按领域跨卡排序后的有序标识序列。 */
  private dueRegularEntries(
    spaceId: string,
    learningDay: LearningDay,
    nowIso: string,
  ): readonly string[] {
    const settings = this.deps.settings.getLearningDaySettings();
    const states = replayWordStates(this.deps);
    const contents = this.deps.wordContentStore.listEntriesForSpace(spaceId);
    const dueWords: RegularDueWord[] = [];
    for (const content of contents) {
      const state = states.get(content.wordId);
      if (state === undefined || state.removed) {
        continue;
      }
      // 资格过滤：录入学习日 + 1 起才参与测试（规格 11.7）；无 T0 视为未正式录入。
      if (state.t0 === null) {
        continue;
      }
      const eligibleFromDay = addLearningDays(resolveLearningDay(new Date(state.t0), settings), 1);
      if (eligibleFromDay > learningDay) {
        continue;
      }
      // 到期过滤：FSRS 卡片到期时间不晚于当前时刻。
      //
      // regularDueAt 只由 testAnswered 的 afterState.dueAt 派生（事件承载的到期事实）；
      // 从未测试的新条目该字段为 null——但 FSRS 新卡（New 态）本身就处于"到期可测"，
      // 且规格 11.7 的资格过滤（录入次日 + 1）已在上面完成。若在此把 null 一律过滤，
      // 新条目将永远进不了首次测试队列（2026-09-20 集成修复的产品缺陷）。
      // 处理：null 视为到期，排序键取资格日（下一学习日）起始时刻——与 domain
      // RegularDueWord 注释"新条目为下一学习日"的设计意图一致，自然排在逾期条目之后。
      const isNewCard = state.regularDueAt === null;
      if (!isNewCard && Date.parse(state.regularDueAt) > Date.parse(nowIso)) {
        continue;
      }
      const dueAt = isNewCard
        ? learningDayStartInstant(eligibleFromDay, settings).toISOString()
        : state.regularDueAt;
      dueWords.push({
        wordId: content.wordId,
        dueAt,
        hasHistory: state.lastJudgement !== null,
        lastJudgement: state.lastJudgement,
        cumulativeRecognizedCount: state.cumulativeRecognizedCount,
      });
    }
    // 积压场景四段固定比较键（规格 11.1）由领域函数固化；只影响展示顺序，
    // 绝不改变 due_at、记忆状态或工作量。
    return sortRegularDueWords(dueWords).map((word) => word.wordId);
  }

  /** 测试和复习共用唯一切分规则，禁止在两个页面各自写入分组常量。 */
  private groupsFromEntries(
    orderedWordIds: readonly string[],
    learningDay: LearningDay,
    spaceId: string,
  ): readonly RegularTestGroup[] {
    const groupSize = this.deps.settings.getSpaceLearningSettings(spaceId).regularGroupSize;
    const chunks = splitRegularTestGroups([...orderedWordIds], groupSize);
    return chunks.map((wordIds, index) => ({
      ordinal: index + 1,
      learningDay,
      wordIds,
    }));
  }

  // ---------------------------------------------------------------------------
  // 当日任务项（看板与测试列表共用）
  // ---------------------------------------------------------------------------

  /** 返回当日到期测试组与已恢复的开放会话，供测试列表页展示。 */
  regularTaskItems(): readonly TaskItemSnapshot[] {
    const spaceId = this.deps.settings.getActiveSpaceId();
    this.requireRegularSpace(spaceId);
    const now = this.deps.clock.now();
    const learningDay = this.learningDayOf(now);
    const groups = this.dueGroups({ spaceId });
    const persistedOpenSession = this.deps.sessionStore.getOpenRegularSession(spaceId, learningDay);
    const rebasedOpenSession = persistedOpenSession === null ? null : this.rebaseRegularSession(persistedOpenSession);
    // 本次读取若恰好收敛至全答，完成会话已不再是开放入口；任务行应与
    // 下一次读取保持一致，不短暂闪现一条已经完成的旧测试组。
    const openSession = rebasedOpenSession?.status === TestSessionExecutionStatus.Completed
      ? null
      : rebasedOpenSession;
    // 任务组已经持有 Word 标识，页面展示内容只需一次 Space 批量查询。
    // 逐词 getEntry 在真实桌面同步 SQLite 桥下会阻塞 WebView 主线程，
    // 使切回“今日”和“测试”随到期词数线性变慢。
    const contentsById = new Map(this.deps.wordContentStore.listEntriesForSpace(spaceId)
      .map((content) => [content.wordId, content]));
    const items: TaskItemSnapshot[] = [];
    for (const group of groups) {
      let sessionStatus: TestSessionExecutionStatus | null = null;
      let completed = 0;
      const isOpenGroup = openSession !== null && openSession.groupOrdinal === group.ordinal;
      if (isOpenGroup) {
        sessionStatus = openSession.status;
        completed = openSession.currentPosition;
      }
      const activeWords: ReviewWordSnapshot[] = [];
      // 到期组在远端作答后会重新切分；开放会话仍以启动时的条目快照计数，
      // 并按收敛后的未答顺序展示，避免任务行误缩小或把已答条目重新列为待测。
      const visibleWordIds = isOpenGroup
        ? openSession.words.slice(openSession.currentPosition).map((word) => word.wordId)
        : group.wordIds;
      for (const wordId of visibleWordIds) {
        const content = contentsById.get(wordId);
        if (content !== undefined) {
          activeWords.push({
            wordId: content.wordId,
            originalSpelling: content.originalSpelling,
            manualMeaning: content.manualMeaning,
            meanings: content.meanings,
          });
        }
      }
      items.push({
        taskId: this.regularTaskId(spaceId, group.ordinal, learningDay),
        listId: "",
        unitNumber: 0,
        listNumber: group.ordinal,
        taskType: "短期测试",
        dueReason: "FSRS 到期测试",
        workload: 1,
        overdueDays: 0,
        completedCount: completed,
        totalCount: isOpenGroup ? openSession.words.length : group.wordIds.length,
        sessionStatus,
        activeWords,
      });
    }
    if (openSession !== null && !groups.some((group) => group.ordinal === openSession.groupOrdinal)) {
      // 全部或大部分条目被另一端确认后，到期组可能消失；开放会话必须仍可见，
      // 否则用户无法看到已收敛进度，也无法从暂停状态恢复。
      items.push({
        taskId: this.regularTaskId(spaceId, openSession.groupOrdinal ?? 0, learningDay),
        listId: "",
        unitNumber: 0,
        listNumber: openSession.groupOrdinal ?? 0,
        taskType: "短期测试",
        dueReason: "FSRS 到期测试",
        workload: 1,
        overdueDays: 0,
        completedCount: openSession.currentPosition,
        totalCount: openSession.words.length,
        sessionStatus: openSession.status,
        activeWords: openSession.words.slice(openSession.currentPosition).flatMap((word) => {
          const content = contentsById.get(word.wordId);
          return content === undefined ? [] : [{
            wordId: content.wordId,
            originalSpelling: content.originalSpelling,
            manualMeaning: content.manualMeaning,
            meanings: content.meanings,
          }];
        }),
      });
    }
    return items;
  }

  // ---------------------------------------------------------------------------
  // 测试会话闭环
  // ---------------------------------------------------------------------------

  /** 开始或恢复当日测试组会话；未确认条目不产生结果。 */
  startOrResumeRegularTest(input: { readonly taskId: string }): TestSessionSnapshot {
    const spaceId = this.deps.settings.getActiveSpaceId();
    this.requireRegularSpace(spaceId);
    const now = this.deps.clock.now();
    const nowIso = now.toISOString();
    const learningDay = this.learningDayOf(now);
    const ordinal = this.ordinalFromTaskId(input.taskId, learningDay, spaceId);
    const persistedExisting = this.deps.sessionStore.getOpenRegularSession(spaceId, learningDay);
    const existing = persistedExisting === null ? null : this.rebaseRegularSession(persistedExisting);
    if (existing !== null) {
      if (existing.groupOrdinal !== ordinal) {
        throw new Error("当前已有其他测试组正在进行的会话");
      }
      if (existing.status === TestSessionExecutionStatus.Paused) {
        const resumed: TestSessionRecord = {
          ...existing,
          lastActiveAt: nowIso,
          status: TestSessionExecutionStatus.InProgress,
        };
        const event = this.deps.eventRecorder.record({
          eventType: "testSessionResumed",
          targetType: "TestSession",
          targetId: existing.sessionId,
          source: "常规模式测试",
          occurredAt: now,
          metadata: { groupOrdinal: ordinal },
        });
        this.deps.eventStore.appendEvents([event]);
        this.deps.sessionStore.updateSession(resumed);
        return this.regularSessionSnapshot(resumed);
      }
      return this.regularSessionSnapshot(existing);
    }

    const group = this.dueGroups({ spaceId }).find((item) => item.ordinal === ordinal);
    if (group === undefined || group.wordIds.length === 0) {
      throw new Error("该测试组没有到期条目");
    }
    // 会话主键必须全局唯一：完成一组后剩余条目会重新编组，组序号会复用，
    // 不能用 Space+学习日+组序号之类的确定性主键（V1 口径），因此用注入 ID 生成器。
    const session: TestSessionRecord = {
      sessionId: this.deps.idGenerator.nextId(),
      learningMode: "常规模式",
      spaceId,
      listId: null,
      learningDay,
      groupOrdinal: ordinal,
      taskId: null,
      // 用开始测试时的卡片到期时刻标识这一轮计划；会话启动时间无法区分
      // 同一条目先后两轮作答，远端事件必须与本轮 beforeState.dueAt 对齐。
      words: group.wordIds.map((wordId) => {
        const card = this.deps.fsrsCardStore.get(wordId);
        if (card === null) {
          throw new Error("条目缺少 FSRS 卡片");
        }
        return { wordId, plannedTestAt: card.dueAt };
      }),
      currentPosition: 0,
      status: TestSessionExecutionStatus.InProgress,
      answeredWordIds: [],
      startedAt: nowIso,
      lastActiveAt: nowIso,
    };
    this.deps.sessionStore.addSession(session);
    return this.regularSessionSnapshot(session);
  }

  /** 确认当前条目最终判断，立即调用 FSRS 更新卡片并推进游标。 */
  confirmRegularTestAnswer(input: {
    readonly sessionId: string;
    readonly expectedWordId: string;
    readonly initialJudgement: TestJudgementType;
    readonly finalJudgement: TestJudgementType;
  }): TestSessionSnapshot {
    if (
      input.initialJudgement === TestJudgement.NotRecognized &&
      input.finalJudgement === TestJudgement.Recognized
    ) {
      throw new Error("初判不认识不得改回认识");
    }
    const persistedSession = this.deps.sessionStore.getSession(input.sessionId);
    if (persistedSession === null || persistedSession.learningMode !== "常规模式") {
      throw new Error("常规模式测试会话不存在");
    }
    const session = this.rebaseRegularSession(persistedSession);
    if (session.status !== TestSessionExecutionStatus.InProgress) {
      throw new Error("测试会话当前不能提交答案");
    }
    const current = session.words[session.currentPosition];
    if (current === undefined) {
      throw new Error("测试会话当前条目不存在");
    }
    const wordId = current.wordId;
    // 拉取事件可能恰好发生在用户初判和最终确认之间；旧页面的判断不能
    // 被应用到重基准后的下一条目，必须由调用方重新展示当前条目。
    if (input.expectedWordId !== wordId) {
      throw new Error("当前条目已变化，请重新查看并作答");
    }
    if (session.answeredWordIds.includes(wordId)) {
      throw new Error("当前条目已经确认过结果");
    }
    const content = this.deps.wordContentStore.getEntry(wordId);
    if (content === null || content.spaceId === null) {
      throw new Error("当前测试条目不存在");
    }
    const card = this.deps.fsrsCardStore.get(wordId);
    if (card === null) {
      throw new Error("条目缺少 FSRS 卡片");
    }
    const now = this.deps.clock.now();
    const nowIso = now.toISOString();
    const desiredRetention = this.spaceDesiredRetention(content.spaceId);
    const outcome = this.deps.scheduler.review({
      cardJson: card.cardJson,
      recognized: input.finalJudgement === TestJudgement.Recognized,
      reviewedAt: nowIso,
      desiredRetention,
    });
    const nextIntervalDays = nextIntervalDaysBetween(outcome.dueAt, nowIso);
    // 软掌握判定与累计认识次数只在常规模式生效：认识累计加一，不认识不清零已投入历史。
    const states = replayWordStates(this.deps);
    const previousState = states.get(wordId);
    const derived = deriveRegularMasteryAfterReview({
      recognized: input.finalJudgement === TestJudgement.Recognized,
      nextIntervalDays,
      previousMasteryStatus: previousState?.masteryStatus ?? "未掌握",
      previousCumulativeRecognizedCount: card.cumulativeRecognizedCount,
    });
    const beforeState = {
      dueAt: FsrsRegularScheduler.cardDueAt(card.cardJson),
    };
    const afterState = {
      dueAt: outcome.dueAt,
      masteryStatus: derived.masteryStatus,
      nextIntervalDays,
    };
    const answerRevised = input.initialJudgement !== input.finalJudgement;
    const metadata = {
      sessionId: session.sessionId,
      groupOrdinal: session.groupOrdinal,
      wordId,
      initialJudgement: input.initialJudgement,
      finalJudgement: input.finalJudgement,
      answerRevised,
      beforeState,
      afterState,
      workload: 1,
      algorithmVersion: this.deps.scheduler.algorithmVersion,
    };
    const events: ApplicationEvent[] = [
      this.deps.eventRecorder.record({
        eventType: "testAnswered",
        targetType: "条目",
        targetId: wordId,
        source: "常规模式测试",
        occurredAt: now,
        metadata,
      }),
    ];
    if (answerRevised) {
      // 改判与确认共享同一 metadata（协议五类逐词测试事件共用形态，V1 口径）。
      events.push(
        this.deps.eventRecorder.record({
          eventType: "answerRevised",
          targetType: "条目",
          targetId: wordId,
          source: "常规模式测试",
          occurredAt: now,
          metadata,
        }),
      );
    }
    this.deps.eventStore.appendEvents(events);
    this.deps.fsrsCardStore.upsert({
      wordId,
      cardJson: outcome.afterCardJson,
      dueAt: outcome.dueAt,
      schedulerJson: outcome.schedulerJson,
      algorithmVersion: this.deps.scheduler.algorithmVersion,
      libraryVersion: this.deps.scheduler.libraryVersion,
      updatedAt: nowIso,
      cardState: outcome.cardState,
      cumulativeRecognizedCount: derived.cumulativeRecognizedCount,
      lastFinalJudgement: input.finalJudgement,
    });
    const nextPosition = session.currentPosition + 1;
    const advanced: TestSessionRecord = {
      ...session,
      lastActiveAt: nowIso,
      currentPosition: nextPosition,
      status:
        nextPosition === session.words.length
          ? TestSessionExecutionStatus.Completed
          : TestSessionExecutionStatus.InProgress,
      answeredWordIds: [...session.answeredWordIds, wordId],
    };
    this.deps.sessionStore.updateSession(advanced);
    return this.regularSessionSnapshot(advanced);
  }

  /** 暂停会话，保留已确认进度；当前未提交的初判由界面丢弃。 */
  pauseRegularTest(input: { readonly sessionId: string }): TestSessionSnapshot {
    const persistedSession = this.deps.sessionStore.getSession(input.sessionId);
    if (persistedSession === null || persistedSession.learningMode !== "常规模式") {
      throw new Error("常规模式测试会话不存在");
    }
    const session = this.rebaseRegularSession(persistedSession);
    if (session.status !== TestSessionExecutionStatus.InProgress) {
      throw new Error("只有进行中的测试会话可以暂停");
    }
    const now = this.deps.clock.now();
    const paused: TestSessionRecord = {
      ...session,
      lastActiveAt: now.toISOString(),
      status: TestSessionExecutionStatus.Paused,
    };
    const event = this.deps.eventRecorder.record({
      eventType: "testSessionPaused",
      targetType: "TestSession",
      targetId: session.sessionId,
      source: "常规模式测试",
      occurredAt: now,
      metadata: { groupOrdinal: session.groupOrdinal },
    });
    this.deps.eventStore.appendEvents([event]);
    this.deps.sessionStore.updateSession(paused);
    return this.regularSessionSnapshot(paused);
  }

  // ---------------------------------------------------------------------------
  // 视图快照与内部工具
  // ---------------------------------------------------------------------------

  /** 读取会话时以本机已拉取的已确认事件重基准，供页面同步通知直接刷新。 */
  getRegularTestSessionSnapshot(sessionId: string): TestSessionSnapshot {
    const session = this.deps.sessionStore.getSession(sessionId);
    if (session === null || session.learningMode !== "常规模式") {
      throw new Error("常规模式测试会话不存在");
    }
    return this.regularSessionSnapshot(this.rebaseRegularSession(session));
  }

  /**
   * 初判“不认识”后选择“点错了”时仅重排本机会话未答条目，不写 FSRS 卡片、
   * testAnswered 或 outbox。重基准与 Word 身份校验和最终确认一致，防止拉取交错
   * 时把另一条目错移到队尾；只剩一个未答条目时拒绝暂缓，避免点击后下一题仍是该条目。
   */
  deferRegularTestWord(input: { readonly sessionId: string; readonly expectedWordId: string }): TestSessionSnapshot {
    const persisted = this.deps.sessionStore.getSession(input.sessionId);
    if (persisted === null || persisted.learningMode !== "常规模式") throw new Error("常规模式测试会话不存在");
    const session = this.rebaseRegularSession(persisted);
    if (session.status !== TestSessionExecutionStatus.InProgress) throw new Error("测试会话当前不能暂缓条目");
    const current = session.words[session.currentPosition];
    if (current?.wordId !== input.expectedWordId) throw new Error("当前条目已变化，请重新查看并作答");
    // 暂缓必须让用户立即进入另一条待测内容；只有当前条目待测时不允许
    // 表面上重排、实际仍显示原条目，避免“点错了”变成重复揭示。
    if (session.currentPosition >= session.words.length - 1) {
      throw new Error("这是最后一个待测条目，没有下一条可先测");
    }
    const deferred: TestSessionRecord = {
      ...session,
      words: [...session.words.slice(0, session.currentPosition), ...session.words.slice(session.currentPosition + 1), current],
      lastActiveAt: this.deps.clock.now().toISOString(),
    };
    // 队列顺序是本机执行状态；专用端口只改顺序，避免 SQLite 的普通进度更新静默丢弃暂缓结果。
    this.deps.sessionStore.reorderSessionWords(deferred);
    return this.regularSessionSnapshot(deferred);
  }

  /** 已确认事件是权威进度；本机会话仅保留顺序与未提交的执行位置。 */
  private rebaseRegularSession(session: TestSessionRecord): TestSessionRecord {
    const alreadyAnswered = new Set(session.answeredWordIds);
    const plansByWordId = new Map(session.words.map((word) => [word.wordId, word]));
    // 旧快照把所有计划时刻写成 startedAt，缺少 FSRS 到期时刻；只能降级为
    // 同条目且会话启动后的已确认事件匹配，无法准确区分同日的另一轮计划。
    const isLegacySnapshot = session.words.every((word) => word.plannedTestAt === session.startedAt);
    for (const event of this.deps.eventStore.listAllEvents()) {
      if (event.eventType !== "testAnswered" || event.targetType !== "条目") {
        continue;
      }
      const plan = plansByWordId.get(event.targetId);
      if (plan === undefined) {
        continue;
      }
      const beforeState = event.metadata["beforeState"];
      const beforeDueAt = beforeState !== null && typeof beforeState === "object"
        ? (beforeState as Record<string, unknown>)["dueAt"]
        : undefined;
      if (isLegacySnapshot
        ? Date.parse(event.occurredAt) >= Date.parse(session.startedAt)
        : beforeDueAt === plan.plannedTestAt) {
        alreadyAnswered.add(event.targetId);
      }
    }
    // 稳定分区不改变两侧各自的会话原顺序；已答条目成为前缀后，当前位置
    // 恰为已答数量，非连续远端结果也不会把未答词隐藏在游标之前。
    const answeredPlans = session.words.filter((word) => alreadyAnswered.has(word.wordId));
    const unansweredPlans = session.words.filter((word) => !alreadyAnswered.has(word.wordId));
    const words = [...answeredPlans, ...unansweredPlans];
    const answeredWordIds = answeredPlans.map((word) => word.wordId);
    const currentPosition = answeredPlans.length;
    const status = currentPosition === words.length
      ? TestSessionExecutionStatus.Completed
      : session.status;
    const changed = currentPosition !== session.currentPosition
      || status !== session.status
      || words.some((word, index) => word.wordId !== session.words[index]?.wordId)
      || answeredWordIds.length !== session.answeredWordIds.length
      || answeredWordIds.some((wordId, index) => wordId !== session.answeredWordIds[index]);
    if (!changed) {
      return session;
    }
    const rebased: TestSessionRecord = {
      ...session,
      words,
      answeredWordIds,
      currentPosition,
      status,
    };
    this.deps.sessionStore.updateSession(rebased);
    return rebased;
  }

  /** 构造逐词测试页每次重绘所需的稳定视图快照。 */
  private regularSessionSnapshot(session: TestSessionRecord): TestSessionSnapshot {
    const currentPlan = session.words[session.currentPosition];
    let currentWord: ReviewWordSnapshot | null = null;
    if (currentPlan !== undefined) {
      const content = this.deps.wordContentStore.getEntry(currentPlan.wordId);
      if (content === null) {
        throw new Error("测试会话当前条目不存在");
      }
      currentWord = {
        wordId: content.wordId,
        originalSpelling: content.originalSpelling,
        manualMeaning: content.manualMeaning,
        meanings: content.meanings,
      };
    }
    const spaceId = session.spaceId ?? this.deps.settings.getActiveSpaceId();
    return {
      sessionId: session.sessionId,
      taskId: this.regularTaskId(
        spaceId,
        session.groupOrdinal ?? 0,
        session.learningDay,
      ),
      status: session.status,
      currentPosition: session.currentPosition,
      totalCount: session.words.length,
      currentWord,
      unitNumber: null,
      listNumber: session.groupOrdinal,
    };
  }

  /** 为常规测试组生成稳定标识，供 UI 与会话恢复引用（V1 _regular_task_id 口径）。 */
  private regularTaskId(spaceId: string, ordinal: number, learningDay: LearningDay): string {
    return `regular-group|${spaceId}|${learningDay}|${ordinal}`;
  }

  /** 从常规测试组标识解析组序号；非法标识直接报错（V1 _ordinal_from_task_id 口径）。 */
  private ordinalFromTaskId(taskId: string, learningDay: LearningDay, spaceId: string): number {
    const parts = taskId.split("|");
    if (parts.length !== 4 || parts[0] !== "regular-group" || parts[1] !== spaceId || parts[2] !== learningDay) {
      throw new Error("常规测试组标识无效");
    }
    const ordinal = Number(parts[3]);
    if (!Number.isInteger(ordinal)) {
      throw new Error("常规测试组序号无效");
    }
    return ordinal;
  }

  /** 校验 Space 存在且为常规模式（V1 _require_regular_space 口径）。 */
  private requireRegularSpace(spaceId: string): void {
    const space = this.deps.spaceStore.getSpace(spaceId);
    if (space === null) {
      throw new Error("Space 不存在");
    }
    if (space.learningMode !== "常规模式") {
      throw new Error("当前 Space 不是常规模式");
    }
  }

  /** 读取当前 Space 的常规模式目标保持率；未配置时回退默认 0.95。 */
  private spaceDesiredRetention(spaceId: string): number {
    return this.deps.settings.getSpaceLearningSettings(spaceId).fsrsParameters.desiredRetention;
  }

  /** 把绝对时刻解析为学习日（用户时区 + 换日时间，全部经设置门面）。 */
  private learningDayOf(instant: Date): LearningDay {
    return resolveLearningDay(instant, this.deps.settings.getLearningDaySettings());
  }
}
