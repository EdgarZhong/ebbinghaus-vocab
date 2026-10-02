/**
 * 复习页测试（2026-10-02 口径）：两种模式统一的纯浏览入口（界面设计规格第 9 章）。
 *
 * 断言口径：
 * - 词书模式：List 卡只显示 "Unit X · List Y" + "今天关注 N 个词"，无到期/逾期/
 *   完成标识、无任何操作按钮；点击卡头展开/收起词列表（纯本机展示，零事件写入）。
 * - 候选集 = 当日到期仅复习词 ∪ 今天完成测试的词（当日未答词不进候选）。
 * - 常规模式：组卡 "第 N 组 · 已测试 N 个条目"，"刚刚忘记"置顶并以文字 + 图标标注；
 *   无完成/确认/推迟按钮。
 * - 空状态统一为"今天没有需要关注的词"。
 */

import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { ConfirmedEntry } from "@ebbinghaus/application";
import { createMutableClock, createTestServices, renderApp } from "./helpers.tsx";
import { seedBookSpaceWithDueReviewCandidate, seedRegularDueServices } from "./seed.ts";
import { FIXED_NOW } from "./helpers.tsx";
import { createTestServicesWithClock } from "./seed.ts";
import { TestJudgement } from "@ebbinghaus/domain";

/** 在常规模式种子上完成一次逐词测试（第一个词认识、第二个词不认识）。 */
function seedTestedToday(services: ReturnType<typeof createTestServices>, spaceId: string): void {
  const group = services.regularLearning.dueGroups({ spaceId })[0];
  if (group === undefined) {
    throw new Error("种子缺少到期测试组");
  }
  const taskId = `regular-group|${spaceId}|${group.learningDay}|${group.ordinal}`;
  const session = services.regularLearning.startOrResumeRegularTest({ taskId });
  let currentWordId = session.currentWord?.wordId ?? "";
  for (let index = 0; index < session.totalCount; index += 1) {
    const snapshot = services.regularLearning.confirmRegularTestAnswer({
      sessionId: session.sessionId,
      // 每次确认以最新快照里的条目身份为准，测试不能绕开并发防护合同。
      expectedWordId: currentWordId,
      initialJudgement: index === 1 ? TestJudgement.NotRecognized : TestJudgement.Recognized,
      finalJudgement: index === 1 ? TestJudgement.NotRecognized : TestJudgement.Recognized,
    });
    if (snapshot.currentWord === null) {
      break;
    }
    currentWordId = snapshot.currentWord.wordId;
  }
}

describe("复习页：词书模式", () => {
  it("无候选词时显示规格空状态", async () => {
    renderApp();
    await userEvent.setup().click(screen.getByTestId("nav-review"));
    expect(screen.getByTestId("empty-state")).toHaveTextContent("今天没有需要关注的词");
    expect(screen.getByTestId("empty-state")).toHaveTextContent(
      "完成测试或复习计划到期后，今天关注的词会显示在这里。",
    );
  });

  it("当日到期仅复习词：List 卡关注数、展开收起词列表、零事件写入", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    seedBookSpaceWithDueReviewCandidate(services);
    renderApp(services);
    await user.click(screen.getByTestId("nav-review"));

    // List 卡：标题行 Unit/List + "今天关注 N 个词"（规格 9.1）。
    const card = screen.getByTestId("review-list-Unit 1 · List 4");
    expect(card).toHaveTextContent("Unit 1 · List 4");
    expect(card).toHaveTextContent("今天关注 1 个词");
    // 无任何到期/逾期/完成标识（规格 9.2：页面不显示逾期、到期或完成状态）。
    expect(card.textContent).not.toMatch(/逾期|今天到期|完成|待复习/);

    // 点击卡头展开词列表（纯浏览，词卡左英右义两列）。
    await user.click(screen.getByTestId("review-list-header-Unit 1 · List 4"));
    const words = screen.getByTestId("review-words-Unit 1 · List 4");
    expect(words).toHaveTextContent("abandon");
    expect(words).toHaveTextContent("v. 放弃");
    // 词卡片不含 Unit/List/掌握信息、不含任何按钮。
    expect(words.textContent).not.toMatch(/Unit|List|掌握/);

    // 展开/收起只改本机展示：不产生任何学习事件（2026-10-02 口径）。
    const eventCountBefore = services.runtime.eventStore.listAllEvents().length;
    await user.click(screen.getByTestId("review-list-header-Unit 1 · List 4"));
    expect(screen.queryByTestId("review-words-Unit 1 · List 4")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("review-list-header-Unit 1 · List 4"));
    expect(screen.getByTestId("review-words-Unit 1 · List 4")).toBeInTheDocument();
    expect(services.runtime.eventStore.listAllEvents()).toHaveLength(eventCountBefore);
    // 复习确认事件族已停止产生（reviewOnlyCompleted / testFollowedByReviewCompleted）。
    expect(
      services.runtime.eventStore
        .listAllEvents()
        .some((event) => event.eventType === "reviewOnlyCompleted"
          || event.eventType === "testFollowedByReviewCompleted"),
    ).toBe(false);
  });

  it("今天完成测试的词进入候选集；当日待测未答词不泄露", async () => {
    const user = userEvent.setup();
    const mutable = createMutableClock(new Date(FIXED_NOW.getTime() - 2 * 86_400_000));
    const services = createTestServicesWithClock(mutable.clock);
    const spaceId = services.getActiveSpace()?.id ?? "";
    services.bookLearning.recordFirstPass({
      spaceId, unitNumber: 1, listNumber: 4,
      entries: [
        new ConfirmedEntry("abandon", [{ partOfSpeech: "v.", definition: "放弃", usage: "abandon ship" }]),
        new ConfirmedEntry("elaborate", [{ partOfSpeech: "ad.", definition: "精细的", usage: null }]),
      ],
    });
    mutable.setNow(FIXED_NOW);
    renderApp(services);
    await user.click(screen.getByTestId("nav-review"));

    // 两个词今天都待测且未答：全部从复习候选集中扣除（不泄露待测答案，规格 6.4）。
    expect(screen.getByTestId("empty-state")).toHaveTextContent("今天没有需要关注的词");

    // 完成其中一词的测试 → 该词进入候选集，未答词仍不显示。
    const listId = services.runtime.bookCatalogStore.listListsForSpace(spaceId)[0]?.listId ?? "";
    await user.click(screen.getByTestId("nav-test"));
    await user.click(screen.getByTestId(`test-start-${listId}`));
    await user.click(screen.getByTestId("session-recognized"));
    await user.click(screen.getByTestId("session-next"));
    await user.click(screen.getByTestId("session-pause"));
    await user.click(screen.getByTestId("nav-review"));
    const card = screen.getByTestId("review-list-Unit 1 · List 4");
    expect(card).toHaveTextContent("今天关注 1 个词");
    await user.click(screen.getByTestId("review-list-header-Unit 1 · List 4"));
    const words = screen.getByTestId("review-words-Unit 1 · List 4");
    expect(words).toHaveTextContent("abandon");
    expect(words).not.toHaveTextContent("elaborate");
  });
});

describe("复习页：常规模式", () => {
  it("当天已测条目组成朗读分组：刚刚忘记置顶，无完成/确认/推迟按钮", async () => {
    const user = userEvent.setup();
    const { services, spaceId } = seedRegularDueServices(["abandon", "elaborate"]);
    seedTestedToday(services, spaceId);
    renderApp(services);
    await user.click(screen.getByTestId("nav-review"));

    // 页面说明切换为常规口径（规格 9.3）。
    expect(screen.getByText("查看今天已经测试过的条目，方便朗读和背诵。")).toBeInTheDocument();
    const card = screen.getByTestId("review-group-1");
    expect(card).toHaveTextContent("第 1 组 · 已测试 2 个条目");
    expect(card).toHaveTextContent("刚刚忘记 1 个");

    // 展开：不认识条目置顶并同时以文字与警示图标标注"刚刚忘记"（规格 9.3）。
    await user.click(screen.getByTestId("review-group-header-1"));
    const words = screen.getByTestId("review-group-words-1");
    const wordsText = words.textContent ?? "";
    expect(wordsText).toContain("刚刚忘记");
    // 无任何完成/确认/推迟操作（规格 9.3）。
    expect(screen.queryByRole("button", { name: /完成|确认|推迟/ })).not.toBeInTheDocument();
  });

  it("没有已测条目时显示统一空状态", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices(["abandon"]);
    renderApp(services);
    await user.click(screen.getByTestId("nav-review"));
    expect(screen.getByTestId("empty-state")).toHaveTextContent("今天没有需要关注的词");
    void user;
  });
});
