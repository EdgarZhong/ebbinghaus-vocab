import { defineConfig } from "vitest/config";

// 应用层包测试配置：node 环境即可（应用层禁止依赖 DOM 与 Tauri，架构守卫测试会断言
// 这一点；全部端口用内存假实现注入，测试不做任何真实 IO）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
