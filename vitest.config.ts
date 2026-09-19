import { defineConfig } from "vitest/config";

// 根 Vitest 配置：采用 projects 模式聚合各 workspace 包自己的 vitest 配置。
// 每个包在自己的 vitest.config.ts 中声明测试环境与用例范围，根配置只负责聚合，
// 保证 `pnpm test` 一条命令跑完全部包，且各包配置互相独立、可按需差异化管理。
// server 包（哑同步服务器）自 M2 起纳入聚合；app（React UI，jsdom 环境）自 UI-1 起纳入。
export default defineConfig({
  test: {
    projects: ["packages/*", "server", "app"],
  },
});
