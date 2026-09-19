/**
 * 学习调度设置的领域类型、默认值与校验（判断文件 A1 的同步键口径）。
 *
 * 本模块只定义类型、校验与默认值，不做持久化。设置经 LWW 同步后的权威数据在
 * 云端（服务器库），客户端落库与 KV 通道见 packages/protocol 的 settings schema
 * （键名 `learning.timezone` / `learning.dayRolloverTime` / `learning.schedulerParameters`
 * 与 `space.<spaceId>.dailyTarget|regularGroupSize|fsrsParameters`）。
 *
 * 值域依据：
 * - 时区必须是可解析的 IANA 名称（由调用方以最小解析验证，见 learningDay.ts）；
 * - 换日时间为本地墙上时间 `HH:mm`；
 * - 常规模式目标保持率默认 0.95，取值 0.80–0.99（复习调度算法 11.2），仅常规模式生效；
 * - 常规模式每组条目数默认 20 且必须为正整数（需求规格 6.8）；
 * - 每日目标工作量按 Space 独立保存，非负整数。
 */

import { DEFAULT_REGULAR_DESIRED_RETENTION, DEFAULT_REGULAR_GROUP_SIZE } from "./fsrsRegular.ts";
import { parseRolloverTime } from "./learningDay.ts";

/** 全局学习调度设置（A1 第 1–3 项同步键的领域形态）。 */
export interface LearningScheduleSettings {
  /** IANA 时区名称，学习日边界计算输入。 */
  readonly timezoneName: string;
  /** 换日时间，`HH:mm` 本地墙上时间。 */
  readonly dayRolloverTime: string;
  /** 全局调度参数 JSON（含目标保持率等）；结构开放，算法升级只增不删。 */
  readonly schedulerParameters: Readonly<Record<string, unknown>>;
}

/** Space 级 FSRS 参数（A1 第 10 项同步键的领域形态）。 */
export interface FsrsParameterSettings {
  /** 常规模式目标记忆保持率；默认 0.95，取值 0.80–0.99，仅常规模式生效。 */
  readonly desiredRetention: number;
  /** FSRS 权重向量（17–22 项）；缺省使用 ts-fsrs 内置默认权重。 */
  readonly weights: readonly number[] | null;
}

/** Space 级学习设置（A1 第 8–10 项同步键的领域形态）。 */
export interface SpaceLearningSettings {
  /** 每日目标工作量（词书模式按"份学习"、常规模式按"条目"计量）。 */
  readonly dailyTarget: number;
  /** 常规模式测试组切分大小（每组条目数）。 */
  readonly regularGroupSize: number;
  readonly fsrsParameters: FsrsParameterSettings;
}

/** 全局学习调度设置默认值：东八区、04:00 换日、空调度参数。 */
export const DEFAULT_LEARNING_SCHEDULE_SETTINGS: LearningScheduleSettings = {
  timezoneName: "Asia/Shanghai",
  dayRolloverTime: "04:00",
  schedulerParameters: {},
};

/** Space 级学习设置默认值：目标 0、每组 20、保持率 0.95 + 库默认权重。 */
export const DEFAULT_SPACE_LEARNING_SETTINGS: SpaceLearningSettings = {
  dailyTarget: 0,
  regularGroupSize: DEFAULT_REGULAR_GROUP_SIZE,
  fsrsParameters: {
    desiredRetention: DEFAULT_REGULAR_DESIRED_RETENTION,
    weights: null,
  },
};

/** 校验并归一全局学习调度设置；unknown 输入直接拒绝，不做任何猜测式修正。 */
export function validateLearningScheduleSettings(raw: unknown): LearningScheduleSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("学习调度设置必须是 JSON 对象");
  }
  const input = raw as Record<string, unknown>;
  const timezoneName = input["timezoneName"];
  if (typeof timezoneName !== "string" || timezoneName.trim().length === 0) {
    throw new Error("学习调度设置的 timezoneName 必须是非空字符串");
  }
  const dayRolloverTime = input["dayRolloverTime"];
  if (typeof dayRolloverTime !== "string") {
    throw new Error("学习调度设置的 dayRolloverTime 必须是 HH:mm 格式字符串");
  }
  // 换日时间合法性由学习日模块统一校验（同一边界口径，禁止两处实现分叉）。
  parseRolloverTime(dayRolloverTime);
  const schedulerParameters = input["schedulerParameters"] ?? {};
  if (
    typeof schedulerParameters !== "object" ||
    schedulerParameters === null ||
    Array.isArray(schedulerParameters)
  ) {
    throw new Error("学习调度设置的 schedulerParameters 必须是 JSON 对象");
  }
  return {
    timezoneName,
    dayRolloverTime,
    schedulerParameters: schedulerParameters as Readonly<Record<string, unknown>>,
  };
}

/** 校验并归一 Space 级 FSRS 参数。 */
export function validateFsrsParameterSettings(raw: unknown): FsrsParameterSettings {
  if (raw === null || raw === undefined) {
    return { ...DEFAULT_SPACE_LEARNING_SETTINGS.fsrsParameters };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FSRS 参数必须是 JSON 对象");
  }
  const input = raw as Record<string, unknown>;
  const desiredRetention = input["desiredRetention"];
  if (typeof desiredRetention !== "number" || !Number.isFinite(desiredRetention)) {
    throw new Error("FSRS 参数的 desiredRetention 必须是 0.80 至 0.99 之间的数值");
  }
  if (desiredRetention < 0.8 || desiredRetention > 0.99) {
    throw new Error(`FSRS 参数的 desiredRetention 必须位于 0.80 至 0.99 之间，收到：${desiredRetention}`);
  }
  const weights = input["weights"];
  if (weights === null || weights === undefined) {
    return { desiredRetention, weights: null };
  }
  if (!Array.isArray(weights) || weights.some((weight) => typeof weight !== "number")) {
    throw new Error("FSRS 参数的 weights 必须是数值数组或 null");
  }
  return { desiredRetention, weights: [...weights] };
}

/** 校验并归一 Space 级学习设置。 */
export function validateSpaceLearningSettings(raw: unknown): SpaceLearningSettings {
  if (raw === null || raw === undefined) {
    return { ...DEFAULT_SPACE_LEARNING_SETTINGS };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Space 级学习设置必须是 JSON 对象");
  }
  const input = raw as Record<string, unknown>;
  const dailyTarget = input["dailyTarget"] ?? DEFAULT_SPACE_LEARNING_SETTINGS.dailyTarget;
  if (typeof dailyTarget !== "number" || !Number.isInteger(dailyTarget) || dailyTarget < 0) {
    throw new Error("Space 级学习的 dailyTarget 必须是不小于 0 的整数");
  }
  const regularGroupSize =
    input["regularGroupSize"] ?? DEFAULT_SPACE_LEARNING_SETTINGS.regularGroupSize;
  if (
    typeof regularGroupSize !== "number" ||
    !Number.isInteger(regularGroupSize) ||
    regularGroupSize <= 0
  ) {
    throw new Error("Space 级学习的 regularGroupSize 必须是正整数");
  }
  return {
    dailyTarget,
    regularGroupSize,
    // 缺省键直接传 undefined，由 validateFsrsParameterSettings 回退领域默认值；
    // 刻意不用 `?? {}`：空对象是"显式但缺字段"的非法输入，必须报错而不是静默补默认。
    fsrsParameters: validateFsrsParameterSettings(input["fsrsParameters"]),
  };
}
