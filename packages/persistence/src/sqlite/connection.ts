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
import { CLIENT_MIGRATIONS } from "./migrations.ts";
export { CLIENT_MIGRATIONS } from "./migrations.ts";

/**
 * 迁移清单：index 0 对应版本 1，依序递增。每个条目是"该版本要执行的 SQL"。
 *
 * 约束设计说明：
 * - learning_events 的 UNIQUE(device_id, device_seq) 与服务器权威库一致：同一设备
 *   的同一序号只能属于一个事件，损坏数据在写入点立即暴露；
 * - learning_events 的 append-only 由两个 BEFORE 触发器兜底：即使未来某段代码
 *   绕过仓储直接执行 UPDATE/DELETE，SQLite 也会 RAISE(ABORT) 阻止（铁律的
 *   最后一道防线，测试显式覆盖）；
 * - v1 曾为 word_contents 增加同 Space 规范键部分唯一索引；v2 迁移撤销它，原因是
 *   两台离线设备可能分别产生同键不同 ID 的词。完整本地副本必须先收齐两行，
 *   再由应用层向用户呈现冲突；索引直接拒绝会让增量拉取永久卡住。
 * - outbox.entry_type 用 CHECK 收紧为两类（事件推送 / settings 推送），
 *   拒绝未来误加的第三类条目静默入库。
 */

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
