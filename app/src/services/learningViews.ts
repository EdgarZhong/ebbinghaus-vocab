/**
 * 组合根侧界面只读视图（UI-2 扩展）。
 *
 * 职责边界（AGENTS.md 分层规则）：本文件不实现任何业务规则——调度、FSRS、冲突
 * 与事件产出全部在 packages/application 与 packages/domain；这里只把既有用例的
 * 输出（调度派生任务、复习候选集、事件重放状态、内容目录）**拼装**为界面直接
 * 可渲染的视图快照，并完成"内部术语 → 行为语言"的展示映射（界面设计规格第 15 章
 * 禁止 `T0 + 1` 之类枚举原文上屏）。
 *
 * 2026-10-02 口径：复习页是纯浏览入口（需求规格 6.4）。词书复习候选集来自
 * ReviewCandidatesService（当日到期仅复习词 ∪ 今日已测词 − 当日未答词），视图层
 * 只做 List 分组标题拼装与词条内容联接，不引入任何任务/到期/完成语义。
 *
 * 页面只经 `useServices()` 消费本文件的视图对象，绝不直接触碰端口实现。
 */

import {
  MasteryStatus,
  resolveLearningDay,
  splitRegularTestGroups,
  TestJudgement,
  type Clock,
  type MasteryStatus as MasteryStatusType,
  type StructuredMeaning,
  type TestJudgement as TestJudgementType,
} from "@ebbinghaus/domain";
import {
  replayWordStates,
  type BookLearningService,
  type PersistedListTask,
  type ReviewCandidatesService,
  type SettingsService,
  type SchedulingService,
  type TaskItemSnapshot,
  type TestSessionExecutionStatus,
  type ListCatalogRecord,
  type WordContentRecord,
} from "@ebbinghaus/application";
import type { InMemoryRuntime } from "@ebbinghaus/persistence/src/adapters/inMemoryRuntime.ts";

// ---------------------------------------------------------------------------
// 视图快照类型
// ---------------------------------------------------------------------------

/** 词汇页 Word 卡片与右侧详情使用的只读词条视图。 */
export interface VocabularyEntryView {
  readonly wordId: string;
  readonly originalSpelling: string;
  readonly manualMeaning: string;
  readonly meanings: readonly StructuredMeaning[];
  /** 录入（或最近内容更新）时刻 UTC ISO；排序与展示日期的唯一来源。 */
  readonly recordedAt: string;
  /** 词书模式纸质定位；常规模式没有 Unit/List。 */
  readonly unitNumber: number | null;
  readonly listNumber: number | null;
  readonly masteryStatus: MasteryStatusType;
  /** 最近一次最终测试判断；从未测试为 null。 */
  readonly lastJudgement: TestJudgementType | null;
  /** 常规模式 FSRS 下次到期时间；词书模式词无 FSRS 卡片为 null。 */
  readonly nextDueAt: string | null;
}

/** V1 详情中可展开的学习事件记录，按发生时间稳定排序。 */
export interface VocabularyTimelineItemView {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly detail: string;
}

/** 复习页词卡片的两列词条内容（左英文、右释义；释义含用法，横放不下时横滚）。 */
export interface ReviewWordContentView {
  readonly wordId: string;
  readonly originalSpelling: string;
  readonly manualMeaning: string;
  readonly meanings: readonly StructuredMeaning[];
}

/** 常规模式复习组内的只读条目（仅展示已有最终测试结果的条目）。 */
export interface RegularReviewEntryView {
  readonly wordId: string;
  readonly originalSpelling: string;
  readonly manualMeaning: string;
  readonly meanings: readonly StructuredMeaning[];
  readonly lastJudgement: TestJudgementType;
}

/** 常规模式复习组：当天已测条目的朗读分组（无完成按钮语义）。 */
export interface RegularReviewGroupView {
  readonly ordinal: number;
  readonly testedCount: number;
  readonly forgottenCount: number;
  /** 最终判断"不认识"的条目（规格 9.3：置顶并标注"刚刚忘记"）。 */
  readonly forgotten: readonly RegularReviewEntryView[];
  /** 其余最终判断"认识"的条目。 */
  readonly others: readonly RegularReviewEntryView[];
}

/**
 * 词书模式复习页 List 卡（界面设计规格 9.1/9.2）。
 *
 * 只承载"Unit / List 定位 + 今天关注的候选词内容"：候选词公式与过滤全部由
 * ReviewCandidatesService 决定（当日到期仅复习词 ∪ 今日已测词 − 当日未答词，
 * 只含活动未掌握 Word、多项需求去重）。视图不再携带任务标识、到期标签、
 * 完成状态或任何写操作入参——复习页没有"完成任务"概念。
 */
export interface BookReviewListView {
  readonly listId: string;
  /** 行为语言标题："Unit 2 · List 3"。 */
  readonly title: string;
  /** 候选词内容（候选稳定顺序：仅复习词在前、今日已测词随后）。 */
  readonly words: readonly ReviewWordContentView[];
}

export interface LearningViews {
  /** 词汇页：活动 Space 的全部条目（未掌握在前，同状态按录入倒序）。 */
  listVocabularyEntries(spaceId: string): readonly VocabularyEntryView[];
  listVocabularyTimeline(wordId: string): readonly VocabularyTimelineItemView[];
  /** 常规模式复习页：当天已有最终测试结果的条目分组。 */
  listRegularReviewGroups(spaceId: string): readonly RegularReviewGroupView[];
  /** 词书模式复习页：今天每个 List 的复习候选词（纯浏览视图，规格 9.2）。 */
  listBookReviewLists(spaceId: string): readonly BookReviewListView[];
  /** 词书模式测试列表：全部派生任务（测试页与今日看板同一数据源）。 */
  bookTaskItems(spaceId: string): readonly TaskItemSnapshot[];
}

// ---------------------------------------------------------------------------
// 视图构造
// ---------------------------------------------------------------------------

export interface CreateLearningViewsDeps {
  readonly runtime: InMemoryRuntime;
  readonly settings: SettingsService;
  readonly scheduling: SchedulingService;
  readonly bookLearning: BookLearningService;
  readonly reviewCandidates: ReviewCandidatesService;
  readonly clock: Clock;
}

/** 把词书派生任务转换为界面任务快照（词书模式测试页与看板共用）。 */
function toBookTaskItem(
  task: PersistedListTask,
  deps: CreateLearningViewsDeps,
  listsById: ReadonlyMap<string, ListCatalogRecord>,
  contentsById: ReadonlyMap<string, WordContentRecord>,
): TaskItemSnapshot {
  const listRecord = listsById.get(task.listId);
  // 会话当日有效：只有当前学习日的开放会话才匹配任务进度；等待纸质复习不再由
  // 会话承载（规格：换日作废、纸书由答案事件派生），旧会话不遮蔽任务行显示。
  const today = resolveLearningDay(deps.clock.now(), deps.settings.getLearningDaySettings());
  let openSession = deps.runtime.testSessionStore.getOpenListSession(task.listId);
  const sessionMatches = openSession !== null && openSession.learningDay === today;
  if (sessionMatches && openSession !== null) {
    // 远端作答已进入本地事件库，但开放会话的位置仍可能是本机上次显示的旧值。
    // 先由应用用例重基准，再读取持久会话统计，避免任务行继续报旧的剩余词数。
    deps.bookLearning.getBookTestSessionSnapshot(openSession.sessionId);
    openSession = deps.runtime.testSessionStore.getOpenListSession(task.listId);
  }
  const sessionStatus: TestSessionExecutionStatus | null = sessionMatches && openSession !== null ? openSession.status : null;
  const completedCount = sessionMatches && openSession !== null ? openSession.currentPosition : 0;
  // 待测词数：调度自 2026-10-02 起只生成测试任务，payload 只有 testDemands
  // （工作量口径 = 待测词数，与 packages/application 派生任务一致）。
  const demandWordIds = task.payload.testDemands.map((demand) => demand.wordId);
  const activeWords = demandWordIds
    .map((wordId) => contentsById.get(wordId))
    .filter((content): content is WordContentRecord => content !== undefined && !content.removed)
    .map((content) => ({
      wordId: content.wordId,
      originalSpelling: content.originalSpelling,
      manualMeaning: content.manualMeaning,
      meanings: content.meanings,
    }));
  return {
    taskId: task.taskId,
    listId: task.listId,
    unitNumber: listRecord?.unitNumber ?? 0,
    listNumber: listRecord?.listNumber ?? 0,
    taskType: task.taskType as TaskItemSnapshot["taskType"],
    dueReason: task.dueReason,
    workload: task.workload,
    overdueDays: task.overdueDays,
    completedCount,
    // 已启动的会话冻结了本轮待测词集合；确认一词后调度需求会立刻缩减。
    // 若此时仍用缩减后的需求数再减 currentPosition，会把已答词扣两次，
    // 暂停列表比会话内少报一词，并可能误导用户以为续测跳词。
    totalCount: sessionMatches && openSession !== null ? openSession.words.length : activeWords.length,
    sessionStatus,
    activeWords,
  };
}

export function createLearningViews(deps: CreateLearningViewsDeps): LearningViews {
  const { runtime, settings, scheduling, clock } = deps;

  /** 全量重放一次（内存运行时数据量小；确定性由事件排序保证）。 */
  const states = (): ReadonlyMap<string, import("@ebbinghaus/domain").ReplayedWordState> =>
    replayWordStates({ eventStore: runtime.eventStore, wordContentStore: runtime.wordContentStore });

  return {
    listVocabularyEntries(spaceId: string): readonly VocabularyEntryView[] {
      const replayed = states();
      // 常规模式条目直接按 Space 查询；词书模式词的 spaceId 为 null，经 List 目录拼接。
      const contents = [...runtime.wordContentStore.listEntriesForSpace(spaceId)];
      const lists = runtime.bookCatalogStore.listListsForSpace(spaceId);
      const listsById = new Map(lists.map((list) => [list.listId, list]));
      for (const listRecord of lists) {
        contents.push(...runtime.wordContentStore.listEntriesForList(listRecord.listId));
      }
      // 事件移除先到、内容墓碑尚未到时也立即隐藏，避免旧卡片继续提供维护操作。
      const withIndex = contents.map((content, index) => ({ content, index }))
        .filter(({ content }) => replayed.get(content.wordId)?.removed !== true);
      // 规格 12.1/6.6：未掌握固定排在已掌握前；同一状态内最新录入在最上方；
      // 同批录入（同一时刻）保持用户保存时的顺序（按目录插入序倒序还原）。
      withIndex.sort((a, b) => {
        const masteryA = replayed.get(a.content.wordId)?.masteryStatus ?? MasteryStatus.Unmastered;
        const masteryB = replayed.get(b.content.wordId)?.masteryStatus ?? MasteryStatus.Unmastered;
        if (masteryA !== masteryB) {
          return masteryA === MasteryStatus.Unmastered ? -1 : 1;
        }
        if (a.content.recordedAt !== b.content.recordedAt) {
          return a.content.recordedAt < b.content.recordedAt ? 1 : -1;
        }
        return b.index - a.index;
      });
      return withIndex.map(({ content }) => {
        const state = replayed.get(content.wordId);
        // List 查询已经在上方一次完成；逐词再查本地 SQLite 会让 60 词列表
        // 产生上百次 WebView 主线程往返，切页和详情展开都会明显卡顿。
        const list = content.listId === null ? undefined : listsById.get(content.listId);
        return {
          wordId: content.wordId,
          originalSpelling: content.originalSpelling,
          manualMeaning: content.manualMeaning,
          meanings: [...content.meanings],
          recordedAt: content.recordedAt,
          unitNumber: list?.unitNumber ?? null,
          listNumber: list?.listNumber ?? null,
          masteryStatus: state?.masteryStatus ?? MasteryStatus.Unmastered,
          lastJudgement: state?.lastJudgement ?? null,
          nextDueAt: state?.regularDueAt ?? null,
        };
      });
    },

    listVocabularyTimeline(wordId: string): readonly VocabularyTimelineItemView[] {
      const labels: Record<string, string> = {
        firstPassRecorded: "首次录入", wordAdded: "新增词条", wordContentUpdated: "编辑内容",
        wordRemoved: "删除词条", testAnswered: "测试作答", answerRevised: "测试改判",
        shortTermPassCountChanged: "短期通过次数变更", longTermValidationCompleted: "长期验证完成",
        wordMastered: "已掌握", wordManuallyMarkedMastered: "手动标记为已掌握",
        wordManuallyMarkedUnmastered: "手动标记为未掌握",
      };
      // 历史库中可能已有 dictionaryFetched/dictionaryFetchFailed；这些事件
      // 保留原样供协议兼容与旧数据审计，但查询结果不是学习行为，不在学习记录
      // 展示。V2 派生任务也不持久化，不能把“当前计划”伪装成已发生的历史。
      return runtime.eventStore.listAllEvents()
        .filter((event) => event.targetId === wordId &&
          event.eventType !== "dictionaryFetched" && event.eventType !== "dictionaryFetchFailed")
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.deviceSeq - b.deviceSeq)
        .map((event) => ({
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          title: labels[event.eventType] ?? event.eventType,
          detail: JSON.stringify(event.metadata),
        }));
    },

    listRegularReviewGroups(spaceId: string): readonly RegularReviewGroupView[] {
      const learningDaySettings = settings.getLearningDaySettings();
      const today = resolveLearningDay(clock.now(), learningDaySettings);
      // 当天已产生最终测试结果的条目：按事件追加顺序收集（每词取首次确认位置）。
      // 改判事件（answerRevised）不另立条目；最终判断以确认事件 metadata 为准。
      const orderedIds: string[] = [];
      const judgementById = new Map<string, TestJudgementType>();
      const contentsById = new Map(runtime.wordContentStore.listEntriesForSpace(spaceId).map((content) => [content.wordId, content]));
      for (const event of runtime.eventStore.listAllEvents()) {
        if (event.eventType !== "testAnswered" || event.learningDay !== today) {
          continue;
        }
        const content = contentsById.get(event.targetId);
        if (content === undefined) {
          continue;
        }
        if (judgementById.has(event.targetId)) {
          continue;
        }
        const finalJudgement = event.metadata["finalJudgement"];
        if (finalJudgement !== TestJudgement.Recognized && finalJudgement !== TestJudgement.NotRecognized) {
          continue;
        }
        judgementById.set(event.targetId, finalJudgement);
        orderedIds.push(event.targetId);
      }
      if (orderedIds.length === 0) {
        return [];
      }
      // 与测试页同源的组切分规则（Space 设置"每组条目数"，禁止页面写死常量）。
      const groupSize = settings.getSpaceLearningSettings(spaceId).regularGroupSize;
      return splitRegularTestGroups(orderedIds, groupSize).map((wordIds, index) => {
        const entries: RegularReviewEntryView[] = wordIds.map((wordId) => {
          const content = contentsById.get(wordId);
          const judgement = judgementById.get(wordId) ?? TestJudgement.Recognized;
          return {
            wordId,
            originalSpelling: content?.originalSpelling ?? "",
            manualMeaning: content?.manualMeaning ?? "",
            meanings: content?.meanings ?? [],
            lastJudgement: judgement,
          };
        });
        const forgotten = entries.filter((entry) => entry.lastJudgement === TestJudgement.NotRecognized);
        const others = entries.filter((entry) => entry.lastJudgement === TestJudgement.Recognized);
        return {
          ordinal: index + 1,
          testedCount: entries.length,
          forgottenCount: forgotten.length,
          forgotten,
          others,
        };
      });
    },

    /**
     * 词书模式复习页：今天每个 List 的候选词浏览分组（规格 9.1/9.2）。
     *
     * 候选集公式（当日到期仅复习词 ∪ 今日已测词 − 当日未答词、活动未掌握、
     * 多需求去重）由 ReviewCandidatesService 完整负责；这里只把候选词标识联接
     * 词条内容并按 List 拼出 "Unit X · List Y" 标题。候选服务已保证候选词全部
     * 活动未掌握，联接时仅防御性剔除内容目录缺失/已移除的条目。
     */
    listBookReviewLists(spaceId: string): readonly BookReviewListView[] {
      const listsById = new Map(runtime.bookCatalogStore.listListsForSpace(spaceId).map((list) => [list.listId, list]));
      const contentsById = new Map(runtime.wordContentStore.listCatalogEntries().map((content) => [content.wordId, content]));
      return deps.reviewCandidates
        .bookReviewCandidates({ spaceId, learningDaySettings: settings.getLearningDaySettings() })
        .map((group) => {
          const listRecord = listsById.get(group.listId);
          const words = group.wordIds
            .map((wordId) => contentsById.get(wordId))
            .filter((content): content is WordContentRecord => content !== undefined && !content.removed)
            .map((content) => ({
              wordId: content.wordId,
              originalSpelling: content.originalSpelling,
              manualMeaning: content.manualMeaning,
              meanings: content.meanings,
            }));
          return {
            listId: group.listId,
            title: `Unit ${listRecord?.unitNumber ?? "?"} · List ${listRecord?.listNumber ?? "?"}`,
            words,
          };
        });
    },

    bookTaskItems(spaceId: string): readonly TaskItemSnapshot[] {
      const learningDaySettings = settings.getLearningDaySettings();
      const refresh = scheduling.refreshSpaceTasks({ spaceId, learningDaySettings });
      const listsById = new Map(runtime.bookCatalogStore.listListsForSpace(spaceId).map((list) => [list.listId, list]));
      const contentsById = new Map(runtime.wordContentStore.listCatalogEntries().map((content) => [content.wordId, content]));
      // 调度排除失效词是主边界；内容或会话在读取间隙更新时，共享任务出口再剔除
      // 无待测词快照，保证今日看板和测试页都不会展示只有历史记录的空 List。
      return refresh.tasks.map((task) => toBookTaskItem(task, deps, listsById, contentsById))
        .filter((task) => task.totalCount > task.completedCount);
    },
  };
}
