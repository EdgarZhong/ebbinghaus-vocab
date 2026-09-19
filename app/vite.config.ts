/**
 * app 的 Vite / Vitest 统一配置。
 *
 * 单文件承担两种职责的理由：本应用的测试环境（jsdom + Testing Library）与构建
 * （react 插件 + persistence 源码别名）共享完全相同的解析规则，拆成两个文件只会
 * 造成别名漂移。根 vitest.config.ts 以 projects 模式把本目录纳入聚合（`pnpm test`
 * 一条命令跑全仓），Vitest 会在本目录自动找到该 vite.config.ts。
 */
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * @ebbinghaus/persistence 的包根出口包含 SQLite/better-sqlite3 实现（Node 专属），
 * 浏览器包只允许引入其中浏览器安全的子模块（内存运行时、系统时钟、密钥透传）。
 * 这里把 `@ebbinghaus/persistence/src/*` 前缀别名到包源码目录，与 app/tsconfig.json
 * 的 paths 保持同一映射，避免 TypeScript 与 Vite 对同一导入解析出不同文件。
 */
const persistenceSrc = fileURLToPath(new URL("../packages/persistence/src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ebbinghaus/persistence/src": persistenceSrc,
    },
  },
  test: {
    // 组件状态与交互测试在 jsdom 中运行（AGENTS.md 测试要求：Vitest + Testing Library）。
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
