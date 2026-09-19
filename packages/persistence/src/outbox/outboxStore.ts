/**
 * 出站队列（outbox）的类型契约与失败退避计算。
 *
 * 业务原因（AGENTS.md "数据与同步" + 判断文件 B2）：客户端写入顺序固定为"先写
 * 本地不可变事件与派生状态，再入 outbox 异步同步"；网络失败进入退避重试，不得
 * 阻塞用户操作，断网不改变应用模式。outbox 是这条铁律的载体：
 * - 事件 append 与 outbox 入队同事务（绝不允许"事件已写而 outbox 丢失"造成
 *   静默不同步）；
 * - settings 变更同事务入队（B2：settings 走 outbox 异步推送，但不进入事件流）；
 * - 推送失败不删除条目，而是记录 attempts 并按指数退避推迟 next_attempt_at，
 *   SyncEngine 只消费到期条目——退避由数据本身表达，重启后依然生效。
 *
 * 本文件同时是 SQLite 实现与内存实现共享的类型与退避算法唯一来源（一致性冒烟
 * 测试保证两种运行时行为一致）。
 */

import type { ApplicationEvent } from "@ebbinghaus/application";
import type { SettingEntry } from "@ebbinghaus/protocol";

/** 出站条目类型：学习事件推送与 settings 推送（B2 两通道分离）。 */
export type OutboxEntryType = "event" | "settings";

/** 出站队列条目视图（存储形态由各自实现承载，引擎只见该结构化视图）。 */
export interface OutboxEntry {
  /** 队列内自增序号：消费顺序的稳定依据（先进先出）。 */
  readonly entryId: number;
  readonly entryType: OutboxEntryType;
  /**
   * 待推送载荷的 JSON 文本：event 条目为完整 ApplicationEvent JSON；settings
   * 条目为完整 SettingEntry JSON。存原文而非结构化引用，保证"入队时刻的事实"
   * 不被后续本地修改改写。
   */
  readonly payloadJson: string;
  /** event 条目的 eventId（对账服务器回执用）；settings 条目为 null。 */
  readonly eventId: string | null;
  /** 入队时刻（UTC ISO8601，审计用）。 */
  readonly createdAt: string;
  /** 已失败次数（成功即删行，留在队列里的条目 attempts 为历史失败次数）。 */
  readonly attempts: number;
  /** 下一次允许尝试的时刻（UTC ISO8601；退避的载体）。 */
  readonly nextAttemptAt: string;
  /** 最近一次失败的错误摘要（运维观测；null 表示尚未失败）。 */
  readonly lastError: string | null;
}

/** 出站队列存储契约：SQLite 与内存实现共同满足，SyncEngine 只依赖本接口。 */
export interface OutboxStore {
  /**
   * 入队一条学习事件推送。调用方（事件仓储）保证它与事件 append 同事务。
   * 运行时不校验事件合法性（产生处已过协议校验），原样保存载荷。
   */
  enqueueEvent(event: ApplicationEvent): void;
  /** 入队一条 settings 推送（调用方为同步设置仓储，与本地写入同事务）。 */
  enqueueSettingsEntry(entry: SettingEntry): void;
  /** 取出到期条目（next_attempt_at <= nowIso），按 entryId 升序，最多 limit 条。 */
  dueEntries(nowIso: string, limit: number): OutboxEntry[];
  /** 推送成功（含服务器 duplicated 幂等回执）后删除条目。 */
  markSucceeded(entryId: number): void;
  /**
   * 推送失败：attempts + 1 并按指数退避推迟 next_attempt_at，记录错误摘要。
   * 条目绝不因失败被删除或丢弃（不得静默丢失同步意图）。
   */
  markFailed(entryId: number, message: string, nowIso: string): void;
  /** 尚未清空的条目总数（观测与测试断言）。 */
  pendingCount(): number;
  /** 全部未清空条目（按 entryId 升序；测试与运维观测）。 */
  listPending(): OutboxEntry[];
}

/** outbox 退避参数（可由组合根覆盖；测试用短周期参数加速）。 */
export interface OutboxBackoffOptions {
  /** 首次失败后的等待毫秒数。 */
  readonly initialDelayMs: number;
  /** 退避乘数（指数底数）。 */
  readonly multiplier: number;
  /** 等待时长上限（毫秒）：长期断网时避免退避无限增长。 */
  readonly maxDelayMs: number;
}

/**
 * 默认退避参数：2s 起步、2 倍指数、封顶 5 分钟。
 * 个人自用规模下，断网恢复后最迟 5 分钟内自动补推；界面层可随时手动触发
 * 立即同步（next_attempt_at 只约束自动重试，不约束显式调用）。
 */
export const DEFAULT_OUTBOX_BACKOFF: OutboxBackoffOptions = {
  initialDelayMs: 2_000,
  multiplier: 2,
  maxDelayMs: 5 * 60_000,
};

/**
 * 计算第 attempt 次（从 1 起）失败后的等待毫秒数：initial × multiplier^(attempt-1)
 * 封顶于 maxDelayMs。指数退避防止断网期间的无效重试打满 CPU 与日志；封顶保证
 * 恢复后的收敛时延有上界。取整避免浮点指数产生亚毫秒噪声。
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: OutboxBackoffOptions,
): number {
  if (attempt < 1) {
    throw new Error(`退避次数必须从 1 起，收到：${attempt}`);
  }
  const raw = options.initialDelayMs * Math.pow(options.multiplier, attempt - 1);
  return Math.min(Math.round(raw), options.maxDelayMs);
}
