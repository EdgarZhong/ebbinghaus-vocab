/**
 * 一次性桌面端复习页截图脚本（2026-10-02 复习卡片视觉修正验收用，非测试用例）：
 * 复用 smallPhone.spec.ts 的词书复习候选种子，在 1100×760 桌面视口截取
 * "List 卡收起态"与"List 卡展开 + 词卡区"两张证据图。
 * 用法：先 `pnpm exec vite preview --port 4174 --strictPort --host 127.0.0.1`，
 * 再 `node e2e/__screenshot-review.mjs`。
 */
import { chromium } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const screenshotsDir = join(dirname(fileURLToPath(import.meta.url)), "__screenshots__");
const baseURL = "http://127.0.0.1:4174";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
await page.goto(baseURL + "/");

// 词书复习候选种子（与 smallPhone.spec.ts 同源，本脚本自包含）
await page.evaluate(() => {
  const services = window.__ebbinghaus;
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
  const events = [];
  const wordIds = [];
  for (let index = 0; index < 8; index += 1) {
    wordIds.push(`e2e-review-word-${index}`);
  }
  const extraWordId = "e2e-review-word-extra";
  events.push(services.eventRecorder.record({
    eventType: "firstPassRecorded",
    targetType: "List",
    targetId: listId,
    source: "验收种子",
    occurredAt: new Date(t0Iso),
    metadata: { workload: 1, wordIds: [...wordIds, extraWordId] },
  }));
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
        beforeState: { shortTermPassCount: 0, masteryStatus: "未掌握", t0: t0Iso, t1: null, t2: null },
        afterState: { shortTermPassCount: 1, masteryStatus: "未掌握", t0: t0Iso, t1: t1Iso, t2: null },
        algorithmVersion: "e2e-seed-v1",
      },
    }));
  }
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
          definition: "一段故意写得非常冗长的释义，用来验证桌面端释义区域横向滚动而词卡行高保持固定不变",
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
      beforeState: { shortTermPassCount: 0, masteryStatus: "未掌握", t0: t0Iso, t1: null, t2: null },
      afterState: { shortTermPassCount: 1, masteryStatus: "未掌握", t0: t0Iso, t1: nowIso, t2: null },
      algorithmVersion: "e2e-seed-v1",
    },
  }));
  services.runtime.eventStore.appendEvents(events);
  services.notifyChanged();
});

await page.getByTestId("nav-review").click();
await page.getByTestId("review-list-Unit 1 · List 3").waitFor({ state: "visible" });
await page.screenshot({ path: join(screenshotsDir, "desktop-review-book-collapsed.png") });

await page.getByTestId("review-list-header-Unit 1 · List 3").click();
await page.getByTestId("review-words-Unit 1 · List 3").waitFor({ state: "visible" });
await page.waitForTimeout(300);
await page.screenshot({ path: join(screenshotsDir, "desktop-review-book-expanded.png") });

// 词汇页对比图：词卡高度与复习页 List 卡统一（--card-list-row-height）
await page.getByTestId("nav-vocabulary").click();
await page.locator(".vocab-card").first().waitFor({ state: "visible" });
await page.waitForTimeout(300);
await page.screenshot({ path: join(screenshotsDir, "desktop-vocabulary-list.png") });

await browser.close();
console.log("截图完成：desktop-review-book-collapsed.png / desktop-review-book-expanded.png / desktop-vocabulary-list.png");
