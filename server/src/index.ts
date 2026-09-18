/**
 * 服务器进程入口（`pnpm --filter @ebbinghaus/server start` 或 tsx src/index.ts）。
 *
 * 职责只有组合与生命周期：解析启动配置 → fail fast 校验 token → 打开库 →
 * buildApp → listen → 信号收尾。任何业务决策都不得出现在这里。
 */

import { buildApp } from "./app.ts";
import { loadServerConfig } from "./config.ts";
import { openDatabase } from "./db.ts";

// CLI 参数与 env 的优先级见 config.ts；token 无默认值。
const config = loadServerConfig(process.argv.slice(2), process.env);

if (config.authToken === undefined || config.authToken.length === 0) {
  // fail fast：无鉴权令牌绝不启动（判断文件 D1；避免裸奔部署暴露全部数据）。
  console.error(
    "[server] 缺少 Bearer 访问令牌：请通过 --token=<token> 或环境变量 EBB_SERVER_TOKEN 提供，拒绝启动",
  );
  process.exit(1);
}

const db = openDatabase(config.dbPath);
const app = await buildApp({ db, authToken: config.authToken, logger: true });

/** 优雅收尾：先停 HTTP（不再接受新请求），再关库（WAL checkpoint 落盘）。 */
async function shutdown(): Promise<void> {
  await app.close();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`[server] 已监听 http://${config.host}:${config.port}（库：${config.dbPath}）`);
} catch (error) {
  console.error("[server] 启动失败：", error);
  db.close();
  process.exit(1);
}
