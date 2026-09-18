import { z } from "zod";

import {
  isoTimestampSchema,
  learningEventSchema,
  storedLearningEventSchema,
  uuidV4Schema,
  type LearningEvent,
  type StoredLearningEvent,
} from "./events.ts";
import { settingEntrySchema, type SettingEntry } from "./settings.ts";

/**
 * 同步 API 契约（技术决策第五章 + docs/V2首轮自主判断与口径收敛.md B7/D2）。
 *
 * 服务器保持"哑"：只做鉴权、schema 校验、event_id 去重、分配 server_seq、存储、
 * 增量查询、settings LWW 存储、健康检查与备份；本文件只定义请求/响应的 JSON
 * 形态与 TypeScript 类型，不包含任何传输实现（HTTP 细节属 server 与客户端
 * SyncEngine 的职责）。所有 schema 的字段命名与 URL 查询参数名以技术决策与
 * 判断文件原文为准，双端（server 与客户端）必须共用本文件，禁止各自漂移。
 *
 * 错误语义（B7）：
 * - 401 = Bearer 鉴权失败；400 = schema 校验失败（响应体附 Zod 错误摘要）或查询参数非法。
 * - push 中重复 event_id 不报错，逐事件返回 duplicated 回执（幂等成功），
 *   不使用 409/416。
 * - 所有错误响应统一 { error: { code, message } } 形态。
 */

// ---------------------------------------------------------------------------
// POST /sync/push
// ---------------------------------------------------------------------------

/** push 请求：待推送事件数组（信封 + 按类型细化的 metadata，不含 serverSeq）。 */
export const syncPushRequestSchema = z.strictObject({
  events: z.array(learningEventSchema),
});

/** push 请求类型。 */
export type SyncPushRequest = z.output<typeof syncPushRequestSchema>;

/**
 * 单事件回执：eventId 为该事件 ID，serverSeq 是它实际获得的同步游标
 * （重复推送的幂等回执返回首次入库时的原游标）。
 */
export const syncEventReceiptSchema = z.strictObject({
  eventId: uuidV4Schema,
  serverSeq: z.number().int().positive(),
});

/** 单事件回执类型。 */
export type SyncEventReceipt = z.output<typeof syncEventReceiptSchema>;

/**
 * push 响应：服务器逐事件回执。
 * accepted 与 duplicated 两个数组互斥地覆盖请求中的每个事件；客户端依据回执
 * 把 outbox 中对应事件标记为已同步（duplicated 同样视为成功，删除 outbox 行）。
 */
export const syncPushResponseSchema = z.strictObject({
  accepted: z.array(syncEventReceiptSchema),
  duplicated: z.array(syncEventReceiptSchema),
});

/** push 响应类型。 */
export type SyncPushResponse = z.output<typeof syncPushResponseSchema>;

// ---------------------------------------------------------------------------
// GET /sync/pull?after_seq=N&limit=M
// ---------------------------------------------------------------------------

/**
 * pull 查询参数（解析后的对象形态）。
 *
 * 字段名刻意用 URL 查询参数字面名 `after_seq`（技术决策原文口径）而非 camelCase：
 * 服务器直接从 req.query 读取，契约对象与 URL 形态保持一字不差，避免转译层各自
 * 命名漂移。HTTP 传输层收到的是字符串（如 "123"），由 server / 客户端在调用本
 * schema 前完成字符串到数字的解析，本 schema 只校验解析后的数值形态。
 * after_seq 是上次拉取到的最大 serverSeq（从 0 开始表示全量）；limit 缺省时由
 * 服务器自定页大小（服务器可实现自己的上限）。
 */
export const syncPullQuerySchema = z.strictObject({
  after_seq: z.number().int().nonnegative(),
  limit: z.number().int().positive().optional(),
});

/** pull 查询参数类型。 */
export type SyncPullQuery = z.output<typeof syncPullQuerySchema>;

/**
 * pull 响应：按 serverSeq 升序返回的存储事件页。
 * nextCursor 是本页最后一个事件的 serverSeq（空页时等于请求的 after_seq），
 * hasMore 表示是否还有后续页；客户端以 nextCursor 作为下一轮 after_seq 实现断点续传。
 */
export const syncPullResponseSchema = z.strictObject({
  events: z.array(storedLearningEventSchema),
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

/** pull 响应类型。 */
export type SyncPullResponse = z.output<typeof syncPullResponseSchema>;

// ---------------------------------------------------------------------------
// GET /settings、PUT /settings（D2：全量对账，不引入 settings 版本游标）
// ---------------------------------------------------------------------------

/** GET /settings 响应：服务器当前全量 KV 条目。 */
export const settingsGetResponseSchema = z.strictObject({
  settings: z.array(settingEntrySchema),
});

/** GET /settings 响应类型。 */
export type SettingsGetResponse = z.output<typeof settingsGetResponseSchema>;

/** PUT /settings 请求：客户端待合并的批量条目（通常是本地有变更的全量条目）。 */
export const settingsPutRequestSchema = z.strictObject({
  settings: z.array(settingEntrySchema),
});

/** PUT /settings 请求类型。 */
export type SettingsPutRequest = z.output<typeof settingsPutRequestSchema>;

/**
 * PUT /settings 响应：服务器逐键 LWW 合并后的（全量）条目。
 * 返回合并结果而非回执，让客户端直接把本地状态对齐到服务器权威视图。
 */
export const settingsPutResponseSchema = z.strictObject({
  settings: z.array(settingEntrySchema),
});

/** PUT /settings 响应类型。 */
export type SettingsPutResponse = z.output<typeof settingsPutResponseSchema>;

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

/** health 响应：status 恒为 "ok"，now 为服务器当前时刻（仅运维观测用，不参与任何领域语义）。 */
export const healthResponseSchema = z.strictObject({
  status: z.literal("ok"),
  now: isoTimestampSchema,
});

/** health 响应类型。 */
export type HealthResponse = z.output<typeof healthResponseSchema>;

// ---------------------------------------------------------------------------
// 统一错误响应（B7）
// ---------------------------------------------------------------------------

/**
 * 错误响应统一形态：{ error: { code, message } }。
 * code 的精确取值集合（如 UNAUTHORIZED / VALIDATION_FAILED）由 server 实装时
 * 在此常量表基础上定稿；schema 阶段只校验"非空字符串"，避免在 server 落地前
 * 把错误码集合锁死造成二次返工。
 */
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

/** 错误响应类型。 */
export type ErrorResponse = z.output<typeof errorResponseSchema>;

/**
 * 错误码建议常量（B7 三类语义 + 兜底内部错误）。
 * message 面向日志与调试，必须足够定位问题，但不承载用户界面文案职责。
 */
export const errorCodes = {
  /** 401：Bearer 鉴权失败。 */
  unauthorized: "UNAUTHORIZED",
  /** 400：请求体 schema 校验失败。 */
  validationFailed: "VALIDATION_FAILED",
  /** 400：查询参数非法（如 after_seq 非数字/负数）。 */
  invalidQuery: "INVALID_QUERY",
  /** 500：未归类服务器内部错误。 */
  internal: "INTERNAL",
} as const;

/** 错误码类型。 */
export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

// ---------------------------------------------------------------------------
// 便捷类型再导出：客户端 SyncEngine 与 server handler 常以本文件为类型入口，
// 事件与设置的负载类型一并从这里取，避免消费方直接深入 events/settings 内部结构。
// ---------------------------------------------------------------------------

export type { LearningEvent, SettingEntry, StoredLearningEvent };
