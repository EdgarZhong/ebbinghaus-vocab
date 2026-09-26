/** V1 同口径的在线词典成功缓存：每词一条、失败不落表、100 MiB 最旧淘汰。 */
import type Database from "better-sqlite3";
import type { DictionaryCacheRecord, DictionaryCacheStore, DictionaryDefinition } from "@ebbinghaus/application";

interface DictionaryRow {
  readonly id: string;
  readonly word_id: string;
  readonly provider: string;
  readonly normalized_word: string;
  readonly structured_definition_json: string;
  readonly raw_response_summary: string;
  readonly fetched_at: string;
  readonly cache_status: "有效" | "失效";
}

export class SqliteDictionaryCacheStore implements DictionaryCacheStore {
  private readonly getStmt;
  private readonly replaceStmt;

  constructor(private readonly db: Database.Database) {
    this.getStmt = db.prepare(`
      SELECT id, word_id, provider, normalized_word, structured_definition_json,
             raw_response_summary, fetched_at, cache_status
      FROM dictionary_entries WHERE word_id = ?
    `);
    // REPLACE 针对 word_id 唯一约束，保持每词至多一条；调用方用 UnitOfWork 把它
    // 与 dictionaryFetched 审计事件包在同一短事务内。
    this.replaceStmt = db.prepare(`
      INSERT INTO dictionary_entries
        (id, word_id, provider, normalized_word, structured_definition_json,
         raw_response_summary, fetched_at, cache_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(word_id) DO UPDATE SET
        id = excluded.id,
        provider = excluded.provider,
        normalized_word = excluded.normalized_word,
        structured_definition_json = excluded.structured_definition_json,
        raw_response_summary = excluded.raw_response_summary,
        fetched_at = excluded.fetched_at,
        cache_status = excluded.cache_status
    `);
  }

  get(wordId: string): DictionaryCacheRecord | null {
    const row = this.getStmt.get(wordId) as DictionaryRow | undefined;
    if (row === undefined) return null;
    return {
      id: row.id, wordId: row.word_id, provider: row.provider,
      normalizedWord: row.normalized_word,
      definitions: JSON.parse(row.structured_definition_json) as readonly DictionaryDefinition[],
      rawResponseSummary: row.raw_response_summary, fetchedAt: row.fetched_at,
      cacheStatus: row.cache_status,
    };
  }

  replace(record: DictionaryCacheRecord): void {
    this.replaceStmt.run(
      record.id, record.wordId, record.provider, record.normalizedWord,
      JSON.stringify(record.definitions), record.rawResponseSummary,
      record.fetchedAt, record.cacheStatus,
    );
  }

  pruneBySize(maxBytes: number): void {
    if (maxBytes <= 0) return;
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(
        LENGTH(CAST(structured_definition_json AS BLOB))
        + LENGTH(CAST(raw_response_summary AS BLOB))
      ), 0) AS total FROM dictionary_entries
    `).get() as { readonly total: number };
    let overflow = row.total - maxBytes;
    if (overflow <= 0) return;
    const oldest = this.db.prepare(`
      SELECT id, LENGTH(CAST(structured_definition_json AS BLOB))
             + LENGTH(CAST(raw_response_summary AS BLOB)) AS bytes
      FROM dictionary_entries ORDER BY fetched_at ASC, id ASC
    `).all() as { readonly id: string; readonly bytes: number }[];
    const deleteStmt = this.db.prepare("DELETE FROM dictionary_entries WHERE id = ?");
    for (const entry of oldest) {
      deleteStmt.run(entry.id);
      overflow -= entry.bytes;
      if (overflow <= 0) break;
    }
  }
}

/** 浏览器验收底座使用同一缓存合同；重载页面后内存清空符合既有 BrowserTestAdapter 语义。 */
export class InMemoryDictionaryCacheStore implements DictionaryCacheStore {
  private readonly rows = new Map<string, DictionaryCacheRecord>();

  get(wordId: string): DictionaryCacheRecord | null {
    return this.rows.get(wordId) ?? null;
  }

  replace(record: DictionaryCacheRecord): void {
    this.rows.set(record.wordId, record);
  }

  pruneBySize(maxBytes: number): void {
    if (maxBytes <= 0) return;
    const size = (entry: DictionaryCacheRecord): number => new TextEncoder().encode(
      JSON.stringify(entry.definitions) + entry.rawResponseSummary,
    ).length;
    let total = [...this.rows.values()].reduce((sum, entry) => sum + size(entry), 0);
    for (const entry of [...this.rows.values()].sort((a, b) =>
      a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id))) {
      if (total <= maxBytes) break;
      this.rows.delete(entry.wordId);
      total -= size(entry);
    }
  }
}
