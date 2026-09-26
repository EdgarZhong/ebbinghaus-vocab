/**
 * V1 一致快照到 V2 共享协议的纯读取映射。
 *
 * V1 旧事件缺 deviceId/deviceSeq，迁移只补协议必需的信封字段；事件 ID、类型、
 * 目标、发生时间、学习日、来源、metadata 保留原值，不“顺手纠错”。V1 的默认
 * Space ID 是非 UUID 字符串，而 V2 Space 设置键只接受 UUIDv4：仅 Space 主键
 * 与所有引用它的目录外键使用确定性映射，并保留旧→新映射供切换审计。
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { ApplicationEvent, FirstPassDraftRecord, ListCatalogRecord, WordContentRecord } from "@ebbinghaus/application";
import {
  DEFAULT_SPACE_DEFINITIONS,
} from "@ebbinghaus/application";
import {
  DEFAULT_SPACE_LEARNING_SETTINGS,
  formatStructuredMeanings,
  type PartOfSpeech,
  type Space,
  type StudyUnit,
  type StructuredMeaning,
} from "@ebbinghaus/domain";
import {
  knownSettingKeys,
  learningEventSchema,
  settingEntrySchema,
  spaceSettingKey,
  uuidV4Schema,
  type SettingEntry,
} from "@ebbinghaus/protocol";

/** 给 V1 不带设备标识的事件分配固定迁移设备；固定值只标识迁移来源，不代表真实机器。 */
export const V1_MIGRATION_DEVICE_ID = "0017a1d1-7e6b-4e4f-8bd3-d00579630901";
/** V1 与 V2 首启固定 Space 必须共用身份；否则导入后启动会再补建四个空 Space。 */
const V1_DEFAULT_SPACE_IDS = ["space-required", "space-common", "space-occasional", "space-daily"] as const;
const DEFAULT_SPACE_ID_MAP = new Map<string, string | undefined>(V1_DEFAULT_SPACE_IDS.map((legacyId, index) => [
  legacyId,
  DEFAULT_SPACE_DEFINITIONS[index]?.id,
]));
/** V1 全局设置无更新时间；用固定基准时刻表达“迁移初始值”，重试不会覆盖 V2 后续更新。 */
const LEGACY_SETTINGS_EPOCH = "1970-01-01T00:00:00.000Z";

/** V1 SQLite TIME 序列化会补零秒；V2 设置协议只接受 HH:mm，非零秒不得截断。 */
function normalizeLearningDayRolloverTime(value: string): string {
  const match = /^(\d{2}:\d{2})(?::(\d{2}))?$/.exec(value);
  if (match === null || (match[2] !== undefined && match[2] !== "00")) {
    throw new Error("V1 换日时间无法等价转换为 V2 的 HH:mm 格式");
  }
  return match[1] ?? value;
}

interface V1SpaceRow {
  id: string; kind: Space["kind"]; name: string; learning_mode: Space["learningMode"];
  display_order: number; archived_at: string | null; created_at: string; updated_at: string;
}
interface V1UnitRow { id: string; space_id: string; number: number }
interface V1ListRow { id: string; unit_id: string; number: number }
interface V1WordRow {
  id: string; space_id: string; list_id: string | null; original_spelling: string;
  normalized_key: string; manual_meaning: string; is_removed: number; updated_at: string;
}
interface V1MeaningRow {
  word_id: string; part_of_speech: PartOfSpeech | null; definition: string;
  usage: string | null; display_order: number;
}
interface V1EventRow {
  legacy_order: number; id: string; event_type: string; target_type: string;
  target_id: string; occurred_at: string; learning_day: string; source: string;
  metadata_json: string;
}
interface V1UserSettingsRow {
  timezone_name: string; learning_day_rollover_time: string;
  scheduler_parameters_json: string; dictionary_provider: string;
  active_space_id: string | null; smart_organizing_enabled: number;
  online_dictionary_enabled: number;
}
interface V1SpaceSettingsRow {
  space_id: string; daily_target: number; regular_group_size: number;
  fsrs_parameters_json: string; updated_at: string;
}
interface V1DraftRow {
  id: string; space_id: string; unit_number: number; list_number: number;
  raw_text: string; use_language_model: number; status: FirstPassDraftRecord["status"];
  last_error: string | null; candidates_json: string; audit_json: string;
  unresolved_description: string; updated_at: string;
}

export interface V1ConvertedSnapshot {
  readonly legacySpaceIdMap: Readonly<Record<string, string>>;
  readonly spaces: readonly Space[];
  readonly units: readonly StudyUnit[];
  readonly lists: readonly ListCatalogRecord[];
  readonly words: readonly WordContentRecord[];
  readonly drafts: readonly FirstPassDraftRecord[];
  readonly events: readonly ApplicationEvent[];
  readonly settings: readonly SettingEntry[];
  /** 活动 Space 是设备本地视图状态，不进入云端 settings。 */
  readonly activeSpaceId: string | null;
  /** V1 已录入手录摘要与结构化义项格式不一致的数量；原文仍保持原值。 */
  readonly meaningFormatMismatchCount: number;
}

/** 将任意 V1 Space ID 稳定映射到 UUIDv4 形态，避免迁移重跑生成不同身份。 */
export function mapLegacySpaceId(legacyId: string): string {
  const defaultId = DEFAULT_SPACE_ID_MAP.get(legacyId);
  if (defaultId !== undefined) return defaultId;
  if (uuidV4Schema.safeParse(legacyId).success) return legacyId;
  const bytes = createHash("sha256").update(`ebbinghaus-v1-space:${legacyId}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 只读快照转换；所有 SQL 表名和列名固定，绝不拼接用户输入。 */
export function convertV1Connection(db: Database.Database): V1ConvertedSnapshot {
  const oldSpaces = db.prepare("SELECT * FROM spaces ORDER BY display_order").all() as V1SpaceRow[];
  const legacySpaceIdMap: Record<string, string> = {};
  for (const space of oldSpaces) legacySpaceIdMap[space.id] = mapLegacySpaceId(space.id);
  const remapSpace = (legacyId: string): string => {
    const mapped = legacySpaceIdMap[legacyId];
    if (mapped === undefined) throw new Error(`V1 数据引用不存在的 Space：${legacyId}`);
    return mapped;
  };

  const spaces: Space[] = oldSpaces.map((row) => ({
    id: remapSpace(row.id), kind: row.kind, name: row.name,
    learningMode: row.learning_mode, displayOrder: row.display_order,
    archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  const oldUnits = db.prepare("SELECT id, space_id, number FROM units ORDER BY rowid").all() as V1UnitRow[];
  const units: StudyUnit[] = oldUnits.map((row) => ({ id: row.id, spaceId: remapSpace(row.space_id), number: row.number }));
  const unitSpace = new Map(units.map((unit) => [unit.id, unit.spaceId]));
  const unitNumber = new Map(units.map((unit) => [unit.id, unit.number]));
  const oldLists = db.prepare("SELECT id, unit_id, number FROM word_lists ORDER BY rowid").all() as V1ListRow[];
  const lists: ListCatalogRecord[] = oldLists.map((row) => {
    const spaceId = unitSpace.get(row.unit_id);
    const number = unitNumber.get(row.unit_id);
    if (spaceId === undefined || number === undefined) throw new Error(`V1 List ${row.id} 缺少 Unit`);
    return { listId: row.id, spaceId, unitId: row.unit_id, unitNumber: number, listNumber: row.number };
  });

  const oldMeanings = db.prepare(`
    SELECT word_id, part_of_speech, definition, usage, display_order
    FROM word_meanings WHERE is_removed = 0 ORDER BY word_id, display_order
  `).all() as V1MeaningRow[];
  const meaningsByWord = new Map<string, StructuredMeaning[]>();
  for (const row of oldMeanings) {
    const meanings = meaningsByWord.get(row.word_id) ?? [];
    meanings.push({ partOfSpeech: row.part_of_speech, definition: row.definition, usage: row.usage });
    meaningsByWord.set(row.word_id, meanings);
  }
  const oldWords = db.prepare(`
    SELECT id, space_id, list_id, original_spelling, normalized_key,
           manual_meaning, is_removed, updated_at FROM words ORDER BY rowid
  `).all() as V1WordRow[];
  const words: WordContentRecord[] = oldWords.map((row) => ({
    wordId: row.id, listId: row.list_id,
    spaceId: row.list_id === null ? remapSpace(row.space_id) : null,
    originalSpelling: row.original_spelling, normalizedKey: row.normalized_key,
    manualMeaning: row.manual_meaning, meanings: meaningsByWord.get(row.id) ?? [],
    removed: row.is_removed === 1, recordedAt: row.updated_at,
  }));

  // 草稿原文、候选和证据树必须逐字段保留；V1 没有 deviceId，使用迁移来源
  // 的固定标识参与日后跨设备版本比较。已确认草稿亦保留为完成墓碑。
  const oldDrafts = db.prepare("SELECT * FROM first_pass_drafts ORDER BY rowid").all() as V1DraftRow[];
  const drafts: FirstPassDraftRecord[] = oldDrafts.map((row) => ({
    id: row.id, spaceId: remapSpace(row.space_id), unitNumber: row.unit_number,
    listNumber: row.list_number, rawText: row.raw_text,
    useLanguageModel: row.use_language_model === 1, status: row.status,
    lastError: row.last_error, candidatesJson: row.candidates_json,
    auditJson: row.audit_json, unresolvedDescription: row.unresolved_description,
    updatedAt: row.updated_at, deviceId: V1_MIGRATION_DEVICE_ID,
  }));

  const oldEvents = db.prepare(`
    SELECT rowid AS legacy_order, id, event_type, target_type, target_id,
           occurred_at, learning_day, source, metadata_json
    FROM learning_events ORDER BY rowid
  `).all() as V1EventRow[];
  const events: ApplicationEvent[] = oldEvents.map((row) => {
    let metadata: unknown;
    try { metadata = JSON.parse(row.metadata_json); }
    catch { throw new Error(`V1 事件 ${row.id} 的元数据不是合法 JSON`); }
    const candidate = {
      eventId: row.id, eventType: row.event_type, targetType: row.target_type,
      targetId: row.target_id, occurredAt: row.occurred_at,
      learningDay: row.learning_day, source: row.source,
      deviceId: V1_MIGRATION_DEVICE_ID, deviceSeq: row.legacy_order, metadata,
    };
    if (!learningEventSchema.safeParse(candidate).success) {
      // 不打印 schema 错误中的可能敏感值，按事件 ID 定位后由离线审计处理。
      throw new Error(`V1 事件 ${row.id}（${row.event_type}）未通过 V2 协议校验`);
    }
    return candidate as ApplicationEvent;
  });

  const oldUserSettings = db.prepare("SELECT * FROM user_settings WHERE id = 1").get() as V1UserSettingsRow | undefined;
  if (oldUserSettings === undefined) throw new Error("V1 全局设置记录缺失");
  const makeSetting = (key: string, value: unknown, updatedAt = LEGACY_SETTINGS_EPOCH): SettingEntry =>
    settingEntrySchema.parse({ key, value, updatedAt, deviceId: V1_MIGRATION_DEVICE_ID });
  const settings: SettingEntry[] = [
    makeSetting(knownSettingKeys.learningTimezone, oldUserSettings.timezone_name),
    makeSetting(knownSettingKeys.learningDayRolloverTime,
      normalizeLearningDayRolloverTime(oldUserSettings.learning_day_rollover_time)),
    makeSetting(knownSettingKeys.learningSchedulerParameters, JSON.parse(oldUserSettings.scheduler_parameters_json)),
    makeSetting(knownSettingKeys.dictionaryProvider, oldUserSettings.dictionary_provider),
    makeSetting(knownSettingKeys.featuresSmartOrganizing, oldUserSettings.smart_organizing_enabled === 1),
    makeSetting(knownSettingKeys.featuresOnlineDictionary, oldUserSettings.online_dictionary_enabled === 1),
  ];
  const oldSpaceSettings = db.prepare("SELECT * FROM space_learning_settings ORDER BY space_id").all() as V1SpaceSettingsRow[];
  for (const row of oldSpaceSettings) {
    const spaceId = remapSpace(row.space_id);
    const rawFsrs = JSON.parse(row.fsrs_parameters_json) as Record<string, unknown>;
    const fsrsParameters = Object.keys(rawFsrs).length === 0
      ? DEFAULT_SPACE_LEARNING_SETTINGS.fsrsParameters : rawFsrs;
    settings.push(makeSetting(spaceSettingKey(spaceId, "dailyTarget"), row.daily_target, row.updated_at));
    settings.push(makeSetting(spaceSettingKey(spaceId, "regularGroupSize"), row.regular_group_size, row.updated_at));
    settings.push(makeSetting(spaceSettingKey(spaceId, "fsrsParameters"), fsrsParameters, row.updated_at));
  }
  const activeSpaceId = oldUserSettings.active_space_id === null
    ? null : remapSpace(oldUserSettings.active_space_id);

  // 旧库格式差异只报告不改写；后续 V2 编辑仍会按 V2 规范保存新版本。
  let meaningFormatMismatchCount = 0;
  for (const word of words) {
    if (word.meanings.length > 0 && word.manualMeaning !== formatStructuredMeanings(word.meanings)) {
      meaningFormatMismatchCount += 1;
    }
  }

  return { legacySpaceIdMap, spaces, units, lists, words, drafts, events, settings,
    activeSpaceId, meaningFormatMismatchCount };
}

/** 正式入口只允许打开已生成的在线备份，禁止把源库当可写连接。 */
export function convertV1Backup(backupPath: string): V1ConvertedSnapshot {
  const db = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    return convertV1Connection(db);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const backupPath = process.argv[2];
  if (!backupPath) throw new Error("请提供已完成在线备份的 V1 SQLite 路径");
  const snapshot = convertV1Backup(backupPath);
  // 只输出统计，不打印原文、义项、词条、设置值或迁移后的 ID 映射。
  process.stdout.write(`${JSON.stringify({
    spaces: snapshot.spaces.length,
    units: snapshot.units.length,
    lists: snapshot.lists.length,
    words: snapshot.words.length,
    drafts: snapshot.drafts.length,
    events: snapshot.events.length,
    settings: snapshot.settings.length,
    meaningFormatMismatchCount: snapshot.meaningFormatMismatchCount,
  }, null, 2)}\n`);
}
