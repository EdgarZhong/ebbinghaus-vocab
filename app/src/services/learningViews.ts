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
  type PersistedListTask,
  type SettingsService,
  type SchedulingService,
  type TaskItemSnapshot,
  type TestSessionExecutionStatus,
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
  readonly masteryStatus: MasteryStatusType;
  /** 最近一次最终测试判断；从未测试为 null。 */
  readonly lastJudgement: TestJudgementType | null;
  /** 常规模式 FSRS 下次到期时间；词书模式词无 FSRS 卡片为 null。 */
  readonly nextDueAt: string | null;
}

/** 常规模式复习组内的只读条目（仅展示已有最终测试结果的条目）。 */
export interface RegularReviewEntryView {
  readonly wordId: string;
  readonly originalSpelling: string;
  readonly manualMeaning: string;
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

/** 词书模式复习页任务卡（仅复习任务；测试后复习在会话接线前不可达）。 */
export interface BookReviewTaskView {
  readonly taskId: string;
  /** 行为语言标题："Unit 2 · List 3"。 */
  readonly title: string;
  /** "今天到期" / "逾期 N 天"。 */
  readonly dueLabel: string;
  /** 展开朗读用的活动词（已掌握词不出现，规格 6.4）。 */
  readonly words: readonly { wordId: string; originalSpelling: string; manualMeaning: string }[];
  /** 原始派生任务：完成纸质复习用例（BookReviewCompletionService）的输入。 */
  readonly task: PersistedListTask;
}

export interface LearningViews {
  /** 词汇页：活动 Space 的全部条目（未掌握在前，同状态按录入倒序）。 */
  listVocabularyEntries(spaceId: string): readonly VocabularyEntryView[];
  /** 常规模式复习页：当天已有最终测试结果的条目分组。 */
  listRegularReviewGroups(spaceId: string): readonly RegularReviewGroupView[];
  /** 词书模式复习页：今天需要纸质复习的 List 任务（仅复习口径）。 */
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
  readonly clock: Clock;
}

/** 把词书派生任务转换为界面任务快照（词书模式测试页与看板共用）。 */
function toBookTaskItem(
  task: PersistedListTask,
  deps: CreateLearningViewsDeps,
  states: ReadonlyMap<string, import("@ebbinghaus/domain").ReplayedWordState>,
): TaskItemSnapshot {
  const listRecord = deps.runtime.bookCatalogStore.getList(task.listId);
  const unit = listRecord === null ? null : deps.runtime.bookCatalogStore.getUnit(listRecord.unitId);
  // 开放会话保护：会话开始时绑定任务标识，仅匹配的会话计入进度（scheduling.ts 口径）。
  const openSession = deps.runtime.testSessionStore.getOpenListSession(task.listId);
  const sessionMatches = openSession !== null && openSession.taskId === task.taskId;
  const sessionStatus: TestSessionExecutionStatus | null = sessionMatches ? openSession.status : null;
  const completedCount = sessionMatches ? openSession.currentPosition : 0;
  // 待测/待复习词数：测试任务取测试需求；仅复习取复习需求（与调度工作量口径一致）。
  const demandWordIds =
    task.taskType === "仅复习"
      ? task.payload.reviewDemands.map((demand) => demand.wordId)
      : task.payload.testDemands.map((demand) => demand.wordId);
  const activeWords = demandWordIds
    .map((wordId) => deps.runtime.wordContentStore.getEntry(wordId))
    .filter((content): content is NonNullable<typeof content> => content !== null)
    // 复习展开默认不显示已掌握词（规格 6.4）；测试需求本身只对未掌握词生成。
    .filter((content) => states.get(content.wordId)?.masteryStatus !== MasteryStatus.Mastered)
    .map((content) => ({
      wordId: content.wordId,
      originalSpelling: content.originalSpelling,
      manualMeaning: content.manualMeaning,
    }));
  return {
    taskId: task.taskId,
    listId: task.listId,
    unitNumber: unit?.number ?? 0,
    listNumber: listRecord?.listNumber ?? 0,
    taskType: task.taskType as TaskItemSnapshot["taskType"],
    dueReason: task.dueReason,
    workload: task.workload,
    overdueDays: task.overdueDays,
    completedCount,
    totalCount: activeWords.length,
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
      for (const listRecord of runtime.bookCatalogStore.listListsForSpace(spaceId)) {
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
        return {
          wordId: content.wordId,
          originalSpelling: content.originalSpelling,
          manualMeaning: content.manualMeaning,
          meanings: [...content.meanings],
          recordedAt: content.recordedAt,
          masteryStatus: state?.masteryStatus ?? MasteryStatus.Unmastered,
          lastJudgement: state?.lastJudgement ?? null,
          nextDueAt: state?.regularDueAt ?? null,
        };
      });
    },

    listRegularReviewGroups(spaceId: string): readonly RegularReviewGroupView[] {
      const learningDaySettings = settings.getLearningDaySettings();
      const today = resolveLearningDay(clock.now(), learningDaySettings);
      // 当天已产生最终测试结果的条目：按事件追加顺序收集（每词取首次确认位置）。
      // 改判事件（answerRevised）不另立条目；最终判断以确认事件 metadata 为准。
      const orderedIds: string[] = [];
      const judgementById = new Map<string, TestJudgementType>();
      for (const event of runtime.eventStore.listAllEvents()) {
        if (event.eventType !== "testAnswered" || event.learningDay !== today) {
          continue;
        }
        const content = runtime.wordContentStore.getEntry(event.targetId);
        if (content === null || content.spaceId !== spaceId) {
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
          const content = runtime.wordContentStore.getEntry(wordId);
          const judgement = judgementById.get(wordId) ?? TestJudgement.Recognized;
          return {
            wordId,
            originalSpelling: content?.originalSpelling ?? "",
            manualMeaning: content?.manualMeaning ?? "",
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
      return refresh.tasks
        .filter((task) => task.taskType === "仅复习")
        .map((task) => {
          const listRecord = runtime.bookCatalogStore.getList(task.listId);
          const unit = listRecord === null ? null : runtime.bookCatalogStore.getUnit(listRecord.unitId);
          const words = task.payload.reviewDemands
            .map((demand) => runtime.wordContentStore.getEntry(demand.wordId))
            .filter((content): content is NonNullable<typeof content> => content !== null)
            // 已掌握 Word 默认不出现在展开列表（规格 6.4）。
            .filter((content) => replayed.get(content.wordId)?.masteryStatus !== MasteryStatus.Mastered)
            .map((content) => ({
              wordId: content.wordId,
              originalSpelling: content.originalSpelling,
              manualMeaning: content.manualMeaning,
            }));
          return {
            taskId: task.taskId,
            title: `Unit ${unit?.number ?? "?"} · List ${listRecord?.listNumber ?? "?"}`,
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
      return refresh.tasks.map((task) => toBookTaskItem(task, deps, replayed));
    },
  };
}
