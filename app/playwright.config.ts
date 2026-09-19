/**
 * Playwright 浏览器验收矩阵（界面规格 v2 测试要求）：
 * - chromium-desktop：1100×760 桌面标准视口；
 * - chromium-compact：800×600 收窄视口（列表收窄与布局压缩回归）；
 * - webkit-desktop：1100×760 的 WebKit 内核（macOS 真实内核代理）。
 *
 * 视口含 chromium mobile（Pixel 7 形态，Android 布局回归）。
 * 冒烟运行在真实的 `vite preview` 服务上（构建产物，而非 dev server）；
 * 每个核心页面输出全窗口 PNG 到 e2e/__screenshots__/ 供视觉复核。
 * 浏览器二进制下载走国内镜像（环境变量由安装命令注入，见 README 记录）。
 */
import { defineConfig, devices } from "@playwright/test";

const previewPort = 4173;

export default defineConfig({
  testDir: "./e2e",
  // 冒烟失败即停，避免同一页面在三视口下重复报错淹没根因。
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${previewPort}`,
    // 截图仅作为证据产物（page.screenshot 显式落盘），失败自动截图辅助定位。
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  expect: {
    timeout: 10_000,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1100, height: 760 } },
    },
    {
      name: "chromium-compact",
      use: { ...devices["Desktop Chrome"], viewport: { width: 800, height: 600 } },
    },
    {
      name: "webkit-desktop",
      use: { ...devices["Desktop Safari"], viewport: { width: 1100, height: 760 } },
    },
    {
      // Chromium mobile 视口（AGENTS.md 测试矩阵要求；Android 形态的布局与触达回归）。
      name: "chromium-mobile",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    // 显式绑定 127.0.0.1：vite preview 默认只绑 localhost（::1），Playwright 的
    // baseURL 用 IPv4 127.0.0.1，不指定 host 会 ERR_CONNECTION_REFUSED。
    command: `pnpm exec vite preview --port ${previewPort} --strictPort --host 127.0.0.1`,
    port: previewPort,
    // 本地复用已启动的 preview；CI 环境必须由本配置自行拉起，避免连到未知服务。
    reuseExistingServer: process.env["CI"] === undefined ? true : false,
    timeout: 120_000,
  },
});
