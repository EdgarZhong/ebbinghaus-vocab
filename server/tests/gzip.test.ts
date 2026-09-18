import { describe, expect, it } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";

import { syncPullResponseSchema } from "@ebbinghaus/protocol";

import { authHeaders, createTestApp, makeEventPayload, pushEvents } from "./helpers.ts";

/**
 * gzip 传输专项（任务规格 7 + 判断文件 D4）：
 * - push 请求体接受 Content-Encoding: gzip；
 * - pull 响应按 Accept-Encoding 压缩，解压后是合法 JSON。
 * 压缩插件阈值配置为 0，保证任意大小的响应都会被压缩，测试可稳定断言。
 */
describe("gzip 传输", () => {
  it("gzip 压缩的 push 请求体成功入库", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const events = [makeEventPayload(), makeEventPayload()];
      const compressed = gzipSync(Buffer.from(JSON.stringify({ events }), "utf8"));

      const response = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: {
          ...authHeaders(token),
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        payload: compressed,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { accepted: unknown[] };
      expect(body.accepted).toHaveLength(2);

      // 解压请求确实按原文入库：pull 回来 eventId 一致。
      const pull = await app.inject({
        method: "GET",
        url: "/sync/pull?after_seq=0",
        headers: authHeaders(token),
      });
      const pulled = pull.json() as { events: Array<Record<string, unknown>> };
      expect(pulled.events.map((item) => item["eventId"]).sort()).toEqual(
        events.map((event) => event["eventId"]).sort(),
      );
    } finally {
      close();
    }
  });

  it("pull 响应带 Content-Encoding: gzip，解压后为合法 JSON 且符合契约", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const { statusCode } = await pushEvents(app, token, [
        makeEventPayload(),
        makeEventPayload(),
        makeEventPayload(),
      ]);
      expect(statusCode).toBe(200);

      const response = await app.inject({
        method: "GET",
        url: "/sync/pull?after_seq=0",
        headers: { ...authHeaders(token), "accept-encoding": "gzip" },
      });

      expect(response.statusCode).toBe(200);
      expect(String(response.headers["content-encoding"] ?? "")).toBe("gzip");

      // gzip magic bytes 校验：确认拿到的是真正的 gzip 流而非明文。
      const raw = response.rawPayload;
      expect(raw[0]).toBe(0x1f);
      expect(raw[1]).toBe(0x8b);

      const parsed = JSON.parse(gunzipSync(raw).toString("utf8")) as unknown;
      expect(syncPullResponseSchema.safeParse(parsed).success).toBe(true);
      expect((parsed as { events: unknown[] }).events).toHaveLength(3);
    } finally {
      close();
    }
  });

  it("未携带 Accept-Encoding 时响应保持明文（不做无谓压缩）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      await pushEvents(app, token, [makeEventPayload()]);
      const response = await app.inject({
        method: "GET",
        url: "/sync/pull?after_seq=0",
        headers: authHeaders(token),
      });
      expect(response.headers["content-encoding"]).toBeUndefined();
      // 明文响应仍是合法 JSON。
      expect((response.json() as { events: unknown[] }).events).toHaveLength(1);
    } finally {
      close();
    }
  });
});
