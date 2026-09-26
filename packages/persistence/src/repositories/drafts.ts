/**
 * 首过草稿的 SQLite 仓储。草稿原文属于用户数据；只在本地事务中记录内容版本，
 * 同步引擎随后异步上传。读取开放草稿时排除“已确认”完成墓碑，但保留其行用于
 * 跨设备收敛与迁移审计。
 */
import type Database from "better-sqlite3";
import type { FirstPassDraftRecord, FirstPassDraftStore } from "@ebbinghaus/application";
import type { ContentSyncStore } from "../sync/contentStore.ts";

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

  constructor(private readonly db: Database.Database, private readonly contentSync?: ContentSyncStore) {
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
    this.db.transaction(() => {
      this.upsert.run({ ...draft, useLanguageModel: draft.useLanguageModel ? 1 : 0 });
      this.contentSync?.recordLocal("draft", draft.id, draft);
    })();
  }

  getDraft(id: string): FirstPassDraftRecord | null {
    const row = this.get.get(id) as DraftRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  listOpenDrafts(spaceId: string): FirstPassDraftRecord[] {
    return (this.listOpen.all(spaceId) as DraftRow[]).map(toRecord);
  }
}
