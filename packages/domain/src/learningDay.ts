/**
 * 学习日计算（需求规格核心概念"学习日" + 复习调度算法第 14 章已确定参数）。
 *
 * 学习日 = 按用户时区与可配置换日时间划分的学习日期，格式 `YYYY-MM-DD`。
 * 换日时间之前的本地时刻归入前一学习日（例如换日时间 04:00 时，本地凌晨 3:00
 * 仍属于前一天）。本模块是纯计算：输入绝对时刻与显式设置，输出确定的学习日；
 * 绝不读取系统当前时间，调用方必须通过 Clock（见 clock.ts）取得"现在"。
 *
 * 时区转换使用 ECMAScript 内建 Intl（Node 与浏览器都可用，不属于 Node 专属模块），
 * 与 V1 的 ZoneInfo 语义一致：先投影为用户时区的本地墙上时间，再与换日时间比较。
 */

/** 学习日标签，`YYYY-MM-DD` 格式的用户时区日历日（不含时区含义）。 */
export type LearningDay = string;

/** 学习日解析所需的两项用户设置（对应 A1 同步键 learning.timezone / learning.dayRolloverTime）。 */
export interface LearningDaySettings {
  /** IANA 时区名称，如 `Asia/Shanghai`。 */
  readonly timezoneName: string;
  /** 换日时间，本地墙上时间 `HH:mm`（24 小时制）。 */
  readonly rolloverTime: string;
}

/** 本地墙上时间的投影结果（学习日计算只关心日期部分与时分）。 */
interface ZonedWallTime {
  year: number;
  /** 1–12。 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * 校验换日时间格式并换算为当日内分钟数。
 *
 * 换日时间是学习日边界的持久化设置，必须在写入前拒绝 `24:00`、`7:5` 这类
 * 非法形态，否则跨设备同步后会出现"同一时刻两台设备算出不同学习日"的分叉。
 */
export function parseRolloverTime(rolloverTime: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(rolloverTime);
  if (match === null) {
    throw new Error(`换日时间必须是 HH:mm 格式的本地墙上时间，收到：${rolloverTime}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 校验学习日标签格式与真实性（拒绝 2026-02-30 这类会被日期算法静默滚动的字面量）。 */
export function isValidLearningDay(value: string): value is LearningDay {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return (
    parsed.getUTCFullYear() === Number(value.slice(0, 4)) &&
    parsed.getUTCMonth() + 1 === Number(value.slice(5, 7)) &&
    parsed.getUTCDate() === Number(value.slice(8, 10))
  );
}

function requireLearningDay(value: string, fieldName: string): LearningDay {
  if (!isValidLearningDay(value)) {
    throw new Error(`${fieldName}必须是真实存在的 YYYY-MM-DD 学习日，收到：${value}`);
  }
  return value;
}

/** 把绝对时刻投影为指定时区的本地墙上时间；时区无效时立即失败，禁止回退本机时区。 */
function zonedWallTime(instant: Date, timezoneName: string): ZonedWallTime {
  if (Number.isNaN(instant.getTime())) {
    throw new Error("学习日解析输入必须是有效的绝对时间");
  }
  let formatter: Intl.DateTimeFormat;
  try {
    // en-CA 仅为稳定取数而选（任意合法 locale 均可），字段值通过 formatToParts 显式读取，
    // 不依赖 locale 的日期书写顺序。
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezoneName,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    // Intl 对未知时区抛 RangeError；与 V1 一致地转成明确的领域错误信息。
    throw new Error(`未知时区：${timezoneName}`);
  }
  const parts = formatter.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type);
    if (part === undefined) {
      throw new Error(`时区投影结果缺少字段 ${type}，无法计算学习日`);
    }
    return Number(part.value);
  };
  const hour = read("hour");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // hourCycle h23 下午夜可能显示为 24（Kotlin/Intl 兼容行为），归一为 0。
    hour: hour === 24 ? 0 : hour,
    minute: read("minute"),
  };
}

/** 以 UTC 语义执行学习日的日历加减；返回仍为 YYYY-MM-DD 标签。 */
export function addLearningDays(day: LearningDay, days: number): LearningDay {
  requireLearningDay(day, "学习日");
  const base = new Date(`${day}T00:00:00Z`);
  const shifted = new Date(base.getTime() + days * 86_400_000);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${dayOfMonth}`;
}

/**
 * 学习日起始绝对时刻：该学习日对应的日历日本地墙上时间到达换日时间的那一刻。
 *
 * 语义与 resolveLearningDay 严格互逆：resolveLearningDay(learningDayStartInstant(D)) === D
 * （换日时刻的 wallMinutes == rolloverMinutes，恰好归入当日）。用途：把"某学习日起才
 * 生效"的规则（如常规模式新条目自录入次日起参与测试，规格 11.7）转换为可与事件
 * occurredAt 直接比较的绝对时刻，避免调用方自建逆投影造成两处时区口径分叉。
 *
 * 实现用两遍法做本地墙上时刻 → UTC 的逆投影（先猜 UTC，再用 Intl 投影差收敛，
 * 两轮足以处理常规 DST 边界；本产品主时区无 DST）。无夏令时参与时精确无误。
 */
export function learningDayStartInstant(day: LearningDay, settings: LearningDaySettings): Date {
  requireLearningDay(day, "学习日");
  const rolloverMinutes = parseRolloverTime(settings.rolloverTime);
  const pad2 = (value: number): string => String(value).padStart(2, "0");
  const hour = Math.floor(rolloverMinutes / 60);
  const minute = rolloverMinutes % 60;
  const targetWallMs = Date.parse(`${day}T${pad2(hour)}:${pad2(minute)}:00Z`);
  if (Number.isNaN(targetWallMs)) {
    throw new Error(`学习日标签无法解析：${day}`);
  }
  let guessMs = targetWallMs;
  for (let pass = 0; pass < 2; pass += 1) {
    const wall = zonedWallTime(new Date(guessMs), settings.timezoneName);
    const wallMs = Date.parse(
      `${String(wall.year).padStart(4, "0")}-${pad2(wall.month)}-${pad2(wall.day)}T${pad2(wall.hour)}:${pad2(wall.minute)}:00Z`,
    );
    guessMs += targetWallMs - wallMs;
  }
  return new Date(guessMs);
}

/** 计算两个学习日之间相差的自然日数（to - from；负值表示 to 更早）。 */
export function daysBetweenLearningDays(from: LearningDay, to: LearningDay): number {
  requireLearningDay(from, "起始学习日");
  requireLearningDay(to, "结束学习日");
  const fromTime = new Date(`${from}T00:00:00Z`).getTime();
  const toTime = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((toTime - fromTime) / 86_400_000);
}

/**
 * 把绝对时刻解析为学习日。
 *
 * 语义与 V1 `ZoneInfoLearningDayResolver.resolve` 完全一致：
 * 1. 先把绝对时刻投影为用户时区的本地墙上时间；
 * 2. 本地时分早于换日时间时归入前一学习日；
 * 3. 时区未知或时刻无效立即报错，绝不静默回退本机默认时区。
 *
 * 注意 V1 会拒绝无时区输入；本函数的输入是 JS Date（自带绝对时刻语义），因此
 * 该校验转化为"必须是有效时刻"。
 */
export function resolveLearningDay(instant: Date, settings: LearningDaySettings): LearningDay {
  const rolloverMinutes = parseRolloverTime(settings.rolloverTime);
  const wall = zonedWallTime(instant, settings.timezoneName);
  const wallMinutes = wall.hour * 60 + wall.minute;
  const month = String(wall.month).padStart(2, "0");
  const day = String(wall.day).padStart(2, "0");
  const localDay = `${wall.year}-${month}-${day}`;
  if (wallMinutes < rolloverMinutes) {
    return addLearningDays(localDay, -1);
  }
  return localDay;
}
