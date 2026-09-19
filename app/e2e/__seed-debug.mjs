import { test } from "@playwright/test";
test("debug seed", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(() => {
    const services = window["__ebbinghaus"];
    const space = services.spaces.createAndActivate({ name: "验收积累", learningMode: "常规模式" });
    const pastMs = Date.now() - 2 * 86_400_000;
    const pastIso = new Date(pastMs).toISOString();
    const cardJson = JSON.stringify({ due: pastIso, stability: 1, difficulty: 5, elapsedDays: 0, scheduledDays: 0, learningSteps: 0, reps: 0, lapses: 0, state: 0, lastReview: null });
    const wordId = "e2e-word-0";
    services.runtime.wordContentStore.upsertEntries([{ wordId, listId: null, spaceId: space.id, originalSpelling: "word0", normalizedKey: "word0", manualMeaning: "v. 释义0", meanings: [{ partOfSpeech: "v.", definition: "释义0", usage: null }], removed: false, recordedAt: pastIso }]);
    services.runtime.fsrsCardStore.upsert({ wordId, cardJson, dueAt: pastIso, schedulerJson: "{}", algorithmVersion: "e2e-seed-v1", libraryVersion: "e2e-seed", updatedAt: pastIso, cardState: "New", cumulativeRecognizedCount: 0, lastFinalJudgement: null });
    const event = services.eventRecorder.record({ eventType: "firstPassRecorded", targetType: "条目", targetId: wordId, source: "验收种子", occurredAt: new Date(pastMs), metadata: { workload: 1 } });
    services.runtime.eventStore.appendEvents([event]);
    const groups = services.regularLearning.dueGroups({ spaceId: space.id });
    return {
      spaceId: space.id,
      activeId: services.getActiveSpace()?.id,
      groups: groups.map(g => ({ ordinal: g.ordinal, words: g.wordIds.length })),
      taskItems: services.dashboard.taskItems().map(t => ({ type: t.taskType, total: t.totalCount })),
    };
  });
  console.log(JSON.stringify(result, null, 1));
});
