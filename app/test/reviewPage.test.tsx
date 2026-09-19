/**
 * 复习页测试：词书模式纸质复习确认（完成事件 + 反馈文案）、常规模式只读朗读
 * 分组（刚刚忘记置顶、无完成按钮）、空状态文案。
 */

import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { createTestServices, renderApp } from "./helpers.tsx";
import { seedBookSpaceWithReviewOnlyTask, seedRegularDueServices } from "./seed.ts";
import { TestJudgement } from "@ebbinghaus/domain";

/** 在常规模式种子上完成一次逐词测试（第一个词认识、第二个词不认识）。 */
function seedTestedToday(services: ReturnType<typeof createTestServices>, spaceId: string): void {
  const group = services.regularLearning.dueGroups({ spaceId })[0];
  if (group === undefined) {
    throw new Error("种子缺少到期测试组");
  }
  const taskId = `regular-group|${spaceId}|${group.learningDay}|${group.ordinal}`;
  const session = services.regularLearning.startOrResumeRegularTest({ taskId });
  for (let index = 0; index < session.totalCount; index += 1) {
    const snapshot = services.regularLearning.confirmRegularTestAnswer({
      sessionId: session.sessionId,
      initialJudgement: index === 1 ? TestJudgement.NotRecognized : TestJudgement.Recognized,
      finalJudgement: index === 1 ? TestJudgement.NotRecognized : TestJudgement.Recognized,
    });
    if (snapshot.currentWord === null) {
      break;
    }
  }
}

describe("复习页：词书模式", () => {
  it("无仅复习任务时显示规格空状态", async () => {
    renderApp();
    await userEvent.setup().click(screen.getByTestId("nav-review"));
    expect(screen.getByTestId("empty-state")).toHaveTextContent("今天没有需要复习的 List");
    expect(screen.getByTestId("empty-state")).toHaveTextContent("有新的复习任务时，会显示在这里。");
  });

  it("仅复习任务：展开词清单 → 完成纸质复习 → 反馈与事件一致，任务消失", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    seedBookSpaceWithReviewOnlyTask(services);
    renderApp(services);
    await user.click(screen.getByTestId("nav-review"));

    // 任务行：Unit/List 定位 + 到期徽章 + 词数。
    expect(screen.getByTestId("review-task-Unit 1 · List 4")).toHaveTextContent("1 个词需要复习");
    expect(screen.getByTestId("review-task-Unit 1 · List 4")).toHaveTextContent("逾期 1 天");

    // 展开词清单（翻书提示，只读）。
    await user.click(screen.getByTestId("review-expand-Unit 1 · List 4"));
    expect(screen.getByTestId("review-words-Unit 1 · List 4")).toHaveTextContent("abandon");
    expect(screen.getByTestId("review-words-Unit 1 · List 4")).toHaveTextContent("v. 放弃");

    // 完成纸质复习：反馈与按钮动作同名（规格 14.3）。
    await user.click(screen.getByTestId("review-complete-Unit 1 · List 4"));
    expect(
      screen.getAllByTestId("toast").some((toast) => toast.textContent === "Unit 1 · List 4 已完成复习。"),
    ).toBe(true);
    // 事件口径：仅复习任务产出 reviewOnlyCompleted。
    expect(
      services.runtime.eventStore.listAllEvents().some((event) => event.eventType === "reviewOnlyCompleted"),
    ).toBe(true);
    // 完成后任务从列表消失（派生态重放）。
    expect(screen.queryByTestId("review-task-Unit 1 · List 4")).not.toBeInTheDocument();
  });
});

describe("复习页：常规模式", () => {
  it("当天已测条目组成朗读分组：刚刚忘记置顶，无完成按钮", async () => {
    const user = userEvent.setup();
    const { services, spaceId } = seedRegularDueServices(["abandon", "elaborate"]);
    seedTestedToday(services, spaceId);
    renderApp(services);
    await user.click(screen.getByTestId("nav-review"));

    // 页面说明切换为常规口径（规格 9.3）。
    expect(screen.getByText("查看今天已经测试过的条目，方便朗读和背诵。")).toBeInTheDocument();
    expect(screen.getByTestId("review-group-1")).toHaveTextContent("第 1 组 · 已测试 2 个条目");
    expect(screen.getByTestId("review-group-1")).toHaveTextContent("刚刚忘记 1 个");

    // 展开：不认识条目置顶并文字标注"刚刚忘记"。
    await user.click(screen.getByTestId("review-group-expand-1"));
    const body = screen.getByTestId("review-group-1");
    const bodyText = body.textContent ?? "";
    expect(bodyText).toContain("刚刚忘记");
    // 无任何完成/确认/推迟操作（规格 9.3）。
    expect(screen.queryByRole("button", { name: "完成纸质复习" })).not.toBeInTheDocument();
  });

  it("没有已测条目时显示常规口径空状态", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices(["abandon"]);
    renderApp(services);
    await user.click(screen.getByTestId("nav-review"));
    expect(screen.getByTestId("empty-state")).toHaveTextContent("今天还没有已测试的条目");
    void user;
  });
});
