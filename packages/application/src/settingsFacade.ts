/**
 * 设置统一门面：同步 settings（云端权威、LWW 收敛）与设备本地设置的唯一读写入口
 * （判断文件 A1/B2/A5 的直接落实）。
 *
 * 三类归宿，调用方绝不直接拼 KV 键：
 * - **全局同步设置**：learning.timezone / learning.dayRolloverTime / learning.schedulerParameters
 *   （学习调度必需，A1 第 1–3 项）、dictionary.provider（第 4 项）、
 *   features.smartOrganizing / features.onlineDictionary（第 6–7 项）；
 * - **Space 级同步设置**：space.<spaceId>.dailyTarget / regularGroupSize / fsrsParameters
 *   （A1 第 8–10 项；A2：走 KV 通道，不新增"设置变更"领域事件）；
 * - **设备本地设置**：activeSpaceId（A1 第 5 项：本设备正在浏览哪个 Space 是 UI 状态，
 *   各设备独立）+ A5 预留的未来本地键。
 *
 * 写入语义：每次写入都以当前可注入时钟 + 本设备 ID 构造完整 SettingEntry 走 LWW；
 * ensure 语义的写入（首次初始化）只在键缺失时写入，避免用默认值 LWW 覆盖用户修改。
 */

import {
  validateLearningScheduleSettings,
  validateSpaceLearningSettings,
  type FsrsParameterSettings,
  type LearningScheduleSettings,
  type SpaceLearningSettings,
  DEFAULT_LEARNING_SCHEDULE_SETTINGS,
  DEFAULT_SPACE_LEARNING_SETTINGS,
} from "@ebbinghaus/domain";
import type { LearningDaySettings } from "@ebbinghaus/domain";
import { parseRolloverTime, resolveLearningDay } from "@ebbinghaus/domain";
import { settingKeySchema, spaceSettingKey, type SettingEntry } from "@ebbinghaus/protocol";
import type {
  Clock,
  DeviceIdentityProvider,
  DeviceLocalStore,
  SyncedSettingsStore,
} from "./ports.ts";

/** 设备本地键常量表（A5：本轮只定义机制，键随功能按需追加）。 */
export const DEVICE_LOCAL_KEYS = {
  /** 本设备当前浏览的活动 Space（A1 第 5 项：设备本地，不同步）。 */
  activeSpaceId: "activeSpaceId",
} as const;

/** V1 user_settings 的功能开关默认值（v001_initial：默认开启）。 */
const DEFAULT_DICTIONARY_PROVIDER = "维基词典";

/**
 * 首启种子的逻辑时间。新设备即使晚于已有设备安装，也不能用“今天”的默认值
 * 覆盖云端早已由用户修改的设置；真实用户操作仍使用注入时钟生成新版本。
 */
export const INITIAL_DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export interface SettingsServiceDeps {
  readonly syncedSettings: SyncedSettingsStore;
  readonly deviceLocal: DeviceLocalStore;
  readonly clock: Clock;
  readonly deviceIdentity: DeviceIdentityProvider;
}

export class SettingsService {
  private readonly deps: SettingsServiceDeps;
  /**
   * 本进程最近一次写入的 updatedAt（毫秒时间戳）。
   *
   * 单调护栏（Lamport 式）：toISOString() 只有毫秒精度，同一毫秒内的连续写入会得到
   * 相同 updatedAt，LWW 随即跌入 deviceId/值序列化决胜——同设备下"后写的值可能输给
   * 先写的值"（例如先存 FSRS 参数再只改保持率，0.9 的序列化排序恰好高于 0.85）。
   * 护栏保证同进程内写入时间戳严格递增，落实"同设备最后写入获胜"的本意；
   * 跨设备同毫秒并列仍由协议的确定性决胜规则处理（与顺序无关）。
   */
  private lastWrittenAtMs = Number.NEGATIVE_INFINITY;

  constructor(deps: SettingsServiceDeps) {
    this.deps = deps;
  }

  // ---------------------------------------------------------------------------
  // 全局学习调度设置（同步）
  // ---------------------------------------------------------------------------

  /** 读取全局学习调度设置；键缺失时回退领域默认值（东八区、04:00、空参数）。 */
  getLearningScheduleSettings(): LearningScheduleSettings {
    const timezoneName = this.readSyncedString("learning.timezone");
    const dayRolloverTime = this.readSyncedString("learning.dayRolloverTime");
    if (timezoneName === null || dayRolloverTime === null) {
      return { ...DEFAULT_LEARNING_SCHEDULE_SETTINGS };
    }
    const schedulerParameters = this.readSyncedValue("learning.schedulerParameters");
    return validateLearningScheduleSettings({
      timezoneName,
      dayRolloverTime,
      schedulerParameters:
        typeof schedulerParameters === "object" &&
        schedulerParameters !== null &&
        !Array.isArray(schedulerParameters)
          ? schedulerParameters
          : DEFAULT_LEARNING_SCHEDULE_SETTINGS.schedulerParameters,
    });
  }

  /** 学习日计算所需的两项设置（时区 + 换日时间）的便捷视图。 */
  getLearningDaySettings(): LearningDaySettings {
    const settings = this.getLearningScheduleSettings();
    return {
      timezoneName: settings.timezoneName,
      rolloverTime: settings.dayRolloverTime,
    };
  }

  /**
   * 保存全局学习日设置（时区 + 换日时间），先完整校验再写入，避免时区错误造成
   * 部分设置生效（V1 save_settings 口径）。学习日解析器负责验证 IANA 时区名称：
   * 只读解析在写入前完成，解析失败即拒绝保存。
   */
  saveLearningDaySettings(input: {
    readonly timezoneName: string;
    readonly dayRolloverTime: string;
  }): void {
    const timezoneName = input.timezoneName.trim();
    if (!timezoneName) {
      throw new Error("时区不能为空");
    }
    // 换日时间格式（HH:mm）由 parseRolloverTime 校验；时区合法性由一次真实解析校验。
    parseRolloverTime(input.dayRolloverTime);
    resolveLearningDay(this.deps.clock.now(), {
      timezoneName,
      rolloverTime: input.dayRolloverTime,
    });
    this.writeSyncedEntry("learning.timezone", timezoneName);
    this.writeSyncedEntry("learning.dayRolloverTime", input.dayRolloverTime);
  }

  /** 功能开关（同步）：智能整理与在线词典；V1 数据库默认值为开启。 */
  getFeatureFlags(): { readonly smartOrganizing: boolean; readonly onlineDictionary: boolean } {
    return {
      smartOrganizing: this.readSyncedBoolean("features.smartOrganizing", true),
      onlineDictionary: this.readSyncedBoolean("features.onlineDictionary", true),
    };
  }

  saveFeatureFlags(input: { readonly smartOrganizing: boolean; readonly onlineDictionary: boolean }): void {
    this.writeSyncedEntry("features.smartOrganizing", input.smartOrganizing);
    this.writeSyncedEntry("features.onlineDictionary", input.onlineDictionary);
  }

  /** 词典提供方偏好（同步）；默认"维基词典"（V1 v001_initial）。 */
  getDictionaryProvider(): string {
    return this.readSyncedString("dictionary.provider") ?? DEFAULT_DICTIONARY_PROVIDER;
  }

  saveDictionaryProvider(provider: string): void {
    this.writeSyncedEntry("dictionary.provider", provider);
  }

  // ---------------------------------------------------------------------------
  // Space 级学习设置（同步，space.<spaceId>.* 键）
  // ---------------------------------------------------------------------------

  /** 读取 Space 级学习设置；键缺失时回退领域默认值（目标 0、每组 20、保持率 0.95）。 */
  getSpaceLearningSettings(spaceId: string): SpaceLearningSettings {
    const raw = {
      dailyTarget: this.readSyncedValue(spaceSettingKey(spaceId, "dailyTarget")),
      regularGroupSize: this.readSyncedValue(spaceSettingKey(spaceId, "regularGroupSize")),
      fsrsParameters: this.readSyncedValue(spaceSettingKey(spaceId, "fsrsParameters")),
    };
    return validateSpaceLearningSettings({
      dailyTarget: raw.dailyTarget ?? undefined,
      regularGroupSize: raw.regularGroupSize ?? undefined,
      fsrsParameters: raw.fsrsParameters === undefined ? undefined : raw.fsrsParameters,
    });
  }

  /** 保存 Space 每日目标（非负整数）；V1 save_active_space_daily_target 校验口径。 */
  saveSpaceDailyTarget(spaceId: string, dailyTarget: number): void {
    if (!Number.isInteger(dailyTarget) || dailyTarget < 0) {
      throw new Error("每日学习目标不能小于 0");
    }
    this.writeSyncedEntry(spaceSettingKey(spaceId, "dailyTarget"), dailyTarget);
  }

  /** 保存常规模式每组条目数（正整数）；默认 20（需求规格 6.8）。 */
  saveRegularGroupSize(spaceId: string, regularGroupSize: number): void {
    if (!Number.isInteger(regularGroupSize) || regularGroupSize <= 0) {
      throw new Error("常规模式每组条目数必须是正整数");
    }
    this.writeSyncedEntry(spaceSettingKey(spaceId, "regularGroupSize"), regularGroupSize);
  }

  /** 整体保存 Space 级 FSRS 参数（保持率 + 权重向量），值域校验走领域函数。 */
  saveFsrsParameters(spaceId: string, parameters: FsrsParameterSettings): void {
    // 借道领域校验保证 0.80–0.99 与权重形态，再原样写入。
    validateSpaceLearningSettings({
      dailyTarget: this.getSpaceLearningSettings(spaceId).dailyTarget,
      regularGroupSize: this.getSpaceLearningSettings(spaceId).regularGroupSize,
      fsrsParameters: parameters,
    });
    this.writeSyncedEntry(spaceSettingKey(spaceId, "fsrsParameters"), {
      desiredRetention: parameters.desiredRetention,
      weights: parameters.weights === null ? null : [...parameters.weights],
    });
  }

  /** 只保存常规模式目标保持率；可编辑范围 0.80–0.99（V1 设置页就地阻止口径）。 */
  saveRegularDesiredRetention(spaceId: string, desiredRetention: number): void {
    const minimum = 0.8;
    const maximum = 0.99;
    if (desiredRetention < minimum || desiredRetention > maximum) {
      throw new Error("目标保持率必须在 0.80 至 0.99 之间");
    }
    // 保持率只是 FSRS 参数的一个字段：写入时必须原样保留既有权重，不得顺手清空。
    const current = this.getSpaceLearningSettings(spaceId).fsrsParameters;
    this.saveFsrsParameters(spaceId, {
      desiredRetention,
      weights: current.weights,
    });
  }

  // ---------------------------------------------------------------------------
  // 设备本地设置（活动 Space 等）
  // ---------------------------------------------------------------------------

  /** 读取活动 Space；未设置时返回 null（由初始化用例负责首次缺省）。 */
  getActiveSpaceIdOrNull(): string | null {
    return this.deps.deviceLocal.getString(DEVICE_LOCAL_KEYS.activeSpaceId);
  }

  /** 读取活动 Space；未设置属于装配错误，立即失败（V1 "用户设置缺少活动 Space"口径）。 */
  getActiveSpaceId(): string {
    const active = this.getActiveSpaceIdOrNull();
    if (active === null || active.length === 0) {
      throw new Error("活动 Space 未设置");
    }
    return active;
  }

  /** 设置活动 Space（设备本地状态，不产生任何同步流量）。 */
  setActiveSpaceId(spaceId: string): void {
    this.deps.deviceLocal.setString(DEVICE_LOCAL_KEYS.activeSpaceId, spaceId);
  }

  // ---------------------------------------------------------------------------
  // 首次初始化（ensure 语义：只补缺失，绝不覆盖既有值）
  // ---------------------------------------------------------------------------

  /**
   * 确保全局学习日设置存在；只写缺失键，避免默认值经 LWW 覆盖用户已有修改。
   * 默认值沿用领域常量（东八区、04:00）。
   */
  ensureLearningDayDefaults(): void {
    if (this.readSyncedString("learning.timezone") === null) {
      this.writeSyncedEntry(
        "learning.timezone",
        DEFAULT_LEARNING_SCHEDULE_SETTINGS.timezoneName,
        true,
      );
    }
    if (this.readSyncedString("learning.dayRolloverTime") === null) {
      this.writeSyncedEntry(
        "learning.dayRolloverTime",
        DEFAULT_LEARNING_SCHEDULE_SETTINGS.dayRolloverTime,
        true,
      );
    }
    if (this.readSyncedValue("learning.schedulerParameters") === null) {
      this.writeSyncedEntry(
        "learning.schedulerParameters",
        DEFAULT_LEARNING_SCHEDULE_SETTINGS.schedulerParameters,
        true,
      );
    }
  }

  /**
   * 确保 Space 级学习设置存在（ensure 语义）；V1 ensure_user_settings 对全部 Space
   * 预置默认行，V2 以"键缺失才写默认值"等价实现。
   */
  ensureSpaceLearningDefaults(spaceId: string): void {
    const defaults = DEFAULT_SPACE_LEARNING_SETTINGS;
    if (this.readSyncedValue(spaceSettingKey(spaceId, "dailyTarget")) === null) {
      this.writeSyncedEntry(spaceSettingKey(spaceId, "dailyTarget"), defaults.dailyTarget, true);
    }
    if (this.readSyncedValue(spaceSettingKey(spaceId, "regularGroupSize")) === null) {
      this.writeSyncedEntry(
        spaceSettingKey(spaceId, "regularGroupSize"),
        defaults.regularGroupSize,
        true,
      );
    }
    if (this.readSyncedValue(spaceSettingKey(spaceId, "fsrsParameters")) === null) {
      this.writeSyncedEntry(spaceSettingKey(spaceId, "fsrsParameters"), {
        desiredRetention: defaults.fsrsParameters.desiredRetention,
        weights: null,
      }, true);
    }
  }

  // ---------------------------------------------------------------------------
  // 内部读写
  // ---------------------------------------------------------------------------

  private readSyncedValue(key: string): unknown {
    for (const entry of this.deps.syncedSettings.getAll()) {
      if (entry.key === key) {
        return entry.value;
      }
    }
    return null;
  }

  private readSyncedString(key: string): string | null {
    const value = this.readSyncedValue(key);
    return typeof value === "string" ? value : null;
  }

  private readSyncedBoolean(key: string, fallback: boolean): boolean {
    const value = this.readSyncedValue(key);
    return typeof value === "boolean" ? value : fallback;
  }

  /** 构造完整 SettingEntry（时钟 + 设备 ID）写入同步通道；键形态先过协议校验。 */
  private writeSyncedEntry(key: string, value: unknown, initialDefault = false): void {
    const parsedKey = settingKeySchema.safeParse(key);
    if (!parsedKey.success) {
      throw new Error(`设置键不满足协议命名规则：${key}`);
    }
    // 单调护栏：时钟读数不晚于本进程上次写入时，向前推 1ms，保证严格递增（见字段注释）。
    const nowMs = this.deps.clock.now().getTime();
    const updatedAtMs = initialDefault
      ? Date.parse(INITIAL_DEFAULT_TIMESTAMP)
      : nowMs > this.lastWrittenAtMs ? nowMs : this.lastWrittenAtMs + 1;
    if (!initialDefault) this.lastWrittenAtMs = updatedAtMs;
    const entry: SettingEntry = {
      key: parsedKey.data,
      value,
      updatedAt: new Date(updatedAtMs).toISOString(),
      deviceId: this.deps.deviceIdentity.getDeviceId(),
    };
    this.deps.syncedSettings.save([entry]);
  }
}
