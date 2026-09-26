/**
 * 本地内容目录仓储：词内容、词书结构（Unit/List）、Space 元数据。
 *
 * 这三张表是"内容目录"而非事件流（ports.ts 合同）：事件承载学习事实，目录承载
 * 词身份与结构定位。派生状态（List 阶段、同步时间、新增锁）刻意不在这里存储——
 * 它们由事件重放派生，防止目录与重放两处状态互相矛盾。
 */

import type Database from "better-sqlite3";

import type { Space, StudyUnit, StructuredMeaning } from "@ebbinghaus/domain";
import type {
  BookCatalogStore,
  ListCatalogRecord,
  SpaceStore,
  WordContentRecord,
  WordContentStore,
} from "@ebbinghaus/application";
import type { ContentSyncStore } from "../sync/contentStore.ts";

// ---------------------------------------------------------------------------
// 词内容目录
// ---------------------------------------------------------------------------

interface WordContentRow {
  readonly word_id: string;
  readonly list_id: string | null;
  readonly space_id: string | null;
  readonly original_spelling: string;
  readonly normalized_key: string;
  readonly manual_meaning: string;
  readonly meanings_json: string;
  readonly removed: number;
  readonly recorded_at: string;
}

function rowToWordContent(row: WordContentRow): WordContentRecord {
  return {
    wordId: row.word_id,
    listId: row.list_id,
    spaceId: row.space_id,
    originalSpelling: row.original_spelling,
    normalizedKey: row.normalized_key,
    manualMeaning: row.manual_meaning,
    meanings: JSON.parse(row.meanings_json) as readonly StructuredMeaning[],
    removed: row.removed === 1,
    recordedAt: row.recorded_at,
  };
}

export class SqliteWordContentStore implements WordContentStore {
  private readonly db: Database.Database;

  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listForSpaceStmt;
  private readonly listForListStmt;
  private readonly markRemovedStmt;
  private readonly listCatalogStmt;
  private readonly hasForSpaceStmt;

  constructor(db: Database.Database, private readonly contentSync?: ContentSyncStore) {
    this.db = db;
    this.upsertStmt = this.db.prepare(`
      INSERT INTO word_contents
        (word_id, list_id, space_id, original_spelling, normalized_key, manual_meaning,
         meanings_json, removed, recorded_at, removed_at)
      VALUES
        (@wordId, @listId, @spaceId, @originalSpelling, @normalizedKey, @manualMeaning,
         @meaningsJson, @removed, @recordedAt, @removedAt)
      ON CONFLICT(word_id) DO UPDATE SET
        list_id = excluded.list_id,
        space_id = excluded.space_id,
        original_spelling = excluded.original_spelling,
        normalized_key = excluded.normalized_key,
        manual_meaning = excluded.manual_meaning,
        meanings_json = excluded.meanings_json,
        removed = excluded.removed,
        recorded_at = excluded.recorded_at,
        removed_at = excluded.removed_at
    `);
    this.getStmt = this.db.prepare(
      `SELECT word_id, list_id, space_id, original_spelling, normalized_key, manual_meaning,
              meanings_json, removed, recorded_at FROM word_contents WHERE word_id = ?`,
    );
    this.listForSpaceStmt = this.db.prepare(
      `SELECT word_id, list_id, space_id, original_spelling, normalized_key, manual_meaning,
              meanings_json, removed, recorded_at
       FROM word_contents WHERE space_id = ? AND removed = 0`,
    );
    this.listForListStmt = this.db.prepare(
      `SELECT word_id, list_id, space_id, original_spelling, normalized_key, manual_meaning,
              meanings_json, removed, recorded_at
       FROM word_contents WHERE list_id = ? AND removed = 0`,
    );
    this.markRemovedStmt = this.db.prepare(
      `UPDATE word_contents SET removed = 1, removed_at = ? WHERE word_id = ?`,
    );
    this.listCatalogStmt = this.db.prepare(
      `SELECT word_id, list_id, space_id, original_spelling, normalized_key, manual_meaning,
              meanings_json, removed, recorded_at FROM word_contents`,
    );
    this.hasForSpaceStmt = this.db.prepare(
      `SELECT COUNT(*) AS total FROM word_contents WHERE space_id = ?`,
    );
  }

  /**
   * 插入或整体替换（内容更新语义：保持同一 wordId 与学习历史）。参数化 SQL 的
   * null 直接绑定 NULL；removed 由调用方传入，upsert 不隐式清除移除标记——重新
   * 登记已移除词属于显式业务决策，必须显式传 removed: false。
   */
  upsertEntries(entries: readonly WordContentRecord[]): void {
    const run = this.db.transaction((batch: readonly WordContentRecord[]) => {
      for (const entry of batch) {
        this.upsertStmt.run({
          wordId: entry.wordId,
          listId: entry.listId,
          spaceId: entry.spaceId,
          originalSpelling: entry.originalSpelling,
          normalizedKey: entry.normalizedKey,
          manualMeaning: entry.manualMeaning,
          meaningsJson: JSON.stringify(entry.meanings),
          removed: entry.removed ? 1 : 0,
          recordedAt: entry.recordedAt,
          removedAt: null,
        });
        this.contentSync?.recordLocal("word", entry.wordId, entry);
      }
    });
    run(entries);
  }

  getEntry(wordId: string): WordContentRecord | null {
    const row = this.getStmt.get(wordId) as WordContentRow | undefined;
    return row === undefined ? null : rowToWordContent(row);
  }

  listEntriesForSpace(spaceId: string): WordContentRecord[] {
    return (this.listForSpaceStmt.all(spaceId) as WordContentRow[]).map(rowToWordContent);
  }

  listEntriesForList(listId: string): WordContentRecord[] {
    return (this.listForListStmt.all(listId) as WordContentRow[]).map(rowToWordContent);
  }

  /** 软移除：只置标记与审计时间，绝不物理删除（历史与重放需要完整时间线）。 */
  markRemoved(wordId: string, removedAt: string): void {
    this.db.transaction(() => {
      const result = this.markRemovedStmt.run(removedAt, wordId);
      if (result.changes === 0) throw new Error(`词内容不存在：${wordId}`);
      const entry = this.getEntry(wordId);
      if (entry === null) throw new Error(`软移除后词内容不存在：${wordId}`);
      this.contentSync?.recordLocal("word", wordId, entry);
    })();
  }

  /** 全量登记（含已移除词）：重放器 wordCatalog 的输入口径。 */
  listCatalogEntries(): WordContentRecord[] {
    return (this.listCatalogStmt.all() as WordContentRow[]).map(rowToWordContent);
  }

  hasEntriesForSpace(spaceId: string): boolean {
    const row = this.hasForSpaceStmt.get(spaceId) as { readonly total: number };
    return row.total > 0;
  }
}

// ---------------------------------------------------------------------------
// 词书目录（Unit/List 定位事实）
// ---------------------------------------------------------------------------

export class SqliteBookCatalogStore implements BookCatalogStore {
  private readonly db: Database.Database;

  private readonly addUnitStmt;
  private readonly getUnitStmt;
  private readonly getUnitByNumberStmt;
  private readonly addListStmt;
  private readonly getListStmt;
  private readonly getListByNumberStmt;
  private readonly listForSpaceStmt;
  private readonly hasForSpaceStmt;

  constructor(db: Database.Database, private readonly contentSync?: ContentSyncStore) {
    this.db = db;
    this.addUnitStmt = this.db.prepare(
      `INSERT INTO study_units (unit_id, space_id, unit_number) VALUES (@id, @spaceId, @number)`,
    );
    this.getUnitStmt = this.db.prepare(
      `SELECT unit_id AS id, space_id AS spaceId, unit_number AS number FROM study_units WHERE unit_id = ?`,
    );
    this.getUnitByNumberStmt = this.db.prepare(
      `SELECT unit_id AS id, space_id AS spaceId, unit_number AS number
       FROM study_units WHERE space_id = ? AND unit_number = ?`,
    );
    this.addListStmt = this.db.prepare(`
      INSERT INTO list_catalog (list_id, space_id, unit_id, unit_number, list_number)
      VALUES (@listId, @spaceId, @unitId, @unitNumber, @listNumber)
    `);
    this.getListStmt = this.db.prepare(
      `SELECT list_id AS listId, space_id AS spaceId, unit_id AS unitId, unit_number AS unitNumber, list_number AS listNumber FROM list_catalog WHERE list_id = ?`,
    );
    this.getListByNumberStmt = this.db.prepare(
      `SELECT list_id AS listId, space_id AS spaceId, unit_id AS unitId, unit_number AS unitNumber, list_number AS listNumber
       FROM list_catalog WHERE unit_id = ? AND list_number = ?`,
    );
    this.listForSpaceStmt = this.db.prepare(
      `SELECT list_id AS listId, space_id AS spaceId, unit_id AS unitId, unit_number AS unitNumber, list_number AS listNumber
       FROM list_catalog WHERE space_id = ? ORDER BY unit_number, list_number`,
    );
    this.hasForSpaceStmt = this.db.prepare(
      `SELECT COUNT(*) AS total FROM list_catalog WHERE space_id = ?`,
    );
  }

  addUnit(unit: StudyUnit): void {
    this.db.transaction(() => {
      this.addUnitStmt.run({ id: unit.id, spaceId: unit.spaceId, number: unit.number });
      this.contentSync?.recordLocal("unit", unit.id, unit);
    })();
  }

  getUnit(unitId: string): StudyUnit | null {
    return (this.getUnitStmt.get(unitId) as StudyUnit | undefined) ?? null;
  }

  getUnitByNumber(spaceId: string, number: number): StudyUnit | null {
    return (this.getUnitByNumberStmt.get(spaceId, number) as StudyUnit | undefined) ?? null;
  }

  addList(record: ListCatalogRecord): void {
    this.db.transaction(() => {
      this.addListStmt.run(record);
      this.contentSync?.recordLocal("list", record.listId, record);
    })();
  }

  getList(listId: string): ListCatalogRecord | null {
    return (this.getListStmt.get(listId) as ListCatalogRecord | undefined) ?? null;
  }

  getListByNumber(unitId: string, number: number): ListCatalogRecord | null {
    return (this.getListByNumberStmt.get(unitId, number) as ListCatalogRecord | undefined) ?? null;
  }

  listListsForSpace(spaceId: string): ListCatalogRecord[] {
    return this.listForSpaceStmt.all(spaceId) as ListCatalogRecord[];
  }

  hasListsForSpace(spaceId: string): boolean {
    const row = this.hasForSpaceStmt.get(spaceId) as { readonly total: number };
    return row.total > 0;
  }
}

// ---------------------------------------------------------------------------
// Space 元数据
// ---------------------------------------------------------------------------

interface SpaceRow {
  readonly id: string;
  readonly kind: string | null;
  readonly display_order: number;
  readonly name: string | null;
  readonly archived_at: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly learning_mode: string;
}

function rowToSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    kind: row.kind as Space["kind"],
    displayOrder: row.display_order,
    name: row.name,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    learningMode: row.learning_mode as Space["learningMode"],
  };
}

export class SqliteSpaceStore implements SpaceStore {
  private readonly db: Database.Database;

  private readonly addStmt;
  private readonly updateStmt;
  private readonly deleteStmt;
  private readonly listStmt;
  private readonly getStmt;

  constructor(db: Database.Database, private readonly contentSync?: ContentSyncStore) {
    this.db = db;
    this.addStmt = this.db.prepare(`
      INSERT INTO spaces (id, kind, display_order, name, archived_at, created_at, updated_at, learning_mode)
      VALUES (@id, @kind, @displayOrder, @name, @archivedAt, @createdAt, @updatedAt, @learningMode)
    `);
    this.updateStmt = this.db.prepare(`
      UPDATE spaces SET kind = @kind, display_order = @displayOrder, name = @name,
                        archived_at = @archivedAt, updated_at = @updatedAt, learning_mode = @learningMode
      WHERE id = @id
    `);
    this.deleteStmt = this.db.prepare(`DELETE FROM spaces WHERE id = ?`);
    this.listStmt = this.db.prepare(
      `SELECT id, kind, display_order, name, archived_at, created_at, updated_at, learning_mode
       FROM spaces ORDER BY display_order ASC`,
    );
    this.getStmt = this.db.prepare(
      `SELECT id, kind, display_order, name, archived_at, created_at, updated_at, learning_mode
       FROM spaces WHERE id = ?`,
    );
  }

  addSpace(space: Space): void {
    this.db.transaction(() => {
      this.addStmt.run({
      id: space.id,
      kind: space.kind,
      displayOrder: space.displayOrder,
      name: space.name,
      archivedAt: space.archivedAt,
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
      learningMode: space.learningMode,
      });
      // 首次创建保留实体创建时间作为同步版本；默认 Space 的固定早期时间
      // 不能压过另一设备已经修改的同一固定 Space。
      this.contentSync?.recordLocal("space", space.id, space, space.createdAt ?? undefined);
    })();
  }

  updateSpace(space: Space): void {
    this.db.transaction(() => {
      const result = this.updateStmt.run({
      id: space.id,
      kind: space.kind,
      displayOrder: space.displayOrder,
      name: space.name,
      archivedAt: space.archivedAt,
      updatedAt: space.updatedAt,
      learningMode: space.learningMode,
      });
      if (result.changes === 0) throw new Error(`Space 不存在：${space.id}`);
      this.contentSync?.recordLocal("space", space.id, space);
    })();
  }

  deleteSpace(spaceId: string): void {
    this.db.transaction(() => {
      this.deleteStmt.run(spaceId);
      this.contentSync?.recordLocal("space", spaceId, null);
    })();
  }

  /** 按端口合同以 displayOrder 升序稳定返回。 */
  listSpaces(): Space[] {
    return (this.listStmt.all() as SpaceRow[]).map(rowToSpace);
  }

  getSpace(spaceId: string): Space | null {
    const row = this.getStmt.get(spaceId) as SpaceRow | undefined;
    return row === undefined ? null : rowToSpace(row);
  }
}
