/**
 * 内容目录的增量同步端点。服务器只比较协议定义的版本，不解读实体归属、词书
 * 阶段或学习语义；不同实体的同标识通过 entityType 组成复合键。删除墓碑永久留在
 * 最新行，迟到的旧写入不能使已删除的 Space 复活。
 */
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";

import {
  contentPullQuerySchema,
  contentPullResponseSchema,
  contentPutRequestSchema,
  contentPutResponseSchema,
  isContentEntryNewer,
  type ContentEntry,
  type StoredContentEntry,
} from "@ebbinghaus/protocol";

import { parseOutgoingContract } from "../contract.ts";
import { invalidQueryError, validationFailedError } from "../errors.ts";
import type { ContentRow, SyncStore } from "../store.ts";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

function rowToEntry(row: ContentRow): StoredContentEntry {
  return {
    ...JSON.parse(row.payload) as ContentEntry,
    serverSeq: row.serverSeq,
  };
}

function numericQuery(raw: unknown, name: string): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw invalidQueryError(`查询参数 ${name} 必须是非负整数字符串`);
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) {
    throw invalidQueryError(`查询参数 ${name} 超出安全整数范围`);
  }
  return number;
}

export function registerContentRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database; store: SyncStore },
): void {
  const { db, store } = deps;

  app.put("/content", async (request, reply) => {
    const parsed = contentPutRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationFailedError(z.prettifyError(parsed.error));

    const apply = db.transaction((entries: readonly ContentEntry[]) => {
      const touched = new Set<string>();
      for (const entry of entries) {
        const key = `${entry.entityType}\u0000${entry.entityId}`;
        touched.add(key);
        const incumbentRow = store.getContentRow(entry.entityType, entry.entityId);
        if (incumbentRow !== undefined && !isContentEntryNewer(entry, rowToEntry(incumbentRow))) {
          continue;
        }
        const serverSeq = store.allocateContentSeq();
        store.upsertContentRow({
          entityType: entry.entityType,
          entityId: entry.entityId,
          payload: JSON.stringify(entry),
          updatedAt: entry.updatedAt,
          deviceId: entry.deviceId,
          deleted: entry.deleted ? 1 : 0,
          serverSeq,
        });
      }
      // 回传请求涉及实体的最终权威版本，客户端可立即覆盖被拒的过时本地写入。
      return [...touched].sort().map((key) => {
        const [entityType, entityId] = key.split("\u0000");
        const row = store.getContentRow(entityType!, entityId!);
        if (row === undefined) throw new Error("内容合并后缺少已触及实体");
        return rowToEntry(row);
      });
    });
    const contents = apply(parsed.data.contents);
    await reply.code(200).send(parseOutgoingContract(contentPutResponseSchema, { contents }));
  });

  app.get("/content", async (request, reply) => {
    const raw = request.query as Record<string, unknown>;
    const afterSeq = numericQuery(raw["after_seq"], "after_seq");
    const limit = raw["limit"] === undefined ? DEFAULT_LIMIT : numericQuery(raw["limit"], "limit");
    if (limit < 1 || limit > MAX_LIMIT) throw invalidQueryError(`limit 必须介于 1 和 ${MAX_LIMIT} 之间`);
    const query = contentPullQuerySchema.safeParse({ after_seq: afterSeq, limit });
    if (!query.success) throw invalidQueryError(z.prettifyError(query.error));

    const rows = store.listContentsAfter(afterSeq, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const contents = page.map(rowToEntry);
    const nextCursor = page.length > 0 ? page[page.length - 1]!.serverSeq : afterSeq;
    await reply.code(200).send(parseOutgoingContract(contentPullResponseSchema, {
      contents, nextCursor, hasMore,
    }));
  });
}
