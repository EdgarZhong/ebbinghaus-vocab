/**
 * 学习日解析测试（映射 V1 tests/unit/application/test_learning_day.py）。
 *
 * 全部输入都是显式构造的固定绝对时刻，绝不依赖本机时区或当前系统时间。
 */
import { describe, expect, it } from "vitest";

import { resolveLearningDay } from "../src/learningDay.ts";

describe("学习日：时区、换日边界与跨时区投影", () => {
  it("换日时间之前的本地凌晨时刻归入前一学习日", () => {
    // 新加坡（UTC+8）2026-07-15 03:00 = UTC 2026-07-14 19:00；换日时间 04:00 之前
    // 属于 2026-07-14 这一学习日。
    const instant = new Date("2026-07-14T19:00:00Z");
    const learningDay = resolveLearningDay(instant, {
      timezoneName: "Asia/Singapore",
      rolloverTime: "04:00",
    });
    expect(learningDay).toBe("2026-07-14");
  });

  it("同一绝对时刻在不同时区属于不同学习日", () => {
    // 保存绝对时间后按用户当前时区投影，不能用固定 UTC 日期替代。
    const instant = new Date("2026-07-15T02:30:00Z");
    const singaporeDay = resolveLearningDay(instant, {
      timezoneName: "Asia/Singapore",
      rolloverTime: "04:00",
    });
    const newYorkDay = resolveLearningDay(instant, {
      timezoneName: "America/New_York",
      rolloverTime: "04:00",
    });
    expect(singaporeDay).toBe("2026-07-15");
    expect(newYorkDay).toBe("2026-07-14");
  });

  it("换日时间等于零点时本地日期即学习日", () => {
    const instant = new Date("2026-07-15T20:00:00Z"); // 上海 07-16 04:00（含零点边界不前移）。
    expect(
      resolveLearningDay(instant, { timezoneName: "Asia/Shanghai", rolloverTime: "00:00" }),
    ).toBe("2026-07-16");
  });

  it("换日时间边界时刻本身属于新学习日", () => {
    // 04:00 整不低于换日时间，归入当天。
    const instant = new Date("2026-07-14T20:00:00Z"); // 新加坡 07-15 04:00。
    expect(
      resolveLearningDay(instant, { timezoneName: "Asia/Singapore", rolloverTime: "04:00" }),
    ).toBe("2026-07-15");
  });

  it("未知时区必须明确失败，不能回退本机默认时区", () => {
    expect(() =>
      resolveLearningDay(new Date("2026-07-15T09:00:00Z"), {
        timezoneName: "Invalid/Timezone",
        rolloverTime: "04:00",
      }),
    ).toThrow(/未知时区/);
  });

  it("非法换日时间格式立即拒绝", () => {
    expect(() =>
      resolveLearningDay(new Date("2026-07-15T09:00:00Z"), {
        timezoneName: "Asia/Singapore",
        rolloverTime: "24:00",
      }),
    ).toThrow(/HH:mm/);
  });

  it("无效时刻输入立即拒绝", () => {
    expect(() =>
      resolveLearningDay(new Date("not-a-date"), {
        timezoneName: "Asia/Singapore",
        rolloverTime: "04:00",
      }),
    ).toThrow(/绝对时间/);
  });
});
