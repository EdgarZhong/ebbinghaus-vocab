import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { settingsGetResponseSchema } from "@ebbinghaus/protocol";

import {
  DEVICE_ID_A,
  DEVICE_ID_B,
  authHeaders,
  createTestApp,
  makeSettingEntry,
} from "./helpers.ts";

interface SettingsBody {
  settings: Array<{
    key: string;
    value: unknown;
    updatedAt: string;
    deviceId: string;
    serverUpdatedAt: string;
  }>;
}

async function getSettings(
  app: FastifyInstance,
  token: string,
): Promise<{ statusCode: number; body: SettingsBody }> {
  const response = await app.inject({ method: "GET", url: "/settings", headers: authHeaders(token) });
  return { statusCode: response.statusCode, body: response.json() as SettingsBody };
}

async function putSettings(
  app: FastifyInstance,
  token: string,
  settings: readonly unknown[],
): Promise<{ statusCode: number; body: SettingsBody }> {
  const response = await app.inject({
    method: "PUT",
    url: "/settings",
    headers: authHeaders(token),
    payload: { settings: [...settings] },
  });
  return { statusCode: response.statusCode, body: response.json() as SettingsBody };
}

/** 按键取条目。 */
function findEntry(body: SettingsBody, key: string): SettingsBody["settings"][number] | undefined {
  return body.settings.find((entry) => entry.key === key);
}

/**
 * settings 专项（任务规格 6 + 判断文件 B1/D2）：LWW 合并、tie-break、幂等、全量对账。
 * LWW 判定本身复用 protocol mergeSettings，此处验证服务器把它接进了正确的事务与
 * 存储路径。
 */
describe("GET /settings 与 PUT /settings", () => {
  it("初始 GET 返回空全量；PUT 后 GET 返回带值条目（对象值正确反序列化）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      expect((await getSettings(app, token)).body.settings).toEqual([]);

      const entry = makeSettingEntry({
        key: "learning.schedulerParameters",
        value: { targetRate: 0.9, weights: [1, 2, 3] },
      });
      const put = await putSettings(app, token, [entry]);
      expect(put.statusCode).toBe(200);

      const got = await getSettings(app, token);
      const stored = findEntry(got.body, "learning.schedulerParameters");
      expect(stored?.value).toEqual({ targetRate: 0.9, weights: [1, 2, 3] });
      expect(stored?.updatedAt).toBe("2026-09-19T10:00:00Z");
      expect(stored?.deviceId).toBe(DEVICE_ID_A);
    } finally {
      close();
    }
  });

  it("LWW：updatedAt 更新的条目覆盖旧值（规格 6）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      await putSettings(app, token, [
        makeSettingEntry({ value: "旧值", updatedAt: "2026-09-19T10:00:00Z" }),
      ]);
      await putSettings(app, token, [
        makeSettingEntry({ value: "新值", updatedAt: "2026-09-19T11:00:00Z" }),
      ]);

      const got = await getSettings(app, token);
      expect(findEntry(got.body, "learning.timezone")?.value).toBe("新值");
    } finally {
      close();
    }
  });

  it("LWW：updatedAt 更旧的条目不得覆盖库中较新的值（后到不等于后写）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      await putSettings(app, token, [
        makeSettingEntry({ value: "新值", updatedAt: "2026-09-19T11:00:00Z" }),
      ]);
      // 旧客户端离线后补传的旧条目：不应回滚权威库。
      await putSettings(app, token, [
        makeSettingEntry({ value: "旧值", updatedAt: "2026-09-19T10:00:00Z" }),
      ]);

      const got = await getSettings(app, token);
      expect(findEntry(got.body, "learning.timezone")?.value).toBe("新值");
    } finally {
      close();
    }
  });

  it("updatedAt 相同时 deviceId 字典序大者胜，且后续更小 deviceId 不再覆盖（规格 6）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      // DEVICE_ID_A（1111…） < DEVICE_ID_B（9999…），同一时刻写入。
      await putSettings(app, token, [
        makeSettingEntry({ value: "来自A", deviceId: DEVICE_ID_A }),
      ]);
      await putSettings(app, token, [
        makeSettingEntry({ value: "来自B", deviceId: DEVICE_ID_B }),
      ]);
      expect(findEntry((await getSettings(app, token)).body, "learning.timezone")?.value).toBe("来自B");

      // 再来一个字典序更小的设备、同时刻：结果保持确定性，不被到达顺序影响。
      await putSettings(app, token, [
        makeSettingEntry({ value: "来自更小的设备", deviceId: "00000000-0000-4000-8000-000000000000" }),
      ]);
      expect(findEntry((await getSettings(app, token)).body, "learning.timezone")?.value).toBe("来自B");
    } finally {
      close();
    }
  });

  it("重复 PUT 相同条目幂等：值不变且 server_updated_at 不刷新（规格 6）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      const entry = makeSettingEntry();
      await putSettings(app, token, [entry]);
      const first = findEntry((await getSettings(app, token)).body, "learning.timezone");

      // 等待一个真实时间刻度后再重复提交，若 server_updated_at 被刷新即可检出。
      await new Promise((resolve) => setTimeout(resolve, 15));
      await putSettings(app, token, [entry]);
      const second = findEntry((await getSettings(app, token)).body, "learning.timezone");

      expect(second?.value).toBe(first?.value);
      expect(second?.serverUpdatedAt).toBe(first?.serverUpdatedAt);
    } finally {
      close();
    }
  });

  it("PUT 空数组返回现有全量（全量对账语义）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      await putSettings(app, token, [makeSettingEntry()]);
      const put = await putSettings(app, token, []);
      expect(put.statusCode).toBe(200);
      expect(put.body.settings).toHaveLength(1);
      expect((await getSettings(app, token)).body.settings).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("PUT 返回合并后的全量条目（多键场景，含未出现在本次请求中的键）", async () => {
    const { app, token, close } = await createTestApp();
    try {
      await putSettings(app, token, [
        makeSettingEntry({ key: "learning.timezone", value: "Asia/Shanghai" }),
      ]);
      const put = await putSettings(app, token, [
        makeSettingEntry({ key: "dictionary.provider", value: "youdao" }),
      ]);
      expect(put.body.settings.map((entry) => entry.key).sort()).toEqual([
        "dictionary.provider",
        "learning.timezone",
      ]);
    } finally {
      close();
    }
  });

  it("非法条目（键名不合命名规则 / 坏 updatedAt）400 且不入库", async () => {
    const { app, token, close } = await createTestApp();
    try {
      for (const bad of [
        makeSettingEntry({ key: "single-segment" }),
        makeSettingEntry({ updatedAt: "昨天" }),
        makeSettingEntry({ deviceId: "not-a-uuid" }),
      ]) {
        const { statusCode, body } = await putSettings(app, token, [bad]);
        expect(statusCode).toBe(400);
        // 400 响应体是错误形态而非 SettingsBody，经 unknown 双重断言读取错误码。
        expect((body as unknown as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
      }
      expect((await getSettings(app, token)).body.settings).toEqual([]);
    } finally {
      close();
    }
  });

  it("GET 响应整体符合 protocol 契约 schema", async () => {
    const { app, token, close } = await createTestApp();
    try {
      await putSettings(app, token, [makeSettingEntry()]);
      const { body } = await getSettings(app, token);
      // 响应携带服务器附加的 serverUpdatedAt 元数据，协议 strip 兼容。
      expect(settingsGetResponseSchema.safeParse(body).success).toBe(true);
    } finally {
      close();
    }
  });
});
