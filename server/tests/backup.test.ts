import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";

import { backupDatabaseFile, resolveBackupDestination } from "../src/backup.ts";

import {
  createTestApp,
  makeEventPayload,
  makeSettingEntry,
  pushEvents,
} from "./helpers.ts";

/**
 * 备份专项（任务规格 8 + 判断文件 D3）：
 * - 备份脚本产出带时间戳的副本文件；
 * - 打开备份文件逐表核对：事件数与 settings 内容与主库完全一致。
 * 备份走 better-sqlite3 在线 backup API（事务一致快照），绝不裸拷贝写入中的文件。
 */
describe("在线备份", () => {
  it("备份文件产出后，打开核对事件与 settings 与主库一致（规格 8）", async () => {
    const { app, token, dbPath, close } = await createTestApp();
    try {
      // 准备权威库数据：3 条事件 + 2 条 settings。
      const { statusCode } = await pushEvents(app, token, [
        makeEventPayload(),
        makeEventPayload(),
        makeEventPayload(),
      ]);
      expect(statusCode).toBe(200);
      const settingsPut = await app.inject({
        method: "PUT",
        url: "/settings",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        payload: {
          settings: [
            makeSettingEntry(),
            makeSettingEntry({ key: "dictionary.provider", value: "wiktionary" }),
          ],
        },
      });
      expect(settingsPut.statusCode).toBe(200);

      // 在库句柄仍然打开（等同写入中的库）时执行在线备份，验证快照一致性。
      const outDir = join(dbPath, "..", "backups");
      const destination = await backupDatabaseFile(dbPath, outDir, new Date("2026-09-19T12:00:00Z"));
      expect(existsSync(destination)).toBe(true);
      expect(destination).toContain("ebbinghaus-backup-20260919T120000Z.db");

      // 只读方式打开备份，逐表与主库核对。
      const backup = new Database(destination, { readonly: true });
      const primary = new Database(dbPath, { readonly: true });
      try {
        const countIn = (database: Database.Database, table: string): number =>
          (database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;

        expect(countIn(backup, "events")).toBe(3);
        expect(countIn(backup, "events")).toBe(countIn(primary, "events"));

        const settingsIn = (database: Database.Database): Array<Record<string, unknown>> =>
          database.prepare("SELECT * FROM settings ORDER BY key").all() as Array<Record<string, unknown>>;
        expect(settingsIn(backup)).toEqual(settingsIn(primary));

        // 迁移版本记录同样被复制（库结构自描述）。
        expect(countIn(backup, "schema_migrations")).toBe(countIn(primary, "schema_migrations"));
      } finally {
        backup.close();
        primary.close();
      }
    } finally {
      close();
    }
  });

  it("备份目标路径永不覆盖：目标已存在时自动换名（毫秒后缀）", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ebb-backup-dest-"));
    const moment = new Date("2026-09-19T12:00:00Z");

    const first = resolveBackupDestination(outDir, moment);
    // 真实落一个空文件模拟"该时刻的备份已存在"（空文件不删除，随系统临时目录回收）。
    writeFileSync(first, "");

    const second = resolveBackupDestination(outDir, moment);
    expect(second).not.toBe(first);
    expect(second).toContain(String(moment.getTime()));
  });
});
