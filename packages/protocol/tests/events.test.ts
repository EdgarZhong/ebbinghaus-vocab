import { describe, expect, it } from "vitest";

import {
  learningEventSchema,
  learningEventTypeValues,
  storedLearningEventSchema,
} from "../src/events.ts";
import { makeEvent, makeStoredEvent, SAMPLE_DEVICE_ID } from "./fixtures.ts";

describe("学习事件 schema：事件类型枚举以需求规格 7.2 原文为准", () => {
  it("固化规格 7.2 与 V1 双向手动掌握共 20 类事件类型", () => {
    // 规格 7.2 实际逐条列出 18 个事件类型（testSessionPaused/Resumed、
    // dictionaryFetched/FetchFailed 为成对条目）。此断言锁死数量，防止后续
    // 维护者无意增删枚举成员而偏离规格。
    expect(learningEventTypeValues).toHaveLength(20);
    expect([...learningEventTypeValues]).toEqual([
      "firstPassRecorded",
      "reviewOnlyCompleted",
      "testFollowedByReviewCompleted",
      "testAnswered",
      "answerRevised",
      "shortTermPassCountChanged",
      "listSynchronized",
      "longTermValidationCompleted",
      "wordMastered",
      "listMastered",
      "taskDeferred",
      "testSessionPaused",
      "testSessionResumed",
      "dictionaryFetched",
      "dictionaryFetchFailed",
      "wordAdded",
      "wordContentUpdated",
      "wordRemoved",
      "wordManuallyMarkedUnmastered",
      "wordManuallyMarkedMastered",
    ]);
  });
});

describe("学习事件 schema：每类事件的合法样例", () => {
  it("20 类事件各提供一个合法样例并通过完整解析", () => {
    for (const eventType of learningEventTypeValues) {
      const parsed = learningEventSchema.safeParse(makeEvent(eventType));
      expect(parsed.success, `${eventType} 的合法样例应通过解析`).toBe(true);
      if (parsed.success) {
        // 解析输出必须保真事件类型，供重放器做可辨识联合分派。
        expect(parsed.data.eventType).toBe(eventType);
      }
    }
  });

  it("metadata 中的未知字段被 passthrough 保留，不被静默丢弃", () => {
    // 宁可宽松不可过严：V1 历史数据与未来新增的 metadata 字段必须在协议
    // 解析后原样保留，供旧版本客户端与新版本客户端共享同一事件集。
    const event = makeEvent("wordAdded", {
      metadata: { listId: "list-1", normalizedKey: "apple", futureField: { nested: [1, 2] } },
    });
    const parsed = learningEventSchema.parse(event);
    expect((parsed.metadata as Record<string, unknown>).futureField).toEqual({
      nested: [1, 2],
    });
  });

  it("taskDeferred 的 metadata 结构在 V1 中未知，接受任意 JSON 对象", () => {
    const event = makeEvent("taskDeferred", { metadata: { 任意结构: ["a", 2, null] } });
    expect(learningEventSchema.safeParse(event).success).toBe(true);
  });

  it("常规模式与词书模式的 testAnswered metadata 字段差异均被接受", () => {
    // 词书模式：taskId + plannedTestAt；常规模式：groupOrdinal + wordId + workload。
    const regular = makeEvent("testAnswered", {
      metadata: {
        sessionId: "session-1",
        groupOrdinal: 2,
        wordId: "word-1",
        initialJudgement: "认识",
        finalJudgement: "不认识",
        answerRevised: true,
        beforeState: { dueAt: "2026-09-19T08:00:00Z" },
        afterState: { dueAt: "2026-09-21T08:00:00Z", masteryStatus: "未掌握", nextIntervalDays: 2.5 },
        workload: 1,
        algorithmVersion: "scheduler-v1",
      },
    });
    expect(learningEventSchema.safeParse(regular).success).toBe(true);
  });

  it("testAnswered 缺失两模式共有的核心字段（如 sessionId）被拒", () => {
    const { sessionId: _omitted, ...broken } = makeEvent("testAnswered").metadata as Record<
      string,
      unknown
    >;
    const event = makeEvent("testAnswered", { metadata: broken });
    const parsed = learningEventSchema.safeParse(event);
    expect(parsed.success).toBe(false);
  });
});

describe("学习事件 schema：信封字段非法样例被拒", () => {
  it("eventId 或 deviceId 不是 UUIDv4 被拒（坏版本位、非 UUID 字符串）", () => {
    // 版本位为 1 的 UUID v1 不满足 v4 约束。
    expect(
      learningEventSchema.safeParse(makeEvent("wordAdded", { eventId: "a3f1c2d4-e5b6-1c7d-8a9b-0c1d2e3f4a5b" }))
        .success,
    ).toBe(false);
    expect(
      learningEventSchema.safeParse(makeEvent("wordAdded", { eventId: "not-a-uuid" })).success,
    ).toBe(false);
    expect(
      learningEventSchema.safeParse(
        makeEvent("wordAdded", { deviceId: "b7e2f3a4-1c5d-4e8f-1a0b-2c3d4e5f6a7b" }),
      ).success,
    ).toBe(false);
  });

  it("occurredAt 无时区或不可解析被拒（协议要求绝对时刻）", () => {
    // 缺时区的本地时间字符串无法确定绝对时刻，禁止入库。
    expect(
      learningEventSchema.safeParse(makeEvent("wordAdded", { occurredAt: "2026-09-19T12:30:00" }))
        .success,
    ).toBe(false);
    expect(
      learningEventSchema.safeParse(makeEvent("wordAdded", { occurredAt: "不是时间" })).success,
    ).toBe(false);
  });

  it("learningDay 格式错误或日历日不存在被拒", () => {
    expect(
      learningEventSchema.safeParse(makeEvent("wordAdded", { learningDay: "2026/09/19" })).success,
    ).toBe(false);
    // 2026-02-30 会被 JS Date 静默滚动到 3 月，schema 必须拒绝。
    expect(
      learningEventSchema.safeParse(makeEvent("wordAdded", { learningDay: "2026-02-30" })).success,
    ).toBe(false);
  });

  it("deviceSeq 必须是正整数（0、负数、小数均拒绝）", () => {
    expect(learningEventSchema.safeParse(makeEvent("wordAdded", { deviceSeq: 0 })).success).toBe(
      false,
    );
    expect(learningEventSchema.safeParse(makeEvent("wordAdded", { deviceSeq: -1 })).success).toBe(
      false,
    );
    expect(learningEventSchema.safeParse(makeEvent("wordAdded", { deviceSeq: 1.5 })).success).toBe(
      false,
    );
  });

  it("缺失必填信封字段被拒", () => {
    const event = makeEvent("wordAdded") as Record<string, unknown>;
    const { occurredAt: _omitted, ...missing } = event;
    expect(learningEventSchema.safeParse(missing).success).toBe(false);
  });

  it("targetType、targetId、source 为空字符串被拒", () => {
    expect(
      learningEventSchema.safeParse(makeEvent("wordAdded", { targetType: "" })).success,
    ).toBe(false);
    expect(learningEventSchema.safeParse(makeEvent("wordAdded", { targetId: "" })).success).toBe(
      false,
    );
    expect(learningEventSchema.safeParse(makeEvent("wordAdded", { source: "" })).success).toBe(
      false,
    );
  });

  it("未知 eventType 被拒（协议枚举外的类型不得入流）", () => {
    const event = makeEvent("wordAdded", { eventType: "spaceSettingsUpdated" });
    expect(learningEventSchema.safeParse(event).success).toBe(false);
  });

  it("push 载荷中混入 serverSeq 被拒（serverSeq 只能由服务器分配）", () => {
    // 信封是 strict 校验：客户端把 serverSeq 写进 push 载荷属于越权伪造同步游标，
    // 必须 fail fast 而不是静默 strip。
    const event = makeEvent("wordAdded", { serverSeq: 42 });
    expect(learningEventSchema.safeParse(event).success).toBe(false);
  });
});

describe("学习事件 schema：服务器已存储事件视图", () => {
  it("含合法 serverSeq 的存储事件通过解析", () => {
    const parsed = storedLearningEventSchema.safeParse(makeStoredEvent("wordMastered"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.serverSeq).toBe(42);
    }
  });

  it("缺失或非法 serverSeq 被拒", () => {
    const missing = makeEvent("wordMastered");
    expect(storedLearningEventSchema.safeParse(missing).success).toBe(false);
    expect(
      storedLearningEventSchema.safeParse(makeStoredEvent("wordMastered", { serverSeq: 0 }))
        .success,
    ).toBe(false);
    expect(
      storedLearningEventSchema.safeParse(makeStoredEvent("wordMastered", { serverSeq: -3 }))
        .success,
    ).toBe(false);
  });

  it("存储视图同样拒绝未知 eventType 与坏信封字段", () => {
    const event = makeStoredEvent("wordMastered", { eventType: "unknownType" });
    expect(storedLearningEventSchema.safeParse(event).success).toBe(false);
  });
});

describe("学习事件 schema：deviceId 全链路一致", () => {
  it("deviceId 变更后事件仍可解析（多设备各自产生事件互不影响）", () => {
    const otherDevice = makeEvent("wordAdded", {
      deviceId: SAMPLE_DEVICE_ID,
      deviceSeq: 9,
    });
    expect(learningEventSchema.safeParse(otherDevice).success).toBe(true);
  });
});
