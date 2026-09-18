import { defineConfig } from "vitest/config";

// @ebbinghaus/protocol 包测试配置：协议包是纯 TS + Zod，无 DOM 依赖，node 环境足够。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
