/**
 * e2e 导航助手：统一封装两种外壳结构下的导航路径差异。
 *
 * 背景：第二轮表现层重构后，应用外壳按视口宽度分流（AppShell.tsx 的
 * "(max-width: 900px)" 断点，JS 驱动）：
 * - 桌面端（>900px）：恒驻玻璃侧栏，nav-* / space-switcher / theme-* 控件恒可见；
 * - 移动端（≤900px，Playwright 矩阵中的 chromium-compact 800px 与 chromium-mobile
 *   项目）：侧栏默认隐藏，导航控件收纳在抽屉内，Space 入口由顶栏恒在的
 *   topbar-space 胶囊承担。
 *
 * 用例一律经本助手的函数导航，而不是直接点 nav-* / space-switcher：
 * 同一用例在四视口矩阵下自动走对应结构的路径，spec 本体不含视口分支。
 * 判定用视口宽度而非项目名——断点是产品行为（≤900px），不是测试配置巧合。
 */

import { expect, type Page } from "@playwright/test";

/** 当前视口是否为移动端外壳（与 AppShell 的 MOBILE_QUERY 同口径）。 */
export function isMobileShell(page: Page): boolean {
  const width = page.viewportSize()?.width ?? 1024;
  return width <= 900;
}

/**
 * 确保一级导航可见：移动端点开抽屉（并等待其出现），桌面端无操作。
 * 主题切换按钮也在抽屉内，同样经此进入。
 */
export async function ensureNavVisible(page: Page): Promise<void> {
  if (!isMobileShell(page)) {
    return;
  }
  await page.getByTestId("nav-drawer-open").click();
  await expect(page.getByTestId("nav-drawer")).toBeVisible();
}

/** 一级导航到指定页面：移动端先开抽屉再点导航项（点击后抽屉自动关闭）。 */
export async function navTo(page: Page, navTestId: string): Promise<void> {
  await ensureNavVisible(page);
  await page.getByTestId(navTestId).click();
}

/**
 * 进入 Space 管理页：桌面端点侧栏 space-switcher，移动端点顶栏 topbar-space
 * 胶囊（两者路由相同，均为界面规格的"侧边栏顶部当前 Space 入口"在两种结构
 * 下的对应形态）。
 */
export async function openSpaceManagement(page: Page): Promise<void> {
  if (isMobileShell(page)) {
    await page.getByTestId("topbar-space").click();
    return;
  }
  await page.getByTestId("space-switcher").click();
}

/** 断言当前活动 Space 名称：移动端读顶栏胶囊，桌面端读侧栏入口。 */
export async function expectActiveSpace(page: Page, name: string): Promise<void> {
  const testId = isMobileShell(page) ? "topbar-space" : "space-switcher";
  await expect(page.getByTestId(testId)).toContainText(name);
}

/** 切换主题：主题开关在导航区内，移动端先开抽屉。 */
export async function setTheme(page: Page, themeTestId: string): Promise<void> {
  await ensureNavVisible(page);
  await page.getByTestId(themeTestId).click();
}

/**
 * 等指定元素的入场动画全部结束（截图前调用）：入场动画期间截图会抓到半透明
 * 残影（任务5 详情面板、移动端抽屉截图均实证）。动画 promise 被取消属正常
 * 路径（元素卸载），吞掉即可；500ms 上限防止库内常驻动画（如玻璃高光）造成
 * 永久等待——入场动画最长 200ms，上限留足余量。
 */
export async function waitAnimationsSettled(page: Page, testId: string): Promise<void> {
  const target = page.getByTestId(testId);
  await target.waitFor({ state: "visible" });
  await target.evaluate((el) => {
    const animations = el
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running" || animation.playState === "pending");
    if (animations.length === 0) {
      return Promise.resolve();
    }
    return Promise.race([
      Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(
        () => undefined,
      ),
      new Promise((resolve) => {
        setTimeout(resolve, 500);
      }),
    ]);
  });
}
