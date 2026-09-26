import { z } from "zod";

import { isoTimestampSchema, uuidV4Schema } from "./events.ts";

/**
 * 内容目录独立于不可变学习事件：Space、Unit、List 与 Word 的身份和用户编辑
 * 必须随云端副本收敛，不能从事件 metadata 猜测。每个实体以类型和标识定位，
 * 更新与删除均保留版本；服务器仅按统一版本顺序保存最新 JSON，不执行词书规则。
 */
const entityIdSchema = z.string().min(1);
const contentVersionShape = {
  updatedAt: isoTimestampSchema,
  deviceId: uuidV4Schema,
};

export const spaceContentSchema = z.strictObject({
  id: entityIdSchema,
  kind: z.enum(["必考词", "常考词", "偶考词"]).nullable(),
  displayOrder: z.number().int().positive(),
  name: z.string().nullable(),
  archivedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema.nullable(),
  updatedAt: isoTimestampSchema.nullable(),
  learningMode: z.enum(["词书模式", "常规模式"]),
});

export const unitContentSchema = z.strictObject({
  id: entityIdSchema,
  spaceId: entityIdSchema,
  number: z.number().int().positive(),
});

export const listContentSchema = z.strictObject({
  listId: entityIdSchema,
  spaceId: entityIdSchema,
  unitId: entityIdSchema,
  unitNumber: z.number().int().positive(),
  listNumber: z.number().int().positive(),
});

export const wordContentSchema = z.strictObject({
  wordId: entityIdSchema,
  listId: entityIdSchema.nullable(),
  spaceId: entityIdSchema.nullable(),
  originalSpelling: z.string().min(1),
  normalizedKey: z.string().min(1),
  manualMeaning: z.string(),
  meanings: z.array(z.strictObject({
    partOfSpeech: z.string().nullable(),
    definition: z.string(),
    usage: z.string().nullable(),
  })),
  removed: z.boolean(),
  recordedAt: isoTimestampSchema,
});

/** 首过草稿的原文与候选为敏感学习数据；完整负载仅在已鉴权内容通道传输。 */
export const firstPassDraftContentSchema = z.strictObject({
  id: entityIdSchema,
  spaceId: entityIdSchema,
  unitNumber: z.number().int().positive(),
  listNumber: z.number().int().positive(),
  rawText: z.string(),
  useLanguageModel: z.boolean(),
  status: z.enum(["草稿", "已解析", "解析失败", "已确认"]),
  lastError: z.string().nullable(),
  candidatesJson: z.string().nullable(),
  auditJson: z.string().nullable(),
  unresolvedDescription: z.string().nullable(),
  updatedAt: isoTimestampSchema,
  deviceId: uuidV4Schema,
});

export const contentEntityTypeSchema = z.enum(["space", "unit", "list", "word", "draft"]);
export type ContentEntityType = z.output<typeof contentEntityTypeSchema>;

/**
 * 删除墓碑只要求实体身份和版本，不能携带旧内容。Space 真删除用墓碑；Word
 * 的业务软移除仍保留完整内容，写成 removed=true 的新 Word 版本。
 */
export const contentEntrySchema = z.discriminatedUnion("entityType", [
  z.strictObject({ entityType: z.literal("space"), entityId: entityIdSchema, value: spaceContentSchema.nullable(), deleted: z.boolean(), ...contentVersionShape }),
  z.strictObject({ entityType: z.literal("unit"), entityId: entityIdSchema, value: unitContentSchema.nullable(), deleted: z.boolean(), ...contentVersionShape }),
  z.strictObject({ entityType: z.literal("list"), entityId: entityIdSchema, value: listContentSchema.nullable(), deleted: z.boolean(), ...contentVersionShape }),
  z.strictObject({ entityType: z.literal("word"), entityId: entityIdSchema, value: wordContentSchema.nullable(), deleted: z.boolean(), ...contentVersionShape }),
  z.strictObject({ entityType: z.literal("draft"), entityId: entityIdSchema, value: firstPassDraftContentSchema.nullable(), deleted: z.boolean(), ...contentVersionShape }),
]).superRefine((entry, context) => {
  if (entry.deleted !== (entry.value === null)) {
    context.addIssue({ code: "custom", message: "内容删除标记必须与空载荷一致" });
  }
  const valueId = entry.value === null ? null :
    entry.entityType === "space" || entry.entityType === "unit" ? entry.value.id :
    entry.entityType === "list" ? entry.value.listId :
    entry.entityType === "word" ? entry.value.wordId : entry.value.id;
  if (valueId !== null && valueId !== entry.entityId) {
    context.addIssue({ code: "custom", message: "实体标识与内容载荷标识不一致" });
  }
});

export type ContentEntry = z.output<typeof contentEntrySchema>;
export const storedContentEntrySchema = z.object({
  serverSeq: z.number().int().positive(),
}).passthrough().transform((stored, context) => {
  const { serverSeq, ...entry } = stored;
  const parsed = contentEntrySchema.safeParse(entry);
  if (!parsed.success) {
    context.addIssue({ code: "custom", message: "服务端内容记录未通过共享协议校验" });
    return z.NEVER;
  }
  return { ...parsed.data, serverSeq };
});
export type StoredContentEntry = z.output<typeof storedContentEntrySchema>;

/** 时间相等时设备标识决胜；同设备同毫秒则墓碑优先，再比较规范化 JSON。 */
export function isContentEntryNewer(candidate: ContentEntry, incumbent: ContentEntry): boolean {
  const candidateAt = Date.parse(candidate.updatedAt);
  const incumbentAt = Date.parse(incumbent.updatedAt);
  if (candidateAt !== incumbentAt) return candidateAt > incumbentAt;
  if (candidate.deviceId !== incumbent.deviceId) return candidate.deviceId > incumbent.deviceId;
  if (candidate.deleted !== incumbent.deleted) return candidate.deleted;
  return canonicalJson(candidate.value) > canonicalJson(incumbent.value);
}

/** 对象键排序防止相同 JSON 内容因插入键顺序不同而产生不确定冲突结果。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const contentPutRequestSchema = z.strictObject({ contents: z.array(contentEntrySchema) });
/** PUT 回传请求各实体最终权威值，客户端可立刻收敛被远端覆盖的旧写入。 */
export const contentPutResponseSchema = z.strictObject({ contents: z.array(storedContentEntrySchema) });
export const contentPullQuerySchema = z.strictObject({ after_seq: z.number().int().nonnegative(), limit: z.number().int().positive().optional() });
export const contentPullResponseSchema = z.strictObject({
  contents: z.array(storedContentEntrySchema),
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
