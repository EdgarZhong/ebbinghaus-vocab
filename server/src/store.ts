/**
 * 存取层（SQL 封装）。
 *
 * 服务器保持"哑"的铁律在此落地的形态：本文件对 events 只做"整体 JSON 的存取与
 * 按同步游标的范围查询"，对 settings 只做"哑 KV 的读写"，不理解任何业务语义。
 * 路由层不直接写 SQL，统一经由本模块，保证所有 SQL 与约束集中一处可审计。
 *
 * 字段物化口径（判断文件 D5）：event_id/device_id/device_seq/occurred_at/event_type
 * 物化为列只为去重与增量查询效率；payload 列保存客户端上传的完整事件 JSON 原文
 * （不含 serverSeq——同步游标是服务器自有产物，单独成列，输出时再附加，payload
 * 永远保持上传原文，服务器不重写客户端数据）。
 */

import type Database from "better-sqlite3";

/** events 表一行的物化形态（payload 为客户端上传的完整事件 JSON 原文）。 */
export interface EventRow {
  readonly eventId: string;
  readonly deviceId: string;
  readonly deviceSeq: number;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly payload: string;
  readonly receivedAt: string;
  readonly serverSeq: number;
}

/** settings 表一行（value_json 为协议 value 字段的 JSON 序列化文本）。 */
export interface SettingRow {
  readonly key: string;
  readonly valueJson: string;
  readonly updatedAt: string;
  readonly deviceId: string;
  readonly serverUpdatedAt: string;
}

/** 增量查询返回的行：payload 原文 + 同步游标。 */
export interface StoredEventPageRow {
  readonly payload: string;
  readonly serverSeq: number;
}

/** 同步存取接口：路由层依赖此接口而非裸 better-sqlite3 句柄。 */
export interface SyncStore {
  /** 按 event_id 查已入库事件获得过的同步游标；不存在返回 undefined。 */
  findServerSeqByEventId(eventId: string): number | undefined;
  /** 插入一条事件（调用方必须在同一事务内完成游标分配与全部插入）。 */
  insertEvent(row: EventRow): void;
  /** 读取并递增 server_seq 计数器（必须在写事务内调用，见 db.ts 计数器选型说明）。 */
  allocateServerSeq(): number;
  /** 按 server_seq 升序取 (afterSeq, afterSeq+limit] 范围内的行。 */
  listEventsAfter(afterSeq: number, limit: number): StoredEventPageRow[];
  /** 事件总数（测试与运维核对用）。 */
  countEvents(): number;
  /** 全量 settings（按键升序）。 */
  listSettingRows(): SettingRow[];
  /** 单键读取（PUT 合并前的现状比对用）。 */
  getSettingRow(key: string): SettingRow | undefined;
  /** 插入或覆盖一条 KV。 */
  upsertSettingRow(row: SettingRow): void;
  /** settings 总数（测试与运维核对用）。 */
  countSettings(): number;
}

/** 创建基于 better-sqlite3 的存取实现。prepared statement 在创建时预编译复用。 */
export function createSyncStore(db: Database.Database): SyncStore {
  const selectSeqByEventId = db.prepare(
    "SELECT server_seq FROM events WHERE event_id = ?",
  );
  const insertEventStmt = db.prepare(`
    INSERT INTO events (event_id, device_id, device_seq, occurred_at, event_type, payload, received_at, server_seq)
    VALUES (@eventId, @deviceId, @deviceSeq, @occurredAt, @eventType, @payload, @receivedAt, @serverSeq)
  `);
  // UPDATE ... RETURNING：读-改-写一步完成，配合外层写事务保证原子分配。
  const allocateSeqStmt = db.prepare(
    "UPDATE sync_counters SET value = value + 1 WHERE name = 'server_seq' RETURNING value",
  );
  const listPageStmt = db.prepare(
    // 列名用 AS 显式映射为 camelCase：SQLite 返回的键与表列名一致（snake_case），
    // 与本模块 TS 接口的 camelCase 对齐必须在 SQL 层完成，避免读取时静默 undefined。
    "SELECT payload, server_seq AS serverSeq FROM events WHERE server_seq > ? ORDER BY server_seq ASC LIMIT ?",
  );
  const countEventsStmt = db.prepare("SELECT COUNT(*) AS total FROM events");
  const listSettingsStmt = db.prepare(
    "SELECT key, value_json AS valueJson, updated_at AS updatedAt, device_id AS deviceId, server_updated_at AS serverUpdatedAt FROM settings ORDER BY key ASC",
  );
  const getSettingStmt = db.prepare(
    "SELECT key, value_json AS valueJson, updated_at AS updatedAt, device_id AS deviceId, server_updated_at AS serverUpdatedAt FROM settings WHERE key = ?",
  );
  const upsertSettingStmt = db.prepare(`
    INSERT INTO settings (key, value_json, updated_at, device_id, server_updated_at)
    VALUES (@key, @valueJson, @updatedAt, @deviceId, @serverUpdatedAt)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at,
      device_id = excluded.device_id,
      server_updated_at = excluded.server_updated_at
  `);
  const countSettingsStmt = db.prepare("SELECT COUNT(*) AS total FROM settings");

  return {
    findServerSeqByEventId(eventId: string): number | undefined {
      const row = selectSeqByEventId.get(eventId) as { server_seq: number } | undefined;
      return row?.server_seq;
    },

    insertEvent(row: EventRow): void {
      insertEventStmt.run(row);
    },

    allocateServerSeq(): number {
      const row = allocateSeqStmt.get() as { value: number };
      return row.value;
    },

    listEventsAfter(afterSeq: number, limit: number): StoredEventPageRow[] {
      return listPageStmt.all(afterSeq, limit) as StoredEventPageRow[];
    },

    countEvents(): number {
      const row = countEventsStmt.get() as { total: number };
      return row.total;
    },

    listSettingRows(): SettingRow[] {
      return listSettingsStmt.all() as SettingRow[];
    },

    getSettingRow(key: string): SettingRow | undefined {
      return getSettingStmt.get(key) as SettingRow | undefined;
    },

    upsertSettingRow(row: SettingRow): void {
      upsertSettingStmt.run(row);
    },

    countSettings(): number {
      const row = countSettingsStmt.get() as { total: number };
      return row.total;
    },
  };
}
