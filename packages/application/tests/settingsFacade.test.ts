/**
 * 设置统一门面测试（判断文件 A1/A2/B1/A5 的行为固化）。
 *
 * 覆盖口径：
 * - 同步键一律走 SyncedSettingsStore（全局学习日设置、功能开关、词典提供方、
 *   Space 级三键），写入条目携带注入时钟的 updatedAt 与注入设备身份的 deviceId；
 * - 设备本地键一律走 DeviceLocalStore：活动 Space 读写绝不进入同步通道；
 * - LWW 决胜用协议函数：假实现 save 以协议 mergeSettings（isSettingEntryNewer 全序）
 *   收敛，测试直接验证"过时写入不得覆盖较新值"；
 * - 校验口径：时区/换日时间、每日目标非负整数、每组条目数正整数、保持率
 *   0.80–0.99 且保留既有权重；
 * - ensure 语义：只补缺失键，绝不覆盖既有值。
 */
import { describe, expect, it } from "vitest";

import { settingKeySchema, spaceSettingKey, type SettingEntry } from "@ebbinghaus/protocol";

import { INITIAL_DEFAULT_TIMESTAMP, SettingsService } from "../src/settingsFacade.ts";
import {
  FixedClock,
  InMemoryDeviceLocalStore,
  InMemorySyncedSettingsStore,
  StaticDeviceIdentity,
} from "./helpers/fakes.ts";

// 期望值用 Date.toISOString() 的规范形态（含毫秒）：门面写入口径，FixedClock 解析后往返一致。
const CLOCK_ISO = "2026-07-15T09:00:00.000Z";
const DEVICE_ID = "b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b";
/** Space 级键要求 UUIDv4（协议 spaceSettingKey 合同），测试用确定性 UUID。 */
const SPACE_ID = "11111111-1111-4111-8111-111111111111";

/** 组装被测门面；返回两个存储假实现供断言与预置。 */
function buildService(clockIso: string = CLOCK_ISO) {
  const clock = new FixedClock(clockIso);
  const syncedSettings = new InMemorySyncedSettingsStore();
  const deviceLocal = new InMemoryDeviceLocalStore();
  const settings = new SettingsService({
    syncedSettings,
    deviceLocal,
    clock,
    deviceIdentity: new StaticDeviceIdentity(DEVICE_ID),
  });
  return { clock, syncedSettings, deviceLocal, settings };
}

describe("全局学习日设置（同步通道）", () => {
  it("首启默认项使用早期版本；之后真实保存仍使用当前时钟", () => {
    const { settings, syncedSettings } = buildService();
    settings.ensureLearningDayDefaults();
    settings.ensureSpaceLearningDefaults(SPACE_ID);
    expect(syncedSettings.getAll().every((entry) => entry.updatedAt === INITIAL_DEFAULT_TIMESTAMP)).toBe(true);

    settings.saveSpaceDailyTarget(SPACE_ID, 10);
    const dailyTarget = syncedSettings.getAll().find((entry) => entry.key === spaceSettingKey(SPACE_ID, "dailyTarget"));
    expect(dailyTarget?.updatedAt).toBe(CLOCK_ISO);
    expect(dailyTarget?.value).toBe(10);
  });

  it("键缺失时回退领域默认值（东八区、04:00）", () => {
    const { settings } = buildService();

    const schedule = settings.getLearningScheduleSettings();

    expect(schedule.timezoneName).toBe("Asia/Shanghai");
    expect(schedule.dayRolloverTime).toBe("04:00");
  });

  it("保存前完整校验：非法时区与非法换日时间都被拒绝，不产生部分写入", () => {
    const { syncedSettings, settings } = buildService();

    expect(() =>
      settings.saveLearningDaySettings({ timezoneName: "Not/AZone", dayRolloverTime: "04:00" }),
    ).toThrow();
    expect(() =>
      settings.saveLearningDaySettings({ timezoneName: "Asia/Shanghai", dayRolloverTime: "25:00" }),
    ).toThrow();
    expect(() =>
      settings.saveLearningDaySettings({ timezoneName: "  ", dayRolloverTime: "04:00" }),
    ).toThrow("时区不能为空");
    // 校验失败不得写入任何键（避免时区错误造成部分设置生效）。
    expect(syncedSettings.getAll()).toEqual([]);
  });

  it("保存后读取回环一致，写入条目的 updatedAt/deviceId 来自注入端口", () => {
    const { syncedSettings, settings } = buildService();

    settings.saveLearningDaySettings({ timezoneName: "Asia/Tokyo", dayRolloverTime: "03:30" });

    const schedule = settings.getLearningScheduleSettings();
    expect(schedule.timezoneName).toBe("Asia/Tokyo");
    expect(schedule.dayRolloverTime).toBe("03:30");
    const byKey = new Map(syncedSettings.getAll().map((entry) => [entry.key, entry]));
    const timezoneEntry = byKey.get("learning.timezone");
    expect(timezoneEntry?.updatedAt).toBe(CLOCK_ISO);
    expect(timezoneEntry?.deviceId).toBe(DEVICE_ID);
    // 键形态先过协议校验。
    expect(settingKeySchema.safeParse("learning.timezone").success).toBe(true);
  });

  it("学习日便捷视图只暴露时区与换日时间", () => {
    const { settings } = buildService();
    settings.saveLearningDaySettings({ timezoneName: "Asia/Tokyo", dayRolloverTime: "03:30" });

    expect(settings.getLearningDaySettings()).toEqual({
      timezoneName: "Asia/Tokyo",
      rolloverTime: "03:30",
    });
  });
});

describe("功能开关与词典提供方（同步通道）", () => {
  it("缺省开启；保存后回读一致", () => {
    const { settings } = buildService();

    expect(settings.getFeatureFlags()).toEqual({ smartOrganizing: true, onlineDictionary: true });

    settings.saveFeatureFlags({ smartOrganizing: false, onlineDictionary: true });
    expect(settings.getFeatureFlags()).toEqual({ smartOrganizing: false, onlineDictionary: true });
  });

  it("词典提供方默认维基词典；保存后回读", () => {
    const { settings } = buildService();

    expect(settings.getDictionaryProvider()).toBe("维基词典");

    settings.saveDictionaryProvider("朗文词典");
    expect(settings.getDictionaryProvider()).toBe("朗文词典");
  });
});

describe("Space 级学习设置（同步通道，space.<spaceId>.* 键）", () => {
  it("缺省回退领域默认值（目标 0、每组 20、保持率 0.95）", () => {
    const { settings } = buildService();

    const spaceSettings = settings.getSpaceLearningSettings(SPACE_ID);

    expect(spaceSettings.dailyTarget).toBe(0);
    expect(spaceSettings.regularGroupSize).toBe(20);
    expect(spaceSettings.fsrsParameters.desiredRetention).toBe(0.95);
    expect(spaceSettings.fsrsParameters.weights).toBeNull();
  });

  it("每日目标：非负整数校验与保存回读，键形态符合协议", () => {
    const { syncedSettings, settings } = buildService();

    expect(() => settings.saveSpaceDailyTarget(SPACE_ID, -1)).toThrow("每日学习目标不能小于 0");
    expect(() => settings.saveSpaceDailyTarget(SPACE_ID, 1.5)).toThrow("每日学习目标不能小于 0");

    settings.saveSpaceDailyTarget(SPACE_ID, 8);
    expect(settings.getSpaceLearningSettings(SPACE_ID).dailyTarget).toBe(8);
    const saved = syncedSettings.getAll().at(-1);
    expect(saved?.key).toBe(spaceSettingKey(SPACE_ID, "dailyTarget"));
    expect(saved?.value).toBe(8);
  });

  it("每组条目数：正整数校验与保存回读", () => {
    const { settings } = buildService();

    expect(() => settings.saveRegularGroupSize(SPACE_ID, 0)).toThrow(
      "常规模式每组条目数必须是正整数",
    );
    expect(() => settings.saveRegularGroupSize(SPACE_ID, 2.5)).toThrow(
      "常规模式每组条目数必须是正整数",
    );

    settings.saveRegularGroupSize(SPACE_ID, 10);
    expect(settings.getSpaceLearningSettings(SPACE_ID).regularGroupSize).toBe(10);
  });

  it("FSRS 参数整体保存：权重向量原样写入", () => {
    const { settings } = buildService();
    const weights = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.3];

    settings.saveFsrsParameters(SPACE_ID, { desiredRetention: 0.9, weights });

    const parameters = settings.getSpaceLearningSettings(SPACE_ID).fsrsParameters;
    expect(parameters.desiredRetention).toBe(0.9);
    expect(parameters.weights).toEqual(weights);
  });

  it("只保存保持率时原样保留既有权重，绝不顺手清空", () => {
    const { settings } = buildService();
    const weights = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.3];
    settings.saveFsrsParameters(SPACE_ID, { desiredRetention: 0.9, weights });

    settings.saveRegularDesiredRetention(SPACE_ID, 0.85);

    const parameters = settings.getSpaceLearningSettings(SPACE_ID).fsrsParameters;
    expect(parameters.desiredRetention).toBe(0.85);
    expect(parameters.weights).toEqual(weights);
  });

  it("保持率超出 0.80–0.99 被拒绝", () => {
    const { settings } = buildService();

    expect(() => settings.saveRegularDesiredRetention(SPACE_ID, 0.79)).toThrow(
      "目标保持率必须在 0.80 至 0.99 之间",
    );
    expect(() => settings.saveRegularDesiredRetention(SPACE_ID, 1)).toThrow(
      "目标保持率必须在 0.80 至 0.99 之间",
    );
  });
});

describe("活动 Space（设备本地通道）", () => {
  it("写入只落 DeviceLocalStore，绝不进入同步通道", () => {
    const { syncedSettings, deviceLocal, settings } = buildService();

    settings.setActiveSpaceId(SPACE_ID);

    expect(settings.getActiveSpaceId()).toBe(SPACE_ID);
    expect(deviceLocal.getString("activeSpaceId")).toBe(SPACE_ID);
    // 设备本地状态不产生任何同步流量（A1 第 5 项）。
    expect(syncedSettings.getAll()).toEqual([]);
  });

  it("同步通道的写入不落设备本地键", () => {
    const { deviceLocal, settings } = buildService();

    settings.saveFeatureFlags({ smartOrganizing: false, onlineDictionary: false });

    expect(deviceLocal.getString("activeSpaceId")).toBeNull();
  });

  it("未设置时 getActiveSpaceIdOrNull 返回 null；强制读取报装配错误", () => {
    const { settings } = buildService();

    expect(settings.getActiveSpaceIdOrNull()).toBeNull();
    expect(() => settings.getActiveSpaceId()).toThrow("活动 Space 未设置");
  });
});

describe("LWW 决胜（协议 isSettingEntryNewer 全序）", () => {
  it("门面写入以更新时刻覆盖旧值", () => {
    const { clock, syncedSettings, settings } = buildService();
    settings.saveSpaceDailyTarget(SPACE_ID, 5);

    clock.setInstant("2026-07-16T09:00:00Z");
    settings.saveSpaceDailyTarget(SPACE_ID, 12);

    expect(settings.getSpaceLearningSettings(SPACE_ID).dailyTarget).toBe(12);
    expect(syncedSettings.getAll().filter((entry) => entry.key === spaceSettingKey(SPACE_ID, "dailyTarget")))
      .toHaveLength(1);
  });

  it("过时的门面写入不得覆盖同步通道中较新的值", () => {
    const { syncedSettings, settings } = buildService();
    // 预置一个"未来"条目（模拟其他设备已写入更新值并收敛到本地视图）。
    const newerEntry: SettingEntry = {
      key: spaceSettingKey(SPACE_ID, "dailyTarget"),
      value: 30,
      updatedAt: "2026-07-20T09:00:00Z",
      deviceId: "11111111-2222-4333-8444-555555555555",
    };
    syncedSettings.save([newerEntry]);

    // 本设备时钟仍停留在更早时刻：写入条目 LWW 落败，读取必须返回较新值 30。
    settings.saveSpaceDailyTarget(SPACE_ID, 8);

    expect(settings.getSpaceLearningSettings(SPACE_ID).dailyTarget).toBe(30);
  });
});

describe("ensure 语义（首次初始化只补缺失）", () => {
  it("ensureLearningDayDefaults 补齐缺失键为默认值", () => {
    const { settings } = buildService();

    settings.ensureLearningDayDefaults();

    const schedule = settings.getLearningScheduleSettings();
    expect(schedule.timezoneName).toBe("Asia/Shanghai");
    expect(schedule.dayRolloverTime).toBe("04:00");
  });

  it("已有用户值时 ensure 不覆盖", () => {
    const { settings } = buildService();
    settings.saveLearningDaySettings({ timezoneName: "Asia/Tokyo", dayRolloverTime: "03:00" });

    settings.ensureLearningDayDefaults();

    expect(settings.getLearningScheduleSettings().timezoneName).toBe("Asia/Tokyo");
  });

  it("ensureSpaceLearningDefaults 补齐 Space 级默认键且不覆盖已有值", () => {
    const { settings } = buildService();
    settings.saveSpaceDailyTarget(SPACE_ID, 8);

    settings.ensureSpaceLearningDefaults(SPACE_ID);

    const spaceSettings = settings.getSpaceLearningSettings(SPACE_ID);
    // 已有值保留；缺失键补默认。
    expect(spaceSettings.dailyTarget).toBe(8);
    expect(spaceSettings.regularGroupSize).toBe(20);
    expect(spaceSettings.fsrsParameters.desiredRetention).toBe(0.95);
  });

  it("非法设置键（不符合协议命名）在写入边界被拒绝", () => {
    const { settings } = buildService();
    // 通过公开入口构造非法键：saveFsrsParameters 走 writeSyncedEntry 前的领域校验，
    // 这里直接以非 UUID SpaceId 触发协议 spaceSettingKey 的 UUIDv4 合同。
    expect(() => settings.saveSpaceDailyTarget("not-a-uuid", 1)).toThrow(
      /Space 级设置键的 spaceId 必须是 UUIDv4/,
    );
  });
});
