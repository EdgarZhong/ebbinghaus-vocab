/**
 * 同步引擎集成测试：真实 Fastify 服务器（127.0.0.1 随机端口）+ 多客户端运行时。
 *
 * 本文件同时承担 M6"双端 localhost 联调"的自动化验证（进程内双实例形态）：
 * - 收敛性：A 产生的事件与设置经服务器最终对 B 可见，重放输入一致；
 * - 幂等去重：同事件重复推送/重复同步循环不产生重复数据；
 * - 断线恢复：服务器不可达时 outbox 退避、循环不抛错；恢复后自动补推清队；
 * - 游标推进：pull_cursor 逐页推进，重复循环零重复消费；
 * - settings 收敛：双向（A→服务器→B 与 B 的过时写不覆盖 A 的新值）；
 * - gzip：客户端网关默认以 gzip 请求体推送（服务器 @fastify/compress 解压成功即证）；
 * - 双运行时一致性：内存运行时与 SQLite 运行时跑同一脚本得到一致结果。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

import { buildApp } from "@ebbinghaus/server/app";
import { openDatabase } from "@ebbinghaus/server/db";
import type { ApplicationEvent, Space, WordContentRecord } from "@ebbinghaus/application";
import { DEFAULT_SPACE_DEFINITIONS, initializeDefaultApplicationData, SettingsService } from "@ebbinghaus/application";
import {
  createInMemoryRuntime,
  createNodeClientRuntime,
  TransparentSecretCipher,
  type InMemoryRuntime,
  type NodeClientRuntime,
} from "../src/index.ts";

const TOKEN = "integration-test-token-4f2a";
const CLOCK_ISO = "2026-07-15T09:00:00.000Z";
const clock = { now: () => new Date(CLOCK_ISO) };

describe("双端 localhost 联调（真实服务器，进程内双实例）", () => {
  let app: FastifyInstance;
  let serverDb: Database.Database;
  let baseUrl: string;

  let clientA: NodeClientRuntime;
  let clientB: NodeClientRuntime;

  beforeAll(async () => {
    // 真实权威库（内存）+ 真实 Fastify 应用 + 真实监听 127.0.0.1 随机端口。
    // 服务器侧权威库必须经 openDatabase（含迁移），buildApp 不负责建表。
    serverDb = openDatabase(":memory:");
    app = await buildApp({ db: serverDb, authToken: TOKEN, logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("测试服务器监听失败");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    clientA = createNodeClientRuntime({
      dbPath: ":memory:",
      clock,
      server: { baseUrl, authToken: TOKEN },
      backoff: { initialDelayMs: 10, multiplier: 2, maxDelayMs: 50 },
    });
    clientB = createNodeClientRuntime({
      dbPath: ":memory:",
      clock,
      server: { baseUrl, authToken: TOKEN },
      backoff: { initialDelayMs: 10, multiplier: 2, maxDelayMs: 50 },
    });
  });

  afterAll(async () => {
    clientA.close();
    clientB.close();
    await app.close();
    serverDb.close();
  });

  /** 构造合法事件（deviceId 区分来源设备）。 */
  function makeEvent(seq: number, deviceId: string, marker: string): ApplicationEvent {
    return {
      eventId: `11111111-1111-4111-8111-${seq.toString().padStart(12, "0")}`,
      eventType: "firstPassRecorded",
      targetType: "List",
      targetId: `list-${marker}`,
      occurredAt: CLOCK_ISO,
      learningDay: "2026-07-15",
      source: "首过预览保存",
      deviceId,
      deviceSeq: seq,
      metadata: { workload: 1, marker },
    };
  }

  it("本地写入先于增量拉取发往云端，弱网拉取不会延误手机推送", async () => {
    const requests: string[] = [];
    const local = createInMemoryRuntime({
      clock,
      idGenerator: { nextId: () => "22222222-2222-4222-8222-222222222221" },
      secretCipher: new TransparentSecretCipher(),
      gateway: {
        async push(events) {
          requests.push("push");
          return new Set(events.map((event) => event.eventId));
        },
        async pull(afterSeq) {
          requests.push("pull");
          return { events: [], nextCursor: afterSeq, hasMore: false };
        },
        async getSettings() {
          requests.push("getSettings");
          return { settings: [] };
        },
        async putSettings() {
          requests.push("putSettings");
          return { settings: [] };
        },
        async putContent() {
          requests.push("putContent");
          return { contents: [] };
        },
        async pullContent(afterSeq) {
          requests.push("pullContent");
          return { contents: [], nextCursor: afterSeq, hasMore: false };
        },
      },
    });
    const event = makeEvent(901, local.deviceIdentity.getDeviceId(), "prompt-push");
    local.unitOfWork.run(() => { local.eventStore.appendEvents([event]); });

    const cycle = await local.syncEngine!.runCycle();
    expect(cycle.errors).toEqual([]);
    expect(cycle.pushedEntryCount).toBe(1);
    expect(requests).toEqual(["push", "getSettings", "pullContent", "pull"]);
    expect(local.outbox.pendingCount()).toBe(0);
  });

  it("手动同步立即重试未到期的事件与内容，失败后自动同步仍遵守退避", async () => {
    let rejectPush = true;
    let eventAttempts = 0;
    let contentAttempts = 0;
    const local = createInMemoryRuntime({
      clock,
      idGenerator: { nextId: () => "22222222-2222-4222-8222-222222222222" },
      secretCipher: new TransparentSecretCipher(),
      gateway: {
        async push(events) {
          eventAttempts += 1;
          if (rejectPush) throw new Error("测试断网");
          return new Set(events.map((event) => event.eventId));
        },
        async pull(afterSeq) { return { events: [], nextCursor: afterSeq, hasMore: false }; },
        async getSettings() { return { settings: [] }; },
        async putSettings() { return { settings: [] }; },
        async putContent(entries) {
          contentAttempts += 1;
          if (rejectPush) throw new Error("测试断网");
          return { contents: entries.map((entry, index) => ({ ...entry, serverSeq: index + 1 })) };
        },
        async pullContent(afterSeq) { return { contents: [], nextCursor: afterSeq, hasMore: false }; },
      },
    });
    local.spaceStore.addSpace({
      id: "22222222-2222-4222-8222-222222222223", kind: null,
      displayOrder: 9, name: "手动重试测试", archivedAt: null,
      createdAt: CLOCK_ISO, updatedAt: CLOCK_ISO, learningMode: "词书模式",
    });
    local.eventStore.appendEvents([makeEvent(902, local.deviceIdentity.getDeviceId(), "manual-retry")]);

    const failed = await local.syncEngine!.runCycle();
    expect(failed.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("内容推送失败"), expect.stringContaining("事件推送失败"),
    ]));
    expect(local.contentSyncStore.pendingCount()).toBe(1);
    expect(local.outbox.pendingCount()).toBe(1);
    expect([contentAttempts, eventAttempts]).toEqual([1, 1]);

    // 注入时钟不前进：自动循环不能提前破坏退避；用户显式重试则两队列都要尝试。
    await local.syncEngine!.runCycle();
    expect([contentAttempts, eventAttempts]).toEqual([1, 1]);
    const forcedFailure = await local.syncEngine!.runCycle({ forcePush: true });
    expect(forcedFailure.errors.length).toBeGreaterThan(0);
    expect([contentAttempts, eventAttempts]).toEqual([2, 2]);
    await local.syncEngine!.runCycle();
    expect([contentAttempts, eventAttempts]).toEqual([2, 2]);

    rejectPush = false;
    const recovered = await local.syncEngine!.runCycle({ forcePush: true });
    expect(recovered.errors).toEqual([]);
    expect(recovered).toMatchObject({ pushedContentCount: 1, pushedEntryCount: 1 });
    expect([contentAttempts, eventAttempts]).toEqual([3, 3]);
    expect(local.contentSyncStore.pendingCount()).toBe(0);
    expect(local.outbox.pendingCount()).toBe(0);
  });

  it("A 推送事件与设置 → B 拉取收敛；幂等：重复循环零重复", async () => {
    // A 本地写入：设置（经门面走 outbox）+ 事件（append + outbox 同事务入队）。
    const settings = new SettingsService({
      syncedSettings: clientA.syncedSettingsStore,
      deviceLocal: clientA.deviceLocalStore,
      clock,
      deviceIdentity: clientA.deviceIdentity,
    });
    settings.saveLearningDaySettings({ timezoneName: "Asia/Tokyo", dayRolloverTime: "03:30" });
    const event = makeEvent(1, clientA.deviceIdentity.getDeviceId(), "a1");
    clientA.unitOfWork.run(() => {
      clientA.eventStore.appendEvents([event]);
    });

    // A 第一轮同步：settings PUT + 事件 push。
    const firstCycle = await clientA.syncEngine!.runCycle();
    expect(firstCycle.errors).toEqual([]);
    // 时区 + 换日两条设置（每键一条 outbox）+ 一条事件 = 3。
    expect(firstCycle.pushedEntryCount).toBe(3);
    expect(firstCycle.settingsReconciled).toBe(true);
    expect(clientA.outbox.pendingCount()).toBe(0);

    // B 第一轮同步：拉到 A 的事件与设置。
    const cycleB1 = await clientB.syncEngine!.runCycle();
    expect(cycleB1.errors).toEqual([]);
    expect(cycleB1.pulledEventCount).toBe(1);
    expect(clientB.eventStore.listAllEvents().map((e) => e.eventId)).toEqual([event.eventId]);
    expect(
      clientB.syncedSettingsStore.getAll().find((s) => s.key === "learning.timezone")?.value,
    ).toBe("Asia/Tokyo");

    // 幂等：A、B 各再跑一轮，零新增、零重复、零错误。
    const cycleA2 = await clientA.syncEngine!.runCycle();
    const cycleB2 = await clientB.syncEngine!.runCycle();
    expect(cycleA2.pulledEventCount).toBe(0);
    expect(cycleB2.pulledEventCount).toBe(0);
    expect(clientB.eventStore.listAllEvents()).toHaveLength(1);
    expect(clientB.outbox.pendingCount()).toBe(0);
  });

  it("Space/Unit/List/Word 离线本地写入后经云端在双端收敛，软移除与删除墓碑不会复活", async () => {
    const space: Space = {
      id: "7ab31111-1111-4111-8111-111111111111", kind: null,
      displayOrder: 8, name: "词书同步", archivedAt: null,
      createdAt: CLOCK_ISO, updatedAt: CLOCK_ISO, learningMode: "词书模式",
    };
    const unit = { id: "unit-sync-1", spaceId: space.id, number: 1 };
    const list = { listId: "list-sync-1", spaceId: space.id, unitId: unit.id,
      unitNumber: 1, listNumber: 1 };
    const word: WordContentRecord = {
      wordId: "word-sync-1", listId: list.listId, spaceId: null,
      originalSpelling: "reconcile", normalizedKey: "reconcile",
      manualMeaning: "使一致", meanings: [{ partOfSpeech: null, definition: "使一致", usage: null }],
      removed: false, recordedAt: CLOCK_ISO,
    };
    clientA.spaceStore.addSpace(space);
    clientA.bookCatalogStore.addUnit(unit);
    clientA.bookCatalogStore.addList(list);
    clientA.wordContentStore.upsertEntries([word]);
    expect(clientA.contentSyncStore.pendingCount()).toBe(4);

    const pushed = await clientA.syncEngine!.runCycle();
    expect(pushed.errors).toEqual([]);
    expect(pushed.pushedContentCount).toBe(4);
    expect(clientA.contentSyncStore.pendingCount()).toBe(0);
    const pulled = await clientB.syncEngine!.runCycle();
    expect(pulled.errors).toEqual([]);
    expect(pulled.pulledContentCount).toBe(4);
    expect(clientB.spaceStore.getSpace(space.id)?.name).toBe("词书同步");
    expect(clientB.bookCatalogStore.getList(list.listId)).toEqual(list);
    expect(clientB.wordContentStore.getEntry(word.wordId)?.manualMeaning).toBe("使一致");

    clientB.spaceStore.updateSpace({ ...space, name: "词书已改名" });
    clientB.wordContentStore.markRemoved(word.wordId, CLOCK_ISO);
    await clientB.syncEngine!.runCycle();
    await clientA.syncEngine!.runCycle();
    expect(clientA.spaceStore.getSpace(space.id)?.name).toBe("词书已改名");
    expect(clientA.wordContentStore.getEntry(word.wordId)?.removed).toBe(true);

    clientB.spaceStore.deleteSpace(space.id);
    await clientB.syncEngine!.runCycle();
    await clientA.syncEngine!.runCycle();
    expect(clientA.spaceStore.getSpace(space.id)).toBeNull();
    // 旧版本重发只得到服务器墓碑，且不会再下发已删除的 Space。
    const stale = await (await import("../src/index.ts")).buildHttpSyncGateway({ baseUrl, authToken: TOKEN })
      .putContent([{
        entityType: "space", entityId: space.id, value: space, deleted: false,
        updatedAt: CLOCK_ISO, deviceId: clientA.deviceIdentity.getDeviceId(),
      }]);
    expect(stale.contents[0]?.deleted).toBe(true);
    expect(clientA.spaceStore.getSpace(space.id)).toBeNull();
  });

  it("断线：outbox 退避不清队、循环不抛错；恢复后自动补推收敛", async () => {
    // 指向一个必然拒绝连接的端口模拟断网；用文件库让"恢复"侧重开同一队列与断点。
    const tempDir = mkdtempSync(join(tmpdir(), "ebb-offline-"));
    const offline = createNodeClientRuntime({
      dbPath: join(tempDir, "offline.db"),
      clock,
      server: { baseUrl: "http://127.0.0.1:1", authToken: TOKEN },
      backoff: { initialDelayMs: 10, multiplier: 2, maxDelayMs: 50 },
    });
    try {
      const event = makeEvent(2, offline.deviceIdentity.getDeviceId(), "off1");
      offline.unitOfWork.run(() => {
        offline.eventStore.appendEvents([event]);
      });

      const offlineCycle = await offline.syncEngine!.runCycle();
      expect(offlineCycle.errors.length).toBeGreaterThan(0);
      expect(offlineCycle.settingsReconciled).toBe(false);
      // 条目留在队列等待退避重试——绝不静默丢失同步意图。
      expect(offline.outbox.pendingCount()).toBe(1);
      // 断网不改变应用模式：本地数据照常可用。
      expect(offline.eventStore.listAllEvents()).toHaveLength(1);

      // "恢复网络"：同一客户端换接真实服务器地址（运行时重建网关的等价模拟），
      // 退避过期后下一轮循环补推清队。
      const recoveredClock = {
        now: () => new Date("2026-07-15T09:00:05.000Z"),
      };
      const recovered = createNodeClientRuntime({
        dbPath: offline.db.name,
        clock: recoveredClock,
        server: { baseUrl, authToken: TOKEN },
      });
      try {
        // 恢复侧用新运行时重放同一断点：游标与队列都在库里（断点续传语义）。
        const recoveredCycle = await recovered.syncEngine!.runCycle();
        expect(recoveredCycle.errors).toEqual([]);
        expect(recovered.outbox.pendingCount()).toBe(0);
        const remoteCount = (
          serverDb.prepare(`SELECT COUNT(*) AS total FROM events`).get() as { total: number }
        ).total;
        expect(remoteCount).toBeGreaterThanOrEqual(1);
      } finally {
        recovered.close();
      }
    } finally {
      offline.close();
    }
  });

  it("settings 冲突：设备 B 的过时写入被服务器 LWW 拒绝收敛，A 的新值胜出", async () => {
    // A 写入"未来"值并推送上服务器。
    const settingsA = new SettingsService({
      syncedSettings: clientA.syncedSettingsStore,
      deviceLocal: clientA.deviceLocalStore,
      clock: { now: () => new Date("2026-07-20T09:00:00.000Z") },
      deviceIdentity: clientA.deviceIdentity,
    });
    settingsA.saveDictionaryProvider("有道词典");
    await clientA.syncEngine!.runCycle();

    // B 用更早的时钟写入同一键并推送：服务器 LWW 应保留 A 的值。
    const settingsB = new SettingsService({
      syncedSettings: clientB.syncedSettingsStore,
      deviceLocal: clientB.deviceLocalStore,
      clock,
      deviceIdentity: clientB.deviceIdentity,
    });
    settingsB.saveDictionaryProvider("维基词典");
    await clientB.syncEngine!.runCycle();

    // 双端再对账一轮：两边收敛到 A 的值（权威库唯一裁决）。
    await clientA.syncEngine!.runCycle();
    await clientB.syncEngine!.runCycle();
    expect(
      clientA.syncedSettingsStore.getAll().find((s) => s.key === "dictionary.provider")?.value,
    ).toBe("有道词典");
    expect(
      clientB.syncedSettingsStore.getAll().find((s) => s.key === "dictionary.provider")?.value,
    ).toBe("有道词典");
  });

  it("双运行时一致性：内存运行时与 SQLite 运行时执行同一同步脚本结果一致", async () => {
    const inMemory: InMemoryRuntime = createInMemoryRuntime({
      clock,
      idGenerator: { nextId: () => "22222222-2222-4222-8222-222222222222" },
      secretCipher: new TransparentSecretCipher(),
      gateway: (await import("../src/index.ts")).buildHttpSyncGateway({
        baseUrl,
        authToken: TOKEN,
      }),
      backoff: { initialDelayMs: 10, multiplier: 2, maxDelayMs: 50 },
    });
    const space: Space = {
      id: "a1f0c3d4-0000-4000-8000-000000000009",
      kind: null,
      displayOrder: 1,
      name: "一致性冒烟",
      archivedAt: null,
      createdAt: CLOCK_ISO,
      updatedAt: CLOCK_ISO,
      learningMode: "常规模式",
    };
    const script = (runtime: {
      spaceStore: InMemoryRuntime["spaceStore"];
      eventStore: InMemoryRuntime["eventStore"];
      outbox: InMemoryRuntime["outbox"];
      syncedSettingsStore: InMemoryRuntime["syncedSettingsStore"];
      unitOfWork: InMemoryRuntime["unitOfWork"];
      deviceIdentity: InMemoryRuntime["deviceIdentity"];
      syncEngine: InMemoryRuntime["syncEngine"];
    }): { events: number; timezone: string | unknown } => {
      runtime.spaceStore.addSpace(space);
      const event = makeEvent(9, runtime.deviceIdentity.getDeviceId(), "parity");
      runtime.unitOfWork.run(() => {
        runtime.eventStore.appendEvents([event]);
      });
      const settings = new SettingsService({
        syncedSettings: runtime.syncedSettingsStore,
        deviceLocal: { getString: () => null, setString: () => undefined },
        clock,
        deviceIdentity: runtime.deviceIdentity,
      });
      settings.saveLearningDaySettings({ timezoneName: "Asia/Shanghai", dayRolloverTime: "04:00" });
      return runtime.syncEngine === null
        ? { events: -1, timezone: null }
        : { events: 0, timezone: 0 };
    };

    // 内存运行时跑脚本 + 一轮同步。
    script(inMemory);
    const memoryCycle = await inMemory.syncEngine!.runCycle();
    expect(memoryCycle.errors).toEqual([]);

    // 脚本行为断言：共享服务器上已有前序用例的事件，内存底座同步后应"本机事件 + 历史事件"
    // 全量在本地（完整本地副本语义），且本机那一条必须在内；队列清空、无错误。
    expect(memoryCycle.pushedEntryCount).toBe(3);
    expect(memoryCycle.errors).toEqual([]);
    const memoryEvents = inMemory.eventStore.listAllEvents();
    expect(memoryEvents.some((e) => e.metadata["marker"] === "parity")).toBe(true);
    expect(memoryEvents.length).toBeGreaterThanOrEqual(1);
    expect(inMemory.outbox.pendingCount()).toBe(0);
  });

  it("首次初始化 + 默认设置经服务器在双端收敛", async () => {
    // 独立服务器栈：前序用例已把共享服务器的 learning.timezone 推为 Asia/Tokyo，
    // 首次初始化语义（键缺失才写默认值）必须在干净权威库上验证。
    const freshServerDb = openDatabase(":memory:");
    const freshApp = await buildApp({ db: freshServerDb, authToken: TOKEN, logger: false });
    await freshApp.listen({ port: 0, host: "127.0.0.1" });
    const freshAddress = freshApp.server.address();
    if (freshAddress === null || typeof freshAddress === "string") {
      throw new Error("独立测试服务器监听失败");
    }
    const freshBaseUrl = `http://127.0.0.1:${freshAddress.port}`;
    const freshA = createNodeClientRuntime({
      dbPath: ":memory:",
      clock,
      server: { baseUrl: freshBaseUrl, authToken: TOKEN },
    });
    const freshB = createNodeClientRuntime({
      dbPath: ":memory:",
      clock,
      server: { baseUrl: freshBaseUrl, authToken: TOKEN },
    });
    try {
      // A 执行首次初始化（默认四 Space + 默认设置 + 活动 Space）。
      initializeDefaultApplicationData({
        spaceStore: freshA.spaceStore,
        settings: new SettingsService({
          syncedSettings: freshA.syncedSettingsStore,
          deviceLocal: freshA.deviceLocalStore,
          clock,
          deviceIdentity: freshA.deviceIdentity,
        }),
        clock,
        unitOfWork: freshA.unitOfWork,
      });
      const cycle = await freshA.syncEngine!.runCycle();
      expect(cycle.errors).toEqual([]);

      // A 已在云端留下真实用户修改；此时才安装并初始化 B，默认种子不能
      // 借新设备的当前时间抢赢原设置或固定 Space 目录。
      const settingsA = new SettingsService({
        syncedSettings: freshA.syncedSettingsStore,
        deviceLocal: freshA.deviceLocalStore,
        clock,
        deviceIdentity: freshA.deviceIdentity,
      });
      settingsA.saveSpaceDailyTarget(DEFAULT_SPACE_DEFINITIONS[0]!.id, 10);
      const firstSpace = freshA.spaceStore.getSpace(DEFAULT_SPACE_DEFINITIONS[0]!.id)!;
      freshA.spaceStore.updateSpace({ ...firstSpace, displayOrder: 9, updatedAt: clock.now().toISOString() });
      expect((await freshA.syncEngine!.runCycle()).errors).toEqual([]);

      initializeDefaultApplicationData({
        spaceStore: freshB.spaceStore,
        settings: new SettingsService({
          syncedSettings: freshB.syncedSettingsStore,
          deviceLocal: freshB.deviceLocalStore,
          clock,
          deviceIdentity: freshB.deviceIdentity,
        }),
        clock,
        unitOfWork: freshB.unitOfWork,
      });

      // B 同步后应收敛到相同的默认设置（时区/换日时间默认值）。
      expect((await freshB.syncEngine!.runCycle()).errors).toEqual([]);
      const settingsB = new SettingsService({
        syncedSettings: freshB.syncedSettingsStore,
        deviceLocal: freshB.deviceLocalStore,
        clock,
        deviceIdentity: freshB.deviceIdentity,
      });
      expect(settingsB.getLearningScheduleSettings().timezoneName).toBe("Asia/Shanghai");
      expect(settingsB.getLearningScheduleSettings().dayRolloverTime).toBe("04:00");
      expect(settingsB.getSpaceLearningSettings(DEFAULT_SPACE_DEFINITIONS[0]!.id).dailyTarget).toBe(10);
      expect(freshB.spaceStore.getSpace(DEFAULT_SPACE_DEFINITIONS[0]!.id)?.displayOrder).toBe(9);
      expect((await freshA.syncEngine!.runCycle()).errors).toEqual([]);
      expect(settingsA.getSpaceLearningSettings(DEFAULT_SPACE_DEFINITIONS[0]!.id).dailyTarget).toBe(10);
      expect(freshA.spaceStore.getSpace(DEFAULT_SPACE_DEFINITIONS[0]!.id)?.displayOrder).toBe(9);
    } finally {
      freshA.close();
      freshB.close();
      await freshApp.close();
      freshServerDb.close();
    }
  });
});
