/**
 * V1 词汇页双向手动掌握用例。两种学习模式对“已掌握”的调度含义不同：
 * 词书模式是退出该 Word 的后续任务，重新标记未掌握则重建短期周期；常规模式
 * 仍保留 FSRS 排期，重新标记未掌握时向卡片提交一次 Again。所有写入通过
 * 不可变事件表达，保证本地重放与云端同步后得到相同的掌握状态。
 */

import { FsrsRegularScheduler, MasteryStatus } from "@ebbinghaus/domain";
import type { LearningEventRecorder } from "./eventRecorder.ts";
import type {
  BookCatalogStore, Clock, FsrsCardStore, LearningEventStore, SpaceStore,
  UnitOfWork, WordContentStore,
} from "./ports.ts";
import type { SettingsService } from "./settingsFacade.ts";
import { replayWordStates } from "./scheduling.ts";

export interface VocabularyMasteryDeps {
  readonly clock: Clock;
  readonly recorder: LearningEventRecorder;
  readonly eventStore: LearningEventStore;
  readonly wordContentStore: WordContentStore;
  readonly bookCatalogStore: BookCatalogStore;
  readonly spaceStore: SpaceStore;
  readonly fsrsCardStore: FsrsCardStore;
  readonly settings: SettingsService;
  readonly scheduler: FsrsRegularScheduler;
  readonly unitOfWork: UnitOfWork;
}

export class VocabularyMasteryService {
  constructor(private readonly deps: VocabularyMasteryDeps) {}

  /** 卡片与详情共用这一入口；重复提交同一状态视为误操作并明确拒绝。 */
  mark(input: { readonly spaceId: string; readonly wordId: string; readonly mastered: boolean }): void {
    const space = this.deps.spaceStore.getSpace(input.spaceId);
    const content = this.deps.wordContentStore.getEntry(input.wordId);
    if (space === null || content === null || content.removed) throw new Error("词条不存在");
    if (content.listId === null) {
      if (content.spaceId !== input.spaceId || space.learningMode !== "常规模式") {
        throw new Error("条目不属于当前常规模式 Space");
      }
    } else {
      const list = this.deps.bookCatalogStore.getList(content.listId);
      if (list?.spaceId !== input.spaceId || space.learningMode !== "词书模式") {
        throw new Error("Word 不属于当前词书模式 Space");
      }
    }

    const state = replayWordStates({
      eventStore: this.deps.eventStore,
      wordContentStore: this.deps.wordContentStore,
    }).get(input.wordId);
    // 移除事件先于内容通道到达时，旧卡片上的操作同样无效，不能借手动标记复活词。
    if (state?.removed === true) throw new Error("词条不存在");
    const previousStatus = state?.masteryStatus ?? MasteryStatus.Unmastered;
    const nextStatus = input.mastered ? MasteryStatus.Mastered : MasteryStatus.Unmastered;
    if (previousStatus === nextStatus) {
      throw new Error(input.mastered ? "该词条已经标记为已掌握" : "该词条已经标记为未掌握");
    }
    const now = this.deps.clock.now();
    const metadata: Record<string, unknown> = {
      wordId: input.wordId,
      feedback: input.mastered ? "标记为已掌握" : "不认识",
      previousMasteryStatus: previousStatus,
      nextMasteryStatus: nextStatus,
    };
    let updatedCard: ReturnType<FsrsCardStore["get"]> = null;

    if (content.listId !== null) {
      if (input.mastered) {
        const states = replayWordStates({ eventStore: this.deps.eventStore, wordContentStore: this.deps.wordContentStore });
        // V1 的 List 聚合规则：最后一个活动 Word 被手动标记时，整组进入掌握终态。
        const allMastered = this.deps.wordContentStore.listEntriesForList(content.listId)
          .every((entry) => entry.wordId === input.wordId || states.get(entry.wordId)?.masteryStatus === MasteryStatus.Mastered);
        metadata["hardMastery"] = true;
        metadata["listMastered"] = allMastered;
      } else {
        metadata["newShortTermCycleAt"] = now.toISOString();
      }
    } else {
      metadata["beforeState"] = { masteryStatus: previousStatus };
      if (input.mastered) {
        // V1 常规模式手动掌握不改卡片，到期测试仍照常进行。
        metadata["afterState"] = { masteryStatus: nextStatus };
      } else {
        const card = this.deps.fsrsCardStore.get(input.wordId);
        if (card === null) throw new Error("条目缺少 FSRS 卡片");
        const outcome = this.deps.scheduler.review({
          cardJson: card.cardJson,
          recognized: false,
          reviewedAt: now.toISOString(),
          desiredRetention: this.deps.settings.getSpaceLearningSettings(input.spaceId).fsrsParameters.desiredRetention,
        });
        metadata["beforeState"] = { dueAt: card.dueAt, masteryStatus: previousStatus };
        metadata["afterState"] = { dueAt: outcome.dueAt, masteryStatus: nextStatus, feedback: "不认识" };
        metadata["algorithmVersion"] = this.deps.scheduler.algorithmVersion;
        updatedCard = {
          ...card,
          cardJson: outcome.afterCardJson,
          dueAt: outcome.dueAt,
          schedulerJson: outcome.schedulerJson,
          algorithmVersion: this.deps.scheduler.algorithmVersion,
          libraryVersion: this.deps.scheduler.libraryVersion,
          updatedAt: now.toISOString(),
          cardState: outcome.cardState,
          lastFinalJudgement: "不认识",
        };
      }
    }

    const event = this.deps.recorder.record({
      eventType: input.mastered ? "wordManuallyMarkedMastered" : "wordManuallyMarkedUnmastered",
      targetType: content.listId === null ? "条目" : "Word",
      targetId: input.wordId,
      source: "词汇页手动掌握标记",
      occurredAt: now,
      metadata,
    });
    this.deps.unitOfWork.run(() => {
      this.deps.eventStore.appendEvents([event]);
      if (updatedCard !== null) this.deps.fsrsCardStore.upsert(updatedCard);
    });
  }
}
