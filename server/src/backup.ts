/**
 * 在线备份核心逻辑（判断文件 D3）。
 *
 * ⚠️ 禁止直接复制正在写入的数据库文件（AGENTS.md 真实数据迁移闭环）：WAL 模式下
 * 最近的写入仍留在 -wal 文件里，且复制期间写入可能交错，裸拷贝 .db 文件会得到
 * 缺失最近事务甚至页级不一致的副本。better-sqlite3 的 db.backup() 走 SQLite 在线
 * 备份 API，在存储引擎层逐页复制出事务一致快照，对运行中的库安全——本模块只用
 * 这一种备份方式。
 *
 * 备份是纯文件级操作（fs 仅用于确保输出目录存在与生成目标路径），不解读库内容。
 */

import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { openDatabase } from "./db.ts";

/**
 * 生成带时间戳的备份目标路径（UTC，秒级；同名冲突追加毫秒后缀，永不覆盖旧备份）。
 * "永不覆盖"是备份纪律：覆盖旧备份等于把唯一的历史快照暴露在单点错误之下。
 */
export function resolveBackupDestination(outDir: string, now: Date): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const primary = join(outDir, `ebbinghaus-backup-${timestamp}.db`);
  if (!existsSync(primary)) {
    return primary;
  }
  return join(outDir, `ebbinghaus-backup-${now.getTime()}.db`);
}

/**
 * 对已打开的库执行在线备份，返回备份文件绝对路径。
 * async 是 better-sqlite3 backup API 的形态（分页拷贝、可让出事件循环）。
 */
export async function backupDatabase(db: Database.Database, outDir: string, now: Date): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const destination = resolveBackupDestination(outDir, now);
  await db.backup(destination);
  return destination;
}

/**
 * 便捷入口：打开指定库（只读用途也走统一打开路径，确保迁移与 PRAGMA 一致）、
 * 备份、关闭。备份脚本使用；测试另有更精细的编排需求时直接用 backupDatabase。
 */
export async function backupDatabaseFile(dbPath: string, outDir: string, now: Date): Promise<string> {
  const db = openDatabase(dbPath);
  try {
    return await backupDatabase(db, outDir, now);
  } finally {
    // 备份是本函数对库的唯一用途，无论成败都要释放句柄。
    db.close();
  }
}
