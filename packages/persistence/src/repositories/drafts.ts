/**
 * 首过草稿的 SQLite 仓储。原文、模型候选和未提交表单只属于当前设备；
 * 正式保存后的词条与义项由内容目录单独同步。读取开放草稿时排除“已确认”
 * 状态，但保留该行，避免本机导航或重启后再次恢复已提交表单。
 */
import type Database from "better-sqlite3";
import type { FirstPassDraftRecord, FirstPassDraftStore } from "@ebbinghaus/application";

interface DraftRow {
  id: string; space_id: string; unit_number: number; list_number: number;
  raw_text: string; use_language_model: number; status: FirstPassDraftRecord["status"];
  last_error: string | null; candidates_json: string | null; audit_json: string | null;
  unresolved_description: string | null; updated_at: string; device_id: string;
}

function toRecord(row: DraftRow): FirstPassDraftRecord {
  return {
    id: row.id, spaceId: row.space_id, unitNumber: row.unit_number,
    listNumber: row.list_number, rawText: row.raw_text,
    useLanguageModel: row.use_language_model === 1, status: row.status,
    lastError: row.last_error, candidatesJson: row.candidates_json,
    auditJson: row.audit_json, unresolvedDescription: row.unresolved_description,
    updatedAt: row.updated_at, deviceId: row.device_id,
  };
}

export class SqliteFirstPassDraftStore implements FirstPassDraftStore {
  private readonly upsert;
  private readonly get;
  private readonly listOpen;

  constructor(db: Database.Database) {
    this.upsert = db.prepare(`
      INSERT INTO first_pass_drafts
        (id, space_id, unit_number, list_number, raw_text, use_language_model, status,
         last_error, candidates_json, audit_json, unresolved_description, updated_at, device_id)
      VALUES
        (@id, @spaceId, @unitNumber, @listNumber, @rawText, @useLanguageModel, @status,
         @lastError, @candidatesJson, @auditJson, @unresolvedDescription, @updatedAt, @deviceId)
      ON CONFLICT(id) DO UPDATE SET
        space_id=excluded.space_id, unit_number=excluded.unit_number,
        list_number=excluded.list_number, raw_text=excluded.raw_text,
        use_language_model=excluded.use_language_model, status=excluded.status,
        last_error=excluded.last_error, candidates_json=excluded.candidates_json,
        audit_json=excluded.audit_json, unresolved_description=excluded.unresolved_description,
        updated_at=excluded.updated_at, device_id=excluded.device_id
    `);
    this.get = db.prepare("SELECT * FROM first_pass_drafts WHERE id = ?");
    this.listOpen = db.prepare("SELECT * FROM first_pass_drafts WHERE space_id = ? AND status <> '已确认' ORDER BY updated_at DESC, id");
  }

  upsertDraft(draft: FirstPassDraftRecord): void {
    // 单条 SQLite upsert 自身具有原子性。草稿正文仅写入 first_pass_drafts，
    // 不能生成 content_versions/content_outbox 记录，否则未提交输入会上传。
    this.upsert.run({ ...draft, useLanguageModel: draft.useLanguageModel ? 1 : 0 });
  }

  getDraft(id: string): FirstPassDraftRecord | null {
    const row = this.get.get(id) as DraftRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  listOpenDrafts(spaceId: string): FirstPassDraftRecord[] {
    return (this.listOpen.all(spaceId) as DraftRow[]).map(toRecord);
  }
}
