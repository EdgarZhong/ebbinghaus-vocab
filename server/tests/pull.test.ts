import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { syncPullResponseSchema } from "@ebbinghaus/protocol";

import {
  createTestApp,
  makeEventPayload,
  pullEvents,
  pushEvents,
} from "./helpers.ts";

interface PullBody {
  events: Array<Record<string, unknown>>;
  nextCursor: number;
  hasMore: boolean;
}

/** push count 条默认事件并返回其 eventId 列表（按推送顺序）。 */
async function pushBatch(
  app: FastifyInstance,
  token: string,
  count: number,
): Promise<string[]> {
  const events = Array.from({ length: count }, () => makeEventPayload());
  const { statusCode } = await pushEvents(app, token, events);
  expect(statusCode).toBe(200);
  return events.map((event) => event["eventId"] as string);
}

/**
 * pull 专项：游标推进与分页（任务规格 3）、参数越界拒绝、幂等读。
 */
describe("GET /sync/pull", () => {
  it("push 5 条后逐页消费：nextCursor/hasMore 正确推进，直到耗尽（规格 3）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const pushedIds = await pushBatch(app, token, 5);

      const page1 = (await pullEvents(app, token, "?after_seq=0&limit=2")).body as PullBody;
      expect(page1.events.map((item) => item["eventId"])).toEqual(pushedIds.slice(0, 2));
      expect(page1.nextCursor).toBe(2);
      expect(page1.hasMore).toBe(true);

      const page2 = (await pullEvents(app, token, "?after_seq=2&limit=2")).body as PullBody;
      expect(page2.events.map((item) => item["eventId"])).toEqual(pushedIds.slice(2, 4));
      expect(page2.nextCursor).toBe(4);
      expect(page2.hasMore).toBe(true);

      const page3 = (await pullEvents(app, token, "?after_seq=4&limit=2")).body as PullBody;
      expect(page3.events.map((item) => item["eventId"])).toEqual(pushedIds.slice(4, 5));
      expect(page3.nextCursor).toBe(5);
      expect(page3.hasMore).toBe(false);

      // 耗尽后再拉：空页 nextCursor 保持请求的 after_seq（协议口径）。
      const page4 = (await pullEvents(app, token, "?after_seq=5&limit=2")).body as PullBody;
      expect(page4.events).toEqual([]);
      expect(page4.nextCursor).toBe(5);
      expect(page4.hasMore).toBe(false);
    } finally {
      close();
    }
  });

  it("重复 pull 同参数结果完全一致（幂等读，规格 3）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      await pushBatch(app, token, 3);
      const first = await pullEvents(app, token, "?after_seq=0&limit=2");
      const second = await pullEvents(app, token, "?after_seq=0&limit=2");
      expect(second.body).toEqual(first.body);
    } finally {
      close();
    }
  });

  it("limit 缺省时服务器默认页大小（本次 3 条一次性返回）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const pushedIds = await pushBatch(app, token, 3);
      const body = (await pullEvents(app, token, "?after_seq=0")).body as PullBody;
      expect(body.events.map((item) => item["eventId"])).toEqual(pushedIds);
      expect(body.hasMore).toBe(false);
    } finally {
      close();
    }
  });

  it("after_seq 缺失、非数字、负数、limit 非正整数一律 400", async () => {
    const { app, token, close } = await createTestApp();
    try {
      for (const query of ["", "?after_seq=abc", "?after_seq=-1", "?after_seq=1.5", "?after_seq=0&limit=0", "?after_seq=0&limit=-2", "?after_seq=0&limit=x"]) {
        const { statusCode, body } = await pullEvents(app, token, query);
        expect(statusCode, `query=${query || "(空)"}`).toBe(400);
        expect((body as { error: { code: string } }).error.code).toBe("INVALID_QUERY");
      }
    } finally {
      close();
    }
  });

  it("limit 超过服务器上限 2000 时 400（越界即拒绝，不静默截断）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const { statusCode, body } = await pullEvents(app, token, "?after_seq=0&limit=2001");
      expect(statusCode).toBe(400);
      expect((body as { error: { code: string; message: string } }).error.message).toContain("2000");
    } finally {
      close();
    }
  });

  it("after_seq 越过当前最大游标时返回空页", async () => {
    const { app, token, close } = await createTestApp();
    try {
      await pushBatch(app, token, 2);
      const body = (await pullEvents(app, token, "?after_seq=100")).body as PullBody;
      expect(body.events).toEqual([]);
      expect(body.nextCursor).toBe(100);
      expect(body.hasMore).toBe(false);
    } finally {
      close();
    }
  });

  it("pull 响应整体符合 protocol 契约（存储事件含 serverSeq）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const pushedIds = await pushBatch(app, token, 2);
      const { body } = await pullEvents(app, token, "?after_seq=0");
      const parsed = syncPullResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        // protocol 输出类型目前呈 index-signature 形态（M1 类型侧副作用），测试侧
        // 以方括号访问并显式断言类型。
        expect(parsed.data.events.map((item) => item["eventId"] as string)).toEqual(pushedIds);
        // 同步游标严格升序且从 1 开始。
        expect(parsed.data.events.map((item) => item["serverSeq"] as number)).toEqual([1, 2]);
      }
    } finally {
      close();
    }
  });
});
