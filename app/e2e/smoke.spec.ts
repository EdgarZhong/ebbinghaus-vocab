/**
 * 浏览器冒烟验收（真实 vite preview 服务）：
 * - 主路径：六个一级页面导航、Space 创建与切换、设置改值保存、主题切换与刷新恢复；
 * - 每个核心页面在当前视口输出全窗口 PNG 到 e2e/__screenshots__/，
 *   文件名形如 {项目名}-{页面}.png，供三视口视觉复核（界面规格测试要求）。
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const screenshotsDir = join(dirname(fileURLToPath(import.meta.url)), "__screenshots__");

/** 全窗口截图（视口即完整浏览器窗口），按项目名+页面键落盘。 */
async function screenshot(page: Page, key: string): Promise<void> {
  const projectName = test.info().project.name;
  await page.screenshot({ path: join(screenshotsDir, `${projectName}-${key}.png`) });
}

test.beforeAll(() => {
  mkdirSync(screenshotsDir, { recursive: true });
});

const NAV_PAGES: readonly { navTestId: string; heading: string | RegExp; key: string }[] = [
  { navTestId: "nav-today", heading: /今天/, key: "today" },
  { navTestId: "nav-review", heading: "复习", key: "review" },
  { navTestId: "nav-test", heading: "测试", key: "test" },
  { navTestId: "nav-first-pass", heading: "首过录入", key: "first-pass" },
  { navTestId: "nav-vocabulary", heading: "词汇", key: "vocabulary" },
  { navTestId: "nav-settings", heading: "设置", key: "settings" },
];

test("六个一级页面导航冒烟并输出全窗口截图", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("space-switcher")).toContainText("必考词");

  for (const item of NAV_PAGES) {
    await page.getByTestId(item.navTestId).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(item.heading);
    await screenshot(page, item.key);
  }
});

test("Space 管理：创建、切换并返回原页面", async ({ page }) => {
  await page.goto("/");
  // 从设置页进入 Space 管理，验证"返回进入前页面"的语义。
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("space-switcher").click();
  await expect(page.getByRole("heading", { level: 1, name: "Space 管理" })).toBeVisible();

  await page.getByTestId("create-space-button").click();
  await page.getByTestId("space-name-input").fill("浏览器验收空间");
  await screenshot(page, "space-create-dialog");
  await page.getByTestId("space-create-submit").click();

  // 创建成功后返回设置页，侧边栏与短暂反馈同步更新。
  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  await expect(page.getByTestId("space-switcher")).toContainText("浏览器验收空间");
  // Toast 会堆叠（产品语义），断言最新一条。
  await expect(page.getByTestId("toast").last()).toContainText("已创建并切换到浏览器验收空间");

  // 重新进入 Space 管理页并切换回必考词。
  await page.getByTestId("space-switcher").click();
  await screenshot(page, "space-management");
  await page.getByTestId("space-select-必考词").click();
  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  await expect(page.getByTestId("space-switcher")).toContainText("必考词");
  await expect(page.getByTestId("toast").last()).toContainText("已切换到必考词");
});

test("设置：修改换日时间并保存成功", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("settings-timezone")).toHaveValue("Asia/Shanghai");

  await page.getByTestId("settings-rollover").fill("05:30");
  await page.getByTestId("settings-daily-target").fill("10");
  await screenshot(page, "settings-editing");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-status")).toContainText("设置已保存。");
  await screenshot(page, "settings-saved");
});

test("主题：切换深色并跨刷新恢复", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await screenshot(page, "today-dark");

  // 主题选择存设备本地 KV（浏览器底座为 localStorage），刷新后保持。
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
