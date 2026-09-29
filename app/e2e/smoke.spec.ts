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
    // 手机浏览器允许纵向滚动，但任一一级页都不应把内容挤出视口右缘；
    // 这个几何断言补足截图肉眼难辨的少量横向溢出。
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );
    await screenshot(page, item.key);
  }
});

test("切页先显示骨架，再挂载本地内容；录入框有足够高度", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const state = { seen: false };
    (window as unknown as { __routeSkeletonState: typeof state }).__routeSkeletonState = state;
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="route-skeleton"]')) state.seen = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await navTo(page, "nav-vocabulary");
  expect(await page.evaluate(() => (window as unknown as { __routeSkeletonState: { seen: boolean } }).__routeSkeletonState.seen)).toBe(true);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await navTo(page, "nav-first-pass");
  const input = page.getByTestId("firstpass-raw-input");
  await expect(input).toBeVisible();
  expect((await input.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(240);
});

test("词书录入两步的 Unit 与 List 编号在手机宽度下互不遮挡", async ({ page }) => {
  await page.goto("/");
  await navTo(page, "nav-first-pass");

  // 两步共用同一字段组，但位于不同容器。逐步检查真实布局盒，防止 label
  // 的行内排版让 100% 宽输入框侵入隔壁字段；尤其覆盖 412px 手机视口。
  const expectSeparateFields = async () => {
    const group = await page.getByTestId("firstpass-book-location").boundingBox();
    const unit = await page.getByTestId("firstpass-unit-number").boundingBox();
    const list = await page.getByTestId("firstpass-list-number").boundingBox();
    expect(group).not.toBeNull();
    expect(unit).not.toBeNull();
    expect(list).not.toBeNull();
    expect(unit!.x + unit!.width).toBeLessThanOrEqual(list!.x);
    expect(unit!.x).toBeGreaterThanOrEqual(group!.x);
    expect(list!.x + list!.width).toBeLessThanOrEqual(group!.x + group!.width);
    expect(unit!.height).toBeGreaterThanOrEqual(40);
    expect(list!.height).toBeGreaterThanOrEqual(40);
  };

  await expectSeparateFields();
  await screenshot(page, "first-pass-book-location-input");
  await page.getByTestId("firstpass-raw-input").fill("词汇、词性、释义与用法。".repeat(80));
  // 长文本应在输入框内部滚动，不撑出页面横向滚动或挡住下一步入口。
  expect(await page.getByTestId("firstpass-raw-input").evaluate((input) => input.scrollHeight > input.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );
  await expect(page.getByTestId("firstpass-direct-manual")).toBeVisible();
  await screenshot(page, "first-pass-long-input");
  await page.getByTestId("firstpass-direct-manual").click();
  await expect(page.getByTestId("firstpass-step-label")).toBeVisible();
  await expectSeparateFields();
  await screenshot(page, "first-pass-book-location-check");
});

test("重复词可展开新旧释义对照并全选处理，桌面和手机弹窗保持清晰", async ({ page }) => {
  await page.goto("/");
  await navTo(page, "nav-first-pass");
  const fillBatch = async (firstMeaning: string, secondMeaning: string): Promise<void> => {
    await page.getByTestId("firstpass-direct-manual").click();
    await page.getByTestId("firstpass-term-0").fill("abandon");
    await page.getByTestId("firstpass-def-0-0").fill(firstMeaning);
    await page.getByTestId("firstpass-add-entry").click();
    await page.getByTestId("firstpass-term-1").fill("retain");
    await page.getByTestId("firstpass-def-1-0").fill(secondMeaning);
    await page.getByTestId("firstpass-save").click();
  };
  await fillBatch("旧释义：放弃", "旧释义：保留");
  await fillBatch("新释义：抛弃", "新释义：保持");

  const modal = page.getByTestId("modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("conflict-progress")).toHaveText("已处理 0 / 2 项");
  await expect(page.getByTestId("conflict-details-abandon")).toHaveAttribute("open", "");
  await expect(page.getByTestId("conflict-row-abandon")).toContainText("旧释义：放弃");
  await expect(page.getByTestId("conflict-row-abandon")).toContainText("新释义：抛弃");
  expect(await modal.evaluate((element) => getComputedStyle(element).backgroundColor)).toMatch(/^rgb\(/);
  expect(await modal.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toContain("rgba");
  const existing = await page.locator(".conflict-version-existing").first().boundingBox();
  const incoming = await page.locator(".conflict-version-incoming").first().boundingBox();
  expect(existing).not.toBeNull();
  expect(incoming).not.toBeNull();
  // 800px 紧凑桌面使用移动导航抽屉，但对照列仍按 600px CSS 断点并排。
  if ((page.viewportSize()?.width ?? 0) <= 600) expect(incoming!.y).toBeGreaterThan(existing!.y);
  else expect(incoming!.x).toBeGreaterThan(existing!.x);
  if ((page.viewportSize()?.width ?? 0) <= 600) {
    const overwrite = await page.getByTestId("conflict-overwrite-abandon").boundingBox();
    const skip = await page.getByTestId("conflict-skip-abandon").boundingBox();
    expect(overwrite).not.toBeNull();
    expect(skip).not.toBeNull();
    expect(Math.abs(overwrite!.y - skip!.y)).toBeLessThan(2);
  }
  await screenshot(page, "conflict-compare");

  await page.getByTestId("conflict-select-all").check();
  await page.getByTestId("conflict-bulk-skip").click();
  await expect(page.getByTestId("conflict-progress")).toHaveText("已处理 2 / 2 项");
  await page.getByTestId("conflict-overwrite-abandon").click();
  await expect(page.getByTestId("conflict-status-abandon")).toContainText("从 List 中删除旧词");
  await expect(page.getByTestId("conflict-commit")).toBeEnabled();
  await screenshot(page, "conflict-decided");
  await page.getByTestId("conflict-commit").click();
  await expect(modal).toHaveCount(0);
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

test("设置：修改换日时间并自动保存成功", async ({ page }) => {
  await page.goto("/");
  await navTo(page, "nav-settings");
  await expect(page.getByTestId("settings-timezone")).toHaveValue("Asia/Shanghai");

  await page.getByTestId("settings-rollover").fill("05:30");
  await screenshot(page, "settings-editing");
  await page.getByTestId("settings-rollover").blur();
  await expect(page.getByTestId("settings-status")).toContainText("设置已自动保存。");
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
          meanings: [{ partOfSpeech: "v.", definition: `释义${index}`, usage: index === 0 ? "用于上下文" : null }],
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
  let usageSeen = false;
  for (let round = 0; round < 3; round += 1) {
    const word = await page.getByTestId("session-word").textContent();
    const pauseBefore = (await page.getByTestId("session-pause").boundingBox())?.y ?? 0;
    await page.getByTestId("session-recognized").click();
    await expect(page.getByTestId("session-meaning")).toBeVisible();
    const pauseAfter = (await page.getByTestId("session-pause").boundingBox())?.y ?? 0;
    expect(Math.abs(pauseAfter - pauseBefore)).toBeLessThanOrEqual(1);
    if (word === "word0") {
      await expect(page.getByTestId("session-meaning")).toContainText("用法：用于上下文");
      usageSeen = true;
    }
    await page.getByTestId("session-next").click();
  }
  expect(usageSeen).toBe(true);

  // 完成反馈（规格 10.5）+ 去复习进入常规朗读分组。
  await expect(page.getByTestId("test-completed")).toBeVisible();
  await page.getByTestId("test-go-review").click();
  await expect(page.getByRole("heading", { level: 1, name: "复习" })).toBeVisible();
  await expect(page.getByTestId("review-group-1")).toContainText("已测试 3 个条目");
  await screenshot(page, "review-reading");
});

test("测试页点错了移到队尾，桌面左上暂停与手机底部次级按钮保持清楚", async ({ page }) => {
  await page.goto("/");
  await seedRegularDueEntries(page, 2);
  await page.getByTestId("today-start-test").click();
  await page.getByTestId("test-start-1").click();
  const firstWord = await page.getByTestId("session-word").textContent();
  const pauseBox = await page.getByTestId("session-pause").boundingBox();
  const remainingBox = await page.getByTestId("test-session-remaining").boundingBox();
  expect(pauseBox).not.toBeNull();
  expect(remainingBox).not.toBeNull();
  expect(pauseBox!.x + pauseBox!.width).toBeLessThan(remainingBox!.x);
  expect(Math.abs(pauseBox!.y - remainingBox!.y)).toBeLessThan(20);

  await page.getByTestId("session-not-recognized").click();
  const confirmBox = await page.getByTestId("session-confirm-not-recognized").boundingBox();
  const deferBox = await page.getByTestId("session-defer").boundingBox();
  expect(confirmBox).not.toBeNull();
  expect(deferBox).not.toBeNull();
  expect(deferBox!.width).toBeLessThan(confirmBox!.width);
  if (isMobileShell(page)) {
    // 手机上暂缓按钮位于卡片末端，与主确认留出足够距离；快捷键提示
    // 只在桌面显示，Android WebView 无需出现物理键盘文案。
    expect(deferBox!.y - (confirmBox!.y + confirmBox!.height)).toBeGreaterThanOrEqual(40);
    if ((page.viewportSize()?.width ?? 0) <= 560) {
      const bottomPadding = await page.locator(".test-session").evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingBottom),
      );
      expect(bottomPadding).toBeGreaterThanOrEqual(32);
    }
    await expect(page.locator(".test-session-shortcut").first()).toBeHidden();
  } else {
    await expect(page.locator(".test-session-shortcut").first()).toBeVisible();
  }
  await screenshot(page, "test-session-unknown-revealed");
  await page.getByTestId("session-defer").click();
  await expect(page.getByTestId("session-word")).not.toHaveText(firstWord ?? "");
  await expect(page.getByTestId("session-answer-panel")).toHaveClass(/pending/);
  await expect(page.getByTestId("test-session-remaining")).toContainText("尚余 2 个条目");
  await page.getByTestId("session-recognized").click();
  await page.getByTestId("session-next").click();
  await expect(page.getByTestId("session-word")).toHaveText(firstWord ?? "");
  await expect(page.getByTestId("session-answer-panel")).toHaveClass(/pending/);
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
