/**
 * V1 数据库只读审计。
 *
 * 正式迁移必须先确认源库结构、完整性和记录量；此工具只输出各表计数、事件类型
 * 计数与 SHA-256 摘要，绝不打印词条、释义、原始转写或密钥。摘要用于核对在线
 * 备份与源库是否对应，不作为迁移后的语义等价证明。
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/** V1 v3 正式数据库全部表；固定白名单避免 SQL 标识符接受用户输入。 */
export const V1_TABLES = [
  "schema_migrations",
  "spaces",
  "space_learning_settings",
  "units",
  "word_lists",
  "words",
  "word_meanings",
  "word_content_versions",
  "fsrs_cards",
  "planned_tasks",
  "test_sessions",
  "test_answers",
  "learning_events",
  "daily_plans",
  "user_settings",
  "dictionary_entries",
  "first_pass_drafts",
  "first_pass_records",
  "llm_service_configuration",
] as const;

export interface V1Audit {
  readonly integrity: "ok";
  readonly foreignKeyViolations: 0;
  readonly counts: Readonly<Record<string, number>>;
  /** 对完整表行按 rowid 排序后的内容摘要；只用于同结构库间逐表比对。 */
  readonly sha256: Readonly<Record<string, string>>;
  readonly eventTypeCounts: Readonly<Record<string, number>>;
}

/** 在已打开的只读连接上审计；测试注入内存数据库也走同一路径。 */
export function auditV1Connection(db: Database.Database): V1Audit {
  const actualTables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name),
  );
  const missing = V1_TABLES.filter((table) => !actualTables.has(table));
  if (missing.length > 0) {
    throw new Error(`V1 数据库结构不完整，缺少表：${missing.join("、")}`);
  }

  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    throw new Error(`V1 数据库完整性检查失败：${String(integrity)}`);
  }
  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length !== 0) {
    throw new Error(`V1 数据库存在 ${foreignKeyViolations.length} 处外键违规`);
  }

  const counts: Record<string, number> = {};
  const sha256: Record<string, string> = {};
  for (const table of V1_TABLES) {
    // 表名来自上方常量白名单；内容不可写入输出，逐行摘要防止大表聚合占满内存。
    const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).iterate();
    const digest = createHash("sha256");
    let count = 0;
    for (const row of rows) {
      digest.update(JSON.stringify(row));
      digest.update("\n");
      count += 1;
    }
    counts[table] = count;
    sha256[table] = digest.digest("hex");
  }

  const eventTypeCounts: Record<string, number> = {};
  const eventGroups = db.prepare(
    "SELECT event_type AS eventType, COUNT(*) AS total FROM learning_events GROUP BY event_type ORDER BY event_type",
  ).all() as { eventType: string; total: number }[];
  for (const group of eventGroups) eventTypeCounts[group.eventType] = group.total;

  // 旧事件 metadata 保持原值迁移；预先拒绝非法 JSON，可避免半途才发现坏记录。
  const metadataRows = db.prepare("SELECT id, metadata_json FROM learning_events").iterate() as Iterable<{
    id: string;
    metadata_json: string;
  }>;
  for (const row of metadataRows) {
    let metadata: unknown;
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      throw new Error(`V1 学习事件 ${row.id} 的 metadata 不是合法 JSON`);
    }
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error(`V1 学习事件 ${row.id} 的 metadata 不是 JSON 对象`);
    }
  }

  return { integrity: "ok", foreignKeyViolations: 0, counts, sha256, eventTypeCounts };
}

/** 文件级入口强制只读，避免审计操作误触发 SQLite 建库或 WAL 写入。 */
export function auditV1Database(sourcePath: string): V1Audit {
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    return auditV1Connection(db);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    throw new Error("请提供 V1 SQLite 文件路径");
  }
  // 标准输出只有不可逆摘要和数量；不打印传入的路径或任何实际词汇数据。
  process.stdout.write(`${JSON.stringify(auditV1Database(sourcePath), null, 2)}\n`);
}
