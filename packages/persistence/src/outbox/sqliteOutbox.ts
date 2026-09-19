/**
 * outbox 的 SQLite 实现。
 *
 * 所有语句都是预编译的单条 SQL：入队（事件仓储/设置仓储在各自事务内调用）、
 * 到期消费、成败收尾。时间比较依赖"同格式 UTC ISO8601 字符串的字典序即时间序"
 * （toISOString 恒为 24 字符定宽格式），无需解析为数值。
 */

import type Database from "better-sqlite3";

import type { ApplicationEvent } from "@ebbinghaus/application";
import type { SettingEntry } from "@ebbinghaus/protocol";

import {
  DEFAULT_OUTBOX_BACKOFF,
  computeBackoffDelayMs,
  type OutboxBackoffOptions,
  type OutboxEntry,
  type OutboxStore,
} from "./outboxStore.ts";

/**
 * 数据库行 → 结构化视图（列名经 AS 显式映射为 camelCase，与 server 侧同口径）。
 * 目前查询直接返回结构化字段，本视图保留为将来按行读取时的形态契约。
 */

export class SqliteOutbox implements OutboxStore {
  private readonly db: Database.Database;
  private readonly backoff: OutboxBackoffOptions;

  private readonly enqueueStmt;
  private readonly dueStmt;
  private readonly markSucceededStmt;
  private readonly markFailedStmt;
  private readonly countStmt;
  private readonly listPendingStmt;

  constructor(
    db: Database.Database,
    options: Partial<OutboxBackoffOptions> = {},
  ) {
    this.db = db;
    this.backoff = { ...DEFAULT_OUTBOX_BACKOFF, ...options };

    this.enqueueStmt = db.prepare(`
      INSERT INTO outbox (entry_type, payload_json, event_id, created_at, attempts, next_attempt_at, last_error)
      VALUES (@entryType, @payloadJson, @eventId, @createdAt, 0, @nextAttemptAt, NULL)
    `);
    this.dueStmt = db.prepare(
      "SELECT entry_id AS entryId, entry_type AS entryType, payload_json AS payloadJson, event_id AS eventId, created_at AS createdAt, attempts, next_attempt_at AS nextAttemptAt, last_error AS lastError FROM outbox WHERE next_attempt_at <= ? ORDER BY entry_id ASC LIMIT ?",
    );
    this.markSucceededStmt = db.prepare("DELETE FROM outbox WHERE entry_id = ?");
    this.markFailedStmt = db.prepare(
      "UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE entry_id = ?",
    );
    this.countStmt = db.prepare("SELECT COUNT(*) AS total FROM outbox");
    this.listPendingStmt = db.prepare(
      "SELECT entry_id AS entryId, entry_type AS entryType, payload_json AS payloadJson, event_id AS eventId, created_at AS createdAt, attempts, next_attempt_at AS nextAttemptAt, last_error AS lastError FROM outbox ORDER BY entry_id ASC",
    );
  }

  enqueueEvent(event: ApplicationEvent): void {
    this.insert("event", JSON.stringify(event), event.eventId);
  }

  enqueueSettingsEntry(entry: SettingEntry): void {
    this.insert("settings", JSON.stringify(entry), null);
  }

  /** 入队公共路径：新条目立即到期（next_attempt_at = created_at），首次推送不等退避。 */
  private insert(
    entryType: OutboxEntry["entryType"],
    payloadJson: string,
    eventId: string | null,
  ): void {
    const nowIso = this.clockNowIso();
    this.enqueueStmt.run({
      entryType,
      payloadJson,
      eventId,
      createdAt: nowIso,
      nextAttemptAt: nowIso,
    });
  }

  dueEntries(nowIso: string, limit: number): OutboxEntry[] {
    return this.dueStmt.all(nowIso, limit) as unknown as OutboxEntry[];
  }

  markSucceeded(entryId: number): void {
    this.markSucceededStmt.run(entryId);
  }

  markFailed(entryId: number, message: string, nowIso: string): void {
    const row = this.db
      .prepare("SELECT attempts FROM outbox WHERE entry_id = ?")
      .get(entryId) as { attempts: number } | undefined;
    if (row === undefined) {
      // 条目已被并发收尾删除（单进程内不可能，防御性保留）。
      return;
    }
    const delayMs = computeBackoffDelayMs(row.attempts + 1, this.backoff);
    const nextAttemptAt = new Date(Date.parse(nowIso) + delayMs).toISOString();
    this.markFailedStmt.run(nextAttemptAt, message.slice(0, 2000), entryId);
  }

  pendingCount(): number {
    const row = this.countStmt.get() as { total: number };
    return row.total;
  }

  listPending(): OutboxEntry[] {
    return this.listPendingStmt.all() as unknown as OutboxEntry[];
  }

  /**
   * 入队时刻：outbox 的 created_at/next_attempt_at 是基础设施审计信息而非领域
   * 时间，读系统当前时刻（经运行时注入的时钟包装）。
   */
  private clockNowIso(): string {
    return this.clock.now().toISOString();
  }

  /** 时钟由组合根注入（默认系统时钟）；延迟字段赋值避免构造参数顺序耦合。 */
  private clock: { now(): Date } = { now: () => new Date() };

  /** 组合根在构造后注入时钟（createNodeClientRuntime / createInMemoryRuntime）。 */
  setClock(clock: { now(): Date }): void {
    this.clock = clock;
  }
}
