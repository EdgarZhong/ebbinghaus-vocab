/**
 * 客户端 SQLite 工作库的打开与 schema 迁移。
 *
 * 与 server/src/db.ts 同构的设计（同一作者维护的两侧约定保持一致，便于审计）：
 * - better-sqlite3 同步驱动：客户端所有仓储方法都是同步写入，"事件 append 与
 *   outbox 入队同事务"等原子性承诺在单进程串行写入下天然成立，无需锁机制；
 * - WAL 模式 + synchronous = NORMAL：读写不互斥，崩溃时最多丢最近事务的 fsync
 *   缓冲而不损库完整性（WAL 官方推荐档位）；
 * - foreign_keys = ON：本包 schema 虽未声明跨表外键（事件与内容目录刻意解耦，
 *   派生关系由重放恢复），仍开启以获得前瞻性防御；
 * - 幂等迁移：所有 DDL 用 IF NOT EXISTS，schema_migrations 记录已应用版本号；
 *   客户端库的版本 1 一次性建立全部业务表（见 CLIENT_MIGRATIONS 注释）。
 *
 * 表职责总览（与 application/ports.ts 一一对应）：
 * - learning_events：不可变学习事件本地副本（append-only 触发器兜底）；既有本机
 *   产生的事件，也有从服务器拉取的其他设备事件——完整本地副本是重放的输入；
 * - word_contents / study_units / list_catalog / spaces：本地内容目录（词身份、
 *   词书结构、Space 元数据），不是事件流；
 * - test_sessions：设备本地执行状态（不同步、不重放）；
 * - fsrs_cards：常规模式 FSRS 卡片设备本地派生态（不同步）；
 * - synced_settings / device_local_kv：同步设置收敛视图 + 设备本地 KV；
 * - llm_configuration：LLM 服务配置（apiKey 密文落库）；
 * - daily_plans：容量预测结果（同 day+space 一行，upsert 覆盖）；
 * - outbox：出站队列（事件推送与 settings 推送两类条目，失败指数退避）；
 * - device_state / device_counters：设备身份与设备内事件序号（重启延续）；
 * - sync_state：同步游标（pull 后推进的 serverSeq 高水位）。
 */

import Database from "better-sqlite3";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 迁移清单：index 0 对应版本 1，依序递增。每个条目是"该版本要执行的 SQL"。
 *
 * 约束设计说明：
 * - learning_events 的 UNIQUE(device_id, device_seq) 与服务器权威库一致：同一设备
 *   的同一序号只能属于一个事件，损坏数据在写入点立即暴露；
 * - learning_events 的 append-only 由两个 BEFORE 触发器兜底：即使未来某段代码
 *   绕过仓储直接执行 UPDATE/DELETE，SQLite 也会 RAISE(ABORT) 阻止（铁律的
 *   最后一道防线，测试显式覆盖）；
 * - word_contents 的部分唯一索引只约束"未移除且归属 Space 的行"：同 Space 内
 *   normalizedKey 的唯一性由用例层检测并把冲突交给用户决定（ports.ts 口径），
 *   索引只是兜底；词书模式词 spaceId 可为 null 且同键可跨 List 出现，不参与约束；
 * - outbox.entry_type 用 CHECK 收紧为两类（事件推送 / settings 推送），
 *   拒绝未来误加的第三类条目静默入库。
 */
export const CLIENT_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS learning_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    learning_day TEXT NOT NULL,
    source TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_seq INTEGER NOT NULL,
    metadata_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE(device_id, device_seq)
  );

  CREATE INDEX IF NOT EXISTS idx_learning_events_occurred_at ON learning_events(occurred_at);

  CREATE TRIGGER IF NOT EXISTS trg_learning_events_forbid_update
  BEFORE UPDATE ON learning_events
  BEGIN
    SELECT RAISE(ABORT, '学习事件不可变：禁止 UPDATE（append-only 铁律）');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_learning_events_forbid_delete
  BEFORE DELETE ON learning_events
  BEGIN
    SELECT RAISE(ABORT, '学习事件不可变：禁止 DELETE（append-only 铁律）');
  END;

  CREATE TABLE IF NOT EXISTS word_contents (
    word_id TEXT PRIMARY KEY,
    list_id TEXT,
    space_id TEXT,
    original_spelling TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    manual_meaning TEXT NOT NULL,
    meanings_json TEXT NOT NULL,
    removed INTEGER NOT NULL CHECK (removed IN (0, 1)),
    recorded_at TEXT NOT NULL,
    removed_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_word_contents_active_space_key
    ON word_contents(space_id, normalized_key)
    WHERE space_id IS NOT NULL AND removed = 0;

  CREATE INDEX IF NOT EXISTS idx_word_contents_list ON word_contents(list_id);
  CREATE INDEX IF NOT EXISTS idx_word_contents_space ON word_contents(space_id);

  CREATE TABLE IF NOT EXISTS study_units (
    unit_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    unit_number INTEGER NOT NULL,
    UNIQUE(space_id, unit_number)
  );

  CREATE TABLE IF NOT EXISTS list_catalog (
    list_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    unit_number INTEGER NOT NULL,
    list_number INTEGER NOT NULL,
    UNIQUE(unit_id, list_number)
  );

  CREATE INDEX IF NOT EXISTS idx_list_catalog_space ON list_catalog(space_id);

  CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    kind TEXT,
    display_order INTEGER NOT NULL,
    name TEXT,
    archived_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    learning_mode TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS test_sessions (
    session_id TEXT PRIMARY KEY,
    learning_mode TEXT NOT NULL,
    space_id TEXT,
    list_id TEXT,
    learning_day TEXT NOT NULL,
    group_ordinal INTEGER,
    task_id TEXT,
    words_json TEXT NOT NULL,
    current_position INTEGER NOT NULL,
    status TEXT NOT NULL,
    answered_word_ids_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_test_sessions_space_day
    ON test_sessions(space_id, learning_day, status);
  CREATE INDEX IF NOT EXISTS idx_test_sessions_list
    ON test_sessions(list_id, status);

  CREATE TABLE IF NOT EXISTS fsrs_cards (
    word_id TEXT PRIMARY KEY,
    card_json TEXT NOT NULL,
    due_at TEXT NOT NULL,
    scheduler_json TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    library_version TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    card_state TEXT NOT NULL,
    cumulative_recognized_count INTEGER NOT NULL,
    last_final_judgement TEXT
  );

  CREATE TABLE IF NOT EXISTS synced_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    device_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_local_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS llm_configuration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    api_key_cipher TEXT NOT NULL,
    thinking_enabled INTEGER NOT NULL CHECK (thinking_enabled IN (0, 1)),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_plans (
    learning_day TEXT NOT NULL,
    space_id TEXT NOT NULL,
    target_capacity INTEGER NOT NULL,
    suggested_first_pass_count INTEGER NOT NULL,
    actual_first_pass_count INTEGER NOT NULL,
    actual_completed_workload REAL NOT NULL,
    prediction_window_days INTEGER NOT NULL,
    algorithm_version TEXT NOT NULL,
    due_snapshot_json TEXT NOT NULL,
    risk_metrics_json TEXT NOT NULL,
    PRIMARY KEY (learning_day, space_id)
  );

  CREATE TABLE IF NOT EXISTS outbox (
    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('event', 'settings')),
    payload_json TEXT NOT NULL,
    event_id TEXT,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(next_attempt_at, entry_id);

  CREATE TABLE IF NOT EXISTS device_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO device_counters (name, value) VALUES ('device_seq', 0);

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO sync_state (key, value) VALUES ('pull_cursor', 0);
  `,
];

/**
 * 打开（必要时创建）客户端工作库并确保 schema 就绪。
 * 路径所在目录不存在时创建（与 server 侧 openDatabase 同口径）；传入
 * `:memory:` 时直接打开内存库（测试与临时场景）。
 */
export function openClientDatabase(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  // WAL 下的推荐持久化档位：崩溃时最多丢最近事务的 fsync 缓冲，不损库完整性。
  db.pragma("synchronous = NORMAL");
  // 前瞻性防御：当前 schema 无跨表外键，未来引入时默认受约束保护。
  db.pragma("foreign_keys = ON");

  migrateClientDatabase(db);
  return db;
}

/** 幂等应用所有尚未落库的迁移（与 server 侧 migrate 同构）。 */
function migrateClientDatabase(db: Database.Database): void {
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
  CLIENT_MIGRATIONS.forEach((sql, index) => {
    const version = index + 1;
    if (appliedVersions.has(version)) return;
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      insertApplied.run(version, new Date().toISOString());
    });
    applyMigration();
  });
}
