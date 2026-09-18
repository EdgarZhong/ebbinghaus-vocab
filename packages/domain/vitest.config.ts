import { defineConfig } from "vitest/config";

// 领域包测试配置：node 环境即可（领域层禁止依赖 DOM 与 Tauri，架构守卫测试会断言这一点）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
