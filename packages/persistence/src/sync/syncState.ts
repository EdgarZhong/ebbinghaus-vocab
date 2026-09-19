/**
 * 拉取游标存取（sync_state.pull_cursor）。
 *
 * 游标是同步断点续传的唯一载体：每页拉取落盘一次，任意时刻崩溃/断线后重启都从
 * 断点继续，绝不重复消费已落库页（重复消费本身被 applyPulledEvents 幂等兜底，
 * 但游标推进让正常路径零浪费）。独立小类而非塞进事件仓储：游标是同步传输状态，
 * 与事件内容无关，职责分离便于单测。
 */

import type Database from "better-sqlite3";

export class SqlitePullCursorStore {
  private readonly db: Database.Database;

  private readonly readStmt;
  private readonly writeStmt;

  constructor(db: Database.Database) {
    this.db = db;
    this.readStmt = this.db.prepare(`SELECT value FROM sync_state WHERE key = 'pull_cursor'`);
    this.writeStmt = this.db.prepare(`
      UPDATE sync_state SET value = ? WHERE key = 'pull_cursor'
    `);
  }

  read(): number {
    const row = this.readStmt.get() as { readonly value: number } | undefined;
    return row === undefined ? 0 : row.value;
  }

  write(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`拉取游标必须是非负整数，收到：${value}`);
    }
    this.writeStmt.run(value);
  }
}
