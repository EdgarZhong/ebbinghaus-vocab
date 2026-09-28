/**
 * 约 360×792 CSS px 的 Android 小手机布局回归。
 * 模拟原生状态栏注入 24px inset，逐项量测可触达尺寸和横向溢出；真实软键盘、
 * 系统栏绘制与后台恢复仍由 Android 模拟器验收，浏览器用例不冒充 WebView。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { navTo, openSpaceManagement, waitAnimationsSettled } from "./nav.ts";

test.use({ viewport: { width: 360, height: 792 } });

test("360px 顶栏、抽屉、长 Space 名称与六个页面保持可读可点", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => document.documentElement.style.setProperty("--android-status-inset", "24px"));

  // 手机环境同时检查 CSS 布局视口，避免设备元信息与页面 viewport 配置不一致
  // 时把实际 980px 布局误判成 360px 适配已通过。
  expect(await page.evaluate(() => ({ width: window.innerWidth, narrow: matchMedia("(max-width: 375px)").matches })))
    .toEqual({ width: 360, narrow: true });

  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      body: style.getPropertyValue("--font-size-body").trim(),
      item: style.getPropertyValue("--font-size-item").trim(),
      section: style.getPropertyValue("--font-size-section").trim(),
      pageTitle: style.getPropertyValue("--font-size-page-title").trim(),
      secondary: style.getPropertyValue("--font-size-secondary").trim(),
      margin: style.getPropertyValue("--page-margin").trim(),
      gap: style.getPropertyValue("--block-gap").trim(),
    };
  });
  expect(tokens).toEqual({
    body: "14px", item: "15px", section: "17px", pageTitle: "23px",
    secondary: "13px", margin: "16px", gap: "16px",
  });

  const menu = await page.getByTestId("nav-drawer-open").boundingBox();
  const title = await page.locator(".topbar-app-name").boundingBox();
  const capsule = await page.getByTestId("topbar-space").boundingBox();
  const topbar = await page.locator(".topbar").boundingBox();
  expect(menu).not.toBeNull();
  expect(title).not.toBeNull();
  expect(capsule).not.toBeNull();
  expect(topbar).not.toBeNull();
  expect(topbar!.height).toBe(72); // 24px 状态栏 + 48px 顶栏
  expect(menu!.width).toBeGreaterThanOrEqual(44);
  expect(menu!.height).toBeGreaterThanOrEqual(44);
  expect(capsule!.height).toBeGreaterThanOrEqual(44);
  expect(title!.x - (menu!.x + menu!.width)).toBeLessThanOrEqual(12);
  expect(capsule!.x + capsule!.width).toBeLessThanOrEqual(352);
  expect(await page.locator(".topbar-app-name").evaluate((node) => getComputedStyle(node).textAlign)).toBe("left");

  const orderMeta = page.getByTestId("today-order-test").locator(".order-row-meta");
  const orderButton = page.getByTestId("today-order-test").getByRole("button");
  const metaBox = await orderMeta.boundingBox();
  const buttonBox = await orderButton.boundingBox();
  expect(metaBox!.height).toBeLessThanOrEqual(24); // "暂无待测任务"保持单行
  expect(buttonBox!.y).toBeGreaterThanOrEqual(metaBox!.y + metaBox!.height);
  expect(buttonBox!.height).toBeGreaterThanOrEqual(44);

  const screenshotsDir = join(dirname(fileURLToPath(import.meta.url)), "__screenshots__");
  await page.screenshot({ path: join(screenshotsDir, `${test.info().project.name}-small-phone-today.png`) });

  await page.getByTestId("nav-drawer-open").click();
  await waitAnimationsSettled(page, "nav-drawer");
  const drawer = await page.getByTestId("nav-drawer").boundingBox();
  expect(drawer).not.toBeNull();
  expect(drawer!.y).toBe(28); // 24px 状态栏 + 4px 抽屉间距
  const nav = await page.getByTestId("nav-review").boundingBox();
  const theme = await page.getByTestId("theme-system").boundingBox();
  expect(nav!.height).toBeGreaterThanOrEqual(44);
  expect(theme!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: join(screenshotsDir, `${test.info().project.name}-small-phone-drawer.png`) });
  await page.keyboard.press("Escape");

  // 长名称不得扩大胶囊或整个页面；可见文案在胶囊内省略，完整名称保留在
  // aria-label，供读屏用户辨识当前 Space。
  await openSpaceManagement(page);
  await page.getByTestId("create-space-button").click();
  await page.getByTestId("space-name-input").fill("用于三百六十像素小手机验收的特别长学习空间名称");
  await page.getByTestId("space-create-submit").click();
  const spaceButton = page.getByTestId("topbar-space");
  await expect(spaceButton).toHaveAttribute("aria-label", /特别长学习空间名称/);
  const label = spaceButton.locator(".topbar-space-label");
  expect(await label.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  const longCapsule = await spaceButton.boundingBox();
  expect(longCapsule!.x + longCapsule!.width).toBeLessThanOrEqual(352);

  for (const navId of ["nav-today", "nav-review", "nav-test", "nav-first-pass", "nav-vocabulary", "nav-settings"]) {
    await navTo(page, navId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  }

  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    expect(await spaceButton.evaluate((node) => getComputedStyle(node).getPropertyValue("-webkit-tap-highlight-color"))).toBe("rgba(0, 0, 0, 0)");
  }
});

test("376px 及以上继续使用原有字号和页边距", async ({ page }) => {
  await page.setViewportSize({ width: 376, height: 792 });
  await page.goto("/");
  const values = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ["--font-size-body", "--font-size-page-title", "--page-margin", "--topbar-height"]
      .map((name) => style.getPropertyValue(name).trim());
  });
  expect(values).toEqual(["15px", "26px", "24px", "56px"]);
});
