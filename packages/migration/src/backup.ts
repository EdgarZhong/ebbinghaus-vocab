/**
 * V1 SQLite 在线备份。
 *
 * 正式库可能仍被 V1 进程打开，禁止直接复制数据库文件及其 WAL 边车；
 * better-sqlite3 的 backup API 通过 SQLite 在线备份协议取得一致快照。
 * 工具只创建新文件，绝不覆盖或删除既有备份。迁移切换窗口内再次审计源库，
 * 若备份期间仍发生写入则拒绝把该备份标为最终切换快照。
 */

import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { auditV1Database, type V1Audit } from "./audit.ts";

export interface OnlineBackupResult {
  readonly destinationPath: string;
  readonly audit: V1Audit;
}

/** 审计值相等才说明源库、目标备份逐表完全相同；对象键序由固定表白名单决定。 */
function sameAudit(left: V1Audit, right: V1Audit): boolean {
  return JSON.stringify(left.counts) === JSON.stringify(right.counts)
    && JSON.stringify(left.sha256) === JSON.stringify(right.sha256);
}

export async function createV1OnlineBackup(
  sourcePath: string,
  destinationPath: string,
): Promise<OnlineBackupResult> {
  if (existsSync(destinationPath)) {
    throw new Error("目标备份文件已存在，拒绝覆盖");
  }
  const before = auditV1Database(sourcePath);
  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    source.pragma("query_only = ON");
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
  // 备份包含个人学习内容与可能的旧版设备密文配置，最小化本机文件权限。
  chmodSync(destinationPath, 0o600);

  const backupAudit = auditV1Database(destinationPath);
  const after = auditV1Database(sourcePath);
  if (!sameAudit(before, after)) {
    throw new Error("在线备份期间 V1 源库发生写入；保留备份供审计，停止切换并重新选择维护窗口");
  }
  if (!sameAudit(before, backupAudit)) {
    throw new Error("在线备份与 V1 源库逐表摘要不一致；停止迁移并保留源库与备份");
  }
  return { destinationPath, audit: backupAudit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourcePath = process.argv[2];
  const destinationPath = process.argv[3];
  if (!sourcePath || !destinationPath) {
    throw new Error("请提供 V1 源库路径和一个尚不存在的目标备份路径");
  }
  const result = await createV1OnlineBackup(sourcePath, destinationPath);
  // 输出位置与不可逆摘要，不输出库中任何原始词条、转写或凭证。
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
