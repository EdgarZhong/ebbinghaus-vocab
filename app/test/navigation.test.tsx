/**
 * 导航与外壳测试：一级导航切换、页面标题焦点播报、空态文案与快捷键。
 * 使用内存运行时 + 确定性时钟，每个用例独立服务实例。
 *
 * 移动端用例通过 stub window.matchMedia 模拟 ≤900px 视口（jsdom 本身不提供
 * matchMedia，不 stub 时外壳稳定走桌面结构——上面桌面用例因此不受影响）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { renderApp } from "./helpers.tsx";
import { screen, within } from "@testing-library/react";

/**
 * 模拟移动端视口：仅 "(max-width: 900px)" 查询返回 matches=true，其余查询
 * （如 theme.ts 的 prefers-color-scheme）一律 false（按浅色/不支持处理），
 * 保证主题解析与外壳断点判定互不干扰。change 事件监听在测试中不需要，给空实现。
 */
function stubMobileMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => {
    return {
      matches: query === "(max-width: 900px)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
}

describe("应用外壳与一级导航", () => {
  it("首次初始化后默认进入今日页，侧边栏显示当前 Space", () => {
    renderApp();
    // 首次初始化创建四个默认 Space 并激活第一个（必考词）。
    expect(screen.getByTestId("space-switcher")).toHaveTextContent("必考词");
    expect(screen.getByRole("heading", { level: 1, name: /今天/ })).toBeInTheDocument();
    expect(screen.getByTestId("nav-today")).toHaveAttribute("aria-current", "page");
  });

  it("点击导航切换页面，页面标题获得焦点并显示对应空态文案", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByTestId("nav-review"));
    const reviewTitle = screen.getByRole("heading", { level: 1, name: "复习" });
    expect(reviewTitle).toHaveFocus();
    expect(screen.getByText("今天没有需要复习的 List")).toBeInTheDocument();
    expect(screen.getByText("有新的复习任务时，会显示在这里。")).toBeInTheDocument();

    await user.click(screen.getByTestId("nav-test"));
    expect(screen.getByRole("heading", { level: 1, name: "测试" })).toBeInTheDocument();
    expect(screen.getByText("今天没有需要测试的 List")).toBeInTheDocument();

    await user.click(screen.getByTestId("nav-first-pass"));
    expect(screen.getByRole("heading", { level: 1, name: "首过录入" })).toBeInTheDocument();

    await user.click(screen.getByTestId("nav-vocabulary"));
    expect(screen.getByRole("heading", { level: 1, name: "词汇" })).toBeInTheDocument();
    expect(screen.getByText("还没有录入任何词")).toBeInTheDocument();

    await user.click(screen.getByTestId("nav-settings"));
    expect(screen.getByRole("heading", { level: 1, name: "设置" })).toBeInTheDocument();
    expect(screen.getByTestId("nav-settings")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("nav-today")).not.toHaveAttribute("aria-current");
  });

  it("快捷键 Ctrl/Cmd+数字 切换到对应页面", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.keyboard("{Control>}2{/Control}");
    expect(screen.getByRole("heading", { level: 1, name: "复习" })).toBeInTheDocument();
    await user.keyboard("{Control>}{,}{/Control}");
    expect(screen.getByRole("heading", { level: 1, name: "设置" })).toBeInTheDocument();
  });

  it("Space 切换器可打开 Space 管理页", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByTestId("space-switcher"));
    expect(screen.getByRole("heading", { level: 1, name: "Space 管理" })).toBeInTheDocument();
    // 侧边栏导航仍然可见（Space 管理在主内容区打开，不遮蔽外壳）。
    expect(screen.getByTestId("nav-today")).toBeInTheDocument();
  });

  it("今日页空态提供录入入口且可跳转首过录入", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(screen.getByText("今天的任务完成了")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "录入新 List" }));
    expect(screen.getByRole("heading", { level: 1, name: "首过录入" })).toBeInTheDocument();
  });

  it("主题切换控件在侧边栏可用", () => {
    renderApp();
    const toggle = screen.getByTestId("theme-toggle");
    expect(within(toggle).getByTestId("theme-system")).toHaveAttribute("aria-pressed", "true");
    expect(within(toggle).getByTestId("theme-light")).toBeInTheDocument();
    expect(within(toggle).getByTestId("theme-dark")).toBeInTheDocument();
  });
});

describe("移动端导航抽屉（≤900px）", () => {
  // 每个用例结束后还原 matchMedia stub，避免影响本文件其他（桌面）用例；
  // body 滚动锁的恢复由组件自身负责，这里仅兜底防御失败用例的残留。
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.style.overflow = "";
  });

  it("默认无抽屉：顶栏提供汉堡按钮与当前 Space 胶囊，无恒驻侧栏", () => {
    stubMobileMatchMedia();
    renderApp();
    expect(screen.getByTestId("nav-drawer-open")).toBeInTheDocument();
    expect(screen.getByTestId("topbar-space")).toHaveTextContent("必考词");
    expect(screen.queryByTestId("nav-drawer")).not.toBeInTheDocument();
    // 移动端不渲染恒驻侧栏（space-switcher 只在抽屉打开后出现）。
    expect(screen.queryByTestId("space-switcher")).not.toBeInTheDocument();
    // 主内容（今日页）正常渲染。
    expect(screen.getByRole("heading", { level: 1, name: /今天/ })).toBeInTheDocument();
  });

  it("点击汉堡按钮打开抽屉：对话框语义、六项导航与主题切换齐备", async () => {
    stubMobileMatchMedia();
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByTestId("nav-drawer-open"));

    const drawer = screen.getByTestId("nav-drawer");
    expect(drawer).toHaveAttribute("role", "dialog");
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("nav-drawer-backdrop")).toBeInTheDocument();
    for (const testId of [
      "nav-today",
      "nav-review",
      "nav-test",
      "nav-first-pass",
      "nav-vocabulary",
      "nav-settings",
    ]) {
      expect(within(drawer).getByTestId(testId)).toBeInTheDocument();
    }
    expect(within(drawer).getByTestId("theme-toggle")).toBeInTheDocument();
    expect(within(drawer).getByTestId("space-switcher")).toHaveTextContent("必考词");
    // 打开期间：body 禁止滚动，焦点进入抽屉内第一个导航链接。
    expect(document.body.style.overflow).toBe("hidden");
    expect(within(drawer).getByTestId("nav-today")).toHaveFocus();
  });

  it("点击抽屉内导航链接：路由切换且抽屉关闭、body 滚动恢复", async () => {
    stubMobileMatchMedia();
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByTestId("nav-drawer-open"));
    await user.click(screen.getByTestId("nav-vocabulary"));

    expect(screen.queryByTestId("nav-drawer")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "词汇" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("点击背景罩与按 Escape 都能关闭抽屉，焦点回到汉堡按钮", async () => {
    stubMobileMatchMedia();
    const user = userEvent.setup();
    renderApp();

    // 背景罩关闭路径。
    await user.click(screen.getByTestId("nav-drawer-open"));
    await user.click(screen.getByTestId("nav-drawer-backdrop"));
    expect(screen.queryByTestId("nav-drawer")).not.toBeInTheDocument();
    expect(screen.getByTestId("nav-drawer-open")).toHaveFocus();

    // Escape 关闭路径。
    await user.click(screen.getByTestId("nav-drawer-open"));
    expect(screen.getByTestId("nav-drawer")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("nav-drawer")).not.toBeInTheDocument();
    expect(screen.getByTestId("nav-drawer-open")).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });
});
