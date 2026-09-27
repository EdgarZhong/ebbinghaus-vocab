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
  const routeByNav: Readonly<Record<string, string>> = {
    "nav-today": "/today", "nav-review": "/review", "nav-test": "/test",
    "nav-first-pass": "/first-pass", "nav-vocabulary": "/vocabulary", "nav-settings": "/settings",
  };
  await ensureNavVisible(page);
  await page.getByTestId(navTestId).click();
  const route = routeByNav[navTestId];
  if (route !== undefined) await expect(page.locator("main.main-area")).toHaveAttribute("data-ready-route", route);
}

/**
 * 进入 Space 管理页：桌面端点侧栏 space-switcher，移动端点顶栏 topbar-space
 * 胶囊（两者路由相同，均为界面规格的"侧边栏顶部当前 Space 入口"在两种结构
 * 下的对应形态）。
 */
export async function openSpaceManagement(page: Page): Promise<void> {
  if (isMobileShell(page)) {
    await page.getByTestId("topbar-space").click();
  } else {
    await page.getByTestId("space-switcher").click();
  }
  // 等待路由切换到位：调用方常紧跟截图，点击即返会拍到进入前页面
  // （space-management 截图曾实测拍到设置页 + 创建 toast 的竞态残影）。
  await expect(page.getByRole("heading", { level: 1, name: "Space 管理" })).toBeVisible();
  await expect(page.locator("main.main-area")).toHaveAttribute("data-ready-route", "/spaces");
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
 * 主题切到深色后，等侧栏玻璃底色完成过渡再截图（截图用例专用）。
 * liquid-glass-react 给 .glass 内联了 transition: all 0.2s，主题翻转瞬间截图
 * 会抓到浅色底 → 深色底过渡中途的奶灰（桌面 today-dark 截图在 headless 与
 * headed 下都实证复现，时快时慢故呈"偶发"）。轮询计算底色直到等于深色令牌；
 * WebKit 降级路径无过渡，首轮轮询即命中。移动端截图时抽屉已收起、页面无玻璃
 * 元素，无此竞态。
 */
export async function waitDarkGlassSettled(page: Page): Promise<void> {
  if (isMobileShell(page)) {
    return;
  }
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.querySelector(".sidebar-glass .glass, .sidebar-glass.glass-fallback");
        return el === null ? null : getComputedStyle(el).backgroundColor;
      }),
    )
    .toBe("rgba(24, 32, 25, 0.55)");
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
      .filter((animation) => animation.playState === "running");
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
