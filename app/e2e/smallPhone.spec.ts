/**
 * 约 360×792 CSS px 的 Android 小手机布局回归。
 * 模拟原生状态栏注入 24px inset，逐项量测可触达尺寸和横向溢出；真实软键盘、
 * 系统栏绘制与后台恢复仍由 Android 模拟器验收，浏览器用例不冒充 WebView。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { navTo, openSpaceManagement, waitAnimationsSettled } from "./nav.ts";

test.use({ viewport: { width: 360, height: 792 } });

/** e2e 播种用的最小服务接口（与 smoke.spec.ts 同形态，本文件自包含）。 */
interface SeedServices {
  getActiveSpace(): { id: string } | null;
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
    bookCatalogStore: {
      addUnit(unit: { id: string; spaceId: string; number: number }): void;
      addList(record: {
        listId: string; spaceId: string; unitId: string; unitNumber: number; listNumber: number;
      }): void;
    };
    eventStore: { appendEvents(events: readonly unknown[]): void };
  };
  notifyChanged(): void;
}

/**
 * 词书复习候选种子（默认活动 Space"必考词"即词书模式）：
 * - reviewOnlyCount 个词的 T1 = 昨天 → T1 + 1 = 今天，仅复习日期当日到期（候选集
 *   第一部分，2026-10-02 口径：逾期不再进入候选集）；
 * - 另 1 个词（serendipity）今天完成测试（候选集第二部分），且释义故意超长，
 *   用于验证窄屏释义区横向滚动。
 */
async function seedBookReviewCandidates(page: Page, reviewOnlyCount: number): Promise<void> {
  await page.evaluate(({ reviewOnlyCount }) => {
    const services = (window as unknown as { __ebbinghaus: SeedServices })["__ebbinghaus"];
    const spaceId = services.getActiveSpace()?.id ?? "";
    const unitId = "e2e-unit-1";
    const listId = "e2e-list-3";
    services.runtime.bookCatalogStore.addUnit({ id: unitId, spaceId, number: 1 });
    services.runtime.bookCatalogStore.addList({
      listId, spaceId, unitId, unitNumber: 1, listNumber: 3,
    });
    const nowMs = Date.now();
    const dayMs = 86_400_000;
    const t0Iso = new Date(nowMs - 2 * dayMs).toISOString();
    const t1Iso = new Date(nowMs - 1 * dayMs).toISOString();
    const nowIso = new Date(nowMs).toISOString();
    const events: unknown[] = [];
    const wordIds: string[] = [];
    for (let index = 0; index < reviewOnlyCount; index += 1) {
      wordIds.push(`e2e-review-word-${index}`);
    }
    const extraWordId = "e2e-review-word-extra";
    const firstPass = services.eventRecorder.record({
      eventType: "firstPassRecorded",
      targetType: "List",
      targetId: listId,
      source: "验收种子",
      occurredAt: new Date(t0Iso),
      metadata: { workload: 1, wordIds: [...wordIds, extraWordId] },
    });
    events.push(firstPass);
    for (const wordId of wordIds) {
      services.runtime.wordContentStore.upsertEntries([
        {
          wordId,
          listId,
          spaceId: null,
          originalSpelling: wordId.replace("e2e-review-word-", "reviewword"),
          normalizedKey: wordId,
          manualMeaning: `v. 释义${wordId}`,
          meanings: [{ partOfSpeech: "v.", definition: `释义${wordId}`, usage: null }],
          removed: false,
          recordedAt: t0Iso,
        },
      ]);
      events.push(services.eventRecorder.record({
        eventType: "testAnswered",
        targetType: "Word",
        targetId: wordId,
        source: "验收种子",
        occurredAt: new Date(t1Iso),
        metadata: {
          sessionId: "e2e-seed-session",
          initialJudgement: "认识",
          finalJudgement: "认识",
          answerRevised: false,
          beforeState: {
            shortTermPassCount: 0,
            masteryStatus: "未掌握",
            t0: t0Iso,
            t1: null,
            t2: null,
          },
          afterState: {
            shortTermPassCount: 1,
            masteryStatus: "未掌握",
            t0: t0Iso,
            t1: t1Iso,
            t2: null,
          },
          algorithmVersion: "e2e-seed-v1",
        },
      }));
    }
    // 今天完成测试的词：T1 = 今天 → T1 + 1 明天才到期，但"今日已测"使其进入候选集。
    services.runtime.wordContentStore.upsertEntries([
      {
        wordId: extraWordId,
        listId,
        spaceId: null,
        originalSpelling: "serendipity",
        normalizedKey: "serendipity",
        manualMeaning: "n. 意外发现珍宝的运气",
        meanings: [
          {
            partOfSpeech: "n.",
            definition: "一段故意写得非常冗长的释义，用来验证三百六十像素窄屏上释义区域横向滚动而词卡行高保持固定不变",
            usage: null,
          },
        ],
        removed: false,
        recordedAt: t0Iso,
      },
    ]);
    events.push(services.eventRecorder.record({
      eventType: "testAnswered",
      targetType: "Word",
      targetId: extraWordId,
      source: "验收种子",
      occurredAt: new Date(nowIso),
      metadata: {
        sessionId: "e2e-seed-session-2",
        initialJudgement: "认识",
        finalJudgement: "认识",
        answerRevised: false,
        beforeState: {
          shortTermPassCount: 0,
          masteryStatus: "未掌握",
          t0: t0Iso,
          t1: null,
          t2: null,
        },
        afterState: {
          shortTermPassCount: 1,
          masteryStatus: "未掌握",
          t0: t0Iso,
          t1: nowIso,
          t2: null,
        },
        algorithmVersion: "e2e-seed-v1",
      },
    }));
    services.runtime.eventStore.appendEvents(events);
    services.notifyChanged();
  }, { reviewOnlyCount });
}

test("360px 复习页：List 卡触控目标、词卡两列排布、释义横滚与展开区 20 行上限", async ({ page }) => {
  await page.goto("/");
  await seedBookReviewCandidates(page, 22);

  await navTo(page, "nav-review");
  const card = page.getByTestId("review-list-Unit 1 · List 3");
  // 22 个当日到期仅复习词 + 1 个今日已测词 = 23 个候选词。
  await expect(card).toContainText("今天关注 23 个词");

  // 卡头是可点控件：触控目标 ≥44px（移动端可达性回归）。
  const header = page.getByTestId("review-list-header-Unit 1 · List 3");
  const headerBox = await header.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(headerBox!.height).toBeGreaterThanOrEqual(44);

  // 点击卡头展开词列表。
  await header.click();
  const words = page.getByTestId("review-words-Unit 1 · List 3");
  await expect(words).toBeVisible();

  // 规格 9.2：区域内部纵向滚动，最大高度 = 20 个词卡片（行高固定 44px）。
  const listMetrics = await words.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    maxHeight: getComputedStyle(node).maxHeight,
    overflowY: getComputedStyle(node).overflowY,
  }));
  expect(listMetrics.maxHeight).toBe("880px");
  expect(listMetrics.overflowY).toBe("auto");
  expect(listMetrics.clientHeight).toBeLessThan(listMetrics.scrollHeight);

  // 词卡行高固定；英文列与释义列都禁止折行——窄屏两列不错行不挤压。
  const row = words.locator(".review-word-card").first();
  const rowMetrics = await row.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    termWhiteSpace: getComputedStyle(node.querySelector(".review-word-term")!).whiteSpace,
    meaningWhiteSpace: getComputedStyle(node.querySelector(".review-word-meaning")!).whiteSpace,
  }));
  expect(rowMetrics.height).toBe(44);
  expect(rowMetrics.termWhiteSpace).toBe("nowrap");
  expect(rowMetrics.meaningWhiteSpace).toBe("nowrap");

  // 长释义词：释义区可横滚（scrollWidth > clientWidth），且不撑出页面横向滚动。
  const longRow = words.locator(".review-word-card", { hasText: "serendipity" });
  const meaningMetrics = await longRow.locator(".review-word-meaning").evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(meaningMetrics.scrollWidth).toBeGreaterThan(meaningMetrics.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  const screenshotsDir = join(dirname(fileURLToPath(import.meta.url)), "__screenshots__");
  await page.screenshot({
    path: join(screenshotsDir, `${test.info().project.name}-small-phone-review-book.png`),
  });
});

test("360px 顶栏、抽屉、长 Space 名称与六个页面保持可读可点", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => document.documentElement.style.setProperty("--android-status-inset", "24px"));

  // 手机环境同时检查 CSS 布局视口，避免设备元信息与页面 viewport 配置不一致
  // 时把实际 980px 布局误判成 360px 适配已通过。
  expect(await page.evaluate(() => ({ width: window.innerWidth, narrow: matchMedia("(max-width: 375px)").matches })))
    .toEqual({ width: 360, narrow: true });

  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      body: style.getPropertyValue("--font-size-body").trim(),
      item: style.getPropertyValue("--font-size-item").trim(),
      section: style.getPropertyValue("--font-size-section").trim(),
      pageTitle: style.getPropertyValue("--font-size-page-title").trim(),
      secondary: style.getPropertyValue("--font-size-secondary").trim(),
      margin: style.getPropertyValue("--page-margin").trim(),
      gap: style.getPropertyValue("--block-gap").trim(),
    };
  });
  expect(tokens).toEqual({
    body: "14px", item: "15px", section: "17px", pageTitle: "23px",
    secondary: "13px", margin: "16px", gap: "16px",
  });

  const menu = await page.getByTestId("nav-drawer-open").boundingBox();
  const title = await page.locator(".topbar-app-name").boundingBox();
  const capsule = await page.getByTestId("topbar-space").boundingBox();
  const topbar = await page.locator(".topbar").boundingBox();
  expect(menu).not.toBeNull();
  expect(title).not.toBeNull();
  expect(capsule).not.toBeNull();
  expect(topbar).not.toBeNull();
  expect(topbar!.height).toBe(72); // 24px 状态栏 + 48px 顶栏
  expect(menu!.width).toBeGreaterThanOrEqual(44);
  expect(menu!.height).toBeGreaterThanOrEqual(44);
  expect(capsule!.height).toBeGreaterThanOrEqual(44);
  expect(title!.x - (menu!.x + menu!.width)).toBeLessThanOrEqual(12);
  expect(capsule!.x + capsule!.width).toBeLessThanOrEqual(352);
  expect(await page.locator(".topbar-app-name").evaluate((node) => getComputedStyle(node).textAlign)).toBe("left");

  const orderMeta = page.getByTestId("today-order-test").locator(".order-row-meta");
  const orderButton = page.getByTestId("today-order-test").getByRole("button");
  const metaBox = await orderMeta.boundingBox();
  const buttonBox = await orderButton.boundingBox();
  expect(metaBox!.height).toBeLessThanOrEqual(24); // "暂无待测任务"保持单行
  expect(buttonBox!.y).toBeGreaterThanOrEqual(metaBox!.y + metaBox!.height);
  expect(buttonBox!.height).toBeGreaterThanOrEqual(44);

  const screenshotsDir = join(dirname(fileURLToPath(import.meta.url)), "__screenshots__");
  await page.screenshot({ path: join(screenshotsDir, `${test.info().project.name}-small-phone-today.png`) });

  await page.getByTestId("nav-drawer-open").click();
  await waitAnimationsSettled(page, "nav-drawer");
  const drawer = await page.getByTestId("nav-drawer").boundingBox();
  expect(drawer).not.toBeNull();
  expect(drawer!.y).toBe(28); // 24px 状态栏 + 4px 抽屉间距
  const nav = await page.getByTestId("nav-review").boundingBox();
  const theme = await page.getByTestId("theme-system").boundingBox();
  expect(nav!.height).toBeGreaterThanOrEqual(44);
  expect(theme!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: join(screenshotsDir, `${test.info().project.name}-small-phone-drawer.png`) });
  await page.keyboard.press("Escape");

  // 长名称不得扩大胶囊或整个页面；可见文案在胶囊内省略，完整名称保留在
  // aria-label，供读屏用户辨识当前 Space。
  await openSpaceManagement(page);
  await page.getByTestId("create-space-button").click();
  await page.getByTestId("space-name-input").fill("用于三百六十像素小手机验收的特别长学习空间名称");
  await page.getByTestId("space-create-submit").click();
  const spaceButton = page.getByTestId("topbar-space");
  await expect(spaceButton).toHaveAttribute("aria-label", /特别长学习空间名称/);
  const label = spaceButton.locator(".topbar-space-label");
  expect(await label.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  const longCapsule = await spaceButton.boundingBox();
  expect(longCapsule!.x + longCapsule!.width).toBeLessThanOrEqual(352);

  for (const navId of ["nav-today", "nav-review", "nav-test", "nav-first-pass", "nav-vocabulary", "nav-settings"]) {
    await navTo(page, navId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  }

  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    expect(await spaceButton.evaluate((node) => getComputedStyle(node).getPropertyValue("-webkit-tap-highlight-color"))).toBe("rgba(0, 0, 0, 0)");
  }
});

test("376px 及以上继续使用原有字号和页边距", async ({ page }) => {
  await page.setViewportSize({ width: 376, height: 792 });
  await page.goto("/");
  const values = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ["--font-size-body", "--font-size-page-title", "--page-margin", "--topbar-height"]
      .map((name) => style.getPropertyValue(name).trim());
  });
  expect(values).toEqual(["15px", "26px", "24px", "56px"]);
});
