/**
 * 常规模式 FSRS 调度器测试。
 *
 * - V1 tests/unit/infrastructure/test_fsrs_regular_scheduler.py 的确定性直接排期
 *   映射为第一个用例（ts-fsrs 5.4.2 与 py-fsrs 6.3.1 的评分数值契约一致）；
 * - 其余用例按复习调度算法第 11 章语义固化：两档映射、软掌握派生、积压跨卡排序
 *   与当日测试组切分。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_REGULAR_DESIRED_RETENTION,
  FsrsRegularScheduler,
  classifyRegularMastery,
  deriveRegularMasteryAfterReview,
  nextIntervalDaysBetween,
  sortRegularDueWords,
  splitRegularTestGroups,
  type RegularDueWord,
} from "../src/fsrsRegular.ts";
import { MasteryStatus, TestJudgement } from "../src/enums.ts";

describe("常规模式 FSRS 调度器（两档映射与确定性排期）", () => {
  it("Good 复习使用确定性直接排期：新卡复习后直接进入 Review 状态", () => {
    const scheduler = new FsrsRegularScheduler();
    const now = "2026-07-23T12:00:00Z";
    const cardJson = scheduler.newCardSnapshotJson({ createdAt: now });

    const outcome = scheduler.review({
      cardJson,
      recognized: true,
      reviewedAt: now,
      desiredRetention: 0.95,
    });

    expect(Date.parse(outcome.dueAt)).toBeGreaterThan(Date.parse(now));
    expect(outcome.cardState).toBe("Review");
    expect(outcome.reviewLogJson).toContain('"rating":3');
    expect(outcome.afterCardJson).toContain('"state":2');
  });

  it("不认识映射为 Again（评分 1），且间隔短于 Good", () => {
    const scheduler = new FsrsRegularScheduler();
    const now = "2026-07-23T12:00:00Z";
    const cardJson = scheduler.newCardSnapshotJson({ createdAt: now });

    const good = scheduler.review({
      cardJson,
      recognized: true,
      reviewedAt: now,
      desiredRetention: DEFAULT_REGULAR_DESIRED_RETENTION,
    });
    const again = scheduler.review({
      cardJson,
      recognized: false,
      reviewedAt: now,
      desiredRetention: DEFAULT_REGULAR_DESIRED_RETENTION,
    });

    expect(again.reviewLogJson).toContain('"rating":1');
    expect(Date.parse(again.dueAt)).toBeLessThan(Date.parse(good.dueAt));
  });

  it("同一输入产生完全一致的结果；卡片与参数快照为确定性 JSON", () => {
    const scheduler = new FsrsRegularScheduler();
    const now = "2026-07-23T12:00:00Z";
    const cardJson = scheduler.newCardSnapshotJson({ createdAt: now });

    const first = scheduler.review({
      cardJson,
      recognized: true,
      reviewedAt: now,
      desiredRetention: 0.95,
    });
    const second = scheduler.review({
      cardJson,
      recognized: true,
      reviewedAt: now,
      desiredRetention: 0.95,
    });

    expect(second).toEqual(first);
    const parameters = JSON.parse(first.schedulerJson) as Record<string, unknown>;
    expect(parameters["requestRetention"]).toBe(0.95);
    expect(parameters["enableFuzz"]).toBe(false);
    // 禁用分钟级学习与重学步骤（规格 11.6）。
    expect(parameters["learningSteps"]).toEqual([]);
    expect(parameters["relearningSteps"]).toEqual([]);
    expect(parameters["enableShortTerm"]).toBe(false);
  });

  it("新卡快照的到期时间与创建时刻一致，且读取不依赖系统时间", () => {
    const scheduler = new FsrsRegularScheduler();
    const now = "2026-07-23T12:00:00Z";
    const cardJson = scheduler.newCardSnapshotJson({ createdAt: now });
    // 序列化统一为 UTC ISO（含毫秒），按绝对时刻比较。
    expect(Date.parse(FsrsRegularScheduler.cardDueAt(cardJson))).toBe(Date.parse(now));
  });
});

describe("常规模式软掌握派生（规格 11.2，阈值 100 天）", () => {
  it("间隔达到阈值标记已掌握，低于阈值恢复未掌握", () => {
    expect(classifyRegularMastery(100)).toBe(MasteryStatus.Mastered);
    expect(classifyRegularMastery(99)).toBe(MasteryStatus.Unmastered);
  });

  it("认识：累计认识次数加一；达到阈值标记掌握，未达到保持原状态", () => {
    const promoted = deriveRegularMasteryAfterReview({
      recognized: true,
      nextIntervalDays: 175,
      previousMasteryStatus: MasteryStatus.Unmastered,
      previousCumulativeRecognizedCount: 6,
    });
    expect(promoted).toEqual({ masteryStatus: MasteryStatus.Mastered, cumulativeRecognizedCount: 7 });

    const kept = deriveRegularMasteryAfterReview({
      recognized: true,
      nextIntervalDays: 43,
      previousMasteryStatus: MasteryStatus.Mastered,
      previousCumulativeRecognizedCount: 5,
    });
    expect(kept).toEqual({ masteryStatus: MasteryStatus.Mastered, cumulativeRecognizedCount: 6 });
  });

  it("不认识：累计认识次数不清零；间隔低于阈值自动恢复未掌握", () => {
    const recovered = deriveRegularMasteryAfterReview({
      recognized: false,
      nextIntervalDays: 8,
      previousMasteryStatus: MasteryStatus.Mastered,
      previousCumulativeRecognizedCount: 7,
    });
    expect(recovered).toEqual({ masteryStatus: MasteryStatus.Unmastered, cumulativeRecognizedCount: 7 });

    const kept = deriveRegularMasteryAfterReview({
      recognized: false,
      nextIntervalDays: 120,
      previousMasteryStatus: MasteryStatus.Mastered,
      previousCumulativeRecognizedCount: 7,
    });
    expect(kept).toEqual({ masteryStatus: MasteryStatus.Mastered, cumulativeRecognizedCount: 7 });
  });

  it("自然日差值向地板取整（与 V1 timedelta.days 一致）", () => {
    // due 比 answered 晚 2 天 23 小时 → 2 个完整自然日。
    expect(
      nextIntervalDaysBetween("2026-07-26T11:00:00Z", "2026-07-23T12:00:00Z"),
    ).toBe(2);
    expect(
      nextIntervalDaysBetween("2026-07-23T12:00:00Z", "2026-07-23T12:00:00Z"),
    ).toBe(0);
  });
});

describe("积压场景的跨卡排序（规格 11.1 四段比较键）", () => {
  const base: RegularDueWord = {
    wordId: "w",
    dueAt: "2026-07-24T00:00:00Z",
    hasHistory: true,
    lastJudgement: TestJudgement.Recognized,
    cumulativeRecognizedCount: 1,
  };

  it("有测试历史的优先于从未测试的新条目", () => {
    const fresh: RegularDueWord = { ...base, wordId: "fresh", hasHistory: false, lastJudgement: null, cumulativeRecognizedCount: 0 };
    const sorted = sortRegularDueWords([fresh, base]);
    expect(sorted[0]?.wordId).toBe("w");
  });

  it("最近一次不认识的优先于最近一次认识的", () => {
    const forgotten: RegularDueWord = { ...base, wordId: "forgotten", lastJudgement: TestJudgement.NotRecognized };
    const sorted = sortRegularDueWords([base, forgotten]);
    expect(sorted[0]?.lastJudgement).toBe(TestJudgement.NotRecognized);
  });

  it("同一最近结果内累计认识次数越多越靠前；不认识不清零历史", () => {
    const veteran: RegularDueWord = { ...base, wordId: "veteran", cumulativeRecognizedCount: 5 };
    const rookie: RegularDueWord = { ...base, wordId: "rookie", cumulativeRecognizedCount: 1 };
    const sorted = sortRegularDueWords([rookie, veteran]);
    expect(sorted[0]?.wordId).toBe("veteran");
  });

  it("仍并列时原始 due_at 越早越靠前，最后按稳定标识打破并列", () => {
    const earlier: RegularDueWord = { ...base, wordId: "b", dueAt: "2026-07-23T00:00:00Z" };
    const later: RegularDueWord = { ...base, wordId: "a", dueAt: "2026-07-25T00:00:00Z" };
    const sortedByDue = sortRegularDueWords([later, earlier]);
    expect(sortedByDue[0]?.wordId).toBe("b");

    const same1: RegularDueWord = { ...base, wordId: "z" };
    const same2: RegularDueWord = { ...base, wordId: "a" };
    const sortedById = sortRegularDueWords([same1, same2]);
    expect(sortedById[0]?.wordId).toBe("a");
  });
});

describe("当日测试组切分（规格 11.2）", () => {
  it("按每组条目数稳定切分；组只是当日展示切分", () => {
    const words = ["w1", "w2", "w3", "w4", "w5"];
    const groups = splitRegularTestGroups(words, 2);
    expect(groups).toEqual([["w1", "w2"], ["w3", "w4"], ["w5"]]);
  });

  it("每组条目数必须为正整数", () => {
    expect(() => splitRegularTestGroups(["w1"], 0)).toThrow(/每组条目数/);
    expect(() => splitRegularTestGroups(["w1"], 1.5)).toThrow(/每组条目数/);
  });
});
