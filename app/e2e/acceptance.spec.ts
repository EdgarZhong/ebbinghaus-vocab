/**
 * 用户级验收走查（界面规格第 16.1 节八项核心任务）。
 *
 * 性质：替代 Computer Use 的浏览器用户级验收（判断文件 C8）——每项任务按真实
 * 用户旅程逐步点击/键盘操作并断言可见结果，证据截图落盘。与 smoke.spec.ts 的
 * 区别：这里按"任务书"组织，一项任务一个 test，全部通过 = 八项核心任务 100%。
 *
 * 词书模式完整闭环说明（如实记录）：词书逐词测试会话用例尚未移植（UI-2 报告
 * 缺口 1），任务 3 的词书"测试后复习确认"路径当前不可达；本文件以常规模式验证
 * 任务 3 的可达部分（完成测试 → 独立复习页朗读分组），词书路径列为遗留缺口。
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { expectActiveSpace, navTo, openSpaceManagement } from "./nav.ts";

const screenshotsDir = join(dirname(fileURLToPath(import.meta.url)), "__screenshots__");

async function screenshot(page: Page, key: string): Promise<void> {
  const projectName = test.info().project.name;
  await page.screenshot({ path: join(screenshotsDir, `${projectName}-accept-${key}.png`) });
}

test.beforeAll(() => {
  mkdirSync(screenshotsDir, { recursive: true });
});

// 复用 smoke.spec.ts 的种子钩子类型与播种函数（拷贝最小形态，保持本文件自包含）。
interface SeedServices {
  spaces: { createAndActivate(input: { name: string; learningMode: string }): { id: string } };
  eventRecorder: {
    record(input: {
      eventType: string;
      targetType: string;
      targetId: string;
      source: string;
      occurredAt: Date;
      metadata: Record<string, unknown>;
    }): unknown;
  };
  runtime: {
    wordContentStore: { upsertEntries(entries: readonly unknown[]): void };
    fsrsCardStore: { upsert(record: Record<string, unknown>): void };
    eventStore: { appendEvents(events: readonly unknown[]): void };
  };
  settings: {
    saveLearningDaySettings(input: { timezoneName: string; dayRolloverTime: string }): void;
    getLearningScheduleSettings(): { timezoneName: string; dayRolloverTime: string };
  };
  notifyChanged(): void;
}

async function seedRegularDueEntries(page: Page, count: number): Promise<void> {
  await page.evaluate((entryCount) => {
    const services = (window as unknown as { __ebbinghaus: SeedServices })["__ebbinghaus"];
    const space = services.spaces.createAndActivate({ name: "验收积累", learningMode: "常规模式" });
    const pastMs = Date.now() - 2 * 86_400_000;
    const pastIso = new Date(pastMs).toISOString();
    const cardJson = JSON.stringify({
      due: pastIso,
      stability: 1,
      difficulty: 5,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      lastReview: null,
    });
    for (let index = 0; index < entryCount; index += 1) {
      const wordId = `e2e-word-${index}`;
      services.runtime.wordContentStore.upsertEntries([
        {
          wordId,
          listId: null,
          spaceId: space.id,
          originalSpelling: `word${index}`,
          normalizedKey: `word${index}`,
          manualMeaning: `v. 释义${index}`,
          meanings: [{ partOfSpeech: "v.", definition: `释义${index}`, usage: null }],
          removed: false,
          recordedAt: pastIso,
        },
      ]);
      services.runtime.fsrsCardStore.upsert({
        wordId,
        cardJson,
        dueAt: pastIso,
        schedulerJson: "{}",
        algorithmVersion: "e2e-seed-v1",
        libraryVersion: "e2e-seed",
        updatedAt: pastIso,
        cardState: "New",
        cumulativeRecognizedCount: 0,
        lastFinalJudgement: null,
      });
      const event = services.eventRecorder.record({
        eventType: "firstPassRecorded",
        targetType: "条目",
        targetId: wordId,
        source: "验收种子",
        occurredAt: new Date(pastMs),
        metadata: { workload: 1 },
      });
      services.runtime.eventStore.appendEvents([event]);
    }
    services.notifyChanged();
  }, count);
}

test("任务1：打开应用 5 秒内回答『现在先做什么』并开始最优先测试", async ({ page }) => {
  await page.goto("/");
  await seedRegularDueEntries(page, 5);

  // 今日页立即给出唯一视觉最强的下一步动作（先做什么 = 测试第 1 组）。
  await expect(page.getByTestId("today-next-title")).toHaveText(/测试第 1 组/);
  // 到期任务 ≤2 次点击进入（16.2 质量门）：点击下一步卡片 → 测试页 → 开始组。
  await page.getByTestId("today-start-test").click();
  await page.getByTestId("test-start-1").click();
  await expect(page.getByTestId("test-session")).toBeVisible();
  await screenshot(page, "task1-start-test");
});

test("任务2：暂停测试后重新进入并继续剩余 Word", async ({ page }) => {
  await page.goto("/");
  await seedRegularDueEntries(page, 3);
  await page.getByTestId("today-start-test").click();
  await page.getByTestId("test-start-1").click();

  // 作答 1 题后暂停返回。
  await page.getByTestId("session-recognized").click();
  await page.getByTestId("session-next").click();
  await page.getByTestId("session-pause").click();
  await expect(page.getByRole("heading", { level: 1, name: "测试" })).toBeVisible();

  // 重新进入同一组（按钮转为"继续测试"）：从上次确认点继续。
  await page.getByTestId("test-start-1").click();
  await expect(page.getByTestId("test-session")).toBeVisible();
  await expect(page.getByTestId("test-session-remaining")).toHaveText("本组尚余 2 个条目");
  await screenshot(page, "task2-resume");

  // 继续完成剩余 2 题。
  for (let round = 0; round < 2; round += 1) {
    await page.getByTestId("session-recognized").click();
    await page.getByTestId("session-next").click();
  }
  await expect(page.getByTestId("test-completed")).toBeVisible();
});

test("任务3：完成软件测试后进入独立复习流程（常规朗读分组一致）", async ({ page }) => {
  await page.goto("/");
  await seedRegularDueEntries(page, 2);
  await page.getByTestId("today-start-test").click();
  await page.getByTestId("test-start-1").click();
  for (let round = 0; round < 2; round += 1) {
    await page.getByTestId("session-recognized").click();
    await page.getByTestId("session-next").click();
  }
  await page.getByTestId("test-go-review").click();

  // 复习页与测试页始终是两个独立一级任务（第 2 章口径 7）；朗读分组只读。
  await expect(page.getByRole("heading", { level: 1, name: "复习" })).toBeVisible();
  await expect(page.getByTestId("review-group-1")).toContainText("已测试 2 个条目");
  await page.getByTestId("review-group-expand-1").click();
  // 只读朗读：展开后可见"刚刚忘记/其余已测试条目"内容，无任何完成/确认/推迟操作。
  await expect(page.getByRole("heading", { name: "其余已测试条目" })).toBeVisible();
  await expect(page.getByRole("listitem").first()).toContainText("word0");
  expect(await page.getByRole("button", { name: /完成|确认|推迟/ }).count()).toBe(0);
  await screenshot(page, "task3-review-reading");
});

test("任务4：根据建议进入首过，完成输入、检查和保存", async ({ page }) => {
  await page.goto("/");
  // 常规模式 Space（默认活动 Space 必考词是词书模式，首过页只显示线下引导占位）。
  await page.evaluate(() => {
    const services = (window as unknown as { __ebbinghaus: SeedServices })["__ebbinghaus"];
    services.spaces.createAndActivate({ name: "验收积累", learningMode: "常规模式" });
  });

  // 首过录入页：输入步 → 智能整理在浏览器模式如实降级（未配置提示）→ 改为手动填写。
  await navTo(page, "nav-first-pass");
  await expect(page.getByRole("heading", { level: 1, name: "录入条目" })).toBeVisible();
  await page.getByTestId("firstpass-organize").click();
  await expect(page.getByTestId("firstpass-organize-error")).toBeVisible();
  await page.getByTestId("firstpass-switch-manual").click();
  await page.getByTestId("firstpass-term-0").fill("serendipity");
  await page.getByTestId("firstpass-def-0-0").fill("意外发现珍宝的运气");
  await screenshot(page, "task4-firstpass-form");

  // 检查（预览保存语义：表单即检查页）→ 保存，进入完成反馈。
  await page.getByTestId("firstpass-save").click();
  await expect(page.getByText("录入完成")).toBeVisible();

  // 词汇页可查到新条目（录入事实已入库）。
  await navTo(page, "nav-vocabulary");
  await expect(page.getByTestId("vocab-card-serendipity")).toBeVisible();
});

test("任务5：词汇卡片倒序找词，右侧详情可理解", async ({ page }) => {
  await page.goto("/");
  await seedRegularDueEntries(page, 6);

  await navTo(page, "nav-vocabulary");
  const list = page.getByTestId("vocabulary-list");
  // 录入倒序：最新在最上（word5 先于 word0）。
  const firstCardY = await list.getByTestId("vocab-card-word5").boundingBox();
  const laterCardY = await list.getByTestId("vocab-card-word0").boundingBox();
  expect(firstCardY!.y).toBeLessThan(laterCardY!.y);

  // 打开右侧详情：自己的释义、当前状态、最近结果可理解（行为语言）。
  await list.getByTestId("vocab-card-word5").click();
  await expect(page.getByTestId("vocabulary-detail")).toBeVisible();
  await expect(page.getByTestId("vocabulary-detail")).toContainText("释义5");
  await screenshot(page, "task5-vocab-detail");
});

test("任务6：侧边栏箭头进入 Space 管理，创建、切换并返回原页面", async ({ page }) => {
  await page.goto("/");
  await navTo(page, "nav-settings");

  await openSpaceManagement(page);
  await expect(page.getByRole("heading", { level: 1, name: "Space 管理" })).toBeVisible();
  await page.getByTestId("create-space-button").click();
  await page.getByTestId("space-name-input").fill("验收新建");
  await page.getByTestId("space-create-submit").click();

  // 切换 Space 后返回进入管理页之前的页面（设置页），上下文立即切换。
  await openSpaceManagement(page);
  await page.getByTestId("space-select-必考词").click();
  await expectActiveSpace(page, "必考词");
  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  await screenshot(page, "task6-space-switch");
});

test("任务7：重命名、归档、恢复 Space；非空 Space 不能删除", async ({ page }) => {
  await page.goto("/");
  await seedRegularDueEntries(page, 1); // "验收积累"从此为非空 Space
  await openSpaceManagement(page);
  await page.getByTestId("space-select-必考词").click();
  await openSpaceManagement(page);

  // 重命名常考词 → 归档 → 已归档折叠区出现。
  await page.getByTestId("space-edit-常考词").click();
  await page.getByTestId("space-rename-input").fill("常考词二零二六");
  await page.getByTestId("space-rename-submit").click();
  await expect(page.getByTestId("space-row-常考词二零二六")).toBeVisible();

  await page.getByTestId("space-edit-常考词二零二六").click();
  await page.getByTestId("space-archive-button").click();
  await page.getByTestId("space-archive-confirm").click();
  await expect(page.getByTestId("archived-section-toggle")).toHaveText(/已归档（1）/);

  // 恢复。
  await page.getByTestId("archived-section-toggle").click();
  await page.getByTestId(`space-restore-常考词二零二六`).click();
  await expect(page.getByTestId("space-row-常考词二零二六")).toBeVisible();

  // 非空 Space（验收积累有学习数据）编辑面板不提供删除按钮。
  await page.getByTestId("space-edit-验收积累").click();
  expect(await page.getByTestId("space-delete-button").count()).toBe(0);
  await screenshot(page, "task7-space-lifecycle");
});

test("任务8：今日看板修改每日目标；设置中修改换日时间", async ({ page }) => {
  await page.goto("/");

  // 今日页每日目标 Stepper 调整并保存（默认 0 → 增加 1）。
  await page.getByTestId("today-daily-target-increase").click();
  await page.getByTestId("today-save-target").click();

  // 持久化验证：设置页的每日目标显示新值。
  await navTo(page, "nav-settings");
  await expect(page.getByTestId("settings-daily-target")).toHaveValue("1");

  // 设置页修改换日时间并保存成功。
  await navTo(page, "nav-settings");
  await page.getByTestId("settings-rollover").fill("05:30");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-status")).toHaveText("设置已保存。");
  await screenshot(page, "task8-targets");
});
