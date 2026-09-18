/**
 * 服务器测试共享设施。
 *
 * 说明：协议事件/设置条目的"测试数据构造器"在此独立实现（fixture 形态参考
 * protocol 契约测试），契约校验本身全部复用 @ebbinghaus/protocol 的 schema——
 * 服务器测试不重定义协议，只构造合法/非法样本。
 *
 * 临时目录策略：每个测试夹具在系统临时目录下建独立子目录（mkdtemp），**测试后
 * 不删除**（遵守项目"永不删除文件"约束），残留交由操作系统临时目录清理机制回收。
 */

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

/** 合法 UUIDv4 设备标识（客户端 A / B 各一，供多客户端场景区分）。 */
export const DEVICE_ID_A = "11111111-2222-4333-8444-555555555555";
export const DEVICE_ID_B = "99999999-8888-4777-8666-777777777777";

/** 设备内序号发生器：默认保证同一 device 的 deviceSeq 全局递增，避免误触
 *  UNIQUE(device_id, device_seq) 约束（需要测约束冲突的用例显式覆盖 deviceSeq）。 */
let deviceSeqCounter = 0;
export function nextDeviceSeq(): number {
  deviceSeqCounter += 1;
  return deviceSeqCounter;
}

/**
 * 构造一条协议合法的 push 载荷事件。
 * 默认用 taskDeferred 类型（协议允许其 metadata 为任意 JSON 对象），需要覆盖
 * 任意字段的用例直接传 overrides；需要"协议非法"样本的用例也通过 overrides 构造。
 */
export function makeEventPayload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    eventId: randomUUID(),
    eventType: "taskDeferred",
    targetType: "List",
    targetId: "list-1",
    occurredAt: "2026-09-19T12:30:00Z",
    learningDay: "2026-09-19",
    source: "服务器专项测试",
    deviceId: DEVICE_ID_A,
    deviceSeq: nextDeviceSeq(),
    metadata: { deferredFrom: "2026-09-19" },
    ...overrides,
  };
}

/** 构造一条协议合法的 settings 条目样本。 */
export function makeSettingEntry(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    key: "learning.timezone",
    value: "Asia/Shanghai",
    updatedAt: "2026-09-19T10:00:00Z",
    deviceId: DEVICE_ID_A,
    ...overrides,
  };
}

/** Bearer 鉴权头。 */
export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** 一个完整测试应用：临时库 + 随机 token + 注入式时钟（默认真实时钟）。 */
export interface TestApp {
  readonly app: FastifyInstance;
  readonly db: Database.Database;
  readonly token: string;
  readonly dbPath: string;
  readonly tempDir: string;
  /** 收尾：关闭 HTTP 实例与库句柄（不删除临时文件）。 */
  close(): void;
}

export async function createTestApp(options: { now?: () => Date } = {}): Promise<TestApp> {
  const tempDir = mkdtempSync(join(tmpdir(), "ebb-server-test-"));
  const dbPath = join(tempDir, "authority.db");
  const db = openDatabase(dbPath);
  const token = randomBytes(24).toString("hex");
  const app = await buildApp({ db, authToken: token, now: options.now });

  return {
    app,
    db,
    token,
    dbPath,
    tempDir,
    close() {
      app.close();
      db.close();
    },
  };
}

/** push 便捷方法：返回 inject 结果。 */
export async function pushEvents(
  app: FastifyInstance,
  token: string,
  events: readonly unknown[],
): Promise<{ statusCode: number; body: unknown }> {
  const response = await app.inject({
    method: "POST",
    url: "/sync/push",
    headers: authHeaders(token),
    payload: { events: [...events] },
  });
  return { statusCode: response.statusCode, body: response.json() };
}

/** pull 便捷方法。 */
export async function pullEvents(
  app: FastifyInstance,
  token: string,
  query: string,
): Promise<{ statusCode: number; body: unknown; headers: Record<string, unknown> }> {
  const response = await app.inject({
    method: "GET",
    url: `/sync/pull${query}`,
    headers: authHeaders(token),
  });
  return { statusCode: response.statusCode, body: response.json(), headers: response.headers };
}
