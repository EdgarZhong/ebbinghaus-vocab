import Database from "better-sqlite3";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { auditV1Connection, V1_TABLES } from "../src/audit.ts";
import { createV1OnlineBackup } from "../src/backup.ts";

/** 合成旧库只含架构与虚构事件，不接触正式生产数据。 */
function createSyntheticV1(): Database.Database {
  const db = new Database(":memory:");
  for (const table of V1_TABLES) {
    if (table === "learning_events") {
      db.exec("CREATE TABLE learning_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, metadata_json TEXT NOT NULL)");
    } else {
      db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY)`);
    }
  }
  return db;
}

describe("V1 只读审计", () => {
  it("对合成旧库生成稳定计数与摘要，不输出事件内容", () => {
    const db = createSyntheticV1();
    try {
      db.prepare("INSERT INTO learning_events VALUES (?, ?, ?)").run("event-1", "testAnswered", JSON.stringify({ sample: "仅供测试" }));
      const first = auditV1Connection(db);
      const second = auditV1Connection(db);
      expect(first.counts["learning_events"]).toBe(1);
      expect(first.eventTypeCounts["testAnswered"]).toBe(1);
      expect(first.sha256["learning_events"]).toBe(second.sha256["learning_events"]);
      expect(JSON.stringify(first)).not.toContain("仅供测试");
    } finally {
      db.close();
    }
  });

  it("在迁移前拒绝非法事件 JSON", () => {
    const db = createSyntheticV1();
    try {
      db.prepare("INSERT INTO learning_events VALUES (?, ?, ?)").run("bad-event", "testAnswered", "{");
      expect(() => auditV1Connection(db)).toThrow(/不是合法 JSON/);
    } finally {
      db.close();
    }
  });

  it("使用 SQLite 在线备份生成私有权限快照并拒绝覆盖", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ebbinghaus-migration-test-"));
    const sourcePath = join(directory, "source.sqlite3");
    const destinationPath = join(directory, "backup.sqlite3");
    const db = new Database(sourcePath);
    try {
      for (const table of V1_TABLES) {
        if (table === "learning_events") {
          db.exec("CREATE TABLE learning_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, metadata_json TEXT NOT NULL)");
        } else {
          db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY)`);
        }
      }
      db.prepare("INSERT INTO learning_events VALUES (?, ?, ?)").run("event-1", "testAnswered", "{}");
    } finally {
      db.close();
    }
    chmodSync(sourcePath, 0o600);
    const backup = await createV1OnlineBackup(sourcePath, destinationPath);
    expect(backup.audit.counts["learning_events"]).toBe(1);
    expect(statSync(destinationPath).mode & 0o777).toBe(0o600);
    await expect(createV1OnlineBackup(sourcePath, destinationPath)).rejects.toThrow(/拒绝覆盖/);
  });
});
