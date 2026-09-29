/**
 * 组合根侧界面只读视图（UI-2 扩展）。
 *
 * 职责边界（AGENTS.md 分层规则）：本文件不实现任何业务规则——调度、FSRS、冲突
 * 与事件产出全部在 packages/application 与 packages/domain；这里只把既有用例的
 * 输出（调度派生任务、事件重放状态、内容目录）**拼装**为界面直接可渲染的视图
 * 快照，并完成"内部术语 → 行为语言"的展示映射（界面设计规格第 15 章禁止
 * `T0 + 1` 之类枚举原文上屏）。
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

/** 词书模式复习页任务卡，包含仅复习与已完成软件测试的纸质复习。 */
export interface BookReviewTaskView {
  readonly taskId: string;
  /** 行为语言标题："Unit 2 · List 3"。 */
  readonly title: string;
  /** "今天到期" / "逾期 N 天"。 */
  readonly dueLabel: string;
  /** 展开朗读用的活动词（已掌握词不出现，规格 6.4）。 */
  readonly words: readonly { wordId: string; originalSpelling: string; manualMeaning: string; meanings: readonly StructuredMeaning[] }[];
  /** 原始派生任务：完成纸质复习用例（BookReviewCompletionService）的输入。 */
  readonly task: PersistedListTask;
}

export interface LearningViews {
  /** 词汇页：活动 Space 的全部条目（未掌握在前，同状态按录入倒序）。 */
  listVocabularyEntries(spaceId: string): readonly VocabularyEntryView[];
  listVocabularyTimeline(wordId: string): readonly VocabularyTimelineItemView[];
  /** 常规模式复习页：当天已有最终测试结果的条目分组。 */
  listRegularReviewGroups(spaceId: string): readonly RegularReviewGroupView[];
  /** 词书模式复习页：今天需要纸质复习的 List 任务。 */
  listBookReviewTasks(spaceId: string): readonly BookReviewTaskView[];
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
  readonly clock: Clock;
}

/** 把词书派生任务转换为界面任务快照（词书模式测试页与看板共用）。 */
function toBookTaskItem(
  task: PersistedListTask,
  deps: CreateLearningViewsDeps,
  states: ReadonlyMap<string, import("@ebbinghaus/domain").ReplayedWordState>,
  listsById: ReadonlyMap<string, ListCatalogRecord>,
  contentsById: ReadonlyMap<string, WordContentRecord>,
): TaskItemSnapshot {
  const listRecord = listsById.get(task.listId);
  // 开放会话保护：会话开始时绑定任务标识，仅匹配的会话计入进度（scheduling.ts 口径）。
  let openSession = deps.runtime.testSessionStore.getOpenListSession(task.listId);
  const sessionMatches = openSession !== null && openSession.taskId === task.taskId;
  if (sessionMatches && openSession !== null) {
    // 远端作答已进入本地事件库，但开放会话的位置仍可能是本机上次显示的旧值。
    // 先由应用用例重基准，再读取持久会话统计，避免任务行继续报旧的剩余词数。
    deps.bookLearning.getBookTestSessionSnapshot(openSession.sessionId);
    openSession = deps.runtime.testSessionStore.getOpenListSession(task.listId);
  }
  const sessionStatus: TestSessionExecutionStatus | null = sessionMatches && openSession !== null ? openSession.status : null;
  const completedCount = sessionMatches && openSession !== null ? openSession.currentPosition : 0;
  // 待测/待复习词数：测试任务取测试需求；仅复习取复习需求（与调度工作量口径一致）。
  const demandWordIds =
    task.taskType === "仅复习"
      ? task.payload.reviewDemands.map((demand) => demand.wordId)
      : task.payload.testDemands.map((demand) => demand.wordId);
  const activeWords = demandWordIds
    .map((wordId) => contentsById.get(wordId))
    .filter((content): content is WordContentRecord => content !== undefined && !content.removed)
    // 复习展开默认不显示已掌握词（规格 6.4）；测试需求本身只对未掌握词生成。
    .filter((content) => states.get(content.wordId)?.masteryStatus !== MasteryStatus.Mastered)
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
      const withIndex = contents.map((content, index) => ({ content, index }));
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

    listBookReviewTasks(spaceId: string): readonly BookReviewTaskView[] {
      const learningDaySettings = settings.getLearningDaySettings();
      const replayed = states();
      const refresh = scheduling.refreshSpaceTasks({ spaceId, learningDaySettings });
      const listsById = new Map(runtime.bookCatalogStore.listListsForSpace(spaceId).map((list) => [list.listId, list]));
      const contentsById = new Map(runtime.wordContentStore.listCatalogEntries().map((content) => [content.wordId, content]));
      // 进行中的软件测试仍留在测试页；测试完成的任务从会话启动快照恢复，
      // 防止答案改变调度投影后，纸质复习入口被新任务覆盖。
      const paperTasks = [
        ...refresh.tasks.filter((task) => task.taskType === "仅复习"),
        ...deps.bookLearning.pendingPaperReviewTasks(spaceId),
      ];
      return [...new Map(paperTasks.map((task) => [task.taskId, task])).values()]
        .map((task) => {
          const listRecord = listsById.get(task.listId);
          const words = task.payload.reviewDemands
            .map((demand) => contentsById.get(demand.wordId))
            .filter((content): content is WordContentRecord => content !== undefined && !content.removed)
            // 已掌握 Word 默认不出现在展开列表（规格 6.4）。
            .filter((content) => replayed.get(content.wordId)?.masteryStatus !== MasteryStatus.Mastered)
            .map((content) => ({
              wordId: content.wordId,
              originalSpelling: content.originalSpelling,
              manualMeaning: content.manualMeaning,
              meanings: content.meanings,
            }));
          return {
            taskId: task.taskId,
            title: `Unit ${listRecord?.unitNumber ?? "?"} · List ${listRecord?.listNumber ?? "?"}`,
            dueLabel: task.overdueDays > 0 ? `逾期 ${task.overdueDays} 天` : "今天到期",
            words,
            task,
          };
        });
    },

    bookTaskItems(spaceId: string): readonly TaskItemSnapshot[] {
      const replayed = states();
      const learningDaySettings = settings.getLearningDaySettings();
      const refresh = scheduling.refreshSpaceTasks({ spaceId, learningDaySettings });
      const listsById = new Map(runtime.bookCatalogStore.listListsForSpace(spaceId).map((list) => [list.listId, list]));
      const contentsById = new Map(runtime.wordContentStore.listCatalogEntries().map((content) => [content.wordId, content]));
      return refresh.tasks.map((task) => toBookTaskItem(task, deps, replayed, listsById, contentsById));
    },
  };
}
