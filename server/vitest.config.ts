import { defineConfig } from "vitest/config";

// @ebbinghaus/server 包测试配置：服务器是纯 Node 侧程序（无 DOM），node 环境足够。
// 测试以 fastify.inject 为主（不占端口、速度快），另有一个真实 listen 的集成
// 测试文件覆盖完整 HTTP 栈（含压缩与鉴权在真实 socket 上的行为）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
