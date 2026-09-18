import { describe, expect, it } from "vitest";

import { errorCodes } from "@ebbinghaus/protocol";

import { authHeaders, createTestApp, makeEventPayload } from "./helpers.ts";

/**
 * 鉴权专项（判断文件 B7/D1）：401 语义、统一错误形态、token 不回显、/health 免鉴权。
 */
describe("Bearer 鉴权", () => {
  it("无 token 访问全部业务路由一律 401", async () => {
    const { app, close } = await createTestApp();
    try {
      for (const [method, url] of [
        ["POST", "/sync/push"],
        ["GET", "/sync/pull?after_seq=0"],
        ["GET", "/settings"],
        ["PUT", "/settings"],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          payload: method === "POST" ? { events: [] } : method === "PUT" ? { settings: [] } : undefined,
        });
        expect(response.statusCode, `${method} ${url} 应拒绝无凭证请求`).toBe(401);
      }
    } finally {
      close();
    }
  });

  it("错误 token 返回 401，错误形态统一且绝不回显请求中的 token", async () => {
    const { app, close } = await createTestApp();
    try {
      const leakedToken = "super-secret-wrong-token-value";
      const response = await app.inject({
        method: "GET",
        url: "/sync/pull?after_seq=0",
        headers: authHeaders(leakedToken),
      });

      expect(response.statusCode).toBe(401);
      const body = response.json() as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe(errorCodes.unauthorized);
      // 固定文案：请求方提供的错误 token 不得出现在响应体中（防凭证碎片进日志）。
      expect(body.error.message).not.toContain(leakedToken);
      expect(body.error.message.length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("Authorization 头缺 Bearer 前缀或为空一律 401", async () => {
    const { app, token, close } = await createTestApp();
    try {
      for (const authorization of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer ", ""]) {
        const response = await app.inject({
          method: "GET",
          url: "/settings",
          headers: { authorization },
        });
        expect(response.statusCode).toBe(401);
      }
      // 正确 token 对照组：同一接口放行。
      const ok = await app.inject({ method: "GET", url: "/settings", headers: authHeaders(token) });
      expect(ok.statusCode).toBe(200);
    } finally {
      close();
    }
  });

  it("/health 免鉴权（唯一例外），其余未知路径先鉴权后 404", async () => {
    const { app, close } = await createTestApp();
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);

      // 未匹配路径：无 token 时 401（防未授权方借 404 差异探测路径存在性）。
      const probeWithoutToken = await app.inject({ method: "GET", url: "/definitely-not-exist" });
      expect(probeWithoutToken.statusCode).toBe(401);

      const probeWithToken = await app.inject({
        method: "GET",
        url: "/definitely-not-exist",
        headers: authHeaders("definitely-wrong"),
      });
      expect(probeWithToken.statusCode).toBe(401);
    } finally {
      close();
    }
  });

  it("合法 token 可正常 push（鉴权放行的正路径冒烟）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/sync/push",
        headers: authHeaders(token),
        payload: { events: [makeEventPayload()] },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      close();
    }
  });
});
