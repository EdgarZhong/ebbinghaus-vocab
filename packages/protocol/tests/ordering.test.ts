import { describe, expect, expectTypeOf, it } from "vitest";

import { compareEvents, sortEventsForReplay, type ReplayableEvent } from "../src/ordering.ts";
import type { StoredLearningEvent } from "../src/events.ts";
import { makeStoredEvent } from "./fixtures.ts";

/** 快速构造排序用事件（不经过 schema，聚焦比较函数本身）。 */
function event(
  eventId: string,
  occurredAt: string,
  deviceSeq: number,
  deviceId: string,
): ReplayableEvent {
  return { eventId, occurredAt, deviceSeq, deviceId };
}

const DEVICE_A = "b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b";
const DEVICE_B = "c8f3a4b5-2d6e-4f9a-8b1c-3d4e5f6a7b8c";

describe("领域重放排序：occurredAt 优先（时间序而非字符串序）", () => {
  it("更早的绝对时刻排在前面", () => {
    const earlier = event("e2", "2026-09-18T10:00:00Z", 1, DEVICE_A);
    const later = event("e1", "2026-09-19T10:00:00Z", 1, DEVICE_A);
    expect(compareEvents(earlier, later)).toBeLessThan(0);
    expect(compareEvents(later, earlier)).toBeGreaterThan(0);
  });

  it("时区表示不同但同一时刻的事件视为 occurredAt 相等，继续比较 deviceSeq", () => {
    // `+08:00` 的 9 月 19 日 00:00 与 `Z` 的 9 月 18 日 16:00 是同一绝对时刻；
    // 若按字符串比较会得到错误先后关系（"2026-09-18T16…" 字符序小于 "2026-09-19T00…"）。
    const fromShanghai = event("e1", "2026-09-19T00:00:00+08:00", 2, DEVICE_A);
    const fromUtc = event("e2", "2026-09-18T16:00:00Z", 1, DEVICE_A);
    expect(compareEvents(fromShanghai, fromUtc)).toBeGreaterThan(0);
    expect(compareEvents(fromUtc, fromShanghai)).toBeLessThan(0);
  });

  it("Z 与 +00:00 两种 UTC 表示同一时刻，排序进入下一级 tie-break", () => {
    const withZ = event("e1", "2026-09-19T12:00:00Z", 1, DEVICE_A);
    const withOffset = event("e2", "2026-09-19T12:00:00+00:00", 2, DEVICE_A);
    expect(compareEvents(withZ, withOffset)).toBeLessThan(0);
    expect(compareEvents(withOffset, withZ)).toBeGreaterThan(0);
  });

  it("occurredAt 无法解析时抛错（fail fast，禁止静默产生不确定排序）", () => {
    const broken = event("e1", "不是时间", 1, DEVICE_A);
    const valid = event("e2", "2026-09-19T12:00:00Z", 1, DEVICE_A);
    expect(() => compareEvents(broken, valid)).toThrow();
  });
});

describe("领域重放排序：同时刻依次按 deviceSeq、deviceId、eventId 决胜", () => {
  const SAME_INSTANT = "2026-09-19T12:00:00Z";

  it("occurredAt 相同时 deviceSeq 小者在前", () => {
    const first = event("e1", SAME_INSTANT, 1, DEVICE_A);
    const second = event("e2", SAME_INSTANT, 2, DEVICE_A);
    expect(compareEvents(first, second)).toBeLessThan(0);
  });

  it("deviceSeq 也相同时 deviceId 字典序小者在前", () => {
    const fromA = event("e1", SAME_INSTANT, 1, DEVICE_A);
    const fromB = event("e2", SAME_INSTANT, 1, DEVICE_B);
    expect(compareEvents(fromA, fromB)).toBeLessThan(0);
    expect(compareEvents(fromB, fromA)).toBeGreaterThan(0);
  });

  it("deviceId 也相同时 eventId 字典序小者在前（杜绝并列）", () => {
    const earlierId = event("a-event", SAME_INSTANT, 1, DEVICE_A);
    const laterId = event("b-event", SAME_INSTANT, 1, DEVICE_A);
    expect(compareEvents(earlierId, laterId)).toBeLessThan(0);
  });

  it("四键全等视为同一事件，比较结果为 0", () => {
    const one = event("same-id", SAME_INSTANT, 1, DEVICE_A);
    const two = event("same-id", SAME_INSTANT, 1, DEVICE_A);
    expect(compareEvents(one, two)).toBe(0);
  });
});

describe("领域重放排序：serverSeq 永不参与", () => {
  it("serverSeq 更大但 occurredAt 更早的离线事件仍排在前面", () => {
    // 场景：设备 B 离线一天后恢复网络，晚上传的旧事件拿到大 serverSeq。
    // 若按 serverSeq 重放会把旧事实排到新事实之后，污染 FSRS 与任务状态。
    const offlineOld = makeStoredEvent("testAnswered", {
      occurredAt: "2026-09-18T08:00:00Z",
      serverSeq: 9999,
      deviceSeq: 1,
      deviceId: DEVICE_B,
    });
    const onlineNew = makeStoredEvent("testAnswered", {
      occurredAt: "2026-09-19T08:00:00Z",
      serverSeq: 10,
      deviceSeq: 1,
      deviceId: DEVICE_A,
    });
    expect(compareEvents(offlineOld, onlineNew)).toBeLessThan(0);
    const replayOrder = sortEventsForReplay([onlineNew, offlineOld]);
    expect(replayOrder[0]).toBe(offlineOld);
  });

  it("比较函数签名在编译层面不含 serverSeq（ReplayableEvent 无此字段）", () => {
    // 排序键接口只声明四个领域字段；StoredLearningEvent 虽含 serverSeq，
    // 但函数参数类型不声明它——任何想给排序加入 serverSeq 的改动都必须
    // 先修改 ReplayableEvent 接口，无法悄悄绕过 review。
    expectTypeOf<Parameters<typeof compareEvents>[0]>().toEqualTypeOf<ReplayableEvent>();
    expectTypeOf<ReplayableEvent>().not.toHaveProperty("serverSeq");
  });

  it("含 serverSeq 的存储事件可直接传入比较函数（结构兼容）", () => {
    const stored: StoredLearningEvent = makeStoredEvent("wordMastered", {
      occurredAt: "2026-09-19T12:00:00Z",
      serverSeq: 5,
      deviceSeq: 1,
      deviceId: DEVICE_A,
    });
    expect(compareEvents(stored, stored)).toBe(0);
  });
});

describe("领域重放排序：sortEventsForReplay 行为", () => {
  it("把混合时区表示的乱序事件集排成确定的重放顺序", () => {
    const events = [
      event("e5", "2026-09-19T20:00:00+08:00", 1, DEVICE_A), // 19 日 12:00Z
      event("e4", "2026-09-19T12:00:00Z", 3, DEVICE_B),
      event("e3", "2026-09-19T12:00:00Z", 2, DEVICE_B),
      event("e2", "2026-09-19T12:00:00Z", 1, DEVICE_B),
      event("e1", "2026-09-18T00:00:00Z", 1, DEVICE_A),
    ];
    const sorted = sortEventsForReplay(events);
    // e5 与 e2 处于同一绝对时刻且 deviceSeq 同为 1，此时由 deviceId 字典序决胜：
    // DEVICE_A（b7e2…）小于 DEVICE_B（c8f3…），故 e5 先于 e2。
    expect(sorted.map((item) => item.eventId)).toEqual(["e1", "e5", "e2", "e3", "e4"]);
  });

  it("返回新数组且不修改入参顺序（纯函数）", () => {
    const original = [
      event("e2", "2026-09-19T12:00:00Z", 1, DEVICE_A),
      event("e1", "2026-09-18T00:00:00Z", 1, DEVICE_A),
    ];
    const snapshot = [...original];
    const sorted = sortEventsForReplay(original);
    expect(original).toEqual(snapshot);
    expect(sorted).not.toBe(original);
    expect(sorted.map((item) => item.eventId)).toEqual(["e1", "e2"]);
  });
});
