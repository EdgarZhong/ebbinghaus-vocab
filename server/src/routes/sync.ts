/**
 * 同步核心路由：POST /sync/push 与 GET /sync/pull。
 *
 * 服务器在本文件内的全部职责边界（技术决策第五章）：
 * - push：protocol schema 校验 → event_id 去重（幂等回执）→ 事务内分配 server_seq
 *   并整体入库。不解读事件语义，payload 只存原文。
 * - pull：参数解析与越界拒绝 → 按 server_seq 升序增量返回 + 断点游标。
 * - server_seq 只是同步游标，不是领域事件顺序：分配严格按"到达顺序"（请求处理
 *   顺序），与事件 occurredAt 无关——离线设备晚上传的旧事件获得更大 serverSeq
 *   是预期行为，领域重放排序由客户端按 protocol ordering 规则独立完成。
 */

import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

import {
  errorCodes,
  syncPullQuerySchema,
  syncPullResponseSchema,
  syncPushRequestSchema,
  syncPushResponseSchema,
} from "@ebbinghaus/protocol";
import { z } from "zod";

import { parseOutgoingContract } from "../contract.ts";
import { invalidQueryError, validationFailedError } from "../errors.ts";
import type { SyncStore } from "../store.ts";

/** pull 分页服务器策略：默认页大小 500，上限 2000（任务简报口径），越界 400。 */
const PULL_DEFAULT_LIMIT = 500;
const PULL_MAX_LIMIT = 2000;

/**
 * push 载荷事件的服务器侧信封视图。
 *
 * schema 校验已在解析点保证了字段存在性与类型正确性，服务器在校验后一次性收窄为
 * 强类型信封视图：payload 序列化仍使用校验后的完整原始对象（spread/stringify 不受
 * 收窄影响），不在任何位置二次猜测字段类型。
 * 此类型的定义宽度刻意只覆盖服务器物化列所需的五个字段 + metadata。
 * （历史注：defineEventSchema 曾因裸 z.ZodObject 返回标注使 protocol 输出类型退化
 * 为 index-signature，彼时本视图还承担类型恢复职责；该缺陷已由主会话修复，视图
 * 现在只是"服务器最小依赖面"的表达。）
 */
interface PushEventEnvelope {
  readonly eventId: string;
  readonly deviceId: string;
  readonly deviceSeq: number;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly metadata: unknown;
}

/**
 * 解析字符串查询参数为数值形态。
 *
 * URL query 原始值恒为字符串；protocol syncPullQuerySchema 校验的是解析后的数值
 * 对象（协议注释明确"字符串到数字的解析是传输层职责"）。这里刻意用"纯数字字符串"
 * 白名单正则而非 Number() 宽松转换：Number("") === 0、Number(" 12 ") === 12 之类的
 * 隐式宽松转换会把畸形输入静默吞掉，掩盖客户端 bug。
 */
function parseNumericQueryValue(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw invalidQueryError(`查询参数 ${name} 必须是非负整数字符串，收到：${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/** 注册 /sync 路由。deps 由组合根注入（库句柄、存取层、可注入时钟）。 */
export function registerSyncRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database; store: SyncStore; now: () => Date },
): void {
  const { db, store, now } = deps;

  // ---------------------------------------------------------------------------
  // POST /sync/push
  // ---------------------------------------------------------------------------
  app.post("/sync/push", async (request, reply) => {
    // 1) 请求体过 protocol 契约 schema（信封严格校验 + 按类型联动校验 metadata）。
    const parsed = syncPushRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // B7：400 附 Zod 摘要，客户端可定位到具体事件与字段。
      throw validationFailedError(z.prettifyError(parsed.error));
    }
    const { events } = parsed.data as unknown as { events: PushEventEnvelope[] };

    // 2) 整批事务处理。
    //
    // 选择"整批一个事务"而非"逐事件小事务"的原因：客户端 push 批次是一个原子
    // 意图——要么全部入库后客户端按回执清空 outbox，要么整批回滚后原样重试。
    // 若半批入库，客户端重试时回执里"成功子集"与"失败子集"交错，outbox 对账
    // 逻辑被迫处理"部分成功"的中间态；个人自用规模单批次很小，整批事务的回滚
    // 成本可忽略，换来重试语义的绝对简单。
    //
    // 事务用 IMMEDIATE 起始：计数器读-改-写与事件插入都在写路径上，IMMEDIATE
    // 在事务开头就取写锁，杜绝中途锁升级导致的 BUSY 抖动。
    const processBatch = db.transaction((batch: typeof events) => {
      const accepted: Array<{ eventId: string; serverSeq: number }> = [];
      const duplicated: Array<{ eventId: string; serverSeq: number }> = [];
      // 批内 eventId → serverSeq 缓存：同一批内重复出现的 eventId 不再打库，
      // 也保证"批内重复"与"跨请求重复"拿到同一回执（都指向首次入库的游标）。
      const seen = new Map<string, number>();

      for (const event of batch) {
        const cachedSeq = seen.get(event.eventId);
        if (cachedSeq !== undefined) {
          duplicated.push({ eventId: event.eventId, serverSeq: cachedSeq });
          continue;
        }

        const existingSeq = store.findServerSeqByEventId(event.eventId);
        if (existingSeq !== undefined) {
          // 幂等去重：重复不是错误（B7），返回首次入库时的原游标。
          seen.set(event.eventId, existingSeq);
          duplicated.push({ eventId: event.eventId, serverSeq: existingSeq });
          continue;
        }

        // 到达顺序分配同步游标：与 occurredAt 无关（技术决策第四章口径）。
        const serverSeq = store.allocateServerSeq();
        try {
          store.insertEvent({
            eventId: event.eventId,
            deviceId: event.deviceId,
            deviceSeq: event.deviceSeq,
            occurredAt: event.occurredAt,
            eventType: event.eventType,
            // payload 保存上传事件原文（不含 serverSeq）；服务器不重写客户端数据。
            payload: JSON.stringify(event),
            receivedAt: now().toISOString(),
            serverSeq,
          });
        } catch (error) {
          // UNIQUE(device_id, device_seq) 被不同 eventId 触发：同设备序号被另一个
          // 事件占用，说明客户端事件流已损坏（同一设备序号只可能属于一个事件）。
          // 按 B7 归入 400 校验失败并整批回滚，让客户端排查数据而不是静默半入库。
          const sqliteCode = (error as { code?: string }).code;
          if (typeof sqliteCode === "string" && sqliteCode.startsWith("SQLITE_CONSTRAINT")) {
            throw validationFailedError(
              `事件 ${event.eventId} 违反同设备序号唯一约束（device_id=${event.deviceId}, device_seq=${event.deviceSeq} 已被其他事件占用），整批已回滚`,
            );
          }
          throw error;
        }

        seen.set(event.eventId, serverSeq);
        accepted.push({ eventId: event.eventId, serverSeq });
      }

      return { accepted, duplicated };
    });

    const receipts = processBatch(events);

    // 3) 响应过 protocol 契约 schema 自校验后返回。
    const responseBody = parseOutgoingContract(syncPushResponseSchema, receipts);
    await reply.code(200).send(responseBody);
  });

  // ---------------------------------------------------------------------------
  // GET /sync/pull?after_seq=N&limit=M
  // ---------------------------------------------------------------------------
  app.get("/sync/pull", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;

    const afterSeq = parseNumericQueryValue(query["after_seq"], "after_seq");
    if (afterSeq === undefined) {
      throw invalidQueryError(
        `查询参数 after_seq 必填：${errorCodes.invalidQuery}（非负整数，表示上次拉取到的最大 server_seq，0 表示全量）`,
      );
    }

    const rawLimit = parseNumericQueryValue(query["limit"], "limit");
    if (rawLimit !== undefined && rawLimit <= 0) {
      throw invalidQueryError(`查询参数 limit 必须是正整数，收到：${rawLimit}`);
    }
    if (rawLimit !== undefined && rawLimit > PULL_MAX_LIMIT) {
      throw invalidQueryError(`查询参数 limit 超过服务器上限 ${PULL_MAX_LIMIT}，收到：${rawLimit}`);
    }

    // 解析后的数值形态再过一次 protocol 契约 schema（双保险：手写解析 + 协议校验）。
    const parsedQuery = syncPullQuerySchema.safeParse({
      after_seq: afterSeq,
      ...(rawLimit !== undefined ? { limit: rawLimit } : {}),
    });
    if (!parsedQuery.success) {
      throw invalidQueryError(z.prettifyError(parsedQuery.error));
    }

    const limit = rawLimit ?? PULL_DEFAULT_LIMIT;
    // 多取一条判定 hasMore：避免为分页额外发 COUNT 查询。
    const rows = store.listEventsAfter(afterSeq, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const events = page.map((row) => {
      // payload 是 push 时保存的事件原文；同步游标独立成列，此处附加为存储事件视图。
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      return { ...payload, serverSeq: row.serverSeq };
    });

    // nextCursor：本页最后一个事件的 serverSeq；空页时保持请求的 after_seq（协议口径），
    // 客户端以它作为下一轮 after_seq 实现断点续传。
    const nextCursor = page.length > 0 ? page[page.length - 1]!.serverSeq : afterSeq;

    const responseBody = parseOutgoingContract(syncPullResponseSchema, {
      events,
      nextCursor,
      hasMore,
    });
    await reply.code(200).send(responseBody);
  });
}
