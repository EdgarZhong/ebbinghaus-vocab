/**
 * 学习调度设置模型测试（判断文件 A1 同步键口径，V2 新增，无 V1 测试对应）。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEARNING_SCHEDULE_SETTINGS,
  DEFAULT_SPACE_LEARNING_SETTINGS,
  validateFsrsParameterSettings,
  validateLearningScheduleSettings,
  validateSpaceLearningSettings,
} from "../src/settings.ts";

describe("全局学习调度设置", () => {
  it("默认值：东八区、04:00 换日、空调度参数", () => {
    expect(DEFAULT_LEARNING_SCHEDULE_SETTINGS.timezoneName).toBe("Asia/Shanghai");
    expect(DEFAULT_LEARNING_SCHEDULE_SETTINGS.dayRolloverTime).toBe("04:00");
    expect(DEFAULT_LEARNING_SCHEDULE_SETTINGS.schedulerParameters).toEqual({});
    expect(validateLearningScheduleSettings(DEFAULT_LEARNING_SCHEDULE_SETTINGS)).toEqual(
      DEFAULT_LEARNING_SCHEDULE_SETTINGS,
    );
  });

  it.each([
    ["非对象输入", "not-an-object"],
    ["缺时区", { dayRolloverTime: "04:00" }],
    ["缺换日时间", { timezoneName: "Asia/Shanghai" }],
    ["非法换日时间", { timezoneName: "Asia/Shanghai", dayRolloverTime: "4:00" }],
  ])("非法输入被拒绝：%s", (_name, raw) => {
    expect(() => validateLearningScheduleSettings(raw)).toThrow();
  });
});

describe("Space 级学习设置", () => {
  it("默认值：目标 0、每组 20、保持率 0.95", () => {
    expect(DEFAULT_SPACE_LEARNING_SETTINGS.dailyTarget).toBe(0);
    expect(DEFAULT_SPACE_LEARNING_SETTINGS.regularGroupSize).toBe(20);
    expect(DEFAULT_SPACE_LEARNING_SETTINGS.fsrsParameters.desiredRetention).toBe(0.95);
    expect(validateSpaceLearningSettings(undefined)).toEqual(DEFAULT_SPACE_LEARNING_SETTINGS);
  });

  it("合法输入归一后原样返回", () => {
    const settings = validateSpaceLearningSettings({
      dailyTarget: 6,
      regularGroupSize: 25,
      fsrsParameters: { desiredRetention: 0.9, weights: null },
    });
    expect(settings).toEqual({
      dailyTarget: 6,
      regularGroupSize: 25,
      fsrsParameters: { desiredRetention: 0.9, weights: null },
    });
  });

  it("每日目标必须是不小于 0 的整数", () => {
    expect(() => validateSpaceLearningSettings({ dailyTarget: -1 })).toThrow(/dailyTarget/);
    expect(() => validateSpaceLearningSettings({ dailyTarget: 1.5 })).toThrow(/dailyTarget/);
  });

  it("每组条目数必须是正整数（规格 6.8 默认 20）", () => {
    expect(() => validateSpaceLearningSettings({ regularGroupSize: 0 })).toThrow(/regularGroupSize/);
  });

  it("目标保持率取值范围为 0.80–0.99（复习调度算法 11.2）", () => {
    expect(() => validateFsrsParameterSettings({ desiredRetention: 0.79 })).toThrow(/0.80 至 0.99/);
    expect(() => validateFsrsParameterSettings({ desiredRetention: 1.0 })).toThrow(/0.80 至 0.99/);
    expect(validateFsrsParameterSettings({ desiredRetention: 0.8 }).desiredRetention).toBe(0.8);
    expect(validateFsrsParameterSettings({ desiredRetention: 0.99 }).desiredRetention).toBe(0.99);
  });
});
