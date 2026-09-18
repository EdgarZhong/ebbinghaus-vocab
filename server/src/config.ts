/**
 * 服务器启动配置解析。
 *
 * 口径（任务简报 + 判断文件 D1）：
 * - 库文件路径绝不写死在业务代码里：CLI 参数 > 环境变量 > 默认值（server 包运行
 *   目录下的 data/ 子目录）。CLI 与 env 的键名单独常量化，避免散落字符串。
 * - Bearer token 只来自启动配置（env 或 CLI），个人自用第一版无账号系统；
 *   token 绝不进仓库、不写日志、不出现在任何错误响应中。
 * - 生产入口（index.ts）在 token 缺失时拒绝启动（fail fast），防止裸奔部署；
 *   测试注入随机 token 不走本函数。
 *
 * fs 在本模块的用途仅限：确保默认数据目录存在（mkdir recursive）。这是启动配置
 * 职责的一部分（路径解析与目录准备），不涉及任何业务数据读写。
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 服务器运行配置。 */
export interface ServerConfig {
  /** SQLite 权威库文件路径。 */
  readonly dbPath: string;
  /** Bearer 访问令牌。 */
  readonly authToken: string;
  /** 监听地址（本地测试默认回环地址，绝不默认暴露到外网）。 */
  readonly host: string;
  /** 监听端口。 */
  readonly port: number;
}

/** 本 server 包根目录（package.json 所在目录），用于解析默认 data/ 路径。 */
function resolvePackageRoot(importMetaUrl: string): string {
  // src/config.ts 位于 <root>/src/ 下，向上一级即包根。
  return dirname(dirname(fileURLToPath(importMetaUrl)));
}

/**
 * 从 CLI 参数（`--key=value` 形态）提取配置值。
 * 手写解析而非引第三方 CLI 库：参数总量个位数，避免多余依赖。
 */
function readCliArgs(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const separator = arg.indexOf("=");
    if (separator < 0) continue;
    const key = arg.slice(2, separator);
    const value = arg.slice(separator + 1);
    if (key.length > 0 && value.length > 0) {
      parsed.set(key, value);
    }
  }
  return parsed;
}

/**
 * 解析启动配置。
 * 优先级：CLI 参数 > 环境变量 > 默认值；token 无默认值（由调用方决定缺省行为：
 * 生产入口 fail fast，测试自行注入随机 token）。
 */
export function loadServerConfig(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { packageRoot?: string; importMetaUrl?: string } = {},
): Omit<ServerConfig, "authToken"> & { authToken?: string } {
  const cli = readCliArgs(args);
  const packageRoot =
    options.packageRoot ?? (options.importMetaUrl ? resolvePackageRoot(options.importMetaUrl) : resolvePackageRoot(import.meta.url));

  const dbPath = cli.get("db") ?? env["EBB_SERVER_DB_PATH"] ?? join(packageRoot, "data", "ebbinghaus.db");
  const authToken = cli.get("token") ?? env["EBB_SERVER_TOKEN"];
  const host = cli.get("host") ?? env["EBB_SERVER_HOST"] ?? "127.0.0.1";
  const portRaw = cli.get("port") ?? env["EBB_SERVER_PORT"] ?? "8787";

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`端口配置非法：${portRaw}（必须是 1-65535 的整数）`);
  }

  // 默认路径指向包内 data/ 时才确保目录存在；外部显式路径的目录准备交给调用方
  // （部署环境自行决定数据目录位置与权限，服务器只认最终文件路径）。
  if (dbPath === join(packageRoot, "data", "ebbinghaus.db")) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  return { dbPath, authToken, host, port };
}
