/**
 * SQLite 权威库的打开与 schema 迁移（判断文件 D5）。
 *
 * 设计要点：
 * - better-sqlite3 同步驱动：Fastify handler 是 async 但 better-sqlite3 的写入是
 *   同步完成的，单进程内天然串行，恰好匹配"server_seq 严格单调递增"的分配要求，
 *   不需要额外的锁机制。
 * - WAL 模式：读写不互斥，备份 API 在 WAL 下也能拿到一致快照；配合
 *   synchronous = NORMAL（WAL 官方推荐档位）在性能与崩溃安全间取平衡。
 * - 建库脚本幂等：所有 DDL 用 IF NOT EXISTS，并以 schema_migrations 表记录已应用
 *   的迁移版本号（applied_at 仅运维观测），重复启动不会重复执行、也不会改写既有
 *   数据；后续 schema 演进追加新版本迁移条目即可。
 * - server_seq 分配选择"独立计数器表"而非 AUTOINCREMENT（任务简报二选一）：
 *   1) AUTOINCREMENT 必须占用 rowid（INTEGER PRIMARY KEY），而本表的业务主键是
 *      event_id（TEXT），把 server_seq 兼任 rowid 会让"删行回填"等 SQLite 内部
 *      行为与同步游标语义意外耦合；
 *   2) 计数器表的当前值持久化在同一库文件里，进程重启后从表中读出继续 +1，
 *      单调性跨重启一目了然，测试可直接断言；
 *   3) 分配动作在 push 的写事务内完成（同一事务读-改-写），配合单进程串行写入，
 *      保证并发批次之间不会分到重复值。
 */

import Database from "better-sqlite3";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 迁移清单：index 0 对应版本 1，依序递增。每个条目是"该版本要执行的 SQL"。
 * 版本 1：初始 schema——events（学习事件，append-only）、settings（KV 通道）、
 * sync_counters（server_seq 独立计数器）。
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    device_seq INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    server_seq INTEGER NOT NULL UNIQUE,
    UNIQUE(device_id, device_seq)
  );

  CREATE INDEX IF NOT EXISTS idx_events_server_seq ON events(server_seq);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    device_id TEXT NOT NULL,
    server_updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO sync_counters (name, value) VALUES ('server_seq', 0);
  `,
  `
  CREATE TABLE IF NOT EXISTS contents (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    device_id TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    server_seq INTEGER NOT NULL UNIQUE,
    PRIMARY KEY (entity_type, entity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_contents_server_seq ON contents(server_seq);
  INSERT OR IGNORE INTO sync_counters (name, value) VALUES ('content_seq', 0);
  `,
];

/**
 * 打开（必要时创建）权威库并确保 schema 就绪。
 * 路径所在目录不存在时创建（目录准备属于存储职责，与 config.ts 的默认目录逻辑
 * 分工：config 只准备默认 data/，本函数兜底任意显式路径的父目录）。
 */
export function openDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  // WAL 下的推荐持久化档位：崩溃时最多丢最近事务的 fsync 缓冲，不损库完整性。
  db.pragma("synchronous = NORMAL");
  // 当前 schema 没有跨表外键，开启属于前瞻性防御（未来加外键时默认即受约束保护）。
  db.pragma("foreign_keys = ON");

  migrate(db);
  return db;
}

/** 幂等应用所有尚未落库的迁移。 */
function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const insertApplied = db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );

  // 逐版本、逐迁移整体执行：迁移 SQL 自身用 IF NOT EXISTS 保证幂等，版本记录
  // 保证未来"非幂等 DDL"的迁移也只会被应用一次。
  MIGRATIONS.forEach((sql, index) => {
    const version = index + 1;
    if (appliedVersions.has(version)) return;
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      insertApplied.run(version, new Date().toISOString());
    });
    applyMigration();
  });
}
