/**
 * 词汇页测试：单列卡片与录入倒序、右侧滑出详情（释义/状态/最近结果）、实时
 * 搜索与状态筛选、筛选与详情解耦、空状态。
 */

import { describe, expect, it } from "vitest";
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
  it("空 Space 显示规格空状态", async () => {
    renderApp();
    await userEvent.setup().click(screen.getByTestId("nav-vocabulary"));
    expect(screen.getByTestId("empty-state")).toHaveTextContent("还没有录入任何词");
  });

  it("卡片按录入倒序；详情滑出显示释义、状态与最近结果", async () => {
    const user = userEvent.setup();
    const { services } = seedVocabulary();
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
    expect(within(detail).getByTestId("vocabulary-detail-meta")).toHaveTextContent("学习中");
    expect(within(detail).getByText(/放弃/)).toBeInTheDocument();
    expect(within(detail).getByTestId("vocabulary-detail-progress")).toHaveTextContent("最近一次测试：认识。");

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
});
