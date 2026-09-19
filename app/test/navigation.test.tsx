/**
 * 导航与外壳测试：一级导航切换、页面标题焦点播报、空态文案与快捷键。
 * 使用内存运行时 + 确定性时钟，每个用例独立服务实例。
 */

import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { renderApp } from "./helpers.tsx";
import { screen, within } from "@testing-library/react";

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
