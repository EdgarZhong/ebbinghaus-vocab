/**
 * 词书模式调度用例：从不可变事件重放派生当前 Space 的计划任务与调度投影
 * （移植 V1 application/scheduling.py，按 V2 事件溯源架构重设计）。
 *
 * 与 V1 的关键差异（如实记录）：
 * - V1 在数据库中持久化 PlannedTask 行并靠仓储 upsert 幂等；V2 的任务是**派生状态**
 *   （AGENTS.md：任务不同步，由各终端从同一事件集确定性重放），本用例每次从事件
 *   重放即时派生，不落库。稳定任务标识由 `deriveListTaskId` 按输入派生，保证同一
 *   (算法版本, List, 任务类型, 计划日) 跨刷新、跨重启引用一致——V1 靠 uuid5 幂等
 *   upsert 达成的效果在 V2 由纯派生等价实现。
 * - 逾期语义保持 V1：逾期不生成虚拟补做任务，计划日保持不变并据此计算逾期天数
 *   （domain/generateListTask 已固化），本用例原样透出。
 * - V1 的"开放会话保护"规则（进行中的会话保留其开始时的任务形态）在 V2 由会话
 *   快照承载：会话开始时快照条目顺序，任务引用保存在 TestSessionRecord.taskId；
 *   测试页在会话打开期间展示会话绑定的任务而非重派生形态（见 TestSessionStore
 *   端口注释，完整词书测试会话流程在后续阶段接线）。
 */

import {
  generateListTask,
  resolveLearningDay,
  schedulableListsFromReplay,
  replayLearningEvents,
  type LearningDay,
  type LearningDaySettings,
  type ListTask,
  type ReplayedWordState,
  type SchedulableList,
} from "@ebbinghaus/domain";
import type {
  BookCatalogStore,
  Clock,
  LearningEventStore,
  WordContentStore,
} from "./ports.ts";
import { deriveListTaskId } from "./eventRecorder.ts";

/** 派生任务的需求明细（与 domain DueDemand 对齐的 JSON 安全形态）。 */
export interface TaskDemandPayload {
  readonly wordId: string;
  readonly taskType: string;
  readonly scheduledDay: LearningDay;
  readonly reason: string;
}

/** 派生任务的结构化解释负载（对应 V1 payload_json，持久化审计时原样序列化）。 */
export interface ListTaskPayload {
  readonly workload: number;
  readonly overdueDays: number;
  readonly activeWordIds: readonly string[];
  readonly testDemands: readonly TaskDemandPayload[];
}

/** 界面与容量模型共同使用的唯一 List 粒度派生任务。 */
export interface PersistedListTask {
  readonly taskId: string;
  readonly listId: string;
  readonly taskType: string;
  readonly scheduledDay: LearningDay;
  readonly workload: number;
  readonly overdueDays: number;
  /** 到期原因的稳定拼接（V1 口径："；"连接去重后的原因集合）。 */
  readonly dueReason: string;
  readonly algorithmVersion: string;
  readonly payload: ListTaskPayload;
}

/** 一次任务刷新的输出：学习日 + 当日可见的派生任务集合。 */
export interface SpaceTaskRefreshResult {
  readonly learningDay: LearningDay;
  readonly tasks: readonly PersistedListTask[];
}

export interface SchedulingServiceDeps {
  readonly clock: Clock;
  readonly eventStore: LearningEventStore;
  readonly wordContentStore: WordContentStore;
  readonly bookCatalogStore: BookCatalogStore;
}

export class SchedulingService {
  private readonly deps: SchedulingServiceDeps;

  constructor(deps: SchedulingServiceDeps) {
    this.deps = deps;
  }

  /**
   * 以真实状态幂等重建当前 Space 的开放计划任务，并返回今天实际可见的派生快照。
   * 任务按（计划日, 任务标识）稳定排序；当天没有任何到期需求的 List 不产生任务。
   */
  refreshSpaceTasks(input: {
    readonly spaceId: string;
    readonly learningDaySettings: LearningDaySettings;
  }): SpaceTaskRefreshResult {
    const today = resolveLearningDay(this.deps.clock.now(), input.learningDaySettings);
    const tasks: PersistedListTask[] = [];
    for (const snapshot of this.projectSpaceLists({
      spaceId: input.spaceId,
      learningDaySettings: input.learningDaySettings,
    })) {
      const task = generateListTask(snapshot, today);
      if (task === null) {
        continue;
      }
      tasks.push(toPersistedListTask(task));
    }
    tasks.sort((a, b) =>
      a.scheduledDay !== b.scheduledDay
        ? a.scheduledDay < b.scheduledDay
          ? -1
          : 1
        : a.taskId < b.taskId
          ? -1
          : a.taskId > b.taskId
            ? 1
            : 0,
    );
    return { learningDay: today, tasks };
  }

  /**
   * 只读投影当前 Space 的领域调度快照，供容量模型模拟未来压力。
   * 已掌握 List 退出投影（domain schedulableListsFromReplay 已处理），软移除词不参与。
   * 只属于该 Space 的 List 才进入投影：目录是空间归属的权威来源（词书词的 spaceId 为 null）。
   */
  projectSpaceLists(input: {
    readonly spaceId: string;
    readonly learningDaySettings: LearningDaySettings;
  }): SchedulableList[] {
    const catalogIds = new Set(
      this.deps.bookCatalogStore.listListsForSpace(input.spaceId).map((record) => record.listId),
    );
    const snapshots = schedulableListsFromReplay(
      replayLearningEvents({
        events: this.deps.eventStore.listAllEvents(),
        wordCatalog: this.deps.wordContentStore.listCatalogEntries().map((entry) => ({
          wordId: entry.wordId,
          listId: entry.listId,
          spaceId: entry.spaceId,
          originalSpelling: entry.originalSpelling,
          normalizedKey: entry.normalizedKey,
        })),
      }),
      input.learningDaySettings,
    );
    return snapshots.filter((snapshot) => catalogIds.has(snapshot.listId));
  }
}

/** 把领域任务转换为带稳定标识与解释负载的派生任务（V1 _to_planned_task 口径）。 */
function toPersistedListTask(task: ListTask): PersistedListTask {
  const taskId = deriveListTaskId({
    algorithmVersion: task.algorithmVersion,
    listId: task.listId,
    taskType: task.taskType,
    scheduledDay: task.scheduledDay,
  });
  const dueReasons = [...new Set(task.testDemands.map((demand) => demand.reason))];
  return {
    taskId,
    listId: task.listId,
    taskType: task.taskType,
    scheduledDay: task.scheduledDay,
    workload: task.workload,
    overdueDays: task.overdueDays,
    dueReason: dueReasons.join("；"),
    algorithmVersion: task.algorithmVersion,
    payload: {
      workload: task.workload,
      overdueDays: task.overdueDays,
      activeWordIds: [...task.activeWordIds],
      testDemands: task.testDemands.map((demand) => ({
        wordId: demand.wordId,
        taskType: demand.taskType,
        scheduledDay: demand.scheduledDay,
        reason: demand.reason,
      })),
    },
  };
}

/** 供容量与词书完成用例复用的重放词状态查询（跨模块共享的内部工具）。 */
export function replayWordStates(deps: {
  readonly eventStore: LearningEventStore;
  readonly wordContentStore: WordContentStore;
}): ReadonlyMap<string, ReplayedWordState> {
  const replay = replayLearningEvents({
    events: deps.eventStore.listAllEvents(),
    wordCatalog: deps.wordContentStore.listCatalogEntries().map((entry) => ({
      wordId: entry.wordId,
      listId: entry.listId,
      spaceId: entry.spaceId,
      originalSpelling: entry.originalSpelling,
      normalizedKey: entry.normalizedKey,
    })),
  });
  return replay.words;
}

/** 从重放词状态集合中筛选某 Space 的活动（未移除）状态，按稳定 Word 标识排序。 */
export function activeSpaceWordStates(
  words: ReadonlyMap<string, ReplayedWordState>,
  spaceId: string,
): ReplayedWordState[] {
  const collected: ReplayedWordState[] = [];
  for (const state of words.values()) {
    if (state.removed || state.spaceId !== spaceId) {
      continue;
    }
    collected.push(state);
  }
  collected.sort((a, b) => (a.wordId < b.wordId ? -1 : a.wordId > b.wordId ? 1 : 0));
  return collected;
}
