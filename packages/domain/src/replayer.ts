/**
 * 学习事件重放器：从不可变事件序列确定性重放出 List/Word/条目/Space 派生状态。
 *
 * 这是 V2 的事件溯源核心（V1 直接写库，派生状态与事件共存于数据库；V2 要求派生
 * 状态可随时从同一事件集重建，且两台设备重放同一事件集必须得到完全一致的结果）。
 *
 * 排序规则：必须使用 `@ebbinghaus/protocol` 的 `sortEventsForReplay`
 * （occurredAt → deviceSeq → deviceId → eventId），禁止自建排序；serverSeq 是同步
 * 游标，绝不参与领域重放。
 *
 * 派生口径与已知协议边界（如实记录，不伪造数据）：
 * - 逐词测试事件族（testAnswered / answerRevised / shortTermPassCountChanged /
 *   longTermValidationCompleted / wordMastered）共享同一 metadata 形态，其中的
 *   afterState 快照（短期通过次数、掌握状态、T0/T1/T2、常规模式 dueAt/间隔）是
 *   权威派生输入，重放器校验值域后采用；
 * - `firstPassRecorded` 事件只携带词数与草稿标识，不携带词内容——词身份（拼写、
 *   规范键、List/Space 归属）由调用方通过 wordCatalog 内容登记表提供（V2 中词
 *   内容属于本地内容表，事件只承载学习事实）。首过确认时刻即为该批词的 T0；
 * - `wordAdded` 携带 targetId 与 normalizedKey，重放器可据此创建词身份；新增词
 *   以事件发生时刻进入短期通过次数 0（复习调度算法 5.2 第 1 条）；
 * - 手动掌握反馈沿用 V1 的状态转换：词书模式已掌握退出调度、重置未掌握重新开始
 *   短期周期；常规模式手动不认识保留 FSRS Again 的到期时间。
 * - `taskDeferred` 在协议层尚未固化字段、`testSessionPaused/Resumed` 属于会话
 *   执行状态属于会话事实；历史 `dictionaryFetched/FetchFailed` 属于已停用的
 *   词典查询记录——均不产生调度派生状态，重放时忽略；
 * - `reviewOnlyCompleted` / `testFollowedByReviewCompleted` 自 2026-10-02 起停止
 *   产生（复习页改为纯浏览入口，不再有复习确认触发点），重放器仅保留对历史已
 *   持久化事件的兼容识别；List 返回短期同步改由测试答案 afterState 派生：长期
 *   验证失败把词重置为短期通过次数 0，重放器据此把仍处于长期验证阶段的 List
 *   退回短期同步（规格 7.3），V1 迁移数据里答案事件与旧完成事件同现不会冲突；
 * - 常规模式条目的完整 FSRS 卡片快照（稳定性/难度）不在事件 metadata 中，重放
 *   只派生事件实际承载的到期时间、掌握状态与累计认识次数。
 *
 * 算法版本常量与重放结果结构一并导出：结果持久化时必须带上版本号，算法升级只
 * 影响未来重放，不得改写既有持久化结果。
 */

import {
  sortEventsForReplay,
  type ReplayableEvent,
} from "@ebbinghaus/protocol";
import { MasteryStatus, ShortTermPassCount as ShortTermPassCountValues, TestJudgement, WordListStage, isShortTermPassCount, isMasteryStatus, type ShortTermPassCount, type MasteryStatus as MasteryStatusType, type WordListStage as WordListStageType } from "./enums.ts";
import {
  createSchedulableList,
  createSchedulableWord,
  type SchedulableList,
  type SchedulableWordSource,
} from "./scheduling.ts";
import { resolveLearningDay, type LearningDay, type LearningDaySettings } from "./learningDay.ts";

/**
 * 重放器消费的事件结构最小视图。
 *
 * 类型说明：protocol 的 `learningEventSchema` 成员经由工厂函数构造，其返回类型
 * 是裸 `z.ZodObject`，导致导出的 `LearningEvent`/`StoredLearningEvent` TS 类型
 * 退化为带索引签名的记录（运行时校验仍是精确的 strictObject/looseObject）。领域
 * 层不改协议（职责归属 protocol），因此重放器声明结构最小视图：信封字段由
 * protocol 的 `ReplayableEvent`（排序四键）+ 事件类型与目标字段构成，metadata
 * 保持 unknown 并在域内逐字段做值域校验（fail fast）。运行时输入必须先经过
 * protocol schema 校验，类型收窄只弥补编译期信息，不放松运行时约束。
 */
export interface ReplayableLearningEvent extends ReplayableEvent {
  readonly eventType: string;
  readonly targetType: string;
  readonly targetId: string;
  /** 事件所属学习日标签（重放排序不使用它，仅作为信封字段保留）。 */
  readonly learningDay: string;
  /** 事件来源的稳定人类可读描述（信封字段，重放不消费）。 */
  readonly source: string;
  readonly metadata: unknown;
}

/** 重放器算法版本；随重放结果持久化。 */
export const REPLAYER_ALGORITHM_VERSION = "replayer-v1";

/** 词身份登记表条目：首过词内容（拼写、规范键、归属）的调用方输入。 */
export interface WordCatalogEntry {
  readonly wordId: string;
  /** 词书模式词所属 List；常规模式条目为 null。 */
  readonly listId: string | null;
  /** 常规模式条目所属 Space；词书模式可为 null（由 List 层级间接归属）。 */
  readonly spaceId: string | null;
  readonly originalSpelling: string;
  readonly normalizedKey: string;
  /** 当前内容的软移除事实；可省略以兼容只依据事件重放的调用方。 */
  readonly removed?: boolean;
}

export interface ReplayInput {
  /** protocol 已校验的事件序列；内部按领域重放排序，无需调用方预先排序。 */
  readonly events: readonly ReplayableLearningEvent[];
  /** 词内容登记表（见模块头说明）；词书模式首过词必须在此登记才有内容归属。 */
  readonly wordCatalog?: readonly WordCatalogEntry[];
}

/** 重放后的 Word/条目派生状态。 */
export interface ReplayedWordState {
  readonly wordId: string;
  readonly listId: string | null;
  readonly spaceId: string | null;
  readonly originalSpelling: string;
  readonly normalizedKey: string;
  /** 软移除标记：词条立即从查询中隐藏，历史与审计保留。 */
  readonly removed: boolean;
  readonly shortTermPassCount: ShortTermPassCount;
  readonly masteryStatus: MasteryStatusType;
  readonly t0: string | null;
  readonly t1: string | null;
  readonly t2: string | null;
  /** 常规模式：最近一次 afterState 的 FSRS 到期时间。 */
  readonly regularDueAt: string | null;
  /** 常规模式：最近一次 afterState 的下一次复习间隔天数。 */
  readonly regularNextIntervalDays: number | null;
  /** 最近一次最终判断（仅 testAnswered 写入；改判事件不覆盖历史判断）。 */
  readonly lastJudgement: TestJudgement | null;
  /** 累计认识次数：每次 testAnswered 最终判断为认识加一，不认识不清零。 */
  readonly cumulativeRecognizedCount: number;
}

/** 重放后的 List 派生状态。 */
export interface ReplayedWordListState {
  readonly listId: string;
  readonly stage: WordListStageType;
  readonly firstPassedAt: string | null;
  readonly synchronizedAt: string | null;
  readonly additionsLocked: boolean;
  readonly aggregateStatus: MasteryStatusType;
  readonly wordIds: readonly string[];
}

/** 重放后的 Space 视图：按 Space 聚合的 List 与常规模式条目。 */
export interface ReplayedSpaceState {
  readonly spaceId: string;
  readonly listIds: readonly string[];
  /** 常规模式条目（无 List 归属的词）。 */
  readonly entryIds: readonly string[];
}

/** 一次重放的完整确定性输出。 */
export interface ReplayResult {
  readonly algorithmVersion: string;
  readonly lists: ReadonlyMap<string, ReplayedWordListState>;
  readonly words: ReadonlyMap<string, ReplayedWordState>;
  readonly spaces: ReadonlyMap<string, ReplayedSpaceState>;
}

/** 重放过程中的可变累积状态（输出前冻结为只读结构）。 */
interface MutableWordState {
  listId: string | null;
  spaceId: string | null;
  originalSpelling: string;
  normalizedKey: string;
  removed: boolean;
  shortTermPassCount: ShortTermPassCount;
  masteryStatus: MasteryStatusType;
  t0: string | null;
  t1: string | null;
  t2: string | null;
  regularDueAt: string | null;
  regularNextIntervalDays: number | null;
  lastJudgement: TestJudgement | null;
  cumulativeRecognizedCount: number;
}

interface MutableListState {
  stage: WordListStageType;
  firstPassedAt: string | null;
  synchronizedAt: string | null;
  additionsLocked: boolean;
  aggregateStatus: MasteryStatusType;
  wordIds: Set<string>;
}

/** 判断 targetId 与 targetType 是否指向 List（词书模式首过的目标）。 */
function isListTarget(event: ReplayableLearningEvent): boolean {
  return event.targetType === "List";
}

/** 从五类逐词测试事件的 metadata 提取 afterState（protocol 保证形态，域内校验值域）。 */
function extractAfterState(metadata: Record<string, unknown>): Record<string, unknown> {
  const afterState = metadata["afterState"];
  if (typeof afterState !== "object" || afterState === null || Array.isArray(afterState)) {
    throw new Error("逐词测试事件缺少可用的 afterState 快照，无法重放");
  }
  return afterState as Record<string, unknown>;
}

/** metadata 的宽松对象视图（协议 looseObject 校验已保证是 JSON 对象）。 */
function metadataView(event: ReplayableLearningEvent): Record<string, unknown> {
  const metadata = event.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error(`事件 ${event.eventId} 的 metadata 必须是 JSON 对象`);
  }
  return metadata as Record<string, unknown>;
}

/**
 * 重放学习事件序列。
 *
 * 输入必须已经过 `@ebbinghaus/protocol` 的 `learningEventSchema`（或
 * storedLearningEventSchema）校验；重放器对值域做二次防御校验，任何不合法状态
 * 立即抛错（fail fast），绝不静默采用脏数据。
 */
export function replayLearningEvents(input: ReplayInput): ReplayResult {
  const words = new Map<string, MutableWordState>();
  const lists = new Map<string, MutableListState>();
  // 内容与事件分通道同步，目录墓碑没有可用于历史排序的发生时刻。独立记录排除事实，
  // 聚合检查可据此忽略已移除词，但旧学习事件仍完整重放，最后才合并到当前输出。
  const catalogRemovedWordIds = new Set<string>();

  const ensureWord = (wordId: string): MutableWordState => {
    const existing = words.get(wordId);
    if (existing !== undefined) {
      return existing;
    }
    const created: MutableWordState = {
      listId: null,
      spaceId: null,
      originalSpelling: "",
      normalizedKey: wordId,
      removed: false,
      shortTermPassCount: 0,
      masteryStatus: MasteryStatus.Unmastered,
      t0: null,
      t1: null,
      t2: null,
      regularDueAt: null,
      regularNextIntervalDays: null,
      lastJudgement: null,
      cumulativeRecognizedCount: 0,
    };
    words.set(wordId, created);
    return created;
  };

  const ensureList = (listId: string): MutableListState => {
    const existing = lists.get(listId);
    if (existing !== undefined) {
      return existing;
    }
    const created: MutableListState = {
      stage: WordListStage.ShortTermSync,
      firstPassedAt: null,
      synchronizedAt: null,
      additionsLocked: false,
      aggregateStatus: MasteryStatus.Unmastered,
      wordIds: new Set(),
    };
    lists.set(listId, created);
    return created;
  };

  // 词内容登记表先行落位：目录是词身份的权威来源（见模块头协议边界说明）。
  if (input.wordCatalog !== undefined) {
    for (const entry of input.wordCatalog) {
      if (entry.removed === true) catalogRemovedWordIds.add(entry.wordId);
      const word = ensureWord(entry.wordId);
      word.listId = entry.listId;
      word.spaceId = entry.spaceId;
      word.originalSpelling = entry.originalSpelling;
      word.normalizedKey = entry.normalizedKey;
      if (entry.listId !== null) {
        ensureList(entry.listId).wordIds.add(entry.wordId);
      }
    }
  }

  const getRequiredMetadataString = (metadata: Record<string, unknown>, key: string, eventDescription: string): string => {
    const value = metadata[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${eventDescription} 缺少有效 metadata.${key}`);
    }
    return value;
  };

  for (const event of sortEventsForReplay(input.events)) {
    const metadata = metadataView(event);
    switch (event.eventType) {
      case "firstPassRecorded": {
        // 词书模式目标 List；常规模式目标条目（targetId 即条目标识）。
        if (isListTarget(event)) {
          const list = ensureList(event.targetId);
          if (list.firstPassedAt === null) {
            list.firstPassedAt = event.occurredAt;
          }
          // 新协议携带本次确认的 Word 标识，避免最终内容目录提前登记了后续补录词时，
          // 旧首过事件错误地把这些词的 T0 回填到最初日期。V1 历史事件没有该字段，
          // 为保持原语义才退回完整 List 登记集合。
          const recordedIds = Array.isArray(metadata["wordIds"])
            ? metadata["wordIds"].filter((id): id is string => typeof id === "string")
            : [...list.wordIds];
          for (const wordId of recordedIds) {
            const word = ensureWord(wordId);
            if (word.t0 === null) {
              word.shortTermPassCount = 0;
              word.t0 = event.occurredAt;
              word.masteryStatus = MasteryStatus.Unmastered;
            }
          }
        } else {
          const word = ensureWord(event.targetId);
          if (word.t0 === null) {
            word.shortTermPassCount = 0;
            word.t0 = event.occurredAt;
          }
        }
        break;
      }
      case "wordAdded": {
        const listId = getRequiredMetadataString(metadata, "listId", `wordAdded 事件 ${event.eventId}`);
        const normalizedKey = getRequiredMetadataString(metadata, "normalizedKey", `wordAdded 事件 ${event.eventId}`);
        const word = ensureWord(event.targetId);
        word.listId = listId;
        word.normalizedKey = normalizedKey;
        // 同一 Word 的移除不可撤销；重新录入必须使用新标识，旧新增事件不能复活旧词。
        ensureList(listId).wordIds.add(event.targetId);
        // 新增词以事件发生时刻进入短期通过次数 0（复习调度算法 5.2 第 1 条）。
        if (word.t0 === null) {
          word.shortTermPassCount = 0;
          word.t0 = event.occurredAt;
        }
        break;
      }
      case "wordRemoved": {
        const word = ensureWord(event.targetId);
        word.removed = true;
        // Space 级删除路径（常规模式冲突处理）携带 spaceId，可补全归属视图。
        const removedSpaceId = metadata["spaceId"];
        if (word.spaceId === null && typeof removedSpaceId === "string") {
          word.spaceId = removedSpaceId;
        }
        break;
      }
      case "wordContentUpdated": {
        const word = ensureWord(event.targetId);
        // 修改内容保持同一对象与学习历史；当前协议只承载规范键。
        word.normalizedKey = getRequiredMetadataString(metadata, "normalizedKey", `wordContentUpdated 事件 ${event.eventId}`);
        break;
      }
      case "wordManuallyMarkedMastered":
      case "wordManuallyMarkedUnmastered": {
        const word = ensureWord(event.targetId);
        const markedMastered = event.eventType === "wordManuallyMarkedMastered";
        word.masteryStatus = markedMastered ? MasteryStatus.Mastered : MasteryStatus.Unmastered;
        // 常规模式的手动“不认识”是真实 FSRS Again；V1 会更新卡片与到期日，
        // 事件中携带的 afterState 是跨设备重放的唯一到期时间来源。
        const afterState = metadata["afterState"];
        if (typeof afterState === "object" && afterState !== null && !Array.isArray(afterState)) {
          const dueAt = (afterState as Record<string, unknown>)["dueAt"];
          if (typeof dueAt === "string") word.regularDueAt = dueAt;
        }
        if (word.listId !== null) {
          const list = ensureList(word.listId);
          if (markedMastered) {
            const allMastered = [...list.wordIds].every((id) => {
              const candidate = words.get(id);
              return catalogRemovedWordIds.has(id) || candidate?.removed === true
                || candidate?.masteryStatus === MasteryStatus.Mastered;
            });
            list.aggregateStatus = allMastered ? MasteryStatus.Mastered : MasteryStatus.Unmastered;
            if (allMastered) list.stage = WordListStage.Mastered;
            list.additionsLocked = true;
          } else {
            const cycleAt = metadata["newShortTermCycleAt"];
            word.shortTermPassCount = 0;
            word.t0 = typeof cycleAt === "string" ? cycleAt : event.occurredAt;
            word.t1 = null;
            word.t2 = null;
            list.stage = WordListStage.ShortTermSync;
            list.aggregateStatus = MasteryStatus.Unmastered;
            list.additionsLocked = true;
          }
        }
        break;
      }
      case "testAnswered":
      case "answerRevised":
      case "shortTermPassCountChanged":
      case "longTermValidationCompleted":
      case "wordMastered": {
        const word = ensureWord(event.targetId);
        const afterState = extractAfterState(metadata);
        const nextPassCount = afterState["shortTermPassCount"];
        if (nextPassCount !== undefined) {
          if (!isShortTermPassCount(nextPassCount)) {
            throw new Error(`事件 ${event.eventId} 的 afterState.shortTermPassCount 必须为 0、1 或 2`);
          }
          word.shortTermPassCount = nextPassCount;
        }
        const nextMasteryStatus = afterState["masteryStatus"];
        if (nextMasteryStatus !== undefined) {
          if (!isMasteryStatus(nextMasteryStatus)) {
            throw new Error(`事件 ${event.eventId} 的 afterState.masteryStatus 必须为"未掌握"或"已掌握"`);
          }
          word.masteryStatus = nextMasteryStatus;
        }
        // 周期起点快照整体覆盖（null 是"无此起点"的合法值，例如等待校验失败后 T0 缺失）。
        if (afterState["t0"] !== undefined) {
          const value = afterState["t0"];
          word.t0 = typeof value === "string" ? value : null;
        }
        if (afterState["t1"] !== undefined) {
          const value = afterState["t1"];
          word.t1 = typeof value === "string" ? value : null;
        }
        if (afterState["t2"] !== undefined) {
          const value = afterState["t2"];
          word.t2 = typeof value === "string" ? value : null;
        }
        // 常规模式 FSRS 口径派生字段。
        if (afterState["dueAt"] !== undefined) {
          const value = afterState["dueAt"];
          word.regularDueAt = typeof value === "string" ? value : null;
        }
        if (afterState["nextIntervalDays"] !== undefined) {
          const value = afterState["nextIntervalDays"];
          word.regularNextIntervalDays =
            typeof value === "number" ? value : null;
        }
        const finalJudgement = metadata["finalJudgement"];
        if (typeof finalJudgement === "string" && event.eventType === "testAnswered") {
          // 只有最终确认事件推进最近判断与累计认识次数；改判审计事件共享同一
          // metadata，重复应用会导致计数翻倍，必须排除。
          word.lastJudgement =
            finalJudgement === TestJudgement.Recognized
              ? TestJudgement.Recognized
              : TestJudgement.NotRecognized;
          if (word.lastJudgement === TestJudgement.Recognized) {
            word.cumulativeRecognizedCount += 1;
          }
        }
        // 长期验证失败的答案派生 List 阶段回退：验证把词重置为短期通过次数 0，
        // List 若仍处长期验证阶段即返回短期同步（规格 7.3，2026-10-02 答案驱动口径；
        // 不再有复习确认事件承担该职责）。同步时建立的新增锁永久保留，不回退。
        if (
          word.listId !== null &&
          word.masteryStatus === MasteryStatus.Unmastered &&
          word.shortTermPassCount !== ShortTermPassCountValues.Two
        ) {
          const list = lists.get(word.listId);
          if (list?.stage === WordListStage.LongTermValidation) {
            list.stage = WordListStage.ShortTermSync;
          }
        }
        break;
      }
      case "listSynchronized": {
        const list = ensureList(event.targetId);
        list.stage = WordListStage.LongTermValidation;
        // 2026-10-02 口径：同步事件随答案逐轮写入（含长期验证失败后重新同步的
        // 第二轮），长期验证日期 = 本轮 TS + 7 个自然日（规格 7.2），因此取
        // **末次**同步事件时刻，不得用首次守卫——否则重新同步的 List 会沿用
        // 上一轮 TS 计算长期验证日期。跨端并发各写一个同步事件时，重放序
        // （occurredAt → deviceSeq → deviceId）保证各端取到同一末次值。
        list.synchronizedAt = event.occurredAt;
        // List 的新增 Word 功能永久上锁；后续长期验证结果不得解除该锁（规格 7.1）。
        list.additionsLocked = true;
        break;
      }
      case "listMastered": {
        const list = ensureList(event.targetId);
        list.aggregateStatus = MasteryStatus.Mastered;
        list.stage = WordListStage.Mastered;
        list.additionsLocked = true;
        break;
      }
      case "reviewOnlyCompleted":
      case "testFollowedByReviewCompleted": {
        // 2026-10-02 起停止产生（复习入口改为纯浏览视图，无复习确认触发点）；仅保留
        // 对历史已持久化事件的兼容识别，避免重放 V1 迁移数据时抛"未知事件类型"。
        // V1 历史中"长期验证后确认纸质复习"事件曾把 List 退回短期同步；该职责现由
        // 测试答案 afterState 派生（见上方 testAnswered 族分支），此处不再消费
        // reviewDemandKeys——仅复习不存在"完成"概念，词状态一律以答案事件为准。
        break;
      }
      case "taskDeferred":
      case "testSessionPaused":
      case "testSessionResumed":
      case "dictionaryFetched":
      case "dictionaryFetchFailed":
        // 不产生调度派生状态（理由见模块头"已知协议边界"）。
        break;
      default: {
        // 协议枚举扩展时在此显式接入，禁止静默吞掉未知事件类型。
        throw new Error(`重放器尚未接入事件类型：${String(event.eventType)}`);
      }
    }
  }

  // 两通道任一明确移除均须排除；目录 false 不覆盖事件墓碑，目录 true 也不被历史
  // 首过、新增或答案复活。只合并 removed，不改变 T0/T1/T2、掌握或答案审计字段。
  for (const wordId of catalogRemovedWordIds) ensureWord(wordId).removed = true;

  // 冻结输出：派生状态一经产出不可被调用方原地改写。
  const frozenWords = new Map<string, ReplayedWordState>();
  for (const [wordId, word] of words) {
    frozenWords.set(wordId, Object.freeze({ ...word, wordId }));
  }
  const frozenLists = new Map<string, ReplayedWordListState>();
  for (const [listId, list] of lists) {
    frozenLists.set(
      listId,
      Object.freeze({
        ...list,
        listId,
        wordIds: Object.freeze([...list.wordIds].sort()),
      }),
    );
  }
  const frozenSpaces = new Map<string, ReplayedSpaceState>();
  const spaceAccumulator = new Map<string, { listIds: Set<string>; entryIds: Set<string> }>();
  const spaceOf = (spaceId: string): { listIds: Set<string>; entryIds: Set<string> } => {
    const existing = spaceAccumulator.get(spaceId);
    if (existing !== undefined) {
      return existing;
    }
    const created = { listIds: new Set<string>(), entryIds: new Set<string>() };
    spaceAccumulator.set(spaceId, created);
    return created;
  };
  for (const word of frozenWords.values()) {
    if (word.spaceId === null) {
      continue;
    }
    const space = spaceOf(word.spaceId);
    if (word.listId === null) {
      space.entryIds.add(word.wordId);
    } else {
      space.listIds.add(word.listId);
    }
  }
  for (const [spaceId, accumulator] of spaceAccumulator) {
    frozenSpaces.set(
      spaceId,
      Object.freeze({
        spaceId,
        listIds: Object.freeze([...accumulator.listIds].sort()),
        entryIds: Object.freeze([...accumulator.entryIds].sort()),
      }),
    );
  }
  return {
    algorithmVersion: REPLAYER_ALGORITHM_VERSION,
    lists: frozenLists,
    words: frozenWords,
    spaces: frozenSpaces,
  };
}

/**
 * 把重放结果投影为调度器输入的 List 快照集合，供统一调度任务生成使用。
 *
 * 学习日锚点由 settings（用户时区 + 换日时间）从绝对时间投影得到；软移除词不
 * 参与调度；已掌握 List 退出常规调度，直接跳过。派生状态在重放时已通过值域与
 * 不变量校验，此处锚点缺失只可能来自内容目录缺漏，按明确错误暴露。
 */
export function schedulableListsFromReplay(
  result: ReplayResult,
  settings: LearningDaySettings,
): SchedulableList[] {
  const toDay = (iso: string | null): LearningDay | null => {
    if (iso === null) {
      return null;
    }
    return resolveLearningDay(new Date(iso), settings);
  };
  const snapshots: SchedulableList[] = [];
  for (const list of result.lists.values()) {
    if (list.stage === WordListStage.Mastered) {
      continue;
    }
    const schedulableWords = list.wordIds
      .map((wordId) => result.words.get(wordId))
      .filter((word): word is ReplayedWordState => word !== undefined && !word.removed)
      .map((word): SchedulableWordSource => ({
        id: word.wordId,
        shortTermPassCount: word.shortTermPassCount,
        masteryStatus: word.masteryStatus,
        shortTermCycleStartedAt: word.t0,
        shortTermOneStartedAt: word.t1,
        waitingCheckStartedAt: word.t2,
      }))
      .map((word) => {
        if (word.masteryStatus === MasteryStatus.Unmastered) {
          return createSchedulableWord({
            word,
            t0Day: toDay(word.shortTermCycleStartedAt),
            t1Day: toDay(word.shortTermOneStartedAt),
            t2Day: toDay(word.waitingCheckStartedAt),
          });
        }
        return createSchedulableWord({ word });
      });
    snapshots.push(
      createSchedulableList({
        listId: list.listId,
        stage: list.stage,
        words: schedulableWords,
        synchronizedDay: toDay(list.synchronizedAt),
      }),
    );
  }
  return snapshots.sort((a, b) => (a.listId < b.listId ? -1 : a.listId > b.listId ? 1 : 0));
}
