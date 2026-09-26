/**
 * 本地内容版本、出站队列与远端内容落地。内容目录可变，因此不能沿用学习事件
 * append-only 通道：每个实体只保留最新版本，离线多次编辑折叠为最新待推版本。
 * 所有本地仓储写入必须在同一 SQLite 事务内调用 recordLocal。
 */
import type Database from "better-sqlite3";
import type { Clock, DeviceIdentityProvider } from "@ebbinghaus/application";
import {
  contentEntrySchema,
  isContentEntryNewer,
  storedContentEntrySchema,
  type ContentEntry,
  type ContentEntityType,
  type StoredContentEntry,
} from "@ebbinghaus/protocol";
import { computeBackoffDelayMs, DEFAULT_OUTBOX_BACKOFF, type OutboxBackoffOptions } from "../outbox/outboxStore.ts";

export interface PendingContentEntry {
  readonly entry: ContentEntry;
  readonly payloadJson: string;
}

export interface ContentSyncStore {
  recordLocal(entityType: ContentEntityType, entityId: string, value: unknown, initialVersionAt?: string): void;
  readCursor(): number;
  writeCursor(cursor: number): void;
  applyRemote(entries: readonly StoredContentEntry[]): number;
  dueEntries(nowIso: string, limit: number): PendingContentEntry[];
  markSucceeded(item: PendingContentEntry): void;
  markFailed(item: PendingContentEntry, message: string, nowIso: string): void;
  pendingCount(): number;
}

interface VersionRow { readonly payloadJson: string; readonly updatedAt: string }
interface OutboxRow { readonly payloadJson: string; readonly attempts: number }

export class SqliteContentSyncStore implements ContentSyncStore {
  private readonly selectVersion;
  private readonly saveVersion;
  private readonly enqueue;
  private readonly due;
  private readonly deletePending;
  private readonly failed;
  private readonly countPending;
  private readonly selectCursor;
  private readonly saveCursor;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly deviceIdentity: DeviceIdentityProvider,
    private readonly backoff: OutboxBackoffOptions = DEFAULT_OUTBOX_BACKOFF,
  ) {
    this.selectVersion = db.prepare("SELECT payload_json AS payloadJson, updated_at AS updatedAt FROM content_versions WHERE entity_type = ? AND entity_id = ?");
    this.saveVersion = db.prepare(`
      INSERT INTO content_versions (entity_type, entity_id, payload_json, updated_at, device_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        payload_json = excluded.payload_json, updated_at = excluded.updated_at, device_id = excluded.device_id
    `);
    this.enqueue = db.prepare(`
      INSERT INTO content_outbox (entity_type, entity_id, payload_json, attempts, next_attempt_at, last_error)
      VALUES (?, ?, ?, 0, ?, NULL)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        payload_json = excluded.payload_json, attempts = 0,
        next_attempt_at = excluded.next_attempt_at, last_error = NULL
    `);
    this.due = db.prepare("SELECT payload_json AS payloadJson FROM content_outbox WHERE next_attempt_at <= ? ORDER BY next_attempt_at, entity_type, entity_id LIMIT ?");
    this.deletePending = db.prepare("DELETE FROM content_outbox WHERE entity_type = ? AND entity_id = ? AND payload_json = ?");
    this.failed = db.prepare("UPDATE content_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE entity_type = ? AND entity_id = ? AND payload_json = ?");
    this.countPending = db.prepare("SELECT COUNT(*) AS total FROM content_outbox");
    this.selectCursor = db.prepare("SELECT value FROM sync_state WHERE key = 'content_pull_cursor'");
    this.saveCursor = db.prepare("UPDATE sync_state SET value = ? WHERE key = 'content_pull_cursor'");
  }

  recordLocal(entityType: ContentEntityType, entityId: string, value: unknown, initialVersionAt?: string): void {
    const previous = this.selectVersion.get(entityType, entityId) as VersionRow | undefined;
    // 仅首次创建时允许传入内容本身的创建时间。固定默认目录用早期版本，
    // 后装设备拉取云端已编辑的目录时，云端版本必然胜出。
    const clockMs = initialVersionAt === undefined ? this.clock.now().getTime() : Date.parse(initialVersionAt);
    // 时钟冻结或回拨时仍需严格单调，尤其同设备同毫秒连改两次不能靠 JSON 大小决胜。
    const previousMs = previous === undefined ? -Infinity : Date.parse(previous.updatedAt);
    const updatedAt = new Date(Math.max(clockMs, previousMs + 1)).toISOString();
    const entry = contentEntrySchema.parse({
      entityType, entityId, value, deleted: value === null,
      updatedAt, deviceId: this.deviceIdentity.getDeviceId(),
    });
    const payload = JSON.stringify(entry);
    this.saveVersion.run(entityType, entityId, payload, updatedAt, entry.deviceId);
    // 版本可因冻结时钟向前微调；待推时间仍取真实注入时钟，避免误等到未来版本时刻。
    this.enqueue.run(entityType, entityId, payload, this.clock.now().toISOString());
  }

  readCursor(): number {
    return (this.selectCursor.get() as { value: number }).value;
  }

  writeCursor(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("内容游标非法");
    this.saveCursor.run(cursor);
  }

  applyRemote(entries: readonly StoredContentEntry[]): number {
    const apply = this.db.transaction(() => {
      let changed = 0;
      for (const stored of entries) {
        const { serverSeq: _serverSeq, ...content } = storedContentEntrySchema.parse(stored);
        const previous = this.selectVersion.get(content.entityType, content.entityId) as VersionRow | undefined;
        if (previous !== undefined && !isContentEntryNewer(content, contentEntrySchema.parse(JSON.parse(previous.payloadJson)))) {
          continue;
        }
        this.applyValue(content);
        this.saveVersion.run(content.entityType, content.entityId, JSON.stringify(content), content.updatedAt, content.deviceId);
        // 仅移除确实被远端更高版本取代的待推条目；本地较新版本仍需继续上传。
        this.db.prepare("DELETE FROM content_outbox WHERE entity_type = ? AND entity_id = ?")
          .run(content.entityType, content.entityId);
        changed += 1;
      }
      return changed;
    });
    return apply();
  }

  private applyValue(entry: ContentEntry): void {
    if (entry.deleted || entry.value === null) {
      const tableAndKey = {
        space: ["spaces", "id"], unit: ["study_units", "unit_id"],
        list: ["list_catalog", "list_id"], word: ["word_contents", "word_id"],
        draft: ["first_pass_drafts", "id"],
      } as const;
      const [table, key] = tableAndKey[entry.entityType];
      this.db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(entry.entityId);
      return;
    }
    switch (entry.entityType) {
      case "space": {
        const v = entry.value;
        this.db.prepare(`
          INSERT INTO spaces (id, kind, display_order, name, archived_at, created_at, updated_at, learning_mode)
          VALUES (@id, @kind, @displayOrder, @name, @archivedAt, @createdAt, @updatedAt, @learningMode)
          ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, display_order=excluded.display_order,
            name=excluded.name, archived_at=excluded.archived_at, created_at=excluded.created_at,
            updated_at=excluded.updated_at, learning_mode=excluded.learning_mode
        `).run(v);
        break;
      }
      case "unit": {
        const v = entry.value;
        this.db.prepare(`
          INSERT INTO study_units (unit_id, space_id, unit_number) VALUES (?, ?, ?)
          ON CONFLICT(unit_id) DO UPDATE SET space_id=excluded.space_id, unit_number=excluded.unit_number
        `).run(v.id, v.spaceId, v.number);
        break;
      }
      case "list": {
        const v = entry.value;
        this.db.prepare(`
          INSERT INTO list_catalog (list_id, space_id, unit_id, unit_number, list_number)
          VALUES (@listId, @spaceId, @unitId, @unitNumber, @listNumber)
          ON CONFLICT(list_id) DO UPDATE SET space_id=excluded.space_id, unit_id=excluded.unit_id,
            unit_number=excluded.unit_number, list_number=excluded.list_number
        `).run(v);
        break;
      }
      case "word": {
        const v = entry.value;
        this.db.prepare(`
          INSERT INTO word_contents (word_id, list_id, space_id, original_spelling, normalized_key,
            manual_meaning, meanings_json, removed, recorded_at, removed_at)
          VALUES (@wordId, @listId, @spaceId, @originalSpelling, @normalizedKey, @manualMeaning,
            @meaningsJson, @removed, @recordedAt, @removedAt)
          ON CONFLICT(word_id) DO UPDATE SET list_id=excluded.list_id, space_id=excluded.space_id,
            original_spelling=excluded.original_spelling, normalized_key=excluded.normalized_key,
            manual_meaning=excluded.manual_meaning, meanings_json=excluded.meanings_json,
            removed=excluded.removed, recorded_at=excluded.recorded_at, removed_at=excluded.removed_at
        `).run({
          wordId: v.wordId, listId: v.listId, spaceId: v.spaceId,
          originalSpelling: v.originalSpelling, normalizedKey: v.normalizedKey,
          manualMeaning: v.manualMeaning, meaningsJson: JSON.stringify(v.meanings),
          removed: v.removed ? 1 : 0, recordedAt: v.recordedAt,
          removedAt: v.removed ? entry.updatedAt : null,
        });
        break;
      }
      case "draft": {
        const v = entry.value;
        this.db.prepare(`
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
        `).run({ ...v, useLanguageModel: v.useLanguageModel ? 1 : 0 });
        break;
      }
    }
  }

  dueEntries(nowIso: string, limit: number): PendingContentEntry[] {
    return (this.due.all(nowIso, limit) as OutboxRow[]).map((row) => ({
      entry: contentEntrySchema.parse(JSON.parse(row.payloadJson)), payloadJson: row.payloadJson,
    }));
  }

  markSucceeded(item: PendingContentEntry): void {
    this.deletePending.run(item.entry.entityType, item.entry.entityId, item.payloadJson);
  }

  markFailed(item: PendingContentEntry, message: string, nowIso: string): void {
    const row = this.db.prepare("SELECT attempts FROM content_outbox WHERE entity_type = ? AND entity_id = ? AND payload_json = ?")
      .get(item.entry.entityType, item.entry.entityId, item.payloadJson) as OutboxRow | undefined;
    if (row === undefined) return;
    const delay = computeBackoffDelayMs(row.attempts + 1, this.backoff);
    this.failed.run(new Date(Date.parse(nowIso) + delay).toISOString(), message.slice(0, 2000),
      item.entry.entityType, item.entry.entityId, item.payloadJson);
  }

  pendingCount(): number {
    return (this.countPending.get() as { total: number }).total;
  }
}
