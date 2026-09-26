/**
 * 词书模式纸质复习完成用例（移植 V1 application/review_testing.py 的
 * complete_paper_review，按 V2 事件溯源架构重设计）。
 *
 * 职责：按 List 确认纸质复习并产出协议事件——
 * - 仅复习任务 → `reviewOnlyCompleted`；
 * - 测试后复习任务 → `testFollowedByReviewCompleted`；
 * - 测试后复习且同步条件已满足（全部活动词短期通过次数为 2）→ 追加 `listSynchronized`；
 * - 长期验证任务且全部词已掌握 → 追加 `listMastered`。
 *
 * List 阶段、聚合状态、新增锁与"已完成仅复习需求键"全部由重放器从事件派生
 * （AGENTS.md：派生状态不同步），本用例只负责在正确时机写入正确事件。
 * 测试任务的完成前置（会话存在且处于"等待纸质复习"）按 V1 口径校验；会话是
 * 设备本地执行状态（TestSessionStore），不是事件。
 *
 * 会话由 BookLearningService 启动并推进；本用例在事件写入后关闭等待纸质复习
 * 会话，确保任务完成反馈不会重复出现。
 */

import { MasteryStatus, ShortTermPassCount, reviewDemandKey } from "@ebbinghaus/domain";
import type { LearningDaySettings } from "@ebbinghaus/domain";
import type {
  BookCatalogStore,
  LearningEventStore,
  TestSessionRecord,
  TestSessionStore,
  UnitOfWork,
  WordContentStore,
} from "./ports.ts";
import { TestSessionExecutionStatus } from "./ports.ts";
import type { LearningEventRecorder } from "./eventRecorder.ts";
import { ReviewTestingError } from "./errors.ts";
import type { PersistedListTask } from "./scheduling.ts";
import { replayWordStates } from "./scheduling.ts";

export interface BookReviewCompletionServiceDeps {
  readonly eventRecorder: LearningEventRecorder;
  readonly eventStore: LearningEventStore;
  readonly wordContentStore: WordContentStore;
  readonly bookCatalogStore: BookCatalogStore;
  readonly sessionStore: TestSessionStore;
  readonly unitOfWork?: UnitOfWork;
}

export class BookReviewCompletionService {
  private readonly deps: BookReviewCompletionServiceDeps;

  constructor(deps: BookReviewCompletionServiceDeps) {
    this.deps = deps;
  }

  /**
   * 按任务确认纸质复习：校验前置状态后，在一个事务语义内产出完成事件（与
   * 可能的 List 聚合事件一批写入，保证重放侧"完成 + 聚合"同生共死）。
   */
  completePaperReview(input: {
    readonly task: PersistedListTask;
    readonly learningDaySettings: LearningDaySettings;
  }): void {
    const task = input.task;
    const listRecord = this.deps.bookCatalogStore.getList(task.listId);
    if (listRecord === null) {
      throw new ReviewTestingError("计划任务所属 List 不存在");
    }
    let session: TestSessionRecord | null = null;
    if (task.taskType !== "仅复习") {
      session = this.deps.sessionStore.getOpenListSession(task.listId);
      if (session === null || session.taskId !== task.taskId) {
        throw new ReviewTestingError("测试任务缺少可恢复的会话");
      }
      if (session.status !== TestSessionExecutionStatus.WaitingForPaperReview) {
        throw new ReviewTestingError("软件测试全部完成后才能确认纸质复习");
      }
    }
    const eventType =
      task.taskType === "仅复习" ? ("reviewOnlyCompleted" as const) : ("testFollowedByReviewCompleted" as const);
    // 完成的仅复习需求稳定键：wordId|仅复习|计划日（domain 统一实现，禁止两处口径）。
    const reviewDemandKeys = task.payload.reviewDemands.map((demand) =>
      reviewDemandKey(demand.wordId, demand.scheduledDay),
    );
    const metadata = {
      taskId: task.taskId,
      taskType: task.taskType,
      workload: task.workload,
      reviewDemandKeys,
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
      this.deps.eventStore.appendEvents(events);
      if (session !== null) {
        this.deps.sessionStore.updateSession({ ...session, status: TestSessionExecutionStatus.Completed });
      }
    };
    if (this.deps.unitOfWork === undefined) {
      commit();
    } else {
      this.deps.unitOfWork.run(commit);
    }
  }
}
