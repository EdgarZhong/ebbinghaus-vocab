/**
 * 不可变学习事件的 SQLite 仓储（ports.ts LearningEventStore 合同实现）。
 *
 * 两条铁律的落地位置：
 * - **append-only**：本地写入口径下 eventId 重复属于编程错误，必须抛错（应用层
 *   InMemory 假实现同口径）；schema 层另有 BEFORE UPDATE/DELETE 触发器兜底，即使
 *   未来代码绕过仓储直接执行 SQL 也无法改写事件。重复插入的约束冲突在这里翻译为
 *   DuplicateEventError（errors.ts），调用方无需理解 SQLite 错误细节。
 * - **完整本地副本**：本表既存本机事件也存服务器拉取的其他设备事件（完整副本是
 *   领域重放的输入）。拉取侧的幂等落库走 `applyPulledEvents`（INSERT OR IGNORE，
 *   与服务器 event_id 去重语义对齐），与本地写入的"重复即抛错"刻意分开——本地
 *   产生的重复是 bug，拉取遇到的重复是已同步事件的正常回声。
 */

import type Database from "better-sqlite3";

import type { ApplicationEvent, Clock, LearningEventStore } from "@ebbinghaus/application";

import { DuplicateEventError } from "../errors.ts";
import type { OutboxStore } from "../outbox/outboxStore.ts";

/** 事件行 → 应用层视图的列映射（SQL 内已用 AS 对齐 camelCase，此处只做 JSON 解析）。 */
interface EventRow {
  readonly event_id: string;
  readonly event_type: ApplicationEvent["eventType"];
  readonly target_type: string;
  readonly target_id: string;
  readonly occurred_at: string;
  readonly learning_day: string;
  readonly source: string;
  readonly device_id: string;
  readonly device_seq: number;
  readonly metadata_json: string;
}

function rowToEvent(row: EventRow): ApplicationEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    targetType: row.target_type,
    targetId: row.target_id,
    occurredAt: row.occurred_at,
    learningDay: row.learning_day,
    source: row.source,
    deviceId: row.device_id,
    deviceSeq: row.device_seq,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}

export class SqliteLearningEventStore implements LearningEventStore {
  private readonly db: Database.Database;
  private readonly clock: Clock;

  private readonly insertStmt;
  private readonly listStmt;
  /** 拉取侧专用语句：INSERT OR IGNORE 实现服务器回声的幂等落地。 */
  private readonly ignoreInsertStmt;

  constructor(db: Database.Database, clock: Clock, private readonly outbox?: OutboxStore) {
    this.db = db;
    this.clock = clock;
    this.insertStmt = this.db.prepare(`
      INSERT INTO learning_events
        (event_id, event_type, target_type, target_id, occurred_at, learning_day,
         source, device_id, device_seq, metadata_json, recorded_at)
      VALUES
        (@eventId, @eventType, @targetType, @targetId, @occurredAt, @learningDay,
         @source, @deviceId, @deviceSeq, @metadataJson, @recordedAt)
    `);
    this.listStmt = this.db.prepare(`
      SELECT event_id, event_type, target_type, target_id, occurred_at, learning_day,
             source, device_id, device_seq, metadata_json
      FROM learning_events
    `);
    this.ignoreInsertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO learning_events
        (event_id, event_type, target_type, target_id, occurred_at, learning_day,
         source, device_id, device_seq, metadata_json, recorded_at)
      VALUES
        (@eventId, @eventType, @targetType, @targetId, @occurredAt, @learningDay,
         @source, @deviceId, @deviceSeq, @metadataJson, @recordedAt)
    `);
  }

  /** 整批原子追加：同一用例的连带事件必须一批写入（ports.ts 合同），事务保证同生共死。 */
  appendEvents(events: readonly ApplicationEvent[]): void {
    const recordedAt = this.clock.now().toISOString();
    const run = this.db.transaction((batch: readonly ApplicationEvent[]) => {
      for (const event of batch) {
        try {
          this.insertStmt.run({
            eventId: event.eventId,
            eventType: event.eventType,
            targetType: event.targetType,
            targetId: event.targetId,
            occurredAt: event.occurredAt,
            learningDay: event.learningDay,
            source: event.source,
            deviceId: event.deviceId,
            deviceSeq: event.deviceSeq,
            metadataJson: JSON.stringify(event.metadata),
            recordedAt,
          });
          // 同一事务内登记推送意图：任何一侧失败都会整批回滚。
          this.outbox?.enqueueEvent(event);
        } catch (error) {
          // UNIQUE 冲突（event_id 主键或 device_id+device_seq）→ 翻译为领域错误。
          if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
            throw new DuplicateEventError(event.eventId);
          }
          throw error;
        }
      }
    });
    run(events);
  }

  listAllEvents(): ApplicationEvent[] {
    return (this.listStmt.all() as EventRow[]).map(rowToEvent);
  }

  /**
   * 拉取侧幂等落库：与本地写入不同，重复（已同步过的本机事件回声）直接忽略，
   * 返回实际新入库数量供引擎判断是否需要触发重放。
   */
  applyPulledEvents(events: readonly ApplicationEvent[]): number {
    const run = this.db.transaction((batch: readonly ApplicationEvent[]) => {
      let inserted = 0;
      for (const event of batch) {
        // OR IGNORE：event_id 主键或 (device_id, device_seq) 命中已有行即回声，跳过。
        const result = this.ignoreInsertStmt.run({
          eventId: event.eventId,
          eventType: event.eventType,
          targetType: event.targetType,
          targetId: event.targetId,
          occurredAt: event.occurredAt,
          learningDay: event.learningDay,
          source: event.source,
          deviceId: event.deviceId,
          deviceSeq: event.deviceSeq,
          metadataJson: JSON.stringify(event.metadata),
          recordedAt: this.clock.now().toISOString(),
        });
        inserted += result.changes;
      }
      return inserted;
    });
    return run(events);
  }
}
