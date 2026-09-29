import Database from "better-sqlite3";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { auditV1Database, V1_TABLES } from "../src/audit.ts";
import { createV1OnlineBackup } from "../src/backup.ts";
import { mapLegacySpaceId } from "../src/convert.ts";
import { importV1BackupToNewClient } from "../src/import.ts";

/**
 * 只用虚构内容建立与转换器列名相同的最小 V1 文件。审计要求全部正式表存在，
 * 未参与迁移的派生表留空，用以模拟“已核验在线备份”的完整结构入口。
 */
function makeV1File(sourcePath: string, invalidWord = false): void {
  const db = new Database(sourcePath);
  try {
    const detailedTables = new Set([
      "spaces", "units", "word_lists", "words", "word_meanings", "learning_events",
      "user_settings", "space_learning_settings", "first_pass_drafts",
    ]);
    for (const table of V1_TABLES) {
      if (!detailedTables.has(table)) db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY)`);
    }
    db.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, kind TEXT, name TEXT, learning_mode TEXT,
        display_order INTEGER, archived_at TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE units (id TEXT PRIMARY KEY, space_id TEXT, number INTEGER);
      CREATE TABLE word_lists (id TEXT PRIMARY KEY, unit_id TEXT, number INTEGER);
      CREATE TABLE words (id TEXT PRIMARY KEY, space_id TEXT, list_id TEXT,
        original_spelling TEXT, normalized_key TEXT, manual_meaning TEXT,
        is_removed INTEGER, updated_at TEXT);
      CREATE TABLE word_meanings (word_id TEXT, part_of_speech TEXT, definition TEXT,
        usage TEXT, display_order INTEGER, is_removed INTEGER);
      CREATE TABLE learning_events (id TEXT PRIMARY KEY, event_type TEXT,
        target_type TEXT, target_id TEXT, occurred_at TEXT, learning_day TEXT,
        source TEXT, metadata_json TEXT);
      CREATE TABLE user_settings (id INTEGER PRIMARY KEY, timezone_name TEXT,
        learning_day_rollover_time TEXT, scheduler_parameters_json TEXT,
        dictionary_provider TEXT, active_space_id TEXT,
        smart_organizing_enabled INTEGER, online_dictionary_enabled INTEGER);
      CREATE TABLE space_learning_settings (space_id TEXT, daily_target INTEGER,
        regular_group_size INTEGER, fsrs_parameters_json TEXT, updated_at TEXT);
      CREATE TABLE first_pass_drafts (id TEXT PRIMARY KEY, space_id TEXT,
        unit_number INTEGER, list_number INTEGER, raw_text TEXT,
        use_language_model INTEGER, status TEXT, last_error TEXT,
        candidates_json TEXT, audit_json TEXT, unresolved_description TEXT,
        updated_at TEXT);
    `);
    const at = "2026-09-01T08:00:00+08:00";
    const unitId = "11111111-1111-4111-8111-111111111111";
    const listId = "22222222-2222-4222-8222-222222222222";
    const wordId = "33333333-3333-4333-8333-333333333333";
    db.prepare("INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-book", "必考词", "必考词", "词书模式", 1, null, at, at);
    db.prepare("INSERT INTO units VALUES (?, ?, ?)").run(unitId, "legacy-book", 1);
    db.prepare("INSERT INTO word_lists VALUES (?, ?, ?)").run(listId, unitId, 1);
    db.prepare("INSERT INTO words VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(wordId, "legacy-book", listId, invalidWord ? "" : "sample", "sample", "n. 示例", 0, at);
    db.prepare("INSERT INTO word_meanings VALUES (?, ?, ?, ?, ?, ?)")
      .run(wordId, "n.", "示例", null, 1, 0);
    db.prepare("INSERT INTO learning_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("44444444-4444-4444-8444-444444444444", "firstPassRecorded", "List",
        listId, at, "2026-09-01", "首过预览保存", JSON.stringify({ workload: 1, wordCount: 1 }));
    db.prepare("INSERT INTO user_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(1, "Asia/Shanghai", "04:00", "{}", "维基词典", "legacy-book", 1, 1);
    db.prepare("INSERT INTO space_learning_settings VALUES (?, ?, ?, ?, ?)")
      .run("legacy-book", 4, 20, "{}", at);
    db.prepare("INSERT INTO first_pass_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("55555555-5555-4555-8555-555555555555", "legacy-book", 2, 3,
        "sample n. 示例", 1, "草稿", null, "[]", "{}", "", at);
  } finally {
    db.close();
  }
}

describe("V1 在线备份导入全新 V2 工作库", () => {
  it("完整导入、出站队列和历史事件逐条对账；重试只读且源备份不变", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ebbinghaus-v1-import-"));
    const source = join(directory, "source.sqlite3");
    const backup = join(directory, "verified-backup.sqlite3");
    const target = join(directory, "new-v2.sqlite3");
    makeV1File(source);
    await createV1OnlineBackup(source, backup);
    const before = auditV1Database(backup);

    const imported = importV1BackupToNewClient(backup, target);
    expect(imported.alreadyImported).toBe(false);
    expect(imported.counts).toEqual({ spaces: 1, units: 1, lists: 1, words: 1,
      drafts: 1, events: 1, settings: 9, eventOutbox: 10, contentOutbox: 4 });
    expect(JSON.stringify(imported)).not.toContain("sample");
    const db = new Database(target, { readonly: true, fileMustExist: true });
    try {
      const event = db.prepare("SELECT * FROM learning_events").get() as Record<string, unknown>;
      expect(event["event_id"]).toBe("44444444-4444-4444-8444-444444444444");
      expect(event["occurred_at"]).toBe("2026-09-01T08:00:00+08:00");
      expect(event["metadata_json"]).toBe(JSON.stringify({ workload: 1, wordCount: 1 }));
      expect(db.prepare("SELECT value FROM device_local_kv WHERE key = 'activeSpaceId'").get())
        .toEqual({ value: mapLegacySpaceId("legacy-book") });
      expect((db.prepare("SELECT payload_json FROM content_outbox WHERE entity_type = 'word'").get() as { payload_json: string })
        .payload_json).toContain("sample");
      // V1 草稿正文仍留在迁入设备，任何待推内容行都不得携带未提交原文。
      expect(db.prepare("SELECT raw_text FROM first_pass_drafts").get()).toEqual({ raw_text: "sample n. 示例" });
      expect(db.prepare("SELECT 1 FROM content_outbox WHERE entity_type = 'draft'").get()).toBeUndefined();
    } finally {
      db.close();
    }
    expect(auditV1Database(backup).sha256).toEqual(before.sha256);
    const bytes = readFileSync(target);
    const retried = importV1BackupToNewClient(backup, target);
    expect(retried).toEqual({ ...imported, alreadyImported: true });
    expect(readFileSync(target)).toEqual(bytes);
  });

  it("拒绝任何非本次已完成导入的既有目标，原文件保持不变", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ebbinghaus-v1-import-existing-"));
    const source = join(directory, "source.sqlite3");
    const backup = join(directory, "verified-backup.sqlite3");
    const target = join(directory, "existing.sqlite3");
    makeV1File(source);
    await createV1OnlineBackup(source, backup);
    const targetDb = new Database(target);
    targetDb.exec("CREATE TABLE preserved (value TEXT)");
    targetDb.prepare("INSERT INTO preserved VALUES (?)").run("untouched");
    targetDb.close();
    const before = readFileSync(target);
    expect(() => importV1BackupToNewClient(backup, target)).toThrow();
    expect(readFileSync(target)).toEqual(before);
  });

  it("内容协议拒绝坏词条时回滚全部业务记录与导入标记", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ebbinghaus-v1-import-rollback-"));
    const source = join(directory, "source.sqlite3");
    const backup = join(directory, "verified-backup.sqlite3");
    const target = join(directory, "new-v2.sqlite3");
    makeV1File(source, true);
    await createV1OnlineBackup(source, backup);
    expect(() => importV1BackupToNewClient(backup, target)).toThrow();
    const db = new Database(target, { readonly: true, fileMustExist: true });
    try {
      for (const table of ["spaces", "study_units", "list_catalog", "word_contents",
        "first_pass_drafts", "learning_events", "synced_settings", "outbox", "content_outbox"]) {
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
      }
      expect(db.prepare("SELECT value FROM device_local_kv WHERE key = 'migration.v1.sourceDigest'").get())
        .toBeUndefined();
    } finally {
      db.close();
    }
  });
});
