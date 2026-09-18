/**
 * 领域重放排序（docs/V2迁移技术决策.md 第四章 + 判断文件 B3）。
 *
 * ⚠️ serverSeq 仅是同步游标，禁止参与领域排序。离线设备晚上传的旧事件可能获得
 * 更大的 serverSeq；若按 serverSeq 重放，FSRS 状态与任务状态会因上传时序抖动而
 * 分叉。领域重放必须采用独立、确定的排序规则：
 *
 *   occurredAt（解析为绝对时刻的时间序）→ deviceSeq → deviceId 字典序 → eventId 字典序
 *
 * 末级 tie-break 同时用 deviceId 与 eventId，杜绝任何并列可能，保证两台设备对
 * 同一事件集重放得到完全一致的状态（技术决策附录"收敛性"口径）。
 * 服务器与客户端都不允许各自实现本排序，一律使用本模块导出的比较函数。
 *
 * 类型层面：ReplayableEvent 接口只声明四个排序键，不含 serverSeq——排序函数的
 * 签名在编译层面表达"serverSeq 不参与领域排序"；StoredLearningEvent 因结构
 * 兼容可直接传入（多余属性不影响结构子类型），但函数实现与排序语义均不可见
 * serverSeq，未来任何人想在排序中加入 serverSeq 都必须显式修改本接口，绕不开
 * code review。
 */

/** 参与领域重放排序的最小事件字段集（刻意不含 serverSeq，理由见文件头）。 */
export interface ReplayableEvent {
  /** 事件发生时刻（UTC ISO8601 或带数值时区偏移的 ISO8601）。 */
  readonly occurredAt: string;
  /** 设备内单调递增序号。 */
  readonly deviceSeq: number;
  /** 产生事件的设备标识。 */
  readonly deviceId: string;
  /** 事件全局唯一标识。 */
  readonly eventId: string;
}

/**
 * 领域重放排序比较函数。
 *
 * 返回负数表示 a 排在 b 之前，正数表示 a 排在 b 之后，0 表示完全并列（同一事件，
 * 因为四键全等时 eventId 也相等）。
 *
 * occurredAt 比较必须解析为绝对时刻（Date.parse）而非字符串比较：同为 UTC 的
 * `2026-09-19T00:00:00Z` 与 `2026-08-31T16:00:00-08:00` 字符串序与时间序相反，
 * 且 V1 迁移数据带本地时区偏移表示，只有时间戳比较才与时区表示无关。
 * occurredAt 无法解析时直接抛错（fail fast）：协议 schema 已保证可解析，走到
 * 这里说明调用方绕过了协议校验喂入脏数据，属于编程错误，不允许静默归零后产生
 * 不确定排序。
 */
export function compareEvents(a: ReplayableEvent, b: ReplayableEvent): number {
  const timeA = Date.parse(a.occurredAt);
  const timeB = Date.parse(b.occurredAt);
  if (Number.isNaN(timeA) || Number.isNaN(timeB)) {
    throw new Error(
      `occurredAt 无法解析为绝对时刻，禁止参与重放排序：a=${a.occurredAt} b=${b.occurredAt}`,
    );
  }
  if (timeA !== timeB) {
    return timeA < timeB ? -1 : 1;
  }
  if (a.deviceSeq !== b.deviceSeq) {
    return a.deviceSeq < b.deviceSeq ? -1 : 1;
  }
  if (a.deviceId !== b.deviceId) {
    return a.deviceId < b.deviceId ? -1 : 1;
  }
  if (a.eventId !== b.eventId) {
    return a.eventId < b.eventId ? -1 : 1;
  }
  return 0;
}

/**
 * 按领域重放顺序排序事件数组。
 *
 * 返回新数组、不修改入参；使用 Array.prototype.sort（ES2019 起规范保证稳定），
 * 四键全等的重复事件（理论上只可能是同一事件的重复副本）保持原相对顺序。
 * 泛型保留调用方的具体事件类型（如 StoredLearningEvent），重放器无需再做类型收窄。
 */
export function sortEventsForReplay<T extends ReplayableEvent>(events: readonly T[]): T[] {
  return [...events].sort(compareEvents);
}
