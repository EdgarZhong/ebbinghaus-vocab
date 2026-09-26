/**
 * 浏览器冒烟验收（真实 vite preview 服务）：
 * - 主路径：六个一级页面导航、Space 创建与切换、设置改值保存、主题切换与刷新恢复；
 * - UI-2 扩展：常规模式逐词测试会话主路径（今日页 ≤2 次点击进入、作答到完成）、
 *   词汇页 60 词列表滚动冒烟；
 * - 每个核心页面在当前视口输出全窗口 PNG 到 e2e/__screenshots__/，
 *   文件名形如 {项目名}-{页面}.png，供三视口视觉复核（界面规格测试要求）。
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  ensureNavVisible,
  expectActiveSpace,
  isMobileShell,
  navTo,
  openSpaceManagement,
  setTheme,
  waitAnimationsSettled,
  waitDarkGlassSettled,
} from "./nav.ts";

const screenshotsDir = join(dirname(fileURLToPath(import.meta.url)), "__screenshots__");

/** 全窗口截图（视口即完整浏览器窗口），按项目名+页面键落盘。 */
async function screenshot(page: Page, key: string): Promise<void> {
  const projectName = test.info().project.name;
  await page.screenshot({ path: join(screenshotsDir, `${projectName}-${key}.png`) });
}

test.beforeAll(() => {
  mkdirSync(screenshotsDir, { recursive: true });
});

const NAV_PAGES: readonly { navTestId: string; heading: string | RegExp; key: string }[] = [
  { navTestId: "nav-today", heading: /今天/, key: "today" },
  { navTestId: "nav-review", heading: "复习", key: "review" },
  { navTestId: "nav-test", heading: "测试", key: "test" },
  { navTestId: "nav-first-pass", heading: "录入词汇", key: "first-pass" },
  { navTestId: "nav-vocabulary", heading: "词汇", key: "vocabulary" },
  { navTestId: "nav-settings", heading: "设置", key: "settings" },
];

test("六个一级页面导航冒烟并输出全窗口截图", async ({ page }) => {
  await page.goto("/");
  await expectActiveSpace(page, "必考词");

  // 移动端结构：先补一张抽屉打开态截图（本轮重构的签名交互，视觉验收证据）。
  // 抽屉有 200ms 滑入动画，等动画沉淀后再截图（否则抓到半透明残影）。
  if (isMobileShell(page)) {
    await ensureNavVisible(page);
    await waitAnimationsSettled(page, "nav-drawer");
    await screenshot(page, "nav-drawer");
    await page.keyboard.press("Escape");
  }

  for (const item of NAV_PAGES) {
    await navTo(page, item.navTestId);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(item.heading);
    await screenshot(page, item.key);
  }
});

test("Space 管理：创建、切换并返回原页面", async ({ page }) => {
  await page.goto("/");
  // 从设置页进入 Space 管理，验证"返回进入前页面"的语义。
  await navTo(page, "nav-settings");
  await openSpaceManagement(page);
  await expect(page.getByRole("heading", { level: 1, name: "Space 管理" })).toBeVisible();

  await page.getByTestId("create-space-button").click();
  await page.getByTestId("space-name-input").fill("浏览器验收空间");
  await screenshot(page, "space-create-dialog");
  await page.getByTestId("space-create-submit").click();

  // 创建成功后返回设置页，侧边栏与短暂反馈同步更新。
  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  await expectActiveSpace(page, "浏览器验收空间");
  // Toast 会堆叠（产品语义），断言最新一条。
  await expect(page.getByTestId("toast").last()).toContainText("已创建并切换到浏览器验收空间");

  // 重新进入 Space 管理页并切换回必考词。
  await openSpaceManagement(page);
  await screenshot(page, "space-management");
  await page.getByTestId("space-select-必考词").click();
  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  await expectActiveSpace(page, "必考词");
  await expect(page.getByTestId("toast").last()).toContainText("已切换到必考词");
});

test("设置：修改换日时间并保存成功", async ({ page }) => {
  await page.goto("/");
  await navTo(page, "nav-settings");
  await expect(page.getByTestId("settings-timezone")).toHaveValue("Asia/Shanghai");

  await page.getByTestId("settings-rollover").fill("05:30");
  await screenshot(page, "settings-editing");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-status")).toContainText("设置已保存。");
  await screenshot(page, "settings-saved");
});

test("主题：切换深色并跨刷新恢复", async ({ page }) => {
  await page.goto("/");
  await setTheme(page, "theme-dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // 主题开关不是导航项，移动端点击后抽屉保持打开；截图"深色今日页"前先收起。
  if (isMobileShell(page)) {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("nav-drawer")).toHaveCount(0);
  }
  await waitDarkGlassSettled(page);
  await screenshot(page, "today-dark");

  // 主题选择存设备本地 KV（浏览器底座为 localStorage），刷新后保持。
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

// ---------------------------------------------------------------------------
// UI-2 扩展：学习主路径冒烟
// ---------------------------------------------------------------------------

/** 浏览器验收种子钩子（main.tsx 注入）的最小访问类型。 */
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
  /** 组件树经 useSyncExternalStore 订阅该版本号：播种后必须通知重读。 */
  notifyChanged(): void;
}

/**
 * 在浏览器内存运行时播种常规模式 Space 与 count 条"两天前录入"的到期条目。
 *
 * 直接经事件工厂 + 本地内容/卡片存储构造与真实写入同构的事实（事件未过调度、
 * 卡片为 FSRS 新卡快照）：条目资格日（录入日 + 1）已过且新卡天然到期，打开
 * 测试页即可逐词作答。每次 page.goto 重建内存运行时，用例之间天然隔离。
 */
async function seedRegularDueEntries(page: Page, count: number): Promise<void> {
  await page.evaluate((entryCount) => {
    const services = (window as unknown as { __ebbinghaus: SeedServices })["__ebbinghaus"];
    const space = services.spaces.createAndActivate({ name: "验收积累", learningMode: "常规模式" });
    const pastMs = Date.now() - 2 * 86_400_000;
    const pastIso = new Date(pastMs).toISOString();
    // FSRS 新卡快照（ts-fsrs Card 的 JSON 安全形态，state 0 = New）。
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
    // 播种在 React 首渲染之后：通知订阅者整体重读（否则组件仍显示旧快照）。
    services.notifyChanged();
  }, count);
}

test("逐词测试主路径：今日页 ≤2 次点击进入，作答到完成", async ({ page }) => {
  await page.goto("/");
  await seedRegularDueEntries(page, 3);
  // 内存运行时随页面刷新重建：播种后只能客户端导航，不得 reload。

  // 今日页下一步卡片直指最优先测试组；点击 1 → 测试页。
  await expect(page.getByTestId("today-next-title")).toHaveText(/测试第 1 组/);
  await page.getByTestId("today-start-test").click();
  await expect(page.getByRole("heading", { level: 1, name: "测试" })).toBeVisible();

  // 点击 2 → 开始该组，进入逐词会话（到达到期任务共 2 次点击，规格 16.2）。
  await page.getByTestId("test-start-1").click();
  await expect(page.getByTestId("test-session")).toBeVisible();
  await expect(page.getByTestId("test-session-remaining")).toHaveText("本组尚余 3 个条目");
  await screenshot(page, "test-session");

  // 逐词作答：认识 → 下一个（三次），直至完成。
  for (let round = 0; round < 3; round += 1) {
    await page.getByTestId("session-recognized").click();
    await expect(page.getByTestId("session-meaning")).toBeVisible();
    await page.getByTestId("session-next").click();
  }

  // 完成反馈（规格 10.5）+ 去复习进入常规朗读分组。
  await expect(page.getByTestId("test-completed")).toBeVisible();
  await page.getByTestId("test-go-review").click();
  await expect(page.getByRole("heading", { level: 1, name: "复习" })).toBeVisible();
  await expect(page.getByTestId("review-group-1")).toContainText("已测试 3 个条目");
  await screenshot(page, "review-reading");
});

test("词汇页：60 词单列卡片倒序与滚动冒烟", async ({ page }) => {
  await page.goto("/");
  await seedRegularDueEntries(page, 60);
  // 内存运行时随页面刷新重建：播种后只能客户端导航，不得 reload。

  await navTo(page, "nav-vocabulary");
  const list = page.getByTestId("vocabulary-list");

  // 最新录入在最上方（同状态内按录入倒序），最旧词条在列表末尾。
  await expect(list.getByTestId("vocab-card-word59")).toBeVisible();
  await expect(list.getByTestId("vocab-card-word0")).toBeAttached();
  await expect(list.getByTestId("vocab-card-word0")).not.toBeInViewport();

  // 滚动到列表末尾：最旧词条进入视口（60 词长列表滚动可用，无横向溢出）。
  await list.getByTestId("vocab-card-word0").scrollIntoViewIfNeeded();
  await expect(list.getByTestId("vocab-card-word0")).toBeInViewport();
  await screenshot(page, "vocabulary-60");

  // 实时搜索过滤。
  await page.getByTestId("vocabulary-filter-toggle").click();
  await page.getByTestId("vocabulary-search").fill("word7");
  await expect(list.getByTestId("vocab-card-word7")).toBeVisible();
  await expect(list.getByTestId("vocab-card-word6")).toHaveCount(0);
});
