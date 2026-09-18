import { z } from "zod";

import { isoTimestampSchema, uuidV4Schema } from "./events.ts";

/**
 * 设置同步协议（docs/V2首轮自主判断与口径收敛.md A1/A2/B1/B2 + 技术决策第五章）。
 *
 * 口径总纲：
 * - 设置走独立的 settings KV 通道，与学习事件通道完全分离（B2）：事件 append-only
 *   靠重放收敛，设置靠 LWW 覆盖收敛，混流会迫使重放器理解 LWW。
 * - 服务器对 settings 是"哑 KV 存储"：不理解键语义，只按 LWW 规则逐键合并；
 *   Space 级设置同样走 KV 键（A2），不新增设置类领域事件。
 * - value 必须是"任意 JSON 可序列化值"（B1）。协议层用 z.unknown() 保真传输，
 *   不在 Zod 层做"JSON 可序列化"递归校验——不可序列化值（函数、循环引用）在
 *   客户端/服务器做 JSON 文本持久化时天然失败，属于实现层错误而非协议校验职责。
 */

/**
 * settings 键命名规则。
 *
 * 结构：以小写字母开头的点分段（段内允许 camelCase，如 learning.dayRolloverTime），
 * 其中任意一段允许是 UUIDv4（当前唯一使用处是 Space 级设置的 `space.<spaceId>.*`
 * 前缀，A1/A2）。规则固化要点：
 * - 至少两段：全局设置一律 `<命名空间>.<键名>`，单段键无命名空间含义，直接拒绝。
 * - UUID 段限定小写 hex + v4 版本位 + [89ab] 变体位：键是持久化身份，大小写敏感，
 *   放宽大小写会制造"同键异形"的收敛分叉（客户端生成的 UUIDv4 一律小写）。
 * - 首段不允许是 UUID：命名空间必须是人读的语义段（learning/dictionary/features/space…）。
 * - 正则刻意不把段序收紧为"UUID 只能出现在第二段"：向前兼容未来可能的
 *   `<ns>.<id>.<leaf>` 形态键，避免 schema 过严阻碍协议演进。
 */
const SETTING_KEY_REGEX =
  /^[a-z][a-zA-Z0-9]*(?:\.(?:[a-z][a-zA-Z0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))+$/;

export const settingKeySchema = z
  .string()
  .regex(SETTING_KEY_REGEX, "settings 键必须是以小写开头的点分段（段内允许 camelCase，段允许为 UUIDv4），且至少两段");

/**
 * settings 条目。
 *
 * schema 用 z.object（strip）而非 strict：服务器可能在条目上附加自己的元数据
 * （如 D5 设计的 server_updated_at），客户端解析时只需 LWW 所需四字段，静默忽略
 * 服务器附加字段比直接拒绝更利于服务器端协议演进；四字段本身全部严格校验。
 */
export const settingEntrySchema = z.object({
  key: settingKeySchema,
  value: z.unknown(),
  /** 该条目最后写入时刻（客户端可注入时钟生成，UTC ISO8601，判断文件 B6）。 */
  updatedAt: isoTimestampSchema,
  /** 写入设备标识（LWW 平局的确定性 tie-break 依据）。 */
  deviceId: uuidV4Schema,
});

/** settings 条目类型。 */
export type SettingEntry = z.output<typeof settingEntrySchema>;

/**
 * 已知设置键常量表（A1 全部判定为"同步"的设置项）。
 *
 * 该表只作为客户端与 Phase 2 迁移的引用常量导出，schema 刻意不限定 key 必须在
 * 表内（向前兼容：服务器是哑 KV，未来新增设置键不需要协议发版）。
 * 注意：简报与 A1 口径表述为"十项同步设置"，A1 表实际判定为同步的是 9 项——
 * 第 5 项 active_space_id 判定为设备本地（各设备独立浏览位置），不在本表。
 */
export const knownSettingKeys = {
  /** 时区（学习日边界计算输入；V1 user_settings.timezone_name）。 */
  learningTimezone: "learning.timezone",
  /** 换日时间（V1 user_settings.learning_day_rollover_time）。 */
  learningDayRolloverTime: "learning.dayRolloverTime",
  /** 全局调度参数 JSON（含目标保持率；V1 user_settings.scheduler_parameters_json）。 */
  learningSchedulerParameters: "learning.schedulerParameters",
  /** 词典提供方（V1 user_settings.dictionary_provider）。 */
  dictionaryProvider: "dictionary.provider",
  /** 智能整理开关（V1 user_settings.smart_organizing_enabled）。 */
  featuresSmartOrganizing: "features.smartOrganizing",
  /** 在线词典开关（V1 user_settings.online_dictionary_enabled）。 */
  featuresOnlineDictionary: "features.onlineDictionary",
} as const;

/** Space 级设置键的叶子段集合（A1 第 8-10 项）。 */
export const spaceSettingLeafKeys = [
  "dailyTarget",
  "regularGroupSize",
  "fsrsParameters",
] as const;

/** Space 级设置叶子键类型。 */
export type SpaceSettingLeafKey = (typeof spaceSettingLeafKeys)[number];

/**
 * 构造 Space 级设置键 `space.<spaceId>.<leaf>`（A2：Space 级设置走 KV 通道）。
 * spaceId 必须是 UUIDv4，防止拼出命名规则之外的非法键流入同步通道。
 */
export function spaceSettingKey(spaceId: string, leaf: SpaceSettingLeafKey): string {
  const parsed = uuidV4Schema.safeParse(spaceId);
  if (!parsed.success) {
    throw new Error(`Space 级设置键的 spaceId 必须是 UUIDv4，收到：${spaceId}`);
  }
  return `space.${parsed.data}.${leaf}`;
}

/**
 * 判断 candidate 是否应覆盖 incumbent（LWW 规则，B1）。
 *
 * 规则：updatedAt 大者胜；updatedAt 相等时 deviceId 字典序大者胜；两者都相等
 * （同设备同一时刻写入、value 仍可能不同）时，用 value 的 JSON 序列化串字典序
 * 大者胜——必须引入确定性末级 tie-break，否则"同键同时刻同设备但值不同"的极端
 * 输入会导致合并结果依赖传参顺序，破坏收敛性。
 * 全序保证：对同一键的任意两个条目，胜者恒定，与合并遍历顺序无关。
 * 返回 true 表示 candidate 胜出应覆盖 incumbent。
 */
export function isSettingEntryNewer(candidate: SettingEntry, incumbent: SettingEntry): boolean {
  const candidateAt = Date.parse(candidate.updatedAt);
  const incumbentAt = Date.parse(incumbent.updatedAt);
  if (candidateAt !== incumbentAt) {
    return candidateAt > incumbentAt;
  }
  if (candidate.deviceId !== incumbent.deviceId) {
    return candidate.deviceId > incumbent.deviceId;
  }
  return serializeSettingValue(candidate.value) > serializeSettingValue(incumbent.value);
}

/**
 * value 的确定性序列化：JSON.stringify 对 undefined 返回 undefined（非字符串），
 * 这里归一为字面量 "undefined"，保证比较函数任何输入下都返回 string。
 */
function serializeSettingValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized;
}

/**
 * 对 KV 集合做 LWW 合并（B1），返回按键升序排序的新数组。
 *
 * 入参为 local / remote 两个条目数组（也可传入同一来源的多个批次）：
 * - 两供建立同一键的条目按 isSettingEntryNewer 全序逐键决胜；
 * - 只出现在单侧的键直接保留（settings 无删除语义，A3：孤儿键可接受）；
 * - 同一数组内部的重复键同样按 LWW 折叠；
 * - 输出按键升序（UTF-16 code unit 序）固定排序：调用方无论以何种顺序传入两批
 *   数据，mergeSettings(a, b) 与 mergeSettings(b, a) 得到完全一致的数组，
 *   这是服务器逐键合并可重放、可测试的基础。
 * 纯函数：不修改任何入参数组。
 */
export function mergeSettings(
  local: readonly SettingEntry[],
  remote: readonly SettingEntry[],
): SettingEntry[] {
  const merged = new Map<string, SettingEntry>();
  const upsert = (entry: SettingEntry): void => {
    const incumbent = merged.get(entry.key);
    if (incumbent === undefined || isSettingEntryNewer(entry, incumbent)) {
      merged.set(entry.key, entry);
    }
  };
  for (const entry of local) {
    upsert(entry);
  }
  for (const entry of remote) {
    upsert(entry);
  }
  return [...merged.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}
