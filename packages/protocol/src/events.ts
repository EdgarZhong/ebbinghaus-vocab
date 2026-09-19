import { z } from "zod";

/**
 * 学习事件协议 schema（需求规格 7.2 + docs/V2首轮自主判断与口径收敛.md B4）。
 *
 * 设计总纲：
 * - 事件类型枚举以需求规格 7.2 原文为准，共 18 个枚举值（判断文件 B4 写"15 类"，
 *   但规格 7.2 实际逐条列出 18 个，其中 testSessionPaused/Resumed、
 *   dictionaryFetched/FetchFailed 是成对条目；本包以规格原文为准，勿漏勿增）。
 *   V1 枚举另有 wordManuallyMarkedUnmastered / wordManuallyMarkedMastered 两个
 *   规格 7.2 未收录的事件类型（对应验收场景 10 的双向手动掌握标记），按 B4 口径
 *   暂不纳入本协议，是否扩枚举留待用户晨审定夺。
 * - 同步事件信封 = V1 `learning_events` 既有字段（id→eventId、event_type→eventType、
 *   target_type/target_id、occurred_at→occurredAt、learning_day、source、
 *   metadata_json→metadata）+ 新增 deviceId、deviceSeq（技术决策第四章）。
 *   serverSeq 由服务器分配，只出现在"服务器已存储事件"视图 schema 中，
 *   push 载荷 schema 不含该字段（客户端伪造 serverSeq 直接被拒）。
 * - 严格性取舍：信封字段用 strictObject（未知信封字段直接拒绝——信封字段集合属于
 *   协议版本的一部分，客户端 bug 应该 fail fast 而不是被静默 strip）；每类事件的
 *   metadata 用 looseObject（已知字段校验类型、未知字段 passthrough 保留——宁可宽松
 *   不可过严，保证 V1 历史数据与未来新增 metadata 字段不被协议解析丢掉）。
 * - 本文件同时导出 uuidV4Schema / isoTimestampSchema 两个原子 schema，供
 *   settings.ts、sync.ts 复用（时间与设备标识是全协议统一口径，不允许各文件自定义）。
 */

/** UUIDv4 字符串（eventId、deviceId 的统一形态；zod 4 按 RFC 9562 校验版本位与变体位）。 */
export const uuidV4Schema = z.uuid({ version: "v4" });

/**
 * UTC ISO8601 绝对时间字符串。
 *
 * offset: true 表示同时接受 `Z` 后缀与 `+hh:mm` 数值时区偏移。原因：V2 新产生的
 * 事件统一使用 UTC（`Z`）表示（判断文件 B6：由客户端可注入时钟生成），但 Phase 2
 * 迁移的 V1 历史数据中 occurred_at 是 Python aware datetime 的 isoformat()，带
 * 本机时区偏移（如 `+08:00`）；协议校验若锁死 `Z` 会把合法历史数据拒之门外。
 * 语义约束是"可解析为绝对时刻"，而非"必须以 Z 结尾"；排序比较一律转时间戳。
 */
export const isoTimestampSchema = z.iso.datetime({ offset: true });

/**
 * 学习日，`YYYY-MM-DD` 格式。
 *
 * 除格式正则外还做"真实存在日期"校验（拒绝 2026-02-30 之类会被 JS Date 静默滚动
 * 到下个月的字面量），因为 learningDay 参与换日边界与逾期计算，坏日期会在重放时
 * 污染调度结果。用 UTC 语义解析做 round-trip 校验，学习日本身是"用户时区下的
 * 日历日"标签，不含时区含义。
 */
const learningDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "learningDay 必须是 YYYY-MM-DD 格式的学习日")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return false;
    return (
      parsed.getUTCFullYear() === Number(value.slice(0, 4)) &&
      parsed.getUTCMonth() + 1 === Number(value.slice(5, 7)) &&
      parsed.getUTCDate() === Number(value.slice(8, 10))
    );
  }, "learningDay 必须是真实存在的日历日");

// ---------------------------------------------------------------------------
// 事件类型枚举：需求规格 7.2 全部 18 类，Zod enum 固化，顺序与规格原文一致。
// ---------------------------------------------------------------------------

export const learningEventTypeValues = [
  "firstPassRecorded",
  "reviewOnlyCompleted",
  "testFollowedByReviewCompleted",
  "testAnswered",
  "answerRevised",
  "shortTermPassCountChanged",
  "listSynchronized",
  "longTermValidationCompleted",
  "wordMastered",
  "listMastered",
  "taskDeferred",
  "testSessionPaused",
  "testSessionResumed",
  "dictionaryFetched",
  "dictionaryFetchFailed",
  "wordAdded",
  "wordContentUpdated",
  "wordRemoved",
] as const;

export const learningEventTypeSchema = z.enum(learningEventTypeValues);

/** 学习事件类型（TS 侧字面量联合，与 Zod enum 严格同步）。 */
export type LearningEventType = (typeof learningEventTypeValues)[number];

/**
 * 各事件类型 metadata（即 V1 learning_events.metadata_json 的 JSON 对象形态）。
 *
 * 字段清单逐类从 V1 源码挖取（src/ebbinghaus/application/*.py 中各 LearningEvent
 * 构造点）。同一事件类型在词书模式与常规模式下的 metadata 字段存在差异，已知字段
 * 取两模式并集并全部 optional 化（除两模式共有且恒存在的字段），差异字段的适用
 * 模式在注释中逐条标明。值域封闭的业务枚举（如判断"认识/不认识"）在协议层仅校验
 * 为非空字符串并注释已知值域：协议职责是传输保真与结构校验，值域合法性属于
 * packages/domain 的领域校验职责，避免未来领域扩展（如新增任务类型）破坏协议解析。
 */

/**
 * Word/条目状态快照（testAnswered 系列事件的 beforeState / afterState）。
 *
 * 词书模式字段（V1 review_testing.py `_word_state`）：shortTermPassCount、
 * masteryStatus、t0/t1/t2（短期周期起点，可为 null）。
 * 常规模式字段（V1 regular_learning.py）：dueAt、masteryStatus、nextIntervalDays、
 * feedback（FSRS 卡片口径）。
 * 两模式结构完全不同，故全部字段 optional + looseObject；V1 的 t0/t1/t2 与 dueAt
 * 都是 aware datetime isoformat()，nullable 与 optional 同时放开（null 是"无此
 * 周期起点"的合法历史值）。
 */
export const wordStateSnapshotSchema = z.looseObject({
  /** 短期通过次数（词书模式；0/1/2 封闭值域，值域校验属 domain 层）。 */
  shortTermPassCount: z.number().int().optional(),
  /** 掌握状态（已知值域："未掌握" | "已掌握"）。 */
  masteryStatus: z.string().min(1).optional(),
  /** T0：短期周期起点（词书模式；null 表示尚未进入任何周期）。 */
  t0: isoTimestampSchema.nullable().optional(),
  /** T1：短期通过次数为 1 的起点（词书模式）。 */
  t1: isoTimestampSchema.nullable().optional(),
  /** T2：等待校验起点（词书模式）。 */
  t2: isoTimestampSchema.nullable().optional(),
  /** FSRS 卡片到期时间（常规模式）。 */
  dueAt: isoTimestampSchema.optional(),
  /** 下次复习间隔天数（常规模式，FSRS 输出可为小数）。 */
  nextIntervalDays: z.number().optional(),
  /** 触发状态变化的反馈词（常规模式手动标记路径，如"不认识"）。 */
  feedback: z.string().optional(),
});

/**
 * firstPassRecorded：List/条目 首过录入并确认。
 * 词书模式（V1 first_pass.py，targetType=List）：workload、wordCount、draftId、
 * removedExistingWords、skippedIncomingWords；
 * 常规模式（V1 regular_learning.py，targetType=条目）：workload、
 * removedExistingWords、skippedIncomingWords（无 wordCount/draftId）。
 * 两模式恒有 workload（固定 1：首过计 1 个工作量），其余按模式 optional。
 */
const firstPassRecordedMetadataSchema = z.looseObject({
  workload: z.number().int(),
  /** 本次确认录入的词数（仅词书模式携带）。 */
  wordCount: z.number().int().optional(),
  /** 智能整理草稿标识（仅词书模式携带；常规模式直录无草稿）。 */
  draftId: z.string().optional(),
  /** 因重复录入冲突被用户选择移除的既有词规范键列表。 */
  removedExistingWords: z.array(z.string()).optional(),
  /** 因重复录入冲突被用户选择跳过的新录入词规范键列表。 */
  skippedIncomingWords: z.array(z.string()).optional(),
});

/**
 * reviewOnlyCompleted / testFollowedByReviewCompleted / listSynchronized /
 * listMastered 四类 List 级事件的共用 metadata：V1 review_testing.py 中
 * complete_paper_review 把同一个 metadata 对象复用给完成事件与 List 聚合事件，
 * 故本协议对四类事件共用同一 schema。
 * taskType 已知值域（V1 TaskType 中文枚举）："仅复习" | "短期测试" | "等待校验" |
 * "长期验证"；reviewDemandKeys 是 `wordId|仅复习|scheduledDay` 复合键的排序数组。
 */
const paperReviewCompletedMetadataSchema = z.looseObject({
  taskId: z.string().min(1),
  taskType: z.string().min(1),
  workload: z.number().int(),
  reviewDemandKeys: z.array(z.string()),
});

/**
 * testAnswered / answerRevised / shortTermPassCountChanged /
 * longTermValidationCompleted / wordMastered 五类词级测试事件的共用 metadata：
 * V1 在 confirm_test_answer 中构造同一个 metadata 对象，按派生结果选择性地
 * 追加多个事件（改判、次数变化、长期验证完成、首次掌握都伴随 testAnswered），
 * 五类事件共享完全相同的 metadata 形态。
 * 词书模式字段：sessionId、taskId、plannedTestAt；常规模式字段：sessionId、
 * groupOrdinal、wordId、workload；共有核心：initialJudgement、finalJudgement、
 * answerRevised、beforeState、afterState、algorithmVersion。
 * judgement 已知值域（规格封闭二值）："认识" | "不认识"。
 */
const testAnsweredMetadataSchema = z.looseObject({
  sessionId: z.string().min(1),
  /** 所属计划任务标识（仅词书模式携带）。 */
  taskId: z.string().min(1).optional(),
  /** 常规模式当日测试组序号（仅常规模式携带）。 */
  groupOrdinal: z.number().int().optional(),
  /** 被测条目标识（仅常规模式携带；词书模式从 targetId 即可取得）。 */
  wordId: z.string().min(1).optional(),
  /** 计划测试时间（仅词书模式携带，ISO8601 绝对时间）。 */
  plannedTestAt: isoTimestampSchema.optional(),
  initialJudgement: z.string().min(1),
  finalJudgement: z.string().min(1),
  answerRevised: z.boolean(),
  beforeState: wordStateSnapshotSchema,
  afterState: wordStateSnapshotSchema,
  /** 本次测试计工作量（仅常规模式携带，固定 1）。 */
  workload: z.number().int().optional(),
  algorithmVersion: z.string().min(1),
});

/**
 * testSessionPaused / testSessionResumed 的共用 metadata。
 * 词书模式记 taskId，常规模式记 groupOrdinal（V1 两模式的暂停/恢复路径字段不同）。
 */
const testSessionPauseMetadataSchema = z.looseObject({
  taskId: z.string().min(1).optional(),
  groupOrdinal: z.number().int().optional(),
});

/**
 * dictionaryFetched：成功查询仅记释义条数，不把词典响应复制进事件
 * （V1 口径：词典内容落 dictionary_entries 缓存表，事件只做审计）。
 */
const dictionaryFetchedMetadataSchema = z.looseObject({
  definitionCount: z.number().int(),
});

/** dictionaryFetchFailed：只记失败原因文本（失败不写缓存，事件是唯一审计痕迹）。 */
const dictionaryFetchFailedMetadataSchema = z.looseObject({
  message: z.string().min(1),
});

/**
 * wordAdded：向尚未满足同步条件的既有 List 新增 Word。
 * V1 content_maintenance.py：{ listId, normalizedKey }。
 */
const wordAddedMetadataSchema = z.looseObject({
  listId: z.string().min(1),
  normalizedKey: z.string().min(1),
});

/**
 * wordContentUpdated：修改 Word/条目内容，保持同一对象与学习历史。
 * V1 content_maintenance.py 当前只记 { normalizedKey }。
 * 注意：需求规格 7.2 要求"标题修改事件必须保存修改前后值和二次确认标记"，
 * V1 实现未落地该要求（已列入偏差报告）；本 schema 仅固化 V1 已有字段并
 * passthrough 保留未知字段，待 V2 实现标题编辑时再补 before/after 与确认标记
 * 字段并收紧本 schema。
 */
const wordContentUpdatedMetadataSchema = z.looseObject({
  normalizedKey: z.string().min(1),
});

/**
 * wordRemoved：经两次确认后从 List 移除 Word（软移除，历史保留）。
 * 词书内容维护路径（V1 content_maintenance.py）：{ listId, normalizedKey }；
 * 首过重复录入冲突路径（V1 first_pass.py）：{ listId, normalizedKey, reason }；
 * 常规模式冲突路径（V1 regular_learning.py）：{ spaceId, normalizedKey, reason }。
 * 三路径已知字段取并集：normalizedKey 恒有，listId/spaceId/reason 按路径 optional。
 */
const wordRemovedMetadataSchema = z.looseObject({
  listId: z.string().min(1).optional(),
  spaceId: z.string().min(1).optional(),
  normalizedKey: z.string().min(1),
  reason: z.string().optional(),
});

/**
 * taskDeferred：任务跨学习日未完成。
 * V1 仅在枚举中定义了该事件类型（domain/enums.py），application 层没有任何构造点，
 * 实际 metadata 结构未知——故用完全开放的 record 校验（只要求是 JSON 对象），
 * 待 M3/M4 移植任务延期逻辑时挖清字段后收紧。
 */
const taskDeferredMetadataSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// 事件信封与按类型联动的完整事件 schema。
// ---------------------------------------------------------------------------

/** 单类事件 object schema 的工厂：信封字段全协议一致，仅 eventType 与 metadata 按类型变化。 */
function defineEventSchema(eventType: LearningEventType, metadataSchema: z.ZodType) {
  // 刻意不写返回类型标注：若标注为裸 `z.ZodObject`（无泛型参数），所有派生 schema
  // 的输出类型会整体退化为索引签名记录，调用方属性访问全部变 unknown（M2/M3 两个
  // 实现分支独立踩中同一问题）；让 TS 从 z.strictObject 字面量精确推断即可。
  return z.strictObject({
    eventId: uuidV4Schema,
    eventType: z.literal(eventType),
    /** 目标类型。V1 实际取值（开集，不 enum 收紧）："Word" | "List" | "TestSession" | "条目"。 */
    targetType: z.string().min(1),
    /** 目标标识：targetType 对应实体（Word/List/TestSession）的 ID。 */
    targetId: z.string().min(1),
    /** 事件真实发生时刻（可注入客户端时钟生成，UTC ISO8601；语义见 isoTimestampSchema）。 */
    occurredAt: isoTimestampSchema,
    /** 事件发生时按用户时区与换日边界计算的学习日标签。 */
    learningDay: learningDaySchema,
    /** 事件来源的稳定人类可读描述（如"首过预览保存"；词典事件记提供方名）。 */
    source: z.string().min(1),
    /** 产生事件的设备标识（UUIDv4，设备首次启动生成并持久化，判断文件 B5）。 */
    deviceId: uuidV4Schema,
    /** 设备内单调递增序号（从 1 起），仅用于同设备内事件排序与去重兜底。 */
    deviceSeq: z.number().int().positive(),
    metadata: metadataSchema,
  });
}

/**
 * push 载荷单事件 schema：按 eventType 判别的联合，一次性校验信封 + 该类型 metadata。
 *
 * 刻意用 z.union 而非 z.discriminatedUnion：discriminatedUnion 的 TS 泛型要求成员
 * 以元组形式传入，此处成员经由工厂函数生成后再 .map() 构造存储视图，tuple 退化
 * 会让联合输出类型退化为 unknown，丢失全部类型推导（校验行为不变）；z.union 对
 * 数组成员的类型推导稳定，输出为 18 类事件输出类型的精确联合。代价是解析错误
 * 信息不按 eventType 分派（逐成员尝试），对双端排障足够。
 */
export const learningEventSchema = z.union([
  defineEventSchema("firstPassRecorded", firstPassRecordedMetadataSchema),
  defineEventSchema("reviewOnlyCompleted", paperReviewCompletedMetadataSchema),
  defineEventSchema(
    "testFollowedByReviewCompleted",
    paperReviewCompletedMetadataSchema,
  ),
  defineEventSchema("testAnswered", testAnsweredMetadataSchema),
  defineEventSchema("answerRevised", testAnsweredMetadataSchema),
  defineEventSchema(
    "shortTermPassCountChanged",
    testAnsweredMetadataSchema,
  ),
  defineEventSchema("listSynchronized", paperReviewCompletedMetadataSchema),
  defineEventSchema(
    "longTermValidationCompleted",
    testAnsweredMetadataSchema,
  ),
  defineEventSchema("wordMastered", testAnsweredMetadataSchema),
  defineEventSchema("listMastered", paperReviewCompletedMetadataSchema),
  defineEventSchema("taskDeferred", taskDeferredMetadataSchema),
  defineEventSchema("testSessionPaused", testSessionPauseMetadataSchema),
  defineEventSchema("testSessionResumed", testSessionPauseMetadataSchema),
  defineEventSchema("dictionaryFetched", dictionaryFetchedMetadataSchema),
  defineEventSchema(
    "dictionaryFetchFailed",
    dictionaryFetchFailedMetadataSchema,
  ),
  defineEventSchema("wordAdded", wordAddedMetadataSchema),
  defineEventSchema("wordContentUpdated", wordContentUpdatedMetadataSchema),
  defineEventSchema("wordRemoved", wordRemovedMetadataSchema),
]);

/** push 载荷单事件类型（不含 serverSeq——serverSeq 由服务器分配，客户端不发送）。 */
export type LearningEvent = z.output<typeof learningEventSchema>;

/**
 * "服务器已存储事件"视图：push 载荷 + serverSeq。
 * serverSeq 是服务器单事务内分配的严格单调同步游标，仅用于增量拉取与去重回执，
 * 绝不参与领域重放排序（见 ordering.ts 顶部说明）。
 */
export const storedLearningEventSchema = z.union([
  defineEventSchema("firstPassRecorded", firstPassRecordedMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("reviewOnlyCompleted", paperReviewCompletedMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("testFollowedByReviewCompleted", paperReviewCompletedMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("testAnswered", testAnsweredMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("answerRevised", testAnsweredMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("shortTermPassCountChanged", testAnsweredMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("listSynchronized", paperReviewCompletedMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("longTermValidationCompleted", testAnsweredMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("wordMastered", testAnsweredMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("listMastered", paperReviewCompletedMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("taskDeferred", taskDeferredMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("testSessionPaused", testSessionPauseMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("testSessionResumed", testSessionPauseMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("dictionaryFetched", dictionaryFetchedMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("dictionaryFetchFailed", dictionaryFetchFailedMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("wordAdded", wordAddedMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("wordContentUpdated", wordContentUpdatedMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
  defineEventSchema("wordRemoved", wordRemovedMetadataSchema).extend({
    serverSeq: z.number().int().positive(),
  }),
]);

/** 服务器已存储事件类型（含 serverSeq）。 */
export type StoredLearningEvent = z.output<typeof storedLearningEventSchema>;

/**
 * 信封公共字段视图（metadata 放宽为 unknown，字段集 strip 而非 strict）。
 * 仅供只需要读取信封字段、不关心 metadata 结构的场景使用（如 outbox 统计、
 * 服务器通用字段透传）；传输契约一律用 learningEventSchema / storedLearningEventSchema。
 */
export const eventEnvelopeSchema = z.object({
  eventId: uuidV4Schema,
  eventType: learningEventTypeSchema,
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  occurredAt: isoTimestampSchema,
  learningDay: learningDaySchema,
  source: z.string().min(1),
  deviceId: uuidV4Schema,
  deviceSeq: z.number().int().positive(),
  metadata: z.unknown(),
});

/** 信封公共字段类型（不含按类型细化的 metadata）。 */
export type LearningEventEnvelope = z.output<typeof eventEnvelopeSchema>;
