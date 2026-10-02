/**
 * 测试页测试：任务列表（常规分组 / 词书任务）、逐词测试会话主路径（开始 →
 * 作答 → 揭示 → 确认 → 完成）、暂停/恢复、"点错了"队尾重测、
 * 改判与键盘语义、词书纸质复习。
 */

import { describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { act, screen } from "@testing-library/react";
import { ConfirmedEntry } from "@ebbinghaus/application";
import { createTestServices, renderApp } from "./helpers.tsx";
import { FIXED_NOW } from "./helpers.tsx";
import { createMutableClock, createTestServicesWithClock, seedRegularDueServices } from "./seed.ts";

/** 渲染 → 打开测试页。 */
async function openTestPage(services = createTestServices()): Promise<void> {
  renderApp(services);
  await userEvent.setup().click(screen.getByTestId("nav-test"));
}

describe("测试页：任务列表", () => {
  it("历史软移除词不产生0词卡片，补完逾期词后测试列表为空", async () => {
    const user = userEvent.setup();
    const mutable = createMutableClock(new Date(FIXED_NOW.getTime() - 2 * 86_400_000));
    const services = createTestServicesWithClock(mutable.clock);
    const spaceId = services.getActiveSpace()?.id ?? "";
    const { listId } = services.bookLearning.recordFirstPass({
      spaceId, unitNumber: 1, listNumber: 1,
      entries: ["abandon", "elaborate"].map((term) =>
        new ConfirmedEntry(term, [{ partOfSpeech: "v.", definition: `释义：${term}`, usage: null }])),
    });
    const removed = services.runtime.wordContentStore.listEntriesForList(listId)[0]!;
    // 模拟正式迁移历史：只保留内容表软移除事实，没有补写 wordRemoved 事件。
    services.runtime.wordContentStore.markRemoved(removed.wordId, mutable.clock.now().toISOString());
    mutable.setNow(FIXED_NOW);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    expect(screen.getByTestId(`test-task-${listId}`)).toHaveTextContent("本 List 有 1 个词");
    await user.click(screen.getByTestId(`test-start-${listId}`));
    expect(screen.getByTestId("session-word")).toHaveTextContent("elaborate");
    await user.click(screen.getByTestId("session-recognized"));
    await user.click(screen.getByTestId("session-next"));
    expect(screen.getByTestId("test-completed")).toHaveTextContent("今天还剩 0 个词待测（0 个 List）");
    await user.click(screen.getByTestId("test-back-to-list"));
    expect(screen.queryByTestId(`test-task-${listId}`)).not.toBeInTheDocument();
    expect(screen.getByTestId("empty-state")).toHaveTextContent("今天没有需要测试的 List");
    expect(services.runtime.eventStore.listAllEvents().filter((event) => event.eventType === "testAnswered" && event.targetId === removed.wordId)).toEqual([]);
  });

  it("任务源暂时返回0待测词任务时不显示卡片与开始按钮", async () => {
    const services = createTestServices();
    vi.spyOn(services.dashboard, "taskItemsPage").mockReturnValue({
      learningMode: "词书模式", tasks: [{
        taskId: "empty-task", listId: "empty-list", unitNumber: 1, listNumber: 1,
        taskType: "短期测试", dueReason: "首次短期测试", workload: 1, overdueDays: 1,
        totalCount: 0, completedCount: 0, sessionStatus: null, activeWords: [],
      }],
    });
    await openTestPage(services);
    expect(screen.queryByTestId("test-task-empty-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("test-start-empty-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("empty-state")).toHaveTextContent("今天没有需要测试的 List");
  });

  it("局部揭示与逐词确认不重复校对会话或读取隐藏任务列表，业务通知仍校对远端进度", async () => {
    const user = userEvent.setup();
    const mutable = createMutableClock(new Date(FIXED_NOW.getTime() - 2 * 86_400_000));
    const services = createTestServicesWithClock(mutable.clock);
    const spaceId = services.getActiveSpace()?.id ?? "";
    const { listId } = services.bookLearning.recordFirstPass({
      spaceId, unitNumber: 1, listNumber: 4,
      entries: ["abandon", "elaborate"].map((term) =>
        new ConfirmedEntry(term, [{ partOfSpeech: "v.", definition: `释义：${term}`, usage: null }])),
    });
    mutable.setNow(FIXED_NOW);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    await user.click(screen.getByTestId(`test-start-${listId}`));

    // 按访问次数约束热点，避免机器速度掩盖同步桥的逐次阻塞；实际跨端语义由下方
    // 远端答案回归覆盖，本用例验证纯页面状态更新不会再次启动业务查询。
    const sessionRead = vi.spyOn(services.bookLearning, "getBookTestSessionSnapshot");
    const taskRead = vi.spyOn(services.dashboard, "taskItemsPage");
    const featureRead = vi.spyOn(services.settings, "getFeatureFlags");
    const spaceRead = vi.spyOn(services, "getActiveSpace");
    await user.click(screen.getByTestId("session-recognized"));
    expect(screen.getByTestId("session-meaning")).toBeInTheDocument();
    expect(sessionRead).not.toHaveBeenCalled();
    expect(taskRead).not.toHaveBeenCalled();
    expect(featureRead).not.toHaveBeenCalled();
    expect(spaceRead).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("session-next"));
    expect(screen.getByTestId("session-word")).toHaveTextContent("elaborate");
    expect(sessionRead).not.toHaveBeenCalled();
    expect(taskRead).not.toHaveBeenCalled();
    // 独立业务通知不能被局部快照短路：本机仍会读取事件收敛后的会话。
    act(() => services.notifyChanged());
    expect(sessionRead).toHaveBeenCalledTimes(1);
    expect(taskRead).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("session-recognized"));
    await user.click(screen.getByTestId("session-next"));
    expect(screen.getByTestId("test-completed")).toHaveTextContent("今天还剩 0 个词待测");
    // 测试工具启用 StrictMode，useMemo 在完成反馈首次派生时执行两次；生产只执行
    // 一次。本断言同时约束任务读取仅发生于结束会话，不发生于中间逐词确认。
    expect(taskRead).toHaveBeenCalledTimes(2);
  });

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

  it("词书模式从首过到逐词测试，完成反馈含成就感文案与剩余工作量，去复习可见候选词", async () => {
    const user = userEvent.setup();
    const mutable = createMutableClock(new Date(FIXED_NOW.getTime() - 2 * 86_400_000));
    const services = createTestServicesWithClock(mutable.clock);
    const spaceId = services.getActiveSpace()?.id ?? "";
    services.bookLearning.recordFirstPass({
      spaceId, unitNumber: 1, listNumber: 4,
      entries: [new ConfirmedEntry("abandon", [{ partOfSpeech: "v.", definition: "放弃", usage: "abandon ship" }])],
    });
    mutable.setNow(FIXED_NOW);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    const listId = services.runtime.bookCatalogStore.listListsForSpace(spaceId)[0]?.listId ?? "";
    expect(screen.getByTestId(`test-task-${listId}`)).toHaveTextContent("Unit 1 · List 4");
    expect(screen.getByTestId(`test-task-${listId}`).classList).toContain("test-task-row");
    await user.click(screen.getByTestId(`test-start-${listId}`));
    expect(screen.getByTestId("session-word")).toHaveTextContent("abandon");
    const answerPanel = screen.getByTestId("session-answer-panel");
    expect(answerPanel).toHaveClass("pending");
    await user.click(screen.getByTestId("session-recognized"));
    expect(screen.getByTestId("session-answer-panel")).toBe(answerPanel);
    expect(answerPanel).not.toHaveClass("pending");
    expect(screen.getByTestId("session-meaning")).toHaveTextContent("用法：abandon ship");
    await user.click(screen.getByTestId("session-next"));

    // 完成反馈（规格 10.4）：成就感文案 + 今日剩余测试工作量；无待测 List 时
    // "继续测试"改"完成测试"。
    const completed = screen.getByTestId("test-completed");
    expect(completed).toHaveTextContent("这个 List 测完了！1 个词全部通过考验。");
    expect(completed).toHaveTextContent("今天还剩 0 个词待测（0 个 List）。");
    expect(screen.getByTestId("test-back-to-list")).toHaveTextContent("完成测试");

    // 去复习：今天完成测试的词进入复习候选集（2026-10-02 口径）。
    await user.click(screen.getByTestId("test-go-review"));
    expect(screen.getByTestId("review-list-Unit 1 · List 4")).toHaveTextContent("今天关注 1 个词");
    await user.click(screen.getByTestId("review-list-header-Unit 1 · List 4"));
    expect(screen.getByTestId("review-words-Unit 1 · List 4")).toHaveTextContent("abandon");
    // 复习页没有任何"完成纸质复习"确认入口，也不产生复习完成事件。
    expect(screen.queryByRole("button", { name: /完成纸质复习/ })).not.toBeInTheDocument();
    expect(services.runtime.eventStore.listAllEvents().some((event) => event.eventType === "testFollowedByReviewCompleted")).toBe(false);
  });

  it("词书完成反馈统计其余待测 List 的剩余工作量，有待测时按钮为继续测试", async () => {
    const user = userEvent.setup();
    const mutable = createMutableClock(new Date(FIXED_NOW.getTime() - 2 * 86_400_000));
    const services = createTestServicesWithClock(mutable.clock);
    const spaceId = services.getActiveSpace()?.id ?? "";
    services.bookLearning.recordFirstPass({
      spaceId, unitNumber: 1, listNumber: 4,
      entries: [new ConfirmedEntry("abandon", [{ partOfSpeech: "v.", definition: "放弃", usage: null }])],
    });
    services.bookLearning.recordFirstPass({
      spaceId, unitNumber: 1, listNumber: 5,
      entries: [
        new ConfirmedEntry("elaborate", [{ partOfSpeech: "ad.", definition: "精细的", usage: null }]),
        new ConfirmedEntry("access", [{ partOfSpeech: "v.", definition: "进入", usage: null }]),
      ],
    });
    mutable.setNow(FIXED_NOW);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    const lists = services.runtime.bookCatalogStore.listListsForSpace(spaceId);
    const firstListId = lists.find((list) => list.listNumber === 4)?.listId ?? "";
    await user.click(screen.getByTestId(`test-start-${firstListId}`));
    await user.click(screen.getByTestId("session-recognized"));
    await user.click(screen.getByTestId("session-next"));

    // 今日剩余测试工作量从当日到期任务投影计算：List 5 尚余 2 个词（规格 10.4）。
    const completed = screen.getByTestId("test-completed");
    expect(completed).toHaveTextContent("这个 List 测完了！1 个词全部通过考验。");
    expect(completed).toHaveTextContent("今天还剩 2 个词待测（1 个 List）。");
    expect(screen.getByTestId("test-back-to-list")).toHaveTextContent("继续测试");

    // 继续测试返回任务列表，仍能看到另一个待测 List。
    await user.click(screen.getByTestId("test-back-to-list"));
    const secondListId = lists.find((list) => list.listNumber === 5)?.listId ?? "";
    expect(screen.getByTestId(`test-task-${secondListId}`)).toHaveTextContent("Unit 1 · List 5");
  });

  it("词书会话确认一词后暂停，任务行与恢复会话都准确显示尚余一词", async () => {
    const user = userEvent.setup();
    const mutable = createMutableClock(new Date(FIXED_NOW.getTime() - 2 * 86_400_000));
    const services = createTestServicesWithClock(mutable.clock);
    const spaceId = services.getActiveSpace()?.id ?? "";
    services.bookLearning.recordFirstPass({
      spaceId, unitNumber: 1, listNumber: 5,
      entries: [
        new ConfirmedEntry("abandon", [{ partOfSpeech: "v.", definition: "放弃", usage: null }]),
        new ConfirmedEntry("elaborate", [{ partOfSpeech: "ad.", definition: "精细的", usage: null }]),
      ],
    });
    mutable.setNow(FIXED_NOW);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    const listId = services.runtime.bookCatalogStore.listListsForSpace(spaceId)[0]?.listId ?? "";
    await user.click(screen.getByTestId(`test-start-${listId}`));
    await user.click(screen.getByTestId("session-recognized"));
    await user.click(screen.getByTestId("session-next"));
    expect(screen.getByTestId("test-session-remaining")).toHaveTextContent("尚余 1 个词");
    await user.click(screen.getByTestId("session-pause"));
    expect(screen.getByTestId(`test-task-${listId}`)).toHaveTextContent("本 List 尚余 1 个词");
    await user.click(screen.getByTestId(`test-start-${listId}`));
    expect(screen.getByTestId("test-session-remaining")).toHaveTextContent("尚余 1 个词");
    await user.click(screen.getByTestId("session-not-recognized"));
    expect(screen.getByTestId("session-defer")).toBeDisabled();
    expect(screen.getByTestId("session-defer-unavailable")).toHaveTextContent("最后一个待测词，没有下一词可先测");
  });

  it("远端确认当前 Word 后原页跳词、丢弃初判，返回列表显示收敛后的剩余数", async () => {
    const user = userEvent.setup();
    const mutable = createMutableClock(new Date(FIXED_NOW.getTime() - 2 * 86_400_000));
    const services = createTestServicesWithClock(mutable.clock);
    const spaceId = services.getActiveSpace()?.id ?? "";
    services.bookLearning.recordFirstPass({
      spaceId, unitNumber: 1, listNumber: 6,
      entries: ["abandon", "elaborate", "access"].map((term) =>
        new ConfirmedEntry(term, [{ partOfSpeech: "v.", definition: `释义：${term}`, usage: null }])),
    });
    mutable.setNow(FIXED_NOW);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    const listId = services.runtime.bookCatalogStore.listListsForSpace(spaceId)[0]?.listId ?? "";
    await user.click(screen.getByTestId(`test-start-${listId}`));
    const initialWord = screen.getByTestId("session-word").textContent;
    await user.click(screen.getByTestId("session-recognized"));
    expect(screen.getByTestId("session-meaning")).toBeInTheDocument();
    act(() => services.notifyChanged());
    // 与当前词无关的通知不应擦掉用户尚未提交的第一阶段判断。
    expect(screen.getByTestId("session-meaning")).toBeInTheDocument();

    const session = services.runtime.testSessionStore.getOpenListSession(listId);
    const firstPlan = session?.words[0];
    if (session === null || firstPlan === undefined) throw new Error("缺少开放的词书测试会话");
    // 模拟同步 pull：事件直接落入本地事件库且不进入本机 outbox，随后才发业务通知。
    // 远端已完成第一步和第二步，本机仅揭示答案的初判不应转移到下一词。
    const remoteAnswer = services.eventRecorder.record({
      eventType: "testAnswered", targetType: "Word", targetId: firstPlan.wordId,
      source: "另一设备的词书模式测试", occurredAt: FIXED_NOW,
      metadata: {
        sessionId: "remote-session", taskId: session.taskId,
        plannedTestAt: firstPlan.plannedTestAt,
        initialJudgement: "认识", finalJudgement: "认识", answerRevised: false,
        beforeState: { shortTermPassCount: 0, masteryStatus: "未掌握" },
        afterState: { shortTermPassCount: 1, masteryStatus: "未掌握", t1: FIXED_NOW.toISOString() },
        algorithmVersion: session.taskSnapshot?.algorithmVersion ?? "test-v1",
      },
    });
    act(() => {
      services.runtime.eventStore.applyPulledEvents([remoteAnswer]);
      services.notifyChanged();
    });

    expect(screen.getByTestId("session-word")).not.toHaveTextContent(initialWord ?? "");
    expect(screen.getByTestId("test-session-remaining")).toHaveTextContent("尚余 2 个词");
    expect(screen.queryByTestId("session-meaning")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-answer-panel")).toHaveClass("pending");
    await user.click(screen.getByTestId("session-pause"));
    expect(screen.getByTestId(`test-task-${listId}`)).toHaveTextContent("本 List 尚余 2 个词");
    expect(screen.getByTestId(`test-start-${listId}`)).toHaveTextContent("继续测试");
  });

  it.each(["远端作答", "内容移除", "事件移除"] as const)("%s与本机点击交错时自动跳过旧 Word，不报内部状态错误或产生重复答案", async (change) => {
    const user = userEvent.setup();
    const mutable = createMutableClock(new Date(FIXED_NOW.getTime() - 2 * 86_400_000));
    const services = createTestServicesWithClock(mutable.clock);
    const spaceId = services.getActiveSpace()?.id ?? "";
    services.bookLearning.recordFirstPass({
      spaceId, unitNumber: 1, listNumber: 7,
      entries: ["abandon", "elaborate"].map((term) =>
        new ConfirmedEntry(term, [{ partOfSpeech: "v.", definition: `释义：${term}`, usage: null }])),
    });
    mutable.setNow(FIXED_NOW);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    const listId = services.runtime.bookCatalogStore.listListsForSpace(spaceId)[0]?.listId ?? "";
    await user.click(screen.getByTestId(`test-start-${listId}`));
    await user.click(screen.getByTestId("session-recognized"));
    const session = services.runtime.testSessionStore.getOpenListSession(listId);
    const firstPlan = session?.words[0];
    if (session === null || firstPlan === undefined) throw new Error("缺少开放的词书测试会话");
    if (change === "内容移除") {
      services.runtime.wordContentStore.markRemoved(firstPlan.wordId, FIXED_NOW.toISOString());
    } else if (change === "事件移除") {
      services.runtime.eventStore.applyPulledEvents([services.eventRecorder.record({
        eventType: "wordRemoved", targetType: "Word", targetId: firstPlan.wordId,
        source: "另一设备移除", metadata: { normalizedKey: "abandon", listId }, occurredAt: FIXED_NOW,
      })]);
    } else {
    const remoteAnswer = services.eventRecorder.record({
      eventType: "testAnswered", targetType: "Word", targetId: firstPlan.wordId,
      source: "另一设备的词书模式测试", occurredAt: FIXED_NOW,
      metadata: {
        sessionId: "remote-session", taskId: session.taskId,
        plannedTestAt: firstPlan.plannedTestAt,
        initialJudgement: "认识", finalJudgement: "认识", answerRevised: false,
        beforeState: { shortTermPassCount: 0, masteryStatus: "未掌握" },
        afterState: { shortTermPassCount: 1, masteryStatus: "未掌握", t1: FIXED_NOW.toISOString() },
        algorithmVersion: session.taskSnapshot?.algorithmVersion ?? "test-v1",
      },
    });
    // 刻意不发 notifyChanged，复现 pull 刚落库、旧按钮仍可被点击的极窄时间窗。
    services.runtime.eventStore.applyPulledEvents([remoteAnswer]);
    }
    await user.click(screen.getByTestId("session-next"));
    expect(screen.getByTestId("session-word")).toHaveTextContent("elaborate");
    expect(screen.getByTestId("session-answer-panel")).toHaveClass("pending");
    expect(screen.queryByTestId("session-error")).not.toBeInTheDocument();
    expect(services.runtime.eventStore.listAllEvents().filter((event) => event.eventType === "testAnswered")).toHaveLength(change === "远端作答" ? 1 : 0);
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
    expect(screen.getByTestId("session-defer")).toHaveTextContent("点错了");
    expect(screen.queryByTestId("session-recognized")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-next")).not.toBeInTheDocument();
  });

  it("初判不认识后点错了不生成作答事件，队尾词重新从未揭晓状态测试", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices(["abandon", "elaborate"]);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    await user.click(screen.getByTestId("test-start-1"));
    const firstWord = screen.getByTestId("session-word").textContent;
    await user.click(screen.getByTestId("session-not-recognized"));
    expect(screen.getByTestId("session-meaning")).toBeInTheDocument();
    await user.keyboard("{Backspace}");
    // 揭晓后的 Backspace 不能触发没有快捷键的"点错了"，也不能提交答案。
    expect(screen.getByTestId("session-meaning")).toBeInTheDocument();
    await user.click(screen.getByTestId("session-defer"));
    expect(screen.getByTestId("session-word")).not.toHaveTextContent(firstWord ?? "");
    expect(screen.getByTestId("session-answer-panel")).toHaveClass("pending");
    expect(screen.getByTestId("test-session-remaining")).toHaveTextContent("尚余 2 个条目");
    expect(services.runtime.eventStore.listAllEvents().filter((event) => event.eventType === "testAnswered")).toHaveLength(0);
    await user.click(screen.getByTestId("session-recognized"));
    await user.click(screen.getByTestId("session-next"));
    expect(screen.getByTestId("session-word")).toHaveTextContent(firstWord ?? "");
    expect(screen.getByTestId("session-answer-panel")).toHaveClass("pending");
  });

  it("常规模式只剩一个待测条目时禁用点错并说明原因", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices(["abandon", "elaborate"]);
    renderApp(services);
    await user.click(screen.getByTestId("nav-test"));
    await user.click(screen.getByTestId("test-start-1"));
    await user.click(screen.getByTestId("session-recognized"));
    await user.click(screen.getByTestId("session-next"));
    expect(screen.getByTestId("test-session-remaining")).toHaveTextContent("尚余 1 个条目");
    await user.click(screen.getByTestId("session-not-recognized"));
    expect(screen.getByTestId("session-defer")).toBeDisabled();
    expect(screen.getByTestId("session-defer-unavailable")).toHaveTextContent("最后一个待测条目，没有下一条可先测");
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
