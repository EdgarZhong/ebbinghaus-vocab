import { describe, expect, it } from "vitest";

import {
  syncPushResponseSchema,
  type SyncPushResponse,
} from "@ebbinghaus/protocol";

import {
  DEVICE_ID_A,
  authHeaders,
  createTestApp,
  makeEventPayload,
  pullEvents,
  pushEvents,
} from "./helpers.ts";

/**
 * push 专项：幂等去重（任务规格 1）、到达顺序分配游标（规格 2）、
 * schema 拒绝与整批回滚（规格 4）、批内唯一约束。
 */
describe("POST /sync/push", () => {
  it("单条合法事件入库并获得从 1 起的同步游标", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const event = makeEventPayload();
      const { statusCode, body } = await pushEvents(app, token, [event]);

      expect(statusCode).toBe(200);
      const parsed = body as SyncPushResponse;
      expect(parsed.accepted).toEqual([{ eventId: event["eventId"], serverSeq: 1 }]);
      expect(parsed.duplicated).toEqual([]);
    } finally {
      close();
    }
  });

  it("幂等：同一事件 push 两次，第二次计入 duplicated 且 serverSeq 不变（规格 1）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const event = makeEventPayload();

      const first = await pushEvents(app, token, [event]);
      expect(first.statusCode).toBe(200);
      const firstSeq = (first.body as SyncPushResponse).accepted[0]?.serverSeq;

      const second = await pushEvents(app, token, [event]);
      expect(second.statusCode).toBe(200);
      const secondBody = second.body as SyncPushResponse;
      expect(secondBody.accepted).toEqual([]);
      expect(secondBody.duplicated).toEqual([{ eventId: event["eventId"], serverSeq: firstSeq }]);
    } finally {
      close();
    }
  });

  it("两个客户端推送同一 eventId：先到者为准，后到者得到重复回执（规格 1）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      // 同一 eventId 由两台设备各自"产生"（现实中是拷贝/竞态双写场景）。
      const sharedEventId = "a3f1c2d4-e5b6-4c7d-8a9b-0c1d2e3f4a5b";
      const fromClientA = makeEventPayload({ eventId: sharedEventId, deviceId: DEVICE_ID_A });
      const fromClientB = makeEventPayload({
        eventId: sharedEventId,
        deviceId: "99999999-8888-4777-8666-777777777777",
        deviceSeq: 999,
      });

      const firstArrival = await pushEvents(app, token, [fromClientA]);
      expect(firstArrival.statusCode).toBe(200);
      const winnerSeq = (firstArrival.body as SyncPushResponse).accepted[0]?.serverSeq;

      const secondArrival = await pushEvents(app, token, [fromClientB]);
      expect(secondArrival.statusCode).toBe(200);
      const secondBody = secondArrival.body as SyncPushResponse;
      // 后到者整条按重复处理：不覆盖、不产生第二个存储行。
      expect(secondBody.accepted).toEqual([]);
      expect(secondBody.duplicated).toEqual([{ eventId: sharedEventId, serverSeq: winnerSeq }]);

      const pull = await pullEvents(app, token, "?after_seq=0");
      expect((pull.body as { events: unknown[] }).events).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("乱序上传：occurredAt 更旧的离线事件后上传，获得更大 serverSeq（规格 2）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      // X 是在线时刚发生的事件；Y 是另一设备离线一天前产生的旧事件，晚于 X 上传。
      const online = makeEventPayload({ occurredAt: "2026-09-19T12:00:00Z" });
      const offlineOld = makeEventPayload({ occurredAt: "2026-09-18T08:00:00Z" });

      await pushEvents(app, token, [online]);
      await pushEvents(app, token, [offlineOld]);

      const pull = await pullEvents(app, token, "?after_seq=0");
      expect(pull.statusCode).toBe(200);
      const events = (pull.body as { events: Array<Record<string, unknown>> }).events;

      // 服务器按到达顺序分配游标：pull 按 serverSeq 升序 => online 在前、offlineOld 在后。
      expect(events.map((item) => item["eventId"])).toEqual([online["eventId"], offlineOld["eventId"]]);
      expect(events[1]?.["serverSeq"]).toBeGreaterThan(events[0]?.["serverSeq"] as number);
      // 时间顺序与游标顺序刻意相反，证明游标不承载领域时间语义。
      expect(events[1]?.["occurredAt"]).toBe("2026-09-18T08:00:00Z");
    } finally {
      close();
    }
  });

  it("schema 拒绝：坏 UUID 事件 400 附 Zod 摘要，且整批不入库（规格 4）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const goodEvent = makeEventPayload();
      const badEvent = makeEventPayload({ eventId: "not-a-uuid" });

      const { statusCode, body } = await pushEvents(app, token, [goodEvent, badEvent]);
      expect(statusCode).toBe(400);
      const errorBody = body as { error: { code: string; message: string } };
      expect(errorBody.error.code).toBe("VALIDATION_FAILED");
      // Zod 摘要以路径定位问题字段（第 2 个事件的 eventId），足以让客户端定位。
      expect(errorBody.error.message).toContain("events[1].eventId");

      // 整批事务：合法事件也不得入库。
      const pull = await pullEvents(app, token, "?after_seq=0");
      expect((pull.body as { events: unknown[] }).events).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("schema 拒绝：未知 eventType / 混入 serverSeq 一律 400（规格 4）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const unknownType = pushEvents(app, token, [
        makeEventPayload({ eventType: "wordManuallyMarkedMastered" }),
      ]);
      const forgedServerSeq = pushEvents(app, token, [
        makeEventPayload({ serverSeq: 999 }),
      ]);

      for (const attempt of await Promise.all([unknownType, forgedServerSeq])) {
        expect(attempt.statusCode).toBe(400);
        expect((attempt.body as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
      }
    } finally {
      close();
    }
  });

  it("同设备序号被不同 eventId 占用时 400 并整批回滚", async () => {
    const { app, token, close } = await createTestApp();
    try {
      // 客户端事件流损坏场景：同 (deviceId, deviceSeq) 却携带不同 eventId。
      const original = makeEventPayload({ deviceSeq: 7 });
      const corrupted = makeEventPayload({ deviceSeq: 7 });

      await pushEvents(app, token, [original]);
      const { statusCode, body } = await pushEvents(app, token, [corrupted]);

      expect(statusCode).toBe(400);
      expect((body as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
      // 整批回滚：即使批次内其他事件合法，也不留半批状态。
      const pull = await pullEvents(app, token, "?after_seq=0");
      const events = (pull.body as { events: unknown[] }).events;
      expect(events).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("空批次返回空回执（合法请求）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const { statusCode, body } = await pushEvents(app, token, []);
      expect(statusCode).toBe(200);
      expect(body).toEqual({ accepted: [], duplicated: [] });
    } finally {
      close();
    }
  });

  it("请求体不是合法 JSON 时 400（统一错误形态）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        payload: "{not-json",
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_FAILED");
    } finally {
      close();
    }
  });

  it("push 响应整体符合 protocol 契约 schema", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const event = makeEventPayload();
      await pushEvents(app, token, [event]);
      const second = await pushEvents(app, token, [event]);
      // duplicated 与 accepted 混合场景（本批仅重复）亦须满足契约。
      expect(syncPushResponseSchema.safeParse(second.body).success).toBe(true);
    } finally {
      close();
    }
  });
});
