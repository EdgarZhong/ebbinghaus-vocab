/**
 * 测试页测试：任务列表（常规分组 / 词书任务）、逐词测试会话主路径（开始 →
 * 作答 → 揭示 → 确认 → 完成）、暂停/恢复、改判单向与键盘语义、词书任务占位。
 */

import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { createTestServices, renderApp } from "./helpers.tsx";
import { seedRegularDueServices, seedBookSpaceWithReviewOnlyTask } from "./seed.ts";

/** 渲染 → 打开测试页。 */
async function openTestPage(services = createTestServices()): Promise<void> {
  renderApp(services);
  await userEvent.setup().click(screen.getByTestId("nav-test"));
}

describe("测试页：任务列表", () => {
  it("无到期条目时显示规格空状态", async () => {
    await openTestPage();
    expect(screen.getByTestId("empty-state")).toHaveTextContent("今天没有需要测试的 List");
    expect(screen.getByTestId("empty-state")).toHaveTextContent("新的测试到期后，会显示在这里。");
  });

  it("常规模式按当日组展示：标题、到期徽章与开始按钮", async () => {
    const { services } = seedRegularDueServices(["abandon", "elaborate"]);
    renderApp(services);
    await userEvent.setup().click(screen.getByTestId("nav-test"));
    expect(screen.getByTestId("test-group-1")).toHaveTextContent("第 1 组 · 2 个条目");
    expect(screen.getByTestId("test-start-1")).toHaveTextContent("开始测试");
    // 常规模式不出现 Unit/List 或纸质复习确认（规格 6.8）。
    expect(screen.queryByText(/Unit/)).not.toBeInTheDocument();
  });

  it("词书模式显示 Unit/List 任务；逐词测试未开放时给出如实占位", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    const spaceId = seedBookSpaceWithReviewOnlyTask(services);
    void spaceId;
    renderApp(services);
    // 默认活动 Space 是"必考词"（词书模式无任务），种子 Space 为新建活动 Space。
    await user.click(screen.getByTestId("nav-test"));
    expect(screen.getByTestId(/test-task-seed-list-4/)).toBeInTheDocument();
    await user.click(screen.getByTestId(/test-start-seed-list-4/));
    expect(screen.getByTestId("test-book-hint")).toHaveTextContent("逐词测试将在后续更新中提供");
  });
});

describe("测试页：逐词测试会话（常规模式）", () => {
  it("主路径：开始 → 初判认识 → 揭示答案 → 下一个 → 全部完成 → 完成反馈", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices(["abandon", "elaborate"]);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    await user.click(screen.getByTestId("test-start-1"));

    // 作答前：只显示词条，不显示任何释义；右上角剩余数。
    expect(screen.getByTestId("test-session-remaining")).toHaveTextContent("本组尚余 2 个条目");
    expect(screen.getByTestId("session-word")).toBeInTheDocument();
    expect(screen.queryByTestId("session-meaning")).not.toBeInTheDocument();

    // 初判认识 → 揭示"你的释义"。
    await user.click(screen.getByTestId("session-recognized"));
    expect(screen.getByTestId("session-meaning")).toBeInTheDocument();
    // 认识揭示后提供"下一个"与"标记为忘记"（规格 10.3）。
    expect(screen.getByTestId("session-next")).toBeInTheDocument();
    expect(screen.getByTestId("session-mark-forgot")).toBeInTheDocument();

    // 确认认识 → 下一词；剩余数递减。
    await user.click(screen.getByTestId("session-next"));
    expect(screen.getByTestId("test-session-remaining")).toHaveTextContent("本组尚余 1 个条目");
    expect(screen.getByTestId("session-word")).toBeInTheDocument();

    // 第二词：不认识路径（两次操作确认，无第三次）。
    await user.click(screen.getByTestId("session-not-recognized"));
    expect(screen.getByTestId("session-confirm-not-recognized")).toBeInTheDocument();
    await user.click(screen.getByTestId("session-confirm-not-recognized"));

    // 会话完成：完成反馈（规格 10.5 常规文案）。
    expect(screen.getByTestId("test-completed")).toHaveTextContent("今天的测试完成了");
    // 已确认结果立即持久化：两条 testAnswered 事件。
    const answers = services.runtime.eventStore
      .listAllEvents()
      .filter((event) => event.eventType === "testAnswered");
    expect(answers).toHaveLength(2);
  });

  it("改判单向：初判认识可标记为忘记，界面绝不提供从不认识改回认识", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices(["abandon"]);
    const firstView = renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    await user.click(screen.getByTestId("test-start-1"));

    await user.click(screen.getByTestId("session-recognized"));
    // 改判：标记为忘记 → 最终不认识（answerRevised 审计事件）。
    await user.click(screen.getByTestId("session-mark-forgot"));
    expect(screen.getByTestId("test-completed")).toBeInTheDocument();
    const types = services.runtime.eventStore.listAllEvents().map((event) => event.eventType);
    expect(types).toContain("testAnswered");
    expect(types).toContain("answerRevised");
    const answered = services.runtime.eventStore
      .listAllEvents()
      .find((event) => event.eventType === "testAnswered");
    expect(answered?.metadata["finalJudgement"]).toBe("不认识");
    firstView.unmount();

    // 初判不认识的揭示态只有"确认不认识"，无"认识"按钮。
    const { services: services2 } = seedRegularDueServices(["access"]);
    renderApp(services2);
    await user.click(screen.getByTestId("nav-test"));
    await user.click(screen.getByTestId("test-start-1"));
    await user.click(screen.getByTestId("session-not-recognized"));
    expect(screen.getByTestId("session-confirm-not-recognized")).toBeInTheDocument();
    expect(screen.queryByTestId("session-recognized")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-next")).not.toBeInTheDocument();
  });

  it("暂停保留进度，任务行显示继续测试，恢复后继续剩余词", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices(["abandon", "elaborate"]);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    await user.click(screen.getByTestId("test-start-1"));

    // 第一词确认认识后暂停。
    await user.click(screen.getByTestId("session-recognized"));
    await user.click(screen.getByTestId("session-next"));
    await user.click(screen.getByTestId("session-pause"));
    // 回到任务列表，该组进入"继续测试"形态（组已重编：已测词退出，未测词保留）。
    expect(screen.getByTestId("test-start-1")).toHaveTextContent("继续测试");

    // 恢复：剩余 1 个词，暂停事件已写入（testSessionPaused 审计）。
    await user.click(screen.getByTestId("test-start-1"));
    expect(screen.getByTestId("test-session-remaining")).toHaveTextContent("本组尚余 1 个条目");
    const types = services.runtime.eventStore.listAllEvents().map((event) => event.eventType);
    expect(types).toContain("testSessionPaused");
  });

  it("键盘语义：Enter 等价认识，Backspace 等价不认识", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices(["abandon"]);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    await user.click(screen.getByTestId("test-start-1"));

    // Enter → 初判认识并揭示答案。
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("session-meaning")).toBeInTheDocument();
    // Enter → 确认认识并完成。
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("test-completed")).toBeInTheDocument();
    const answered = services.runtime.eventStore
      .listAllEvents()
      .find((event) => event.eventType === "testAnswered");
    expect(answered?.metadata["finalJudgement"]).toBe("认识");
  });
});
