import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

import {
  createTestApp,
  makeEventPayload,
  pullEvents,
  pushEvents,
} from "./helpers.ts";

interface PullBody {
  events: Array<Record<string, unknown>>;
  nextCursor: number;
}

/** 拉取全量并返回 serverSeq 列表（升序）。 */
async function allServerSeqs(
  app: FastifyInstance,
  token: string,
): Promise<number[]> {
  const { body } = await pullEvents(app, token, "?after_seq=0");
  return (body as PullBody).events.map((event) => event["serverSeq"] as number);
}

/**
 * server_seq 严格单调性专项（任务规格 10）：跨批次、跨"进程重启"持续递增。
 * 单调性是增量拉取与去重回执正确性的根基：游标一旦回退，客户端会把已同步区间
 * 整个重拉一遍，甚至误判数据丢失。
 */
describe("server_seq 严格单调性", () => {
  it("同进程内跨批次严格递增", async () => {
    const { app, token, close } = await createTestApp();
    try {
      await pushEvents(app, token, [makeEventPayload(), makeEventPayload()]);
      await pushEvents(app, token, [makeEventPayload()]);
      await pushEvents(app, token, [makeEventPayload(), makeEventPayload(), makeEventPayload()]);

      const seqs = await allServerSeqs(app, token);
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      close();
    }
  });

  it("重建应用实例（模拟进程重启）后游标从持久化计数器继续单调递增", async () => {
    const first = await createTestApp();
    try {
      await pushEvents(first.app, first.token, [makeEventPayload(), makeEventPayload()]);
    } finally {
      first.close();
    }

    // 同一库文件路径重新打开库、重新构建应用：等价于服务器进程重启后的新连接。
    const db = openDatabase(first.dbPath);
    const app = await buildApp({ db, authToken: first.token });
    try {
      await pushEvents(app, first.token, [makeEventPayload(), makeEventPayload(), makeEventPayload()]);

      const seqs = await allServerSeqs(app, first.token);
      // 重启前 1、2，重启后 3、4、5：计数器值持久化在库内，绝不回退或重用。
      expect(seqs).toEqual([1, 2, 3, 4, 5]);
    } finally {
      app.close();
      db.close();
    }
  });

  it("部分重复的混合批次也保持游标严格递增（重复事件不分配新游标）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const event = makeEventPayload();
      await pushEvents(app, token, [event]);

      // 第二批：一个重复事件 + 一个新事件。重复事件不应推进计数器。
      await pushEvents(app, token, [event, makeEventPayload()]);

      const seqs = await allServerSeqs(app, token);
      expect(seqs).toEqual([1, 2]);
    } finally {
      close();
    }
  });
});
