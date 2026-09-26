import { describe, expect, it } from "vitest";
import { authHeaders, createTestApp, DEVICE_ID_A, DEVICE_ID_B } from "./helpers.ts";

const base = {
  entityType: "space", entityId: "space-1", deleted: false,
  value: {
    id: "space-1", kind: null, displayOrder: 1, name: "旧名",
    archivedAt: null, createdAt: "2026-09-26T00:00:00Z",
    updatedAt: "2026-09-26T00:00:00Z", learningMode: "常规模式",
  },
  updatedAt: "2026-09-26T00:00:00Z", deviceId: DEVICE_ID_A,
};

describe("内容目录权威存储", () => {
  it("首次上传、幂等重复、跨设备较新版本、删除墓碑与旧写入拒绝", async () => {
    const { app, db, token, close } = await createTestApp();
    const put = (contents: unknown[]) => app.inject({
      method: "PUT", url: "/content", headers: authHeaders(token), payload: { contents },
    });
    const pull = (afterSeq: number) => app.inject({
      method: "GET", url: `/content?after_seq=${afterSeq}&limit=1`, headers: authHeaders(token),
    });
    try {
      expect((await put([base])).statusCode).toBe(200);
      expect(db.prepare("SELECT value FROM sync_counters WHERE name = 'content_seq'").get()).toEqual({ value: 1 });
      expect((await put([base])).statusCode).toBe(200);
      expect(db.prepare("SELECT value FROM sync_counters WHERE name = 'content_seq'").get()).toEqual({ value: 1 });

      const newer = { ...base, value: { ...base.value, name: "新名" },
        updatedAt: "2026-09-26T01:00:00Z", deviceId: DEVICE_ID_B };
      expect((await put([newer])).statusCode).toBe(200);
      const firstPage = (await pull(0)).json() as { contents: Array<{ value: { name: string }; serverSeq: number }>; nextCursor: number };
      // 覆盖式权威目录只保留最新版本；内容游标允许跳号，第一页即获得最终值。
      expect(firstPage.contents[0]?.value.name).toBe("新名");
      expect(firstPage.nextCursor).toBe(2);

      const tombstone = { ...newer, deleted: true, value: null, updatedAt: "2026-09-26T02:00:00Z" };
      expect((await put([tombstone])).statusCode).toBe(200);
      const staleReply = (await put([base])).json() as { contents: Array<{ deleted: boolean; serverSeq: number }> };
      expect(staleReply.contents[0]).toMatchObject({ deleted: true, serverSeq: 3 });
      expect((await pull(2)).json()).toMatchObject({
        contents: [{ deleted: true, serverSeq: 3 }], nextCursor: 3, hasMore: false,
      });
    } finally { close(); }
  });

  it("非法批次原子回滚；未鉴权不可读取或写入", async () => {
    const { app, db, token, close } = await createTestApp();
    try {
      const unauthorized = await app.inject({ method: "GET", url: "/content?after_seq=0" });
      expect(unauthorized.statusCode).toBe(401);
      const invalid = await app.inject({
        method: "PUT", url: "/content", headers: authHeaders(token),
        payload: { contents: [base, { ...base, entityId: "wrong" }] },
      });
      expect(invalid.statusCode).toBe(400);
      expect(db.prepare("SELECT COUNT(*) AS total FROM contents").get()).toEqual({ total: 0 });
    } finally { close(); }
  });
});
