/**
 * 常规模式 FSRS 调度器（复习调度算法第 11 章，移植 V1 infrastructure/fsrs/scheduler.py
 * 的策略并下沉为纯领域计算）。
 *
 * 边界（规格第 11 章）：
 * - 常规模式只接收两档最终判断：认识映射 FSRS `Good`，不认识映射 `Again`；
 * - 禁用分钟级学习与重学步骤、关闭随机扰动，保证逐日确定排期；默认目标记忆保持率 0.95；
 * - 每个条目独立维护卡片状态、真实测试时间、算法版本与参数版本；测试组不参与状态读写；
 * - 卡片到期时间 `due_at` 与参数、库版本、算法版本随每次测试事件一并持久化，升级不得
 *   重算历史结果；
 * - 掌握标记是只读派生状态：下一次复习间隔 ≥ 100 天标记已掌握，可逆，不退出 FSRS 调度。
 *
 * 时间口径：卡片快照内的时刻一律序列化为 UTC ISO8601 字符串，保证 JSON 形态确定、
 * 可跨设备重放；输入绝对时间允许带任意数值时区偏移（语义为绝对时刻，与协议一致）。
 */

import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  FSRSVersion,
  Rating,
  State,
  type Card,
  type FSRSParameters,
  type Grade,
} from "ts-fsrs";
import { MasteryStatus, TestJudgement, type MasteryStatus as MasteryStatusType } from "./enums.ts";

/** FSRS 调度算法版本：库名 + 库版本 + 模式 + 策略版本；随每次测试结果持久化。 */
export const FSRS_ALGORITHM_VERSION = "fsrs-ts-5.4.2-regular-v1";
/** ts-fsrs 库版本（来自库自身常量），与算法版本一并落库供审计。 */
export const FSRS_LIBRARY_VERSION = FSRSVersion;

/** 常规模式默认目标记忆保持率；Space 可在 0.80–0.99 覆盖，仅常规模式生效。 */
export const DEFAULT_REGULAR_DESIRED_RETENTION = 0.95;

/** 软掌握阈值：FSRS 下一次间隔达到该自然天数时标记为可逆软掌握（规格 11.2）。 */
export const SOFT_MASTERY_INTERVAL_THRESHOLD_DAYS = 100;

/** 常规模式默认测试组大小（每组条目数）；实际取值按 Space 设置集中读取。 */
export const DEFAULT_REGULAR_GROUP_SIZE = 20;

/** ts-fsrs 卡片状态的可持久化文本名（含新卡；规格 11.2 只认 Learning/Review/Relearning）。 */
export const FSRS_STATE_NAMES: Readonly<Record<number, string>> = {
  [State.New]: "New",
  [State.Learning]: "Learning",
  [State.Review]: "Review",
  [State.Relearning]: "Relearning",
};

/** FSRS 卡片快照（JSON 安全形态；Card 中的 Date 全部转为 UTC ISO 字符串）。 */
export interface FsrsCardSnapshotJson {
  readonly due: string;
  readonly stability: number;
  readonly difficulty: number;
  readonly elapsedDays: number;
  readonly scheduledDays: number;
  readonly learningSteps: number;
  readonly reps: number;
  readonly lapses: number;
  readonly state: number;
  readonly lastReview: string | null;
}

/** 把 ts-fsrs Card 序列化为确定性 JSON 字符串（字段显式列出，日期转 UTC ISO）。 */
export function serializeCard(card: Card): string {
  const snapshot: FsrsCardSnapshotJson = {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review === undefined ? null : card.last_review.toISOString(),
  };
  return JSON.stringify(snapshot);
}

/** 把卡片快照 JSON 反序列化为 ts-fsrs Card；字段缺失或类型不符立即失败。 */
export function deserializeCard(cardJson: string): Card {
  const parsed: unknown = JSON.parse(cardJson);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("FSRS 卡片快照必须是 JSON 对象");
  }
  const snapshot = parsed as Record<string, unknown>;
  const requireIso = (key: string): Date => {
    const value = snapshot[key];
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw new Error(`FSRS 卡片快照字段 ${key} 必须是可解析的绝对时间`);
    }
    return new Date(value);
  };
  const requireNumber = (key: string): number => {
    const value = snapshot[key];
    if (typeof value !== "number") {
      throw new Error(`FSRS 卡片快照字段 ${key} 必须是数字`);
    }
    return value;
  };
  const lastReview = snapshot["lastReview"];
  return {
    due: requireIso("due"),
    stability: requireNumber("stability"),
    difficulty: requireNumber("difficulty"),
    elapsed_days: requireNumber("elapsedDays"),
    scheduled_days: requireNumber("scheduledDays"),
    learning_steps: requireNumber("learningSteps"),
    reps: requireNumber("reps"),
    lapses: requireNumber("lapses"),
    state: requireNumber("state"),
    last_review:
      typeof lastReview === "string" && lastReview.length > 0 ? new Date(lastReview) : undefined,
  };
}

/** 调度器参数快照（JSON 安全形态），随卡片首次落库与每次复习一并持久化。 */
export interface FsrsSchedulerSnapshotJson {
  readonly requestRetention: number;
  readonly maximumInterval: number;
  readonly weights: readonly number[];
  readonly enableFuzz: boolean;
  readonly enableShortTerm: boolean;
  readonly learningSteps: readonly string[];
  readonly relearningSteps: readonly string[];
}

/** 从 ts-fsrs 参数对象生成确定性参数快照。 */
export function serializeSchedulerParameters(parameters: FSRSParameters): string {
  const snapshot: FsrsSchedulerSnapshotJson = {
    requestRetention: parameters.request_retention,
    maximumInterval: parameters.maximum_interval,
    weights: [...parameters.w],
    enableFuzz: parameters.enable_fuzz,
    enableShortTerm: parameters.enable_short_term,
    learningSteps: [...parameters.learning_steps],
    relearningSteps: [...parameters.relearning_steps],
  };
  return JSON.stringify(snapshot);
}

/** 一次常规模式复习的可审计输出（与 V1 RegularFsrsReviewOutcome 字段一一对应）。 */
export interface RegularFsrsReviewOutcome {
  readonly beforeCardJson: string;
  readonly afterCardJson: string;
  readonly reviewLogJson: string;
  /** 复习后的卡片到期时间（UTC ISO8601）。 */
  readonly dueAt: string;
  /** 与本次复习一致的调度器参数快照。 */
  readonly schedulerJson: string;
  /** 复习后的卡片状态文本名。 */
  readonly cardState: string;
}

/**
 * 常规模式固定策略调度器：无分钟步骤、无随机扰动、按 Space 目标保持率调度。
 *
 * 类本身是纯计算封装：所有输入显式给出，不读取系统时间；同一保持率的 ts-fsrs
 * 实例按参数缓存复用，避免重复构造参数对象（与 V1 `_scheduler_for` 一致）。
 */
export class FsrsRegularScheduler {
  /** 算法与库版本属于调度器契约，调用方必须随每次结果持久化。 */
  public readonly algorithmVersion = FSRS_ALGORITHM_VERSION;
  public readonly libraryVersion = FSRS_LIBRARY_VERSION;

  private readonly schedulers = new Map<number, ReturnType<typeof fsrs>>();

  /**
   * 创建常规模式 FSRS 实例。
   *
   * `enableShortTerm: false` 使用库的 LongTermScheduler：新卡复习直接进入 Review
   * 状态并按 FSRS 间隔安排下一学习日或之后的到期，等价 V1 py-fsrs 空学习步骤策略
   * （已用库行为验证：新卡 Good 后 state=Review）。
   */
  private schedulerFor(desiredRetention: number): ReturnType<typeof fsrs> {
    const cached = this.schedulers.get(desiredRetention);
    if (cached !== undefined) {
      return cached;
    }
    const instance = fsrs(
      generatorParameters({
        request_retention: desiredRetention,
        enable_fuzz: false,
        enable_short_term: false,
        learning_steps: [],
        relearning_steps: [],
      }),
    );
    this.schedulers.set(desiredRetention, instance);
    return instance;
  }

  /** 创建新卡片快照；业务层另以学习日控制首次可测试日期（规格 11.7）。 */
  public newCardSnapshotJson(input: { createdAt: string }): string {
    return serializeCard(createEmptyCard(new Date(requireAbsoluteTime(input.createdAt, "新卡创建时间"))));
  }

  /** 返回与 review 一致的调度器参数快照，供新卡首次落库使用。 */
  public schedulerSnapshotJson(input: { desiredRetention: number }): string {
    return serializeSchedulerParameters(this.schedulerFor(input.desiredRetention).parameters);
  }

  /** 把产品仅有的两档反馈映射为 Good/Again 并返回可审计快照。 */
  public review(input: {
    cardJson: string;
    recognized: boolean;
    reviewedAt: string;
    desiredRetention: number;
  }): RegularFsrsReviewOutcome {
    const scheduler = this.schedulerFor(input.desiredRetention);
    const card = deserializeCard(input.cardJson);
    // 两档封闭映射：认识 → Good（3），不认识 → Again（1）；绝不引入 Hard/Easy。
    const rating: Grade = input.recognized ? Rating.Good : Rating.Again;
    const reviewed = scheduler.next(
      card,
      new Date(requireAbsoluteTime(input.reviewedAt, "复习时间")),
      rating,
    );
    return {
      beforeCardJson: input.cardJson,
      afterCardJson: serializeCard(reviewed.card),
      reviewLogJson: JSON.stringify({
        rating: reviewed.log.rating,
        state: reviewed.log.state,
        due: reviewed.log.due.toISOString(),
        stability: reviewed.log.stability,
        difficulty: reviewed.log.difficulty,
        elapsedDays: reviewed.log.elapsed_days,
        lastElapsedDays: reviewed.log.last_elapsed_days,
        scheduledDays: reviewed.log.scheduled_days,
        review: reviewed.log.review.toISOString(),
      }),
      dueAt: reviewed.card.due.toISOString(),
      schedulerJson: serializeSchedulerParameters(scheduler.parameters),
      cardState: FSRS_STATE_NAMES[reviewed.card.state] ?? "Review",
    };
  }

  /** 读取卡片快照中的绝对到期时间（UTC ISO），不依赖本机系统时间。 */
  public static cardDueAt(cardJson: string): string {
    return deserializeCard(cardJson).due.toISOString();
  }
}

/** 校验绝对时间输入并解析为 Date（领域内一切时刻经显式输入，不读系统时间）。 */
function requireAbsoluteTime(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName}必须是可解析的绝对时间，收到：${value}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 软掌握派生（规格 11.2，移植 V1 regular_learning.classify_regular_mastery 及其派生规则）
// ---------------------------------------------------------------------------

/** 根据 FSRS 下一次间隔判定常规模式可逆软掌握；只服务常规模式，词书模式不得复用。 */
export function classifyRegularMastery(nextIntervalDays: number): MasteryStatusType {
  if (nextIntervalDays >= SOFT_MASTERY_INTERVAL_THRESHOLD_DAYS) {
    return MasteryStatus.Mastered;
  }
  return MasteryStatus.Unmastered;
}

/** FSRS 到期时间与真实测试时间的自然日差（向零取整前的地板除，与 V1 timedelta.days 一致）。 */
export function nextIntervalDaysBetween(dueAt: string, answeredAt: string): number {
  const due = requireAbsoluteTime(dueAt, "到期时间").getTime();
  const answered = requireAbsoluteTime(answeredAt, "测试时间").getTime();
  return Math.floor((due - answered) / 86_400_000);
}

/**
 * 一次最终判断后的常规模式掌握状态与累计认识次数派生。
 *
 * 规则（规格 6.8/11.2 + V1 行为）：
 * - 认识：累计认识次数加一；间隔达到阈值标记已掌握，否则保持原状态（避免把
 *   刚巩固但尚未达到 100 天的条目错误降级）。
 * - 不认识：累计认识次数不清零（保留已投入并成功巩固的历史）；间隔低于阈值
 *   自动恢复未掌握，否则保持原状态。
 */
export function deriveRegularMasteryAfterReview(input: {
  recognized: boolean;
  nextIntervalDays: number;
  previousMasteryStatus: MasteryStatusType;
  previousCumulativeRecognizedCount: number;
}): { masteryStatus: MasteryStatusType; cumulativeRecognizedCount: number } {
  if (input.recognized) {
    const cumulativeRecognizedCount = input.previousCumulativeRecognizedCount + 1;
    const masteryStatus =
      input.nextIntervalDays >= SOFT_MASTERY_INTERVAL_THRESHOLD_DAYS
        ? MasteryStatus.Mastered
        : input.previousMasteryStatus;
    return { masteryStatus, cumulativeRecognizedCount };
  }
  const masteryStatus =
    input.nextIntervalDays < SOFT_MASTERY_INTERVAL_THRESHOLD_DAYS
      ? MasteryStatus.Unmastered
      : input.previousMasteryStatus;
  return { masteryStatus, cumulativeRecognizedCount: input.previousCumulativeRecognizedCount };
}

// ---------------------------------------------------------------------------
// 积压场景的跨卡排序与当日测试组切分（规格 11.1 / 6.8）
// ---------------------------------------------------------------------------

/** 参与跨卡排序的到期条目快照（由重放/仓储层从条目历史投影）。 */
export interface RegularDueWord {
  readonly wordId: string;
  /** 原始 FSRS 到期时间（UTC ISO）；新条目为下一学习日，自然排在逾期条目之后。 */
  readonly dueAt: string;
  /** 是否已有至少一次最终测试结果。 */
  readonly hasHistory: boolean;
  /** 最近一次最终判断；从未测试为 null。 */
  readonly lastJudgement: TestJudgement | null;
  /** 累计认识次数（不认识不清零）。 */
  readonly cumulativeRecognizedCount: number;
}

/**
 * 积压场景的四段固定比较键（规格 11.1）：
 * 1. 有测试历史的优先于从未测试的新条目——新条目的"逾期"只是录入积压；
 * 2. 历史者中最近一次不认识的优先——刚发生遗忘需要尽快回到复习；
 * 3. 同一最近结果内累计认识次数越多越靠前——不认识绝不清零已投入历史；
 * 4. 仍并列时原始 due_at 越早越靠前，最后按稳定 Word 标识打破并列。
 *
 * 该排序只影响当日测试组的展示顺序与分组，绝不改变 due_at、记忆状态或工作量。
 */
export function compareRegularDueWords(a: RegularDueWord, b: RegularDueWord): number {
  if (a.hasHistory !== b.hasHistory) {
    return a.hasHistory ? -1 : 1;
  }
  if (a.hasHistory && a.lastJudgement !== b.lastJudgement) {
    const aForgotten = a.lastJudgement === TestJudgement.NotRecognized;
    const bForgotten = b.lastJudgement === TestJudgement.NotRecognized;
    if (aForgotten !== bForgotten) {
      return aForgotten ? -1 : 1;
    }
  }
  if (a.hasHistory && a.cumulativeRecognizedCount !== b.cumulativeRecognizedCount) {
    return a.cumulativeRecognizedCount > b.cumulativeRecognizedCount ? -1 : 1;
  }
  const dueA = requireAbsoluteTime(a.dueAt, "条目到期时间").getTime();
  const dueB = requireAbsoluteTime(b.dueAt, "条目到期时间").getTime();
  if (dueA !== dueB) {
    return dueA < dueB ? -1 : 1;
  }
  if (a.wordId !== b.wordId) {
    return a.wordId < b.wordId ? -1 : 1;
  }
  return 0;
}

/**
 * 对当日到期条目按积压排序规则排序（稳定排序：四键全等的条目保持原相对顺序）。
 * 返回新数组，不修改入参。
 */
export function sortRegularDueWords(words: readonly RegularDueWord[]): RegularDueWord[] {
  return [...words].sort(compareRegularDueWords);
}

/**
 * 把排序后的到期序列按每组条目数切分为仅当日有效的测试组。
 *
 * 组只是当天的显示切分（规格 11.2）：组的顺序和成员仅用于恢复当日界面，跨学习日
 * 不保留为学习对象。groupSize 必须为正整数，调用方必须从 Space 设置集中读取。
 */
export function splitRegularTestGroups<T>(sortedWords: readonly T[], groupSize: number): T[][] {
  if (!Number.isInteger(groupSize) || groupSize <= 0) {
    throw new Error(`每组条目数必须为正整数，收到：${groupSize}`);
  }
  const groups: T[][] = [];
  for (let index = 0; index < sortedWords.length; index += groupSize) {
    groups.push(sortedWords.slice(index, index + groupSize));
  }
  return groups;
}
