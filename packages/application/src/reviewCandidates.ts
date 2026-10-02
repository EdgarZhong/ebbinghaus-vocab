/**
 * 词书模式复习入口候选集只读查询（需求规格 6.4、复习调度算法 5.5）。
 *
 * 2026-10-02 口径：复习页是纯浏览入口，候选集是**纯派生只读视图**——不持久化、
 * 不同步、无写路径，打开/展开/关闭页面都不产生任何数据写入。候选词公式：
 *
 *   每 List 候选 = 当日到期的仅复习词 ∪ 今天完成测试的词 − 当日测试任务中未答词
 *
 * 三部分释义：
 * - "当日到期的仅复习词"：domain `dueReviewOnlyDemands` 给出的严格当日（不是 <=）
 *   仅复习需求；逾期不做累积，直到状态推进生成新的仅复习日期；
 * - "今天完成测试的词"：当前学习日内已有最终测试答案（testAnswered）的活动未掌握
 *   词，按最终答案的发生学习日判断——逾期测试任务在今天完成同样计入；
 * - "当日测试任务中未答词"：今天测试任务里仍未产生今日答案的词，整体从候选集中
 *   扣除，防止复习入口泄露待测答案。
 *
 * 候选只含活动（未软移除）且未掌握的 Word；同一 Word 多项需求只计一次；输出按
 * List 分组、组内按稳定顺序（仅复习词在前按需求序，今日已测词随后按领域重放序）。
 *
 * 性能口径：与 regularTaskItems 相同——全部经一次性事件重放与批量目录查询计算，
 * 禁止逐词 getEntry 阻塞真实 SQLite 桥上的 WebView 主线程。
 */

import {
  dueReviewOnlyDemands,
  MasteryStatus,
  resolveLearningDay,
  type LearningDaySettings,
} from "@ebbinghaus/domain";
import { sortEventsForReplay } from "@ebbinghaus/protocol";
import type {
  BookCatalogStore,
  Clock,
  LearningEventStore,
  WordContentStore,
} from "./ports.ts";
import type { SchedulingService } from "./scheduling.ts";
import { replayWordStates } from "./scheduling.ts";

/** 一个 List 的复习候选分组：listId + 稳定有序的去重候选词标识。 */
export interface ReviewCandidateGroup {
  readonly listId: string;
  readonly wordIds: readonly string[];
}

/** 复习候选查询依赖：全部为只读端口与调度投影，本用例无任何写入。 */
export interface ReviewCandidatesServiceDeps {
  readonly clock: Clock;
  readonly eventStore: LearningEventStore;
  readonly wordContentStore: WordContentStore;
  readonly bookCatalogStore: BookCatalogStore;
  readonly scheduling: SchedulingService;
}

export class ReviewCandidatesService {
  constructor(private readonly deps: ReviewCandidatesServiceDeps) {}

  /**
   * 计算当前 Space（词书模式）今天每 List 的复习候选词集合。
   * 每次调用都从最新本地事件集实时重算：候选集不同步、不缓存、不落库。
   */
  bookReviewCandidates(input: {
    readonly spaceId: string;
    readonly learningDaySettings: LearningDaySettings;
  }): readonly ReviewCandidateGroup[] {
    const today = resolveLearningDay(this.deps.clock.now(), input.learningDaySettings);
    const listIds = new Set(
      this.deps.bookCatalogStore.listListsForSpace(input.spaceId).map((record) => record.listId),
    );
    if (listIds.size === 0) {
      return [];
    }

    // 词状态一次性重放（批量）：候选资格（活动未掌握、归属本 Space 的 List）只从
    // 重放状态与内容目录判定，禁止逐词 getEntry——真实桌面 SQLite 桥下会阻塞主线程。
    const states = replayWordStates({
      eventStore: this.deps.eventStore,
      wordContentStore: this.deps.wordContentStore,
    });
    const listOf = (wordId: string): string | null => {
      const state = states.get(wordId);
      if (
        state === undefined ||
        state.removed ||
        state.masteryStatus !== MasteryStatus.Unmastered ||
        state.listId === null ||
        !listIds.has(state.listId)
      ) {
        return null;
      }
      return state.listId;
    };

    // 第二部分：今天完成测试的词。答案的学习日必须按**本机**设置从 occurredAt 重新
    // 解析：事件上的 learningDay 标签由产生设备的设置投影，跨设备设置不一致时
    // 直接比对标签会把别的学习日的答案错算进来。排序用协议领域重放序
    // （occurredAt → deviceSeq → deviceId → eventId），保证各终端对同一事件集
    // 输出完全相同的候选顺序。
    const answeredToday = new Set<string>();
    const answerOrderByList = new Map<string, string[]>();
    const todaysAnswerEvents = sortEventsForReplay(
      this.deps.eventStore
        .listAllEvents()
        .filter((event) => event.eventType === "testAnswered" && event.targetType === "Word"),
    );
    for (const event of todaysAnswerEvents) {
      if (resolveLearningDay(new Date(event.occurredAt), input.learningDaySettings) !== today) {
        continue;
      }
      const listId = listOf(event.targetId);
      if (listId === null || answeredToday.has(event.targetId)) {
        continue;
      }
      answeredToday.add(event.targetId);
      const ordered = answerOrderByList.get(listId) ?? [];
      ordered.push(event.targetId);
      answerOrderByList.set(listId, ordered);
    }

    // 第一部分：当日到期的仅复习词（domain 调度投影已按 List 过滤本 Space、
    // 剔除软移除词与已掌握词，并保证严格当日命中）。
    const reviewOrderByList = new Map<string, string[]>();
    for (const snapshot of this.deps.scheduling.projectSpaceLists({
      spaceId: input.spaceId,
      learningDaySettings: input.learningDaySettings,
    })) {
      for (const demand of dueReviewOnlyDemands(snapshot, today)) {
        if (listOf(demand.wordId) === null) {
          continue;
        }
        const ordered = reviewOrderByList.get(snapshot.listId) ?? [];
        if (!ordered.includes(demand.wordId)) {
          ordered.push(demand.wordId);
        }
        reviewOrderByList.set(snapshot.listId, ordered);
      }
    }

    // 排除集：当日测试任务中未答词（当日到期待测且尚未测试的词），防止复习入口
    // 泄露待测答案。注意只对"今日无答案"的词扣除——今天已测的词保留在候选集中。
    const excludedUnanswered = new Set<string>();
    const refresh = this.deps.scheduling.refreshSpaceTasks({
      spaceId: input.spaceId,
      learningDaySettings: input.learningDaySettings,
    });
    for (const task of refresh.tasks) {
      for (const demand of task.payload.testDemands) {
        if (!answeredToday.has(demand.wordId)) {
          excludedUnanswered.add(demand.wordId);
        }
      }
    }

    // 合并：仅复习词（domain 稳定序）在前，今日已测词（答案重放序）随后，去重；
    // 再整体扣除未答排除集；空组不输出。List 按标识稳定排序。
    const groups: ReviewCandidateGroup[] = [];
    for (const listId of [...listIds].sort()) {
      const merged: string[] = [];
      const seen = new Set<string>();
      for (const wordId of [...(reviewOrderByList.get(listId) ?? []), ...(answerOrderByList.get(listId) ?? [])]) {
        if (seen.has(wordId)) {
          continue;
        }
        seen.add(wordId);
        merged.push(wordId);
      }
      const candidates = merged.filter((wordId) => !excludedUnanswered.has(wordId));
      if (candidates.length > 0) {
        groups.push({ listId, wordIds: Object.freeze(candidates) });
      }
    }
    return Object.freeze(groups);
  }
}
