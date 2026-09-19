import { defineConfig } from "vitest/config";

// @ebbinghaus/persistence 包测试配置：node 环境即可。持久化包的 SQLite 适配器
// 依赖 better-sqlite3（Node 原生模块），集成测试通过相对路径引入 server 包的
// app 工厂在 127.0.0.1 随机端口起真实服务，不发起任何外网请求。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
