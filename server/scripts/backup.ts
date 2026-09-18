/**
 * 在线备份 CLI（`pnpm --filter @ebbinghaus/server backup`）。
 *
 * 只是 src/backup.ts 的命令行壳：参数解析、默认值推导与输出打印；备份本体
 * （SQLite 在线备份 API、事务一致快照、永不覆盖旧备份）见 src/backup.ts。
 *
 * 用法：
 *   tsx scripts/backup.ts --db=/path/to/ebbinghaus.db --out-dir=/path/to/backups
 * 参数缺省时：db 取启动配置解析结果（CLI --db > 环境变量 > 包内 data/ 默认路径）；
 * out-dir 取 CLI --out-dir > 环境变量 EBB_SERVER_BACKUP_DIR > 库文件同目录。
 */

import { dirname } from "node:path";

import { backupDatabaseFile } from "../src/backup.ts";
import { loadServerConfig } from "../src/config.ts";

function main(): void {
  const config = loadServerConfig(process.argv.slice(2), process.env);

  const outDir =
    readArgValue("out-dir") ?? process.env["EBB_SERVER_BACKUP_DIR"] ?? dirname(config.dbPath);

  backupDatabaseFile(config.dbPath, outDir, new Date())
    .then((destination) => {
      console.log(`[backup] 备份完成：${destination}`);
    })
    .catch((error: unknown) => {
      console.error("[backup] 备份失败：", error);
      process.exit(1);
    });
}

/** 读取 `--key=value` 形态的 CLI 参数值。 */
function readArgValue(key: string): string | undefined {
  const prefix = `--${key}=`;
  const arg = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return arg === undefined ? undefined : arg.slice(prefix.length);
}

main();
