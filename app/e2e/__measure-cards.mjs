/**
 * 一次性卡片高度量测脚本（2026-10-02 卡片高度统一设计用，非测试用例）：
 * 播种词书复习候选后，量测复习页 List 卡/词卡、词汇页词卡、测试页任务卡的
 * 实际渲染高度，为统一规格提供像素依据。
 * 用法：先 `pnpm exec vite preview --port 4174 --strictPort --host 127.0.0.1`，
 * 再 `node e2e/__measure-cards.mjs`。
 */
import { chromium } from "@playwright/test";

const baseURL = "http://127.0.0.1:4174";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
await page.goto(baseURL + "/");

// 与 __screenshot-review.mjs 相同的词书复习候选种子（8 个仅复习到期词 + 1 个今日已测词）
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
  events.push(services.eventRecorder.record({
    eventType: "firstPassRecorded",
    targetType: "List",
    targetId: listId,
    source: "量测种子",
    occurredAt: new Date(t0Iso),
    metadata: { workload: 1, wordIds },
  }));
  for (const wordId of wordIds) {
    services.runtime.wordContentStore.upsertEntries([
      {
        wordId, listId, spaceId: null,
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
      source: "量测种子",
      occurredAt: new Date(t1Iso),
      metadata: {
        sessionId: "e2e-seed-session",
        initialJudgement: "认识", finalJudgement: "认识", answerRevised: false,
        beforeState: { shortTermPassCount: 0, masteryStatus: "未掌握", t0: t0Iso, t1: null, t2: null },
        afterState: { shortTermPassCount: 1, masteryStatus: "未掌握", t0: t0Iso, t1: t1Iso, t2: null },
        algorithmVersion: "e2e-seed-v1",
      },
    }));
  }
  services.runtime.eventStore.appendEvents(events);
  services.notifyChanged();
});

async function measure(page, selector) {
  return page.locator(selector).first().evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      height: Math.round(rect.height * 10) / 10,
      padding: style.padding,
      gap: style.gap,
      borderRadius: style.borderRadius,
    };
  });
}

// 复习页：List 卡 + 展开后的词卡
await page.getByTestId("nav-review").click();
await page.getByTestId("review-list-Unit 1 · List 3").waitFor({ state: "visible" });
console.log("review-card(收起):", await measure(page, ".review-card"));
await page.getByTestId("review-list-header-Unit 1 · List 3").click();
await page.getByTestId("review-words-Unit 1 · List 3").waitFor({ state: "visible" });
console.log("review-word-card:", await measure(page, ".review-word-card"));

// 词汇页：词卡
await page.getByTestId("nav-vocabulary").click();
await page.locator(".vocab-card").first().waitFor({ state: "visible" });
console.log("vocab-card:", await measure(page, ".vocab-card"));

// 测试页：任务卡（若有种生任务）
await page.getByTestId("nav-test").click();
await page.waitForTimeout(500);
const taskCount = await page.locator(".task-row").count();
if (taskCount > 0) {
  console.log("task-row:", await measure(page, ".task-row"));
} else {
  console.log("task-row: 无任务卡");
}

await browser.close();
