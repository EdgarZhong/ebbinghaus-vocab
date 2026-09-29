/**
 * 已核验 V1 在线备份到全新 V2 客户端工作库的导入入口。
 *
 * 来源始终以 query_only 打开。目标以 O_EXCL 独占创建，禁止覆盖任何既有文件；
 * 再次指定同一已完成目标时只读核验并返回相同统计。导入调用 V2 正式仓储，
 * 因而事件、设置和已确认内容目录会分别形成待推送队列，后续可交给 SyncEngine 上云；
 * 未提交首过草稿只存于目标客户端本机，不进入内容出站队列。
 * 全部业务写入与校验置于单个 SQLite 事务内，失败时只保留新建的空工作库。
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { createNodeClientRuntime, type NodeClientRuntime } from "@ebbinghaus/persistence";

import { auditV1Database, type V1Audit } from "./audit.ts";
import { convertV1Backup, type V1ConvertedSnapshot } from "./convert.ts";

const IMPORT_MARKER_KEY = "migration.v1.sourceDigest";
const COUNT_TABLES = {
  spaces: "spaces",
  units: "study_units",
  lists: "list_catalog",
  words: "word_contents",
  drafts: "first_pass_drafts",
  events: "learning_events",
  settings: "synced_settings",
} as const;

export interface V1ImportCounts {
  readonly spaces: number;
  readonly units: number;
  readonly lists: number;
  readonly words: number;
  readonly drafts: number;
  readonly events: number;
  readonly settings: number;
  readonly eventOutbox: number;
  readonly contentOutbox: number;
}

export interface V1ImportResult {
  readonly backupPath: string;
  readonly targetPath: string;
  /** true 表示再次调用只读核验，未产生任何写入。 */
  readonly alreadyImported: boolean;
  readonly counts: V1ImportCounts;
}

function expectedCounts(snapshot: V1ConvertedSnapshot): V1ImportCounts {
  return {
    spaces: snapshot.spaces.length, units: snapshot.units.length,
    lists: snapshot.lists.length, words: snapshot.words.length,
    drafts: snapshot.drafts.length, events: snapshot.events.length,
    settings: snapshot.settings.length,
    eventOutbox: snapshot.events.length + snapshot.settings.length,
    // 首过草稿需要逐条导入与核对，但未确认正文不属于云端内容目录。
    contentOutbox: snapshot.spaces.length + snapshot.units.length + snapshot.lists.length
      + snapshot.words.length,
  };
}

/** 备份的逐表 SHA-256 审计结果合成稳定指纹；只在本地目标库存储，不向云端同步。 */
function sourceDigest(audit: V1Audit): string {
  return createHash("sha256").update(JSON.stringify({ counts: audit.counts, sha256: audit.sha256 })).digest("hex");
}

function count(db: Database.Database, table: string): number {
  // table 仅来自本文件的固定白名单，不接受路径或用户输入。
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** 在映射阶段就核对关键源行数，避免转换器无意漏行后仍然开始建目标库。 */
function assertSourceCounts(audit: V1Audit, snapshot: V1ConvertedSnapshot): void {
  const expected = expectedCounts(snapshot);
  const actual = audit.counts;
  if (actual["spaces"] !== expected.spaces || actual["units"] !== expected.units
    || actual["word_lists"] !== expected.lists || actual["words"] !== expected.words
    || actual["first_pass_drafts"] !== expected.drafts
    || actual["learning_events"] !== expected.events
    || actual["space_learning_settings"] === undefined) {
    throw new Error("V1 备份与转换结果的关键记录数量不一致");
  }
  if (expected.settings !== 6 + actual["space_learning_settings"] * 3) {
    throw new Error("V1 备份的设置转换数量不一致");
  }
}

/** 核验迁移成品本身；失败必须抛出，让外层事务整体回滚。 */
function verifyTarget(
  db: Database.Database,
  snapshot: V1ConvertedSnapshot,
  digest: string,
  requireMarker: boolean,
): V1ImportCounts {
  if (db.pragma("integrity_check", { simple: true }) !== "ok") {
    throw new Error("V2 目标库完整性检查失败");
  }
  if ((db.pragma("foreign_key_check") as unknown[]).length !== 0) {
    throw new Error("V2 目标库外键检查失败");
  }
  const expected = expectedCounts(snapshot);
  const actual = {} as Record<keyof V1ImportCounts, number>;
  for (const [key, table] of Object.entries(COUNT_TABLES) as [keyof typeof COUNT_TABLES, string][]) {
    actual[key] = count(db, table);
  }
  actual.eventOutbox = count(db, "outbox");
  actual.contentOutbox = count(db, "content_outbox");
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("V2 目标库关键记录或出站队列数量不一致");
  }

  // 历史事件不可改写：逐条比对信封和 metadata。学习事件没有目录外键，
  // 仅做 count 无法发现错位、字段变更或两条事件互换。
  const storedEvents = db.prepare(`
    SELECT event_id AS eventId, event_type AS eventType, target_type AS targetType,
      target_id AS targetId, occurred_at AS occurredAt, learning_day AS learningDay,
      source, device_id AS deviceId, device_seq AS deviceSeq, metadata_json AS metadataJson
    FROM learning_events
  `).all() as Array<Record<string, unknown> & { eventId: string; metadataJson: string }>;
  const expectedById = new Map(snapshot.events.map((event) => [event.eventId, event]));
  for (const row of storedEvents) {
    const { metadataJson, ...fields } = row;
    const expectedEvent = expectedById.get(row.eventId);
    if (expectedEvent === undefined || !isDeepStrictEqual({ ...fields, metadata: JSON.parse(metadataJson) }, expectedEvent)) {
      throw new Error("V2 目标库历史事件逐条核对失败");
    }
  }

  // 全部内容目录按稳定主键核对，避免只有计数一致却漏掉某一条用户数据。
  for (const [table, key, sourceIds] of [
    ["spaces", "id", snapshot.spaces.map((item) => item.id)],
    ["study_units", "unit_id", snapshot.units.map((item) => item.id)],
    ["list_catalog", "list_id", snapshot.lists.map((item) => item.listId)],
    ["word_contents", "word_id", snapshot.words.map((item) => item.wordId)],
    ["first_pass_drafts", "id", snapshot.drafts.map((item) => item.id)],
  ] as const) {
    const found = (db.prepare(`SELECT ${key} AS id FROM ${table}`).all() as { id: string }[]).map((row) => row.id).sort();
    if (!isDeepStrictEqual(found, [...sourceIds].sort())) {
      throw new Error("V2 目标库内容目录逐条标识核对失败");
    }
  }
  const storedSettingKeys = (db.prepare("SELECT key FROM synced_settings").all() as { key: string }[])
    .map((row) => row.key).sort();
  if (!isDeepStrictEqual(storedSettingKeys, snapshot.settings.map((item) => item.key).sort())) {
    throw new Error("V2 目标库设置键核对失败");
  }
  const activeSpace = db.prepare("SELECT value FROM device_local_kv WHERE key = 'activeSpaceId'")
    .get() as { value: string } | undefined;
  if (activeSpace?.value !== snapshot.activeSpaceId && (activeSpace !== undefined || snapshot.activeSpaceId !== null)) {
    throw new Error("V2 目标库活动 Space 核对失败");
  }
  if (requireMarker) {
    const marker = db.prepare("SELECT value FROM device_local_kv WHERE key = ?")
      .get(IMPORT_MARKER_KEY) as { value: string } | undefined;
    if (marker?.value !== digest) throw new Error("既有目标库不是本次已完成的 V1 导入");
  }
  return actual;
}

function writeSnapshot(
  runtime: NodeClientRuntime,
  snapshot: V1ConvertedSnapshot,
  sourcePath: string,
  digest: string,
): V1ImportCounts {
  let result: V1ImportCounts | undefined;
  runtime.unitOfWork.run(() => {
    for (const space of snapshot.spaces) runtime.spaceStore.addSpace(space);
    for (const unit of snapshot.units) runtime.bookCatalogStore.addUnit(unit);
    for (const list of snapshot.lists) runtime.bookCatalogStore.addList(list);
    runtime.wordContentStore.upsertEntries(snapshot.words);
    for (const draft of snapshot.drafts) runtime.firstPassDraftStore.upsertDraft(draft);
    runtime.eventStore.appendEvents(snapshot.events);
    runtime.syncedSettingsStore.save(snapshot.settings);
    if (snapshot.activeSpaceId !== null) {
      runtime.deviceLocalStore.setString("activeSpaceId", snapshot.activeSpaceId);
    }
    result = verifyTarget(runtime.db, snapshot, digest, false);
    // 来源若在导入期间被改写，目标事务必须回滚；禁止出现有导入标记的半旧半新库。
    if (sourceDigest(auditV1Database(sourcePath)) !== digest) {
      throw new Error("导入期间 V1 备份内容变化，停止后续上云");
    }
    runtime.deviceLocalStore.setString(IMPORT_MARKER_KEY, digest);
  });
  if (result === undefined) throw new Error("V2 导入事务未完成");
  return result;
}

/**
 * 只接受已通过 V1 全表审计的备份文件。既有目标仅在导入标记、源摘要和逐项校验
 * 全部匹配时作为幂等重试返回；其他任何既有文件都拒绝打开为可写目标。
 */
export function importV1BackupToNewClient(backupPath: string, targetPath: string): V1ImportResult {
  const source = resolve(backupPath);
  const target = resolve(targetPath);
  if (source === target) throw new Error("来源与目标路径不得相同");
  const firstAudit = auditV1Database(source);
  const snapshot = convertV1Backup(source);
  assertSourceCounts(firstAudit, snapshot);
  const digest = sourceDigest(firstAudit);

  if (existsSync(target)) {
    const db = new Database(target, { readonly: true, fileMustExist: true });
    try {
      db.pragma("query_only = ON");
      const counts = verifyTarget(db, snapshot, digest, true);
      return { backupPath: source, targetPath: target, alreadyImported: true, counts };
    } finally {
      db.close();
    }
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // O_EXCL 比 existsSync 的预检查更强：并发进程抢先建库时绝不覆写它。
  closeSync(openSync(target, "wx", 0o600));
  const runtime = createNodeClientRuntime({ dbPath: target });
  try {
    const counts = writeSnapshot(runtime, snapshot, source, digest);
    return { backupPath: source, targetPath: target, alreadyImported: false, counts };
  } finally {
    runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const backupPath = process.argv[2];
  const targetPath = process.argv[3];
  if (!backupPath || !targetPath) {
    process.stderr.write("用法：pnpm --filter @ebbinghaus/migration import:v1 <已核验V1在线备份> <不存在的V2数据库路径>\n");
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(importV1BackupToNewClient(backupPath, targetPath), null, 2)}\n`);
    } catch {
      // SQLite/协议异常可能夹带用户原文；命令行仅允许输出固定错误与路径。
      process.stderr.write(`导入失败；来源：${resolve(backupPath)}；目标：${resolve(targetPath)}。请核对备份与目标状态。\n`);
      process.exitCode = 1;
    }
  }
}
