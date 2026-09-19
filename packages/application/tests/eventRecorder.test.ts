/**
 * 学习事件工厂（应用层事件唯一产生入口）的行为测试。
 *
 * 覆盖口径（对应 ports.ts / eventRecorder.ts 关键语义注释）：
 * - 信封字段全部来自注入端口：ID/设备身份/设备序号/时钟/学习日设置；
 * - 每个事件在产生处过 protocol `learningEventSchema`（strictObject 信封 + 按类型
 *   metadata），校验失败立即抛错，绝不产生半成品事件；
 * - learningDay 由当前学习日设置从 occurredAt 投影（时区 + 换日边界）；
 * - deriveListTaskId 幂等：同输入同标识、异输入异标识、形态过 uuidV4Schema。
 */
import { describe, expect, it } from "vitest";

import { uuidV4Schema } from "@ebbinghaus/protocol";
import { LearningEventRecorder, deriveListTaskId, hashTextFnv1a } from "../src/eventRecorder.ts";
import { SequentialDeviceSeqAllocator, SequentialIdGenerator, StaticDeviceIdentity, FixedClock } from "./helpers/fakes.ts";
import { LEARNING_DAY_SETTINGS } from "./helpers/assemble.ts";

/** 组装一个事件工厂；学习日设置固定上海/04:00。 */
function buildRecorder(clock: FixedClock): LearningEventRecorder {
  return new LearningEventRecorder({
    clock,
    idGenerator: new SequentialIdGenerator(),
    deviceIdentity: new StaticDeviceIdentity(),
    deviceSeqAllocator: new SequentialDeviceSeqAllocator(),
    readLearningDaySettings: () => LEARNING_DAY_SETTINGS,
  });
}

describe("事件工厂：信封字段来自注入端口", () => {
  it("按端口生成完整信封：deviceSeq 从 1 起单调，occurredAt 取时钟当前时刻", () => {
    const clock = new FixedClock("2026-07-15T09:00:00Z");
    const recorder = buildRecorder(clock);

    const first = recorder.record({
      eventType: "firstPassRecorded",
      targetType: "条目",
      targetId: "word-1",
      source: "常规模式录入",
      metadata: { workload: 1 },
    });
    const second = recorder.record({
      eventType: "testSessionPaused",
      targetType: "TestSession",
      targetId: "session-1",
      source: "常规模式测试",
      metadata: { groupOrdinal: 1 },
    });

    expect(first.deviceSeq).toBe(1);
    expect(second.deviceSeq).toBe(2);
    expect(first.occurredAt).toBe("2026-07-15T09:00:00.000Z");
    expect(first.deviceId).toBe("b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b");
    expect(first.learningDay).toBe("2026-07-15");
    // eventId 由注入的 ID 生成器产生，形态必须过协议 UUIDv4 校验。
    expect(uuidV4Schema.safeParse(first.eventId).success).toBe(true);
  });

  it("显式 occurredAt 覆盖时钟当前时刻，learningDay 仍按学习日设置投影", () => {
    const clock = new FixedClock("2026-07-30T00:00:00Z");
    const recorder = buildRecorder(clock);

    const event = recorder.record({
      eventType: "firstPassRecorded",
      targetType: "List",
      targetId: "list-1",
      source: "首过预览保存",
      metadata: { workload: 1, wordCount: 3, draftId: "draft-1" },
      occurredAt: new Date("2026-07-15T09:00:00Z"),
    });

    expect(event.occurredAt).toBe("2026-07-15T09:00:00.000Z");
    expect(event.learningDay).toBe("2026-07-15");
  });

  it("换日边界前的时刻投影为前一学习日（上海 03:00 归入前一日）", () => {
    const clock = new FixedClock("2026-07-19T19:00:00Z"); // 上海本地 03:00
    const recorder = buildRecorder(clock);

    const event = recorder.record({
      eventType: "firstPassRecorded",
      targetType: "条目",
      targetId: "word-1",
      source: "常规模式录入",
      metadata: { workload: 1 },
    });

    expect(event.learningDay).toBe("2026-07-19");
  });

  it("换日边界整点不提前换日（上海 04:00 仍属当日）", () => {
    const clock = new FixedClock("2026-07-19T20:00:00Z"); // 上海本地 04:00
    const recorder = buildRecorder(clock);

    const event = recorder.record({
      eventType: "firstPassRecorded",
      targetType: "条目",
      targetId: "word-1",
      source: "常规模式录入",
      metadata: { workload: 1 },
    });

    expect(event.learningDay).toBe("2026-07-20");
  });
});

describe("事件工厂：协议校验 fail fast", () => {
  it("metadata 缺少该事件类型的必填字段时抛错，且错误信息带校验摘要", () => {
    const clock = new FixedClock("2026-07-15T09:00:00Z");
    const recorder = buildRecorder(clock);

    // firstPassRecorded 的 metadata 协议必填 workload；缺失属于编程错误。
    expect(() =>
      recorder.record({
        eventType: "firstPassRecorded",
        targetType: "条目",
        targetId: "word-1",
        source: "常规模式录入",
        metadata: { removedExistingWords: [] },
      }),
    ).toThrow(/产生的事件未通过协议 schema 校验/);
  });

  it("校验失败不产生任何半成品事件对象", () => {
    const clock = new FixedClock("2026-07-15T09:00:00Z");
    const recorder = buildRecorder(clock);

    let produced: unknown = null;
    try {
      produced = recorder.record({
        eventType: "wordRemoved",
        targetType: "条目",
        targetId: "word-1",
        source: "录入冲突处理",
        // wordRemoved 协议必填 normalizedKey。
        metadata: { reason: "测试" },
      });
    } catch {
      // 预期抛错。
    }
    expect(produced).toBeNull();
  });

  it("非法信封字段同样被协议拒绝（空 source）", () => {
    const clock = new FixedClock("2026-07-15T09:00:00Z");
    const recorder = buildRecorder(clock);

    expect(() =>
      recorder.record({
        eventType: "firstPassRecorded",
        targetType: "条目",
        targetId: "word-1",
        source: "",
        metadata: { workload: 1 },
      }),
    ).toThrow(/产生的事件未通过协议 schema 校验/);
  });
});

describe("deriveListTaskId：稳定任务标识", () => {
  const base = {
    algorithmVersion: "scheduler-v1",
    listId: "list-1",
    taskType: "短期测试",
    scheduledDay: "2026-07-16",
  };

  it("同一输入跨刷新得到同一标识（幂等语义）", () => {
    expect(deriveListTaskId(base)).toBe(deriveListTaskId({ ...base }));
  });

  it("任一输入维度变化都得到不同标识", () => {
    const ids = [
      deriveListTaskId(base),
      deriveListTaskId({ ...base, listId: "list-2" }),
      deriveListTaskId({ ...base, taskType: "仅复习" }),
      deriveListTaskId({ ...base, scheduledDay: "2026-07-17" }),
      deriveListTaskId({ ...base, algorithmVersion: "scheduler-v2" }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("标识形态过协议 UUIDv4 校验，可直接作为事件与任务引用", () => {
    expect(uuidV4Schema.safeParse(deriveListTaskId(base)).success).toBe(true);
  });
});

describe("hashTextFnv1a：确定性摘要", () => {
  it("同文本同摘要，异文本异摘要；不同盐产生不同摘要", () => {
    expect(hashTextFnv1a("abc")).toBe(hashTextFnv1a("abc"));
    expect(hashTextFnv1a("abc")).not.toBe(hashTextFnv1a("abd"));
    expect(hashTextFnv1a("abc")).not.toBe(hashTextFnv1a("abc", 0x9747b28c));
  });

  it("返回 32 位无符号整数", () => {
    const value = hashTextFnv1a("capacity-monte-carlo-v2|space-daily|2026-07-15");
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });
});
