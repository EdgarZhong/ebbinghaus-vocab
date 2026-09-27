/**
 * 词汇页测试：V1 单列卡片与录入倒序、详情中的手录/在线释义区和学习记录、
 * 双向手动掌握、详情确认删除、实时搜索与掌握状态筛选。
 */

import { describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import { ConfirmedEntry } from "@ebbinghaus/application";
import { TestJudgement } from "@ebbinghaus/domain";
import type { AppServices } from "../src/composition.ts";
import { FIXED_NOW, renderApp } from "./helpers.tsx";
import { createMutableClock, createTestServicesWithClock } from "./seed.ts";

/**
 * 分时刻录入两个条目（先 abandon 后 elaborate），并为 abandon 造一次
 * "认识"的最终测试结果——验证倒序与最近结果展示。
 */
function seedVocabulary(): { services: AppServices; spaceId: string } {
  const mutable = createMutableClock(new Date(FIXED_NOW.getTime() - 3 * 86_400_000));
  const services = createTestServicesWithClock(mutable.clock);
  const space = services.spaces.createAndActivate({ name: "词表空间", learningMode: "常规模式" });
  services.regularLearning.recordEntries({
    spaceId: space.id,
    entries: [new ConfirmedEntry("abandon", [{ partOfSpeech: "v.", definition: "放弃", usage: null }])],
  });
  mutable.setNow(new Date(FIXED_NOW.getTime() - 2 * 86_400_000));
  services.regularLearning.recordEntries({
    spaceId: space.id,
    entries: [new ConfirmedEntry("elaborate", [{ partOfSpeech: "a.", definition: "详尽的", usage: null }])],
  });
  mutable.setNow(FIXED_NOW);
  // abandon 今天完成一次"认识"测试（次日资格已过：3 天前录入）。
  const group = services.regularLearning.dueGroups({ spaceId: space.id })[0];
  if (group !== undefined) {
    const session = services.regularLearning.startOrResumeRegularTest({
      taskId: `regular-group|${space.id}|${group.learningDay}|${group.ordinal}`,
    });
    services.regularLearning.confirmRegularTestAnswer({
      sessionId: session.sessionId,
      initialJudgement: TestJudgement.Recognized,
      finalJudgement: TestJudgement.Recognized,
    });
  }
  return { services, spaceId: space.id };
}

describe("词汇页", () => {
  it("手录用法随释义显示；点击列表空白收起，点击其他卡片直接换详情", async () => {
    const user = userEvent.setup();
    const services = createTestServicesWithClock({ now: () => new Date(FIXED_NOW) });
    const space = services.spaces.createAndActivate({ name: "用法验收", learningMode: "常规模式" });
    services.regularLearning.recordEntries({ spaceId: space.id, entries: [
      new ConfirmedEntry("abandon", [{ partOfSpeech: "v.", definition: "放弃", usage: "abandon ship" }]),
      new ConfirmedEntry("elaborate", [{ partOfSpeech: "a.", definition: "详尽的", usage: null }]),
    ] });
    const timeline = vi.spyOn(services.learningViews, "listVocabularyTimeline");
    renderApp(services);
    await user.click(screen.getByTestId("nav-vocabulary"));
    expect(screen.getByTestId("vocab-card-abandon")).toHaveTextContent("用法：abandon ship");
    await user.click(screen.getByTestId("vocab-card-abandon"));
    expect(screen.getByTestId("vocabulary-manual-meaning")).toHaveValue("v. 放弃 · 用法：abandon ship");
    expect(timeline).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("vocab-card-elaborate"));
    expect(screen.getByTestId("vocabulary-detail")).toHaveTextContent("elaborate");
    // main 的非卡片留白可收起；旧监听只绑在有最大宽度的 PageShell，
    // 页面容器外的主内容区留白不会触发，此处专门覆盖那个边界。
    const main = document.querySelector<HTMLElement>(".main-area");
    if (main === null) throw new Error("缺少主内容区");
    await user.click(main);
    expect(screen.queryByTestId("vocabulary-detail")).not.toBeInTheDocument();
  });

  it("空 Space 显示规格空状态", async () => {
    renderApp();
    await userEvent.setup().click(screen.getByTestId("nav-vocabulary"));
    expect(screen.getByTestId("empty-state")).toHaveTextContent("还没有录入任何词");
  });

  it("卡片按录入倒序；详情按 V1 顺序显示手录释义、在线释义与折叠记录", async () => {
    const user = userEvent.setup();
    const { services, spaceId } = seedVocabulary();
    const abandonId = services.learningViews.listVocabularyEntries(spaceId).find((entry) => entry.originalSpelling === "abandon")?.wordId;
    if (abandonId === undefined) throw new Error("缺少测试词条");
    services.runtime.dictionaryCacheStore.replace({
      id: "dictionary-test-1", wordId: abandonId, provider: "有道词典", normalizedWord: "abandon",
      definitions: [{ partOfSpeech: "v.", definition: "舍弃" }], rawResponseSummary: "测试释义",
      fetchedAt: FIXED_NOW.toISOString(), cacheStatus: "有效",
    });
    renderApp(services);
    await user.click(screen.getByTestId("nav-vocabulary"));

    // 未掌握固定在前；同状态内最新录入在最上（elaborate 后录入 → 先显示）。
    const cards = screen.getAllByTestId(/^vocab-card-/);
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("elaborate"),
      expect.stringContaining("abandon"),
    ]);

    // 点击卡片 → 右侧详情（默认不展开）。
    expect(screen.queryByTestId("vocabulary-detail")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("vocab-card-abandon"));
    const detail = screen.getByTestId("vocabulary-detail");
    expect(within(detail).getByTestId("vocabulary-manual-meaning")).toHaveValue("v. 放弃");
    expect(await within(detail).findByTestId("vocabulary-online-section")).toHaveTextContent("在线释义");
    expect(within(detail).getByTestId("vocabulary-online-meanings")).toHaveValue("v.：舍弃");
    expect(within(detail).getByTestId("vocabulary-timeline-toggle")).toHaveAttribute("aria-expanded", "false");
    await user.click(within(detail).getByTestId("vocabulary-timeline-toggle"));
    expect(within(detail).getByTestId("vocabulary-timeline")).toHaveTextContent("测试作答");

    // 收起详情。
    await user.click(screen.getByTestId("vocabulary-detail-close"));
    expect(screen.queryByTestId("vocabulary-detail")).not.toBeInTheDocument();
    void services;
  });

  it("搜索实时匹配英文与中文释义", async () => {
    const user = userEvent.setup();
    const { services } = seedVocabulary();
    renderApp(services);
    await user.click(screen.getByTestId("nav-vocabulary"));
    await user.click(screen.getByTestId("vocabulary-filter-toggle"));

    // 英文前缀匹配。
    await user.type(screen.getByTestId("vocabulary-search"), "aban");
    expect(screen.getByTestId("vocab-card-abandon")).toBeInTheDocument();
    expect(screen.queryByTestId("vocab-card-elaborate")).not.toBeInTheDocument();

    // 中文释义匹配。
    await user.clear(screen.getByTestId("vocabulary-search"));
    await user.type(screen.getByTestId("vocabulary-search"), "详尽");
    expect(screen.getByTestId("vocab-card-elaborate")).toBeInTheDocument();
    expect(screen.queryByTestId("vocab-card-abandon")).not.toBeInTheDocument();
    void services;
  });

  it("状态筛选与详情解耦：词条被过滤掉时详情自动收起", async () => {
    const user = userEvent.setup();
    const { services } = seedVocabulary();
    renderApp(services);
    await user.click(screen.getByTestId("nav-vocabulary"));
    await user.click(screen.getByTestId("vocab-card-abandon"));
    expect(screen.getByTestId("vocabulary-detail")).toBeInTheDocument();

    // 切到"已掌握"筛选：abandon 未掌握，被过滤 → 详情收起，列表空结果提示。
    await user.click(screen.getByTestId("vocabulary-filter-toggle"));
    await user.selectOptions(screen.getByTestId("vocabulary-status-filter"), "已掌握");
    expect(screen.queryByTestId("vocabulary-detail")).not.toBeInTheDocument();
    expect(screen.getByTestId("empty-state")).toHaveTextContent("没有匹配的词");
    void services;
  });

  it("详情双向掌握立即写事件并刷新卡片；删除先展开确认再移除", async () => {
    const user = userEvent.setup();
    const { services } = seedVocabulary();
    renderApp(services);
    await user.click(screen.getByTestId("nav-vocabulary"));
    await user.click(screen.getByTestId("vocab-card-abandon"));
    await user.click(screen.getByTestId("vocabulary-mark-mastery"));
    expect(screen.getByTestId("vocabulary-mark-mastery")).toHaveTextContent("标记为未掌握");
    expect(services.runtime.eventStore.listAllEvents().some((event) => event.eventType === "wordManuallyMarkedMastered")).toBe(true);
    await user.click(screen.getByTestId("vocabulary-mark-mastery"));
    expect(screen.getByTestId("vocabulary-mark-mastery")).toHaveTextContent("标记为已掌握");
    expect(services.runtime.eventStore.listAllEvents().some((event) => event.eventType === "wordManuallyMarkedUnmastered")).toBe(true);

    await user.click(screen.getByTestId("vocabulary-remove"));
    expect(screen.getByTestId("vocab-card-abandon")).toBeInTheDocument();
    await user.click(screen.getByTestId("vocabulary-cancel-delete"));
    expect(screen.getByTestId("vocab-card-abandon")).toBeInTheDocument();
    await user.click(screen.getByTestId("vocabulary-remove"));
    await user.click(screen.getByTestId("vocabulary-confirm-delete"));
    expect(screen.queryByTestId("vocab-card-abandon")).not.toBeInTheDocument();
  });
});
