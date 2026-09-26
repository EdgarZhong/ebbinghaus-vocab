import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { convertV1Connection, mapLegacySpaceId, V1_MIGRATION_DEVICE_ID } from "../src/convert.ts";

/** 仅用虚构词条构造旧库最小快照，检查映射不会改写旧行或学习事件语义。 */
function fixture(): Database.Database {
  const db = new Database(":memory:");
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
  const now = "2026-09-01T08:00:00+08:00";
  db.prepare("INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-book", "必考词", "必考词", "词书模式", 1, null, now, now);
  db.prepare("INSERT INTO units VALUES (?, ?, ?)")
    .run("11111111-1111-4111-8111-111111111111", "legacy-book", 1);
  db.prepare("INSERT INTO word_lists VALUES (?, ?, ?)")
    .run("22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111", 1);
  db.prepare("INSERT INTO words VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("33333333-3333-4333-8333-333333333333", "legacy-book", "22222222-2222-4222-8222-222222222222",
      "sample", "sample", "n. 示例", 0, now);
  db.prepare("INSERT INTO word_meanings VALUES (?, ?, ?, ?, ?, ?)")
    .run("33333333-3333-4333-8333-333333333333", "n.", "示例", null, 1, 0);
  db.prepare("INSERT INTO learning_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("44444444-4444-4444-8444-444444444444", "firstPassRecorded", "List",
      "22222222-2222-4222-8222-222222222222", now, "2026-09-01", "首过预览保存",
      JSON.stringify({ workload: 1, wordCount: 1 }));
  db.prepare("INSERT INTO user_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(1, "Asia/Shanghai", "04:00:00", "{}", "维基词典", "legacy-book", 1, 1);
  db.prepare("INSERT INTO space_learning_settings VALUES (?, ?, ?, ?, ?)")
    .run("legacy-book", 4, 20, "{}", now);
  db.prepare("INSERT INTO first_pass_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("55555555-5555-4555-8555-555555555555", "legacy-book", 2, 3,
      "sample n. 示例", 1, "草稿", null, "[]", "{}", "", now);
  return db;
}

describe("V1 快照转换", () => {
  it("Space 映射稳定且满足 UUIDv4，不改变事件原值与源库", () => {
    const db = fixture();
    try {
      const snapshot = convertV1Connection(db);
      const expectedSpaceId = mapLegacySpaceId("legacy-book");
      expect(expectedSpaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(mapLegacySpaceId("legacy-book")).toBe(expectedSpaceId);
      expect(snapshot.spaces[0]?.id).toBe(expectedSpaceId);
      expect(snapshot.units[0]?.spaceId).toBe(expectedSpaceId);
      expect(snapshot.lists[0]?.spaceId).toBe(expectedSpaceId);
      expect(snapshot.words[0]?.listId).toBe(snapshot.lists[0]?.listId);
      expect(snapshot.drafts[0]).toMatchObject({
        spaceId: expectedSpaceId, rawText: "sample n. 示例",
        candidatesJson: "[]", auditJson: "{}", deviceId: V1_MIGRATION_DEVICE_ID,
      });
      expect(snapshot.events[0]).toMatchObject({
        eventId: "44444444-4444-4444-8444-444444444444",
        eventType: "firstPassRecorded",
        occurredAt: "2026-09-01T08:00:00+08:00",
        deviceId: V1_MIGRATION_DEVICE_ID,
        deviceSeq: 1,
        metadata: { workload: 1, wordCount: 1 },
      });
      expect(snapshot.settings.find((entry) => entry.key === `space.${expectedSpaceId}.dailyTarget`)?.value).toBe(4);
      expect(snapshot.settings.find((entry) => entry.key === "learning.dayRolloverTime")?.value).toBe("04:00");
      expect(snapshot.activeSpaceId).toBe(expectedSpaceId);
      expect(snapshot.meaningFormatMismatchCount).toBe(0);
      expect((db.prepare("SELECT id FROM spaces").get() as { id: string }).id).toBe("legacy-book");
    } finally {
      db.close();
    }
  });

  it("V1 四个默认 Space 映射到 V2 固定标识，避免启动时补建重复空间", () => {
    expect(mapLegacySpaceId("space-required")).toBe("a1f0c3d4-0000-4000-8000-000000000001");
    expect(mapLegacySpaceId("space-common")).toBe("a1f0c3d4-0000-4000-8000-000000000002");
    expect(mapLegacySpaceId("space-occasional")).toBe("a1f0c3d4-0000-4000-8000-000000000003");
    expect(mapLegacySpaceId("space-daily")).toBe("a1f0c3d4-0000-4000-8000-000000000004");
  });
});
