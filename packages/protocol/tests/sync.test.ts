import { describe, expect, it } from "vitest";

import {
  errorCodes,
  errorResponseSchema,
  healthResponseSchema,
  settingsGetResponseSchema,
  settingsPutRequestSchema,
  settingsPutResponseSchema,
  syncEventReceiptSchema,
  syncPullQuerySchema,
  syncPullResponseSchema,
  syncPushRequestSchema,
  syncPushResponseSchema,
} from "../src/sync.ts";
import { makeEvent, makeStoredEvent, SAMPLE_EVENT_ID, SAMPLE_OCCURRED_AT } from "./fixtures.ts";

describe("POST /sync/push 契约", () => {
  it("批量事件请求通过解析，逐事件信封与 metadata 完整校验", () => {
    const request = {
      events: [makeEvent("firstPassRecorded"), makeEvent("testAnswered"), makeEvent("wordAdded")],
    };
    const parsed = syncPushRequestSchema.safeParse(request);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.events).toHaveLength(3);
    }
  });

  it("请求中任一事件非法则整体被拒（服务器 400，客户端不入 outbox）", () => {
    const request = {
      events: [makeEvent("wordAdded"), makeEvent("wordAdded", { deviceSeq: 0 })],
    };
    expect(syncPushRequestSchema.safeParse(request).success).toBe(false);
  });

  it("events 缺失或非数组被拒", () => {
    expect(syncPushRequestSchema.safeParse({}).success).toBe(false);
    expect(syncPushRequestSchema.safeParse({ events: "wordAdded" }).success).toBe(false);
  });

  it("回执要求 eventId 为 UUIDv4 且 serverSeq 为正整数", () => {
    expect(
      syncEventReceiptSchema.safeParse({ eventId: SAMPLE_EVENT_ID, serverSeq: 7 }).success,
    ).toBe(true);
    expect(
      syncEventReceiptSchema.safeParse({ eventId: SAMPLE_EVENT_ID, serverSeq: 0 }).success,
    ).toBe(false);
    expect(
      syncEventReceiptSchema.safeParse({ eventId: "bad", serverSeq: 7 }).success,
    ).toBe(false);
  });

  it("push 响应的 accepted 与 duplicated 逐事件回执形态合法", () => {
    const response = {
      accepted: [
        { eventId: SAMPLE_EVENT_ID, serverSeq: 101 },
      ],
      duplicated: [
        { eventId: "c8f3a4b5-2d6e-4f9a-8b1c-3d4e5f6a7b8c", serverSeq: 57 },
      ],
    };
    expect(syncPushResponseSchema.safeParse(response).success).toBe(true);
  });

  it("push 响应缺 accepted 或 duplicated 数组被拒", () => {
    expect(
      syncPushResponseSchema.safeParse({ accepted: [] }).success,
    ).toBe(false);
  });
});

describe("GET /sync/pull 契约", () => {
  it("after_seq 与 limit 的合法查询参数通过解析", () => {
    expect(syncPullQuerySchema.safeParse({ after_seq: 0 }).success).toBe(true);
    expect(syncPullQuerySchema.safeParse({ after_seq: 1234, limit: 500 }).success).toBe(true);
  });

  it("after_seq 负数、小数或缺失被拒；limit 非正整数被拒", () => {
    expect(syncPullQuerySchema.safeParse({ after_seq: -1 }).success).toBe(false);
    expect(syncPullQuerySchema.safeParse({ after_seq: 1.5 }).success).toBe(false);
    expect(syncPullQuerySchema.safeParse({}).success).toBe(false);
    expect(syncPullQuerySchema.safeParse({ after_seq: 0, limit: 0 }).success).toBe(false);
  });

  it("查询参数保留字符串形态被拒：字符串到数字的解析是传输层职责", () => {
    // URL query 原始值是字符串；schema 校验的是解析后的数值对象，
    // 把字符串直接喂给契约 schema 必须失败，防止隐式 coercion 掩盖传输层 bug。
    expect(syncPullQuerySchema.safeParse({ after_seq: "1234" }).success).toBe(false);
  });

  it("pull 响应携带按 serverSeq 升序的存储事件页与游标推进字段", () => {
    const response = {
      events: [
        makeStoredEvent("firstPassRecorded", { serverSeq: 100 }),
        makeStoredEvent("testAnswered", { serverSeq: 101 }),
      ],
      nextCursor: 101,
      hasMore: true,
    };
    const parsed = syncPullResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it("空页响应合法（nextCursor 等于请求的 after_seq）", () => {
    const response = { events: [], nextCursor: 1234, hasMore: false };
    expect(syncPullResponseSchema.safeParse(response).success).toBe(true);
  });

  it("响应中事件缺 serverSeq 或 hasMore 缺失被拒", () => {
    expect(
      syncPullResponseSchema.safeParse({
        events: [makeEvent("testAnswered")],
        nextCursor: 1,
        hasMore: false,
      }).success,
    ).toBe(false);
    expect(
      syncPullResponseSchema.safeParse({ events: [], nextCursor: 1 }).success,
    ).toBe(false);
  });
});

describe("GET /settings 与 PUT /settings 契约", () => {
  const entry = {
    key: "learning.timezone",
    value: "Asia/Shanghai",
    updatedAt: SAMPLE_OCCURRED_AT,
    deviceId: "b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b",
  };

  it("GET 响应与 PUT 请求的条目数组形态合法", () => {
    expect(settingsGetResponseSchema.safeParse({ settings: [entry] }).success).toBe(true);
    expect(settingsPutRequestSchema.safeParse({ settings: [entry] }).success).toBe(true);
  });

  it("PUT 响应返回合并后条目数组，缺 settings 字段被拒", () => {
    expect(settingsPutResponseSchema.safeParse({ settings: [entry] }).success).toBe(true);
    expect(settingsPutResponseSchema.safeParse({}).success).toBe(false);
  });

  it("条目非法（坏 updatedAt）时 GET/PUT 全部被拒", () => {
    const broken = { ...entry, updatedAt: "昨夜" };
    expect(settingsGetResponseSchema.safeParse({ settings: [broken] }).success).toBe(false);
    expect(settingsPutRequestSchema.safeParse({ settings: [broken] }).success).toBe(false);
  });
});

describe("GET /health 契约", () => {
  it("status 必须字面等于 ok，now 必须可解析", () => {
    expect(
      healthResponseSchema.safeParse({ status: "ok", now: SAMPLE_OCCURRED_AT }).success,
    ).toBe(true);
    expect(
      healthResponseSchema.safeParse({ status: "degraded", now: SAMPLE_OCCURRED_AT }).success,
    ).toBe(false);
    expect(healthResponseSchema.safeParse({ status: "ok", now: "now" }).success).toBe(false);
  });
});

describe("统一错误响应契约（判断文件 B7）", () => {
  it("统一 { error: { code, message } } 形态，code 建议值可用", () => {
    const response = {
      error: { code: errorCodes.validationFailed, message: "请求体 schema 校验失败" },
    };
    expect(errorResponseSchema.safeParse(response).success).toBe(true);
  });

  it("code 或 message 为空被拒；error 结构缺失被拒", () => {
    expect(
      errorResponseSchema.safeParse({ error: { code: "", message: "x" } }).success,
    ).toBe(false);
    expect(errorResponseSchema.safeParse({ error: { code: "X", message: "" } }).success).toBe(
      false,
    );
    expect(errorResponseSchema.safeParse({ error: "boom" }).success).toBe(false);
  });
});
