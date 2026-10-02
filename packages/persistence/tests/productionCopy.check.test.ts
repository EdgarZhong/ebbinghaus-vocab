/**
 * 正式库副本集成验证（2026-10-02 复习入口统一改造，一次性验收脚本）。
 *
 * 用法：EBB_CHECK_DB=<正式库副本路径> pnpm vitest run tests/productionCopy.check.test.ts
 * （在 packages/persistence 目录执行；不设置环境变量时整体跳过，不影响常规测试。）
 *
 * 用正式库的在线备份副本（只读打开）验证新口径在真实数据上的正确性：
 *  1. 全部真实学习事件重放无异常；
 *  2. 任务投影无"仅复习"任务，且每个任务 workload === testDemands.length（新口径）；
 *  3. 复习候选集可计算，候选词全部满足活动未掌握（结构性断言，不绑定具体词）；
 *  4. 每个 listSynchronized 事件写入时刻，其 List 重放状态确实满足同步条件（逐事件切片校验）。
 */
import { describe, expect, it } from "vitest";
import { openClientDatabase } from "../src/sqlite/connection.ts";
import { SqliteLearningEventStore } from "../src/repositories/events.ts";
import { SqliteBookCatalogStore, SqliteSpaceStore, SqliteWordContentStore } from "../src/repositories/content.ts";
import { SystemClock } from "../src/clock.ts";
import { SchedulingService, replayWordStates, ReviewCandidatesService } from "@ebbinghaus/application";
import {
  MasteryStatus,
  replayLearningEvents,
  resolveLearningDay,
  ShortTermPassCount,
} from "@ebbinghaus/domain";
import type { LearningDaySettings } from "@ebbinghaus/domain";

const DB_PATH = process.env["EBB_CHECK_DB"];
const clock = new SystemClock();
// 2026-10-01 用户确认：V2 全局学习时区 Asia/Shanghai，换日 04:00。
const settings: LearningDaySettings = { timeZone: "Asia/Shanghai", rolloverTime: "04:00" };

describe.skipIf(DB_PATH === undefined)("正式库副本集成验证", () => {
  it("重放、任务投影、候选集与同步事件全部符合新口径", () => {
    const db = openClientDatabase(DB_PATH as string);
    try {
      db.pragma("query_only = ON");
      const events = new SqliteLearningEventStore(db, clock);
      const contents = new SqliteWordContentStore(db);
      const catalog = new SqliteBookCatalogStore(db);
      const spaces = new SqliteSpaceStore(db);

      // 1) 全量重放无异常（fail fast 重放器：任何脏数据立即抛错）。
      const all = events.listAllEvents();
      expect(() => replayWordStates({ eventStore: events, wordContentStore: contents })).not.toThrow();
      expect(all.length).toBeGreaterThan(0);

      const scheduling = new SchedulingService({ clock, eventStore: events, wordContentStore: contents, bookCatalogStore: catalog });
      const reviewCandidates = new ReviewCandidatesService({ clock, eventStore: events, wordContentStore: contents, bookCatalogStore: catalog, scheduling });
      const states = replayWordStates({ eventStore: events, wordContentStore: contents });
      const today = resolveLearningDay(clock.now(), settings);
      console.log(`当前学习日：${today}，事件 ${all.length} 条`);

      // 2) 任务投影新口径：无仅复习任务；workload 严格等于待测词数。
      let taskTotal = 0;
      for (const space of spaces.listSpaces().filter((s) => !s.archived)) {
        const refresh = scheduling.refreshSpaceTasks({ spaceId: space.id, learningDaySettings: settings });
        taskTotal += refresh.tasks.length;
        for (const task of refresh.tasks) {
          expect(task.taskType, `${space.name} 出现已废弃的仅复习任务`).not.toBe("仅复习");
          expect(task.workload, `${space.name}/${task.taskId} workload 必须等于待测词数`).toBe(task.payload.testDemands.length);
        }
      }
      console.log(`任务投影合计：${taskTotal} 个`);

      // 3) 复习候选集结构性断言：候选词必须全部活动且未掌握。
      for (const space of spaces.listSpaces().filter((s) => !s.archived && s.learningMode === "词书模式")) {
        const groups = reviewCandidates.bookReviewCandidates({ spaceId: space.id, learningDaySettings: settings });
        let candidateCount = 0;
        for (const group of groups) {
          for (const wordId of group.wordIds) {
            candidateCount += 1;
            const state = states.get(wordId);
            expect(state, `候选词 ${wordId} 必须存在`).toBeDefined();
            expect(state?.removed, `候选词 ${wordId} 不得已移除`).toBe(false);
            expect(state?.masteryStatus, `候选词 ${wordId} 必须未掌握`).toBe(MasteryStatus.Unmastered);
          }
        }
        console.log(`候选集 [${space.name}]：${groups.length} 个 List、${candidateCount} 个候选词`);
      }

      // 4) listSynchronized 逐事件切片校验：事件发生时该 List 词状态满足同步条件。
      const ordered = all.slice().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      for (const event of ordered) {
        if (event.eventType !== "listSynchronized") continue;
        const prior = ordered.filter((e) => e.occurredAt <= event.occurredAt);
        const replayed = replayLearningEvents({ events: prior.map((e) => ({ ...e })) });
        const words = [...replayed.words.values()].filter(
          (w) => w.listId === event.targetId && !w.removed && w.masteryStatus === MasteryStatus.Unmastered,
        );
        expect(
          words.length > 0 && words.every((w) => w.shortTermPassCount === ShortTermPassCount.Two),
          `listSynchronized [${event.targetId}] 写入时同步条件必须成立（活动词 ${words.length} 个）`,
        ).toBe(true);
      }
      console.log(`listSynchronized 校验：${ordered.filter((e) => e.eventType === "listSynchronized").length} 条`);
    } finally {
      db.close();
    }
  });
});

/**
 * 集成链路：在 writable 副本（formal-copy 再复制一份）上写入一条"今天的测试答案"
 * 事件，验证真实 SQLite 写入 → 重放 → 复习候选集出现"今日完成测试的词"的完整链路。
 */
describe.skipIf(DB_PATH === undefined)("正式库副本集成链路（今日答案 → 候选集）", () => {
  it("写入今日 testAnswered 后，该词进入当日复习候选集", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { LearningEventRecorder } = await import("@ebbinghaus/application");
    const { SqliteDeviceIdentityProvider, SqliteDeviceSeqAllocator, CryptoUuidV4IdGenerator } = await import("../src/index.ts");
    const writablePath = path.join(os.tmpdir(), `ebb-check-writable-${Date.now()}.sqlite3`);
    fs.copyFileSync(DB_PATH as string, writablePath);
    const db = openClientDatabase(writablePath);
    try {
      const events = new SqliteLearningEventStore(db, clock);
      const contents = new SqliteWordContentStore(db);
      const catalog = new SqliteBookCatalogStore(db);
      const spaces = new SqliteSpaceStore(db);
      const states = replayWordStates({ eventStore: events, wordContentStore: contents });

      // 找一个有活动未掌握词的词书 List，取其第一个词作为链路对象。
      // 注意必须校验词所属 List 确实属于当前 Space（跨 Space 归属会让候选查询为空）。
      let target: { spaceId: string; listId: string; wordId: string } | null = null;
      for (const space of spaces.listSpaces().filter((s) => !s.archived && s.learningMode === "词书模式")) {
        const spaceListIds = new Set(catalog.listListsForSpace(space.id).map((record) => record.listId));
        for (const state of states.values()) {
          if (
            !state.removed &&
            state.listId !== null &&
            spaceListIds.has(state.listId) &&
            state.masteryStatus === MasteryStatus.Unmastered
          ) {
            target = { spaceId: space.id, listId: state.listId, wordId: state.wordId };
            break;
          }
        }
        if (target !== null) break;
      }
      expect(target, "副本中应存在活动未掌握的词书词").not.toBeNull();
      if (target === null) return;
      const wordState = states.get(target.wordId);
      console.log(`链路对象：词 ${target.wordId.slice(0, 8)}…，当前 pass=${wordState?.shortTermPassCount}`);

      // 写入"今天 10:00"的 testAnswered（afterState 与当前状态自洽，只注入"今日已测"事实）。
      const recorder = new LearningEventRecorder({
        clock,
        idGenerator: new CryptoUuidV4IdGenerator(),
        deviceIdentity: new SqliteDeviceIdentityProvider(db),
        deviceSeqAllocator: new SqliteDeviceSeqAllocator(db),
        readLearningDaySettings: () => settings,
      });
      const now = clock.now();
      const todayAt10 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
      const event = recorder.record({
        eventType: "testAnswered",
        targetType: "Word",
        targetId: target.wordId,
        source: "正式库副本集成链路验证",
        occurredAt: todayAt10,
        metadata: {
          sessionId: `check-session-${target.wordId.slice(0, 8)}`,
          initialJudgement: "认识",
          finalJudgement: "认识",
          answerRevised: false,
          beforeState: {
            shortTermPassCount: wordState?.shortTermPassCount,
            masteryStatus: wordState?.masteryStatus,
            t0: wordState?.t0,
            t1: wordState?.t1,
            t2: wordState?.t2,
          },
          afterState: {
            shortTermPassCount: wordState?.shortTermPassCount,
            masteryStatus: wordState?.masteryStatus,
            t0: wordState?.t0,
            t1: wordState?.t1,
            t2: wordState?.t2,
          },
          algorithmVersion: "scheduler-v1",
        },
      });
      events.appendEvents([event]);

      // 重放 + 候选集：该词必须作为"今天完成测试的词"出现在其 List 的候选组里。
      const scheduling = new SchedulingService({ clock, eventStore: events, wordContentStore: contents, bookCatalogStore: catalog });
      const reviewCandidates = new ReviewCandidatesService({ clock, eventStore: events, wordContentStore: contents, bookCatalogStore: catalog, scheduling });
      const groups = reviewCandidates.bookReviewCandidates({ spaceId: target.spaceId, learningDaySettings: settings });
      const group = groups.find((g) => g.listId === target.listId);
      expect(group, "该 List 应出现候选组").toBeDefined();
      expect(group?.wordIds, "候选组必须包含今日已测词").toContain(target.wordId);
      console.log(`链路通过：候选组 ${group?.wordIds.length} 个词，含今日已测词`);
    } finally {
      db.close();
      fs.rmSync(writablePath, { force: true });
    }
  });
});
