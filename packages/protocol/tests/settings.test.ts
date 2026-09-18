import { describe, expect, it } from "vitest";

import {
  isSettingEntryNewer,
  knownSettingKeys,
  mergeSettings,
  settingEntrySchema,
  settingKeySchema,
  spaceSettingKey,
} from "../src/settings.ts";
import { SAMPLE_DEVICE_ID, SAMPLE_OCCURRED_AT } from "./fixtures.ts";

const OTHER_DEVICE_ID = "c8f3a4b5-2d6e-4f9a-8b1c-3d4e5f6a7b8c";

/** 快速构造合法 settings 条目。 */
function makeEntry(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    key: "learning.timezone",
    value: "Asia/Shanghai",
    updatedAt: SAMPLE_OCCURRED_AT,
    deviceId: SAMPLE_DEVICE_ID,
    ...overrides,
  };
}

describe("settings 键命名规则：点分段 + Space 级 UUID 前缀", () => {
  it("接受 A1 全部 9 个已知同步键形态", () => {
    const validKeys = [
      ...Object.values(knownSettingKeys),
      spaceSettingKey("b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b", "dailyTarget"),
      spaceSettingKey("b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b", "regularGroupSize"),
      spaceSettingKey("b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b", "fsrsParameters"),
    ];
    for (const key of validKeys) {
      expect(settingKeySchema.safeParse(key).success, `合法键 ${key} 应通过`).toBe(true);
    }
  });

  it("拒绝单段键、空段、大写开头段与非法字符", () => {
    const invalidKeys = [
      "timezone", // 无命名空间含义的单段键
      "learning", // 同上
      "learning.", // 空段
      ".timezone", // 空段
      "learning..timezone", // 空段
      "Learning.timezone", // 段首字母大写
      "learning.3abc", // 段以数字开头
      "learning.time_zone", // 下划线不在命名规则内
      "learning.时间", // 非 ASCII
      " learning.timezone", // 前导空格
      "learning.timezone ", // 尾随空格
    ];
    for (const key of invalidKeys) {
      expect(settingKeySchema.safeParse(key).success, `非法键 ${key} 应被拒`).toBe(false);
    }
  });

  it("Space 级键要求 UUIDv4 段（版本位/变体位非法、大写 hex 被拒）", () => {
    // 版本位不是 4 的 UUID 段拒绝。
    expect(
      settingKeySchema.safeParse("space.a3f1c2d4-e5b6-1c7d-8a9b-0c1d2e3f4a5b.dailyTarget")
        .success,
    ).toBe(false);
    // 大写 hex 段拒绝：键是持久化身份，同键异形会制造收敛分叉。
    expect(
      settingKeySchema.safeParse("space.A3F1C2D4-E5B6-4C7D-8A9B-0C1D2E3F4A5B.dailyTarget")
        .success,
    ).toBe(false);
    // 首段不允许是 UUID（命名空间必须是人读语义段）。
    expect(
      settingKeySchema.safeParse("a3f1c2d4-e5b6-4c7d-8a9b-0c1d2e3f4a5b.dailyTarget").success,
    ).toBe(false);
  });

  it("schema 不限定 key 必须在已知键常量表内（向前兼容新设置键）", () => {
    // 服务器是哑 KV，未来新增设置键不应要求协议发版。
    expect(settingKeySchema.safeParse("ui.futureFeature.threshold").success).toBe(true);
  });

  it("spaceSettingKey 拒绝非 UUIDv4 的 spaceId，防止拼出非法键", () => {
    expect(() => spaceSettingKey("not-a-uuid", "dailyTarget")).toThrow();
  });
});

describe("settings 条目 schema", () => {
  it("合法条目通过解析，value 支持嵌套 JSON 与 null", () => {
    const nested = makeEntry({
      key: "learning.schedulerParameters",
      value: { desiredRetention: 0.9, weights: [1, 2, { stability: 3.5 }], note: null },
    });
    const parsed = settingEntrySchema.safeParse(nested);
    expect(parsed.success).toBe(true);
  });

  it("updatedAt 不可解析或 deviceId 非法被拒", () => {
    expect(settingEntrySchema.safeParse(makeEntry({ updatedAt: "2026/09/19" })).success).toBe(
      false,
    );
    expect(settingEntrySchema.safeParse(makeEntry({ deviceId: "bad-device" })).success).toBe(
      false,
    );
  });

  it("key 命名规则之外被拒", () => {
    expect(settingEntrySchema.safeParse(makeEntry({ key: "TIMEZONE" })).success).toBe(false);
  });
});

describe("settings LWW 合并：updatedAt 大者胜、deviceId 兜底、全序确定", () => {
  it("updatedAt 较新的条目胜出（新者胜、旧者败两个方向都成立）", () => {
    const older = makeEntry({ updatedAt: "2026-09-18T10:00:00Z" });
    const newer = makeEntry({ updatedAt: "2026-09-19T10:00:00Z" });
    expect(isSettingEntryNewer(newer as never, older as never)).toBe(true);
    expect(isSettingEntryNewer(older as never, newer as never)).toBe(false);
  });

  it("updatedAt 相等时 deviceId 字典序大者胜", () => {
    const smaller = makeEntry({ deviceId: SAMPLE_DEVICE_ID });
    const larger = makeEntry({ deviceId: OTHER_DEVICE_ID });
    // OTHER_DEVICE_ID 的首段 c8f3... 字典序大于 SAMPLE 的 b7e2...。
    expect(isSettingEntryNewer(larger as never, smaller as never)).toBe(true);
    expect(isSettingEntryNewer(smaller as never, larger as never)).toBe(false);
  });

  it("updatedAt 与 deviceId 全相等、value 不同时仍有确定性决胜（与传参顺序无关）", () => {
    const entryA = makeEntry({ value: { scheme: "a" } });
    const entryB = makeEntry({ value: { scheme: "b" } });
    // 两次调用方向的结果必须一致，保证收敛结果与到达顺序无关。
    const firstRound = isSettingEntryNewer(entryA as never, entryB as never);
    const secondRound = isSettingEntryNewer(entryB as never, entryA as never);
    expect(firstRound).not.toBe(secondRound);
    // 且同一方向重复调用结果稳定。
    expect(isSettingEntryNewer(entryA as never, entryB as never)).toBe(firstRound);
  });

  it("mergeSettings 对同一键两侧行按 LWW 决胜，只出现单侧的键保留", () => {
    const local = [
      makeEntry({ key: "learning.timezone", updatedAt: "2026-09-18T00:00:00Z" }),
      makeEntry({ key: "features.onlineDictionary", value: true }),
    ];
    const remote = [
      makeEntry({ key: "learning.timezone", updatedAt: "2026-09-19T00:00:00Z", value: "UTC" }),
      makeEntry({ key: "dictionary.provider", value: "维基词典" }),
    ];
    const merged = mergeSettings(local as never, remote as never);
    expect(merged.map((entry) => entry.key)).toEqual([
      "dictionary.provider",
      "features.onlineDictionary",
      "learning.timezone",
    ]);
    const timezone = merged.find((entry) => entry.key === "learning.timezone");
    expect(timezone?.value).toBe("UTC");
  });

  it("合并结果与传参顺序无关（a+b 与 b+a 完全一致）", () => {
    const local = [
      makeEntry({ key: "learning.timezone", updatedAt: "2026-09-18T00:00:00Z" }),
      makeEntry({
        key: "space.b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b.dailyTarget",
        value: 30,
        deviceId: OTHER_DEVICE_ID,
        updatedAt: "2026-09-19T00:00:00Z",
      }),
      makeEntry({ key: "dictionary.provider", value: "维基词典" }),
    ];
    const remote = [
      makeEntry({
        key: "space.b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b.dailyTarget",
        value: 25,
        updatedAt: "2026-09-19T00:00:00Z",
      }),
      makeEntry({ key: "learning.timezone", value: "UTC", updatedAt: "2026-09-17T00:00:00Z" }),
      makeEntry({ key: "features.smartOrganizing", value: false }),
    ];
    const ab = mergeSettings(local as never, remote as never);
    const ba = mergeSettings(remote as never, local as never);
    expect(ab).toEqual(ba);
  });

  it("value 含嵌套 JSON 时合并保真不变形", () => {
    const value = { a: [1, { b: "文本" }], c: null };
    const merged = mergeSettings(
      [makeEntry({ key: "learning.schedulerParameters", value })] as never,
      [] as never,
    );
    expect(merged[0]?.value).toEqual(value);
  });

  it("合并是纯函数：不修改任何入参数组", () => {
    const local = [makeEntry()];
    const remote = [makeEntry({ key: "features.smartOrganizing", value: true })];
    const localCopy = structuredClone(local);
    const remoteCopy = structuredClone(remote);
    mergeSettings(local as never, remote as never);
    expect(local).toEqual(localCopy);
    expect(remote).toEqual(remoteCopy);
  });
});
