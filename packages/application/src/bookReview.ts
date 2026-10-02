/**
 * 词书模式纸质复习完成用例（移植 V1 application/review_testing.py 的
 * complete_paper_review，按 V2 事件溯源架构重设计）。
 *
 * 职责：按 List 确认纸质复习并产出协议事件——
 * - 仅复习任务 → `reviewOnlyCompleted`；
 * - 测试后复习任务 → `testFollowedByReviewCompleted`（metadata 带 answeredPlannedDays
 *   配对键，标识本次确认覆盖哪些答案计划日）；
 * - 测试后复习且同步条件已满足（全部活动词短期通过次数为 2）→ 追加 `listSynchronized`；
 * - 长期验证任务且全部词已掌握 → 追加 `listMastered`。
 *
 * List 阶段、聚合状态、新增锁与"已完成仅复习需求键"全部由重放器从事件派生
 * （AGENTS.md：派生状态不同步），本用例只负责在正确时机写入正确事件。
 * 等待纸质复习由答案事件派生（BookLearningService.pendingPaperReviewBatches），
 * 不依赖本机会话存活；确认前校验批次存在且未被确认过，重复确认与跨端重复点击安全。
 */

import { MasteryStatus, resolveLearningDay, ShortTermPassCount, reviewDemandKey } from "@ebbinghaus/domain";
import type { LearningDaySettings } from "@ebbinghaus/domain";
import type {
  BookCatalogStore,
  LearningEventStore,
  UnitOfWork,
  WordContentStore,
} from "./ports.ts";
import type { LearningEventRecorder } from "./eventRecorder.ts";
import { ReviewTestingError } from "./errors.ts";
import type { PersistedListTask } from "./scheduling.ts";
import { replayWordStates } from "./scheduling.ts";

export interface BookReviewCompletionServiceDeps {
  readonly eventRecorder: LearningEventRecorder;
  readonly eventStore: LearningEventStore;
  readonly wordContentStore: WordContentStore;
  readonly bookCatalogStore: BookCatalogStore;
  readonly unitOfWork?: UnitOfWork;
}

export class BookReviewCompletionService {
  private readonly deps: BookReviewCompletionServiceDeps;

  constructor(deps: BookReviewCompletionServiceDeps) {
    this.deps = deps;
  }

  /**
   * 按任务确认纸质复习：校验前置状态后写入完成事件（与可能的 List 聚合事件一批
   * 提交，保证重放侧"完成 + 聚合"同生共死）。等待纸质复习由答案事件派生而非本机
   * 会话承载，因此本用例不读写会话；测试后复习以 answeredPlannedDays 为配对键，
   * 校验批次确有答案且未被确认过，保证跨端重复点击与刷新重试安全。
   */
  completePaperReview(input: {
    readonly task: PersistedListTask;
    /** 测试后复习批次覆盖的答案计划日；仅复习任务不需要。 */
    readonly answeredPlannedDays?: readonly string[];
    readonly learningDaySettings: LearningDaySettings;
  }): void {
    const task = input.task;
    const listRecord = this.deps.bookCatalogStore.getList(task.listId);
    if (listRecord === null) {
      throw new ReviewTestingError("计划任务所属 List 不存在");
    }
    const isReviewOnly = task.taskType === "仅复习";
    let plannedDays: readonly string[] = [];
    if (!isReviewOnly) {
      plannedDays = input.answeredPlannedDays ?? [];
      if (plannedDays.length === 0) {
        throw new ReviewTestingError("测试后复习缺少对应的测试批次");
      }
      const answeredDays = new Set<string>();
      const coveredDays = new Set<string>();
      for (const event of this.deps.eventStore.listAllEvents()) {
        if (event.eventType === "testAnswered" && event.targetType === "Word") {
          const word = this.deps.wordContentStore.getEntry(event.targetId);
          if (word === null || word.listId !== task.listId) continue;
          const plannedTestAt = String(event.metadata["plannedTestAt"] ?? "");
          if (plannedTestAt === "") continue;
          answeredDays.add(resolveLearningDay(new Date(plannedTestAt), input.learningDaySettings));
        } else if (event.eventType === "testFollowedByReviewCompleted" && event.targetId === task.listId) {
          const days = event.metadata["answeredPlannedDays"];
          if (Array.isArray(days)) {
            for (const day of days) {
              if (typeof day === "string") coveredDays.add(day);
            }
          }
        }
      }
      for (const day of plannedDays) {
        if (!answeredDays.has(day)) {
          throw new ReviewTestingError(`该 List 在 ${day} 没有已完成的软件测试批次`);
        }
        if (coveredDays.has(day)) {
          throw new ReviewTestingError("该测试批次的纸质复习已确认过");
        }
      }
    }
    const eventType =
      isReviewOnly ? ("reviewOnlyCompleted" as const) : ("testFollowedByReviewCompleted" as const);
    // 完成的仅复习需求稳定键：wordId|仅复习|计划日（domain 统一实现，禁止两处口径）。
    const reviewDemandKeys = task.payload.reviewDemands.map((demand) =>
      reviewDemandKey(demand.wordId, demand.scheduledDay),
    );
    const metadata = {
      taskId: task.taskId,
      taskType: task.taskType,
      workload: task.workload,
      reviewDemandKeys,
      // 测试后复习的跨端配对键：确认时写入，重放与派生按它识别已覆盖的答案计划日。
      ...(isReviewOnly ? {} : { answeredPlannedDays: [...plannedDays] }),
    };

    const events = [
      this.deps.eventRecorder.record({
        eventType,
        targetType: "List",
        targetId: task.listId,
        source: "纸质复习完成",
        metadata,
      }),
    ];

    // List 聚合事件的判定基于当前（完成事件写入前）的词状态快照。
    const states = replayWordStates(this.deps);
    const listWordStates = [...states.values()].filter(
      (state) => state.listId === task.listId && !state.removed,
    );
    if (task.taskType === "长期验证") {
      const allMastered =
        listWordStates.length > 0 &&
        listWordStates.every((state) => state.masteryStatus === MasteryStatus.Mastered);
      if (allMastered) {
        events.push(
          this.deps.eventRecorder.record({
            eventType: "listMastered",
            targetType: "List",
            targetId: task.listId,
            source: "纸质复习完成",
            metadata,
          }),
        );
      }
    } else if (task.taskType !== "仅复习") {
      // 短期测试后复习：全部活动词通过次数达到 2 即满足同步条件（规格 5.5/7）。
      const activeWordCount = listWordStates.filter(
        (state) => state.masteryStatus === MasteryStatus.Unmastered,
      ).length;
      const allPassedTwice = listWordStates
        .filter((state) => state.masteryStatus === MasteryStatus.Unmastered)
        .every((state) => state.shortTermPassCount === ShortTermPassCount.Two);
      if (activeWordCount > 0 && allPassedTwice) {
        events.push(
          this.deps.eventRecorder.record({
            eventType: "listSynchronized",
            targetType: "List",
            targetId: task.listId,
            source: "纸质复习完成",
            metadata,
          }),
        );
      }
    }
    const commit = (): void => {
      // 只写事件：等待纸质复习由答案事件派生，没有需要顺带关闭的会话状态。
      this.deps.eventStore.appendEvents(events);
    };
    if (this.deps.unitOfWork === undefined) {
      commit();
    } else {
      this.deps.unitOfWork.run(commit);
    }
  }
}
