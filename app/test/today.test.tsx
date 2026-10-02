/**
 * 今日页测试：看板聚合（任务/容量/建议/每日目标）、"现在先做什么"的下一步
 * 语义、到期任务 ≤2 次点击进入逐词测试（界面规格 16.2 质量门）、空 Space 与
 * 完成态的表达。
 */

import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { screen, waitFor as rtlWaitFor } from "@testing-library/react";
import { createTestServices, renderApp } from "./helpers.tsx";
import { seedRegularDueServices } from "./seed.ts";

describe("今日页：空状态与看板骨架", () => {
  it("全新词书 Space：显示完成状态与每日目标卡，不制造虚假任务", async () => {
    // 首次启动默认活动 Space 是词书模式"必考词"，无任何学习数据。
    renderApp();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/今天/);
    expect(screen.getByTestId("empty-state")).toHaveTextContent("今天的任务完成了");
    // 任务清单三类入口始终可点（推荐顺序不阻塞选择）；复习入口固定浏览文案（规格 8.2）。
    expect(screen.getByTestId("today-order-test")).toHaveTextContent("暂无待测任务");
    expect(screen.getByTestId("today-order-review")).toHaveTextContent("浏览今天关注的词");
    expect(screen.getByTestId("today-order-first-pass")).toBeInTheDocument();
    // 容量两段式：后台刷新完成后建议行出现（绝不阻塞等待）。
    expect(screen.getByTestId("today-target-section")).toBeInTheDocument();
    expect(screen.getByTestId("today-capacity-note")).toBeInTheDocument();
  });

  it("每日目标从今日看板调整并按 Space 保存", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    renderApp(services);
    const input = screen.getByTestId("today-daily-target");
    await user.clear(input);
    await user.type(input, "8");
    await user.click(screen.getByTestId("today-save-target"));
    expect(screen.getAllByTestId("toast").some((toast) => toast.textContent === "每日目标已更新。")).toBe(true);
    expect(
      services.settings.getSpaceLearningSettings("a1f0c3d4-0000-4000-8000-000000000001").dailyTarget,
    ).toBe(8);
  });

  it("每日目标输入非法时就地提示且不保存", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    renderApp(services);
    const input = screen.getByTestId("today-daily-target");
    await user.clear(input);
    await user.type(input, "-3");
    await user.click(screen.getByTestId("today-save-target"));
    expect(screen.getByText("每日学习目标必须是不小于 0 的整数。")).toBeInTheDocument();
    // 未写入：默认目标仍是 0。
    expect(
      services.settings.getSpaceLearningSettings("a1f0c3d4-0000-4000-8000-000000000001").dailyTarget,
    ).toBe(0);
  });
});

describe("今日页：常规模式到期任务", () => {
  it("下一步卡片显示最优先测试组，≤2 次点击进入逐词测试", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices(["abandon", "elaborate"]);
    renderApp(services);

    // 下一步卡片（规格 8.5：测试第 N 组 · N 个条目）。
    expect(screen.getByTestId("today-next-title")).toHaveTextContent("测试第 1 组");
    expect(screen.getByTestId("today-start-test")).toHaveTextContent("开始测试");

    // 第 1 次点击：进入测试页；第 2 次点击：开始该组 → 逐词会话出现。
    await user.click(screen.getByTestId("today-start-test"));
    expect(screen.getByRole("heading", { level: 1, name: "测试" })).toBeInTheDocument();
    await user.click(screen.getByTestId("test-start-1"));
    expect(screen.getByTestId("test-session")).toBeInTheDocument();
    expect(screen.getByTestId("session-word")).toBeInTheDocument();
  });

  it("学习顺序行汇总待测组数与建议录入数", async () => {
    const { services } = seedRegularDueServices(["abandon", "elaborate", "access"]);
    renderApp(services);
    expect(screen.getByTestId("today-order-test")).toHaveTextContent("1 组");
    expect(screen.getByTestId("today-order-review")).toHaveTextContent("暂无可朗读条目");
    // 容量后台刷新（setTimeout 0 + 蒙特卡洛）完成后建议行携带具体数字。
    await rtlWaitFor(
      () => {
        const suggested = screen.getByTestId("today-suggested-count");
        expect(suggested.textContent).toMatch(/建议新增 \d+ 个条目|今天不建议新增/);
      },
      { timeout: 10_000 },
    );
  });
});
