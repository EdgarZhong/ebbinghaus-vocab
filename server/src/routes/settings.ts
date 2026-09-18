/**
 * settings KV 路由：GET /settings 与 PUT /settings（判断文件 B1/B2/D2）。
 *
 * 服务器对 settings 是"哑 KV"：不理解键语义（Space 级键与全局键一视同仁），
 * 只按 protocol 定稿的 LWW 规则逐键合并。LWW 判定逻辑（updatedAt 大者胜；相等时
 * deviceId 字典序大者胜；再相等按 value 序列化串决胜）**直接调用 protocol 导出的
 * mergeSettings**，本文件不重写任何合并规则——收敛规则只有一份真理源，双端
 * （客户端仓库与服务器）必须共享同一实现。
 *
 * D2 口径：不引入 settings 版本游标，每次全量对账；PUT 返回合并后的（全量）条目，
 * 客户端直接把本地状态对齐到服务器权威视图。
 *
 * server_updated_at 是服务器附加的存储元数据（本次胜出值的落库时刻），用于运维
 * 观测；protocol settingEntrySchema 是 strip 模式，响应携带该字段兼容协议
 * （协议注释明确允许服务器附加元数据）。
 */

import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

import {
  mergeSettings,
  settingsGetResponseSchema,
  settingsPutRequestSchema,
  settingsPutResponseSchema,
  type SettingEntry,
} from "@ebbinghaus/protocol";
import { z } from "zod";

import { parseOutgoingContract } from "../contract.ts";
import { validationFailedError } from "../errors.ts";
import type { SettingRow, SyncStore } from "../store.ts";

/** settings 表行 → 协议条目（value_json 反序列化；服务器只存取不解读 value）。 */
function rowToEntry(row: SettingRow): SettingEntry & { serverUpdatedAt: string } {
  return {
    key: row.key,
    value: JSON.parse(row.valueJson) as unknown,
    updatedAt: row.updatedAt,
    deviceId: row.deviceId,
    serverUpdatedAt: row.serverUpdatedAt,
  };
}

/**
 * 判断合并条目相对库中现状是否发生了实质变化（决定是否落库与刷新 server_updated_at）。
 * value 以 JSON 文本全等比较：与 LWW 决胜用的序列化口径一致（此处输入均来自
 * JSON 反序列化，不存在 undefined，无需 protocol 的 undefined 归一变体）。
 */
function isSameAsStored(entry: SettingEntry, stored: SettingEntry): boolean {
  return (
    entry.updatedAt === stored.updatedAt &&
    entry.deviceId === stored.deviceId &&
    JSON.stringify(entry.value) === JSON.stringify(stored.value)
  );
}

/** 注册 /settings 路由。deps 由组合根注入。 */
export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database; store: SyncStore; now: () => Date },
): void {
  const { db, store, now } = deps;

  // GET /settings：全量 KV（D2：无版本游标，全量对账）。
  app.get("/settings", async (_request, reply) => {
    const entries = store.listSettingRows().map(rowToEntry);
    // 条目含 serverUpdatedAt 附加元数据；协议 schema strip 兼容，仅校验四要素。
    parseOutgoingContract(settingsGetResponseSchema, { settings: entries });
    await reply.code(200).send({ settings: entries });
  });

  // PUT /settings：批量条目逐键 LWW 合并。
  app.put("/settings", async (request, reply) => {
    const parsed = settingsPutRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailedError(z.prettifyError(parsed.error));
    }
    const incoming = parsed.data.settings;

    // 合并三步走，全部在单事务内（读现状 → LWW 决胜 → 落库），与 push 一致的
    // 批量原子性：避免并发 PUT 交错导致半新半旧的中间态。
    const applyMerge = db.transaction(() => {
      // 1) 库中现状作为 LWW 的"本地侧"输入（协议条目形态，不含服务器元数据）。
      const storedRows = store.listSettingRows().map(rowToEntry);
      // 2) 直接调用 protocol 合并函数：胜者裁决只有这一份实现（任务硬性口径）。
      const merged = mergeSettings(storedRows, incoming);

      // 3) 只把"相对库中现状发生实质变化"的条目写回（幂等 PUT 的关键：
      //    重复提交相同条目时零写入、server_updated_at 不刷新）。
      const responseEntries: Array<SettingEntry & { serverUpdatedAt: string }> = [];
      const storedByKey = new Map(storedRows.map((entry) => [entry.key, entry]));

      for (const entry of merged) {
        const stored = storedByKey.get(entry.key);
        if (stored !== undefined && isSameAsStored(entry, stored)) {
          responseEntries.push({ ...entry, serverUpdatedAt: stored.serverUpdatedAt });
          continue;
        }
        const serverUpdatedAt = now().toISOString();
        store.upsertSettingRow({
          key: entry.key,
          valueJson: JSON.stringify(entry.value),
          updatedAt: entry.updatedAt,
          deviceId: entry.deviceId,
          serverUpdatedAt,
        });
        responseEntries.push({ ...entry, serverUpdatedAt });
      }

      return responseEntries;
    });

    const responseEntries = applyMerge();

    // 响应 = 合并后全量条目（协议口径），自校验后返回。
    parseOutgoingContract(settingsPutResponseSchema, { settings: responseEntries });
    await reply.code(200).send({ settings: responseEntries });
  });
}
