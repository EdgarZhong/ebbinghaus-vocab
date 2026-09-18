import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

import { authHeaders, makeEventPayload, makeSettingEntry } from "./helpers.ts";

/**
 * 真实监听集成测试（任务规格要求至少一个真实 listen 用例）：
 * 其余测试走 fastify.inject（不占端口、跳过 socket 层），本文件在 127.0.0.1 随机
 * 端口上起真服务，用 Node 全局 fetch 走完整 TCP/HTTP 栈，验证鉴权与响应在真实
 * 网络行为下与 inject 一致。
 */
describe("真实 listen 集成", () => {
  it("在 127.0.0.1 随机端口上完成 push → pull 往返，鉴权在真实 socket 上生效", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ebb-server-listen-"));
    const db = openDatabase(join(tempDir, "authority.db"));
    const token = "real-listen-token-" + Math.random().toString(36).slice(2);
    const app = await buildApp({ db, authToken: token });

    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error(`未获得预期的监听地址：${String(address)}`);
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // 1) 无 token：真实 HTTP 层也拒绝。
      const denied = await fetch(`${baseUrl}/sync/pull?after_seq=0`);
      expect(denied.status).toBe(401);
      await denied.body?.cancel();

      // 2) push：gzip 压缩请求体走真实链路（fetch + NodeUndici 自动不重复压缩，
      //    此处手动预压缩以同时覆盖请求解压路径）。
      const event = makeEventPayload();
      const pushBody = JSON.stringify({ events: [event] });
      const { gzipSync } = await import("node:zlib");
      const pushed = await fetch(`${baseUrl}/sync/push`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body: gzipSync(Buffer.from(pushBody, "utf8")),
      });
      expect(pushed.status).toBe(200);
      const pushResult = (await pushed.json()) as { accepted: Array<{ serverSeq: number }> };
      expect(pushResult.accepted).toHaveLength(1);
      expect(pushResult.accepted[0]?.serverSeq).toBe(1);

      // 3) pull：带 Accept-Encoding: gzip 的真实响应。
      const pulled = await fetch(`${baseUrl}/sync/pull?after_seq=0`, {
        headers: { authorization: `Bearer ${token}`, "accept-encoding": "gzip" },
      });
      expect(pulled.status).toBe(200);
      const pullResult = (await pulled.json()) as {
        events: Array<Record<string, unknown>>;
        nextCursor: number;
        hasMore: boolean;
      };
      expect(pullResult.events).toHaveLength(1);
      expect(pullResult.events[0]?.["eventId"]).toBe(event["eventId"]);
      expect(pullResult.nextCursor).toBe(1);
      expect(pullResult.hasMore).toBe(false);

      // 4) settings：真实链路上的全量对账。
      const settingsPut = await fetch(`${baseUrl}/settings`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ settings: [makeSettingEntry()] }),
      });
      expect(settingsPut.status).toBe(200);
      const settingsGet = await fetch(`${baseUrl}/settings`, {
        headers: authHeaders(token),
      });
      const settingsBody = (await settingsGet.json()) as { settings: unknown[] };
      expect(settingsBody.settings).toHaveLength(1);
    } finally {
      await app.close();
      db.close();
    }
  });
});
