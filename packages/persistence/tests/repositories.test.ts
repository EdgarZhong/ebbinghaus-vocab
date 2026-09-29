/**
 * SQLite 仓储单元测试：逐端口验证 ports.ts 合同在 SQLite 底座上的落实。
 *
 * 覆盖重点（按端口）：
 * - 事件存储：append-only（重复抛错 + 触发器拒绝 UPDATE/DELETE）、整批原子、拉取幂等；
 * - 内容目录：upsert 整体替换、软移除不物理删除、跨设备同键冲突可完整落地；
 * - 词书目录与 Space：定位事实存取、displayOrder 稳定排序；
 * - 会话/卡片/每日计划：设备本地存取与 upsert 覆盖语义；
 * - 设置通道：LWW 收敛 + outbox 同事务入队（save 与 applyMerged 的入队差异）；
 * - 设备身份与序号：跨连接（重启）延续；
 * - LLM 配置：密钥三态（保留/清空/更新）与密文落库。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationEvent, FirstPassDraftRecord, WordContentRecord } from "@ebbinghaus/application";
import { createNodeClientRuntime, type NodeClientRuntime } from "../src/index.ts";
import { TransparentSecretCipher } from "../src/repositories/settings.ts";

/** 固定测试锚点：所有仓储时间经它注入，绝不读系统时间。 */
const CLOCK_ISO = "2026-07-15T09:00:00.000Z";

const clock = {
  now: () => new Date(CLOCK_ISO),
};

/** 构造合法事件（信封字段全协议一致；metadata 任意 JSON）。 */
function makeEvent(seq: number, deviceId = "b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b"): ApplicationEvent {
  return {
    eventId: `00000000-0000-4000-8000-${seq.toString().padStart(12, "0")}`,
    eventType: "firstPassRecorded",
    targetType: "List",
    targetId: "list-1",
    occurredAt: CLOCK_ISO,
    learningDay: "2026-07-15",
    source: "首过预览保存",
    deviceId,
    deviceSeq: seq,
    metadata: { unitNumber: 1, listNumber: 1, wordCount: 2 },
  };
}

describe("SQLite 仓储（端口合同落实）", () => {
  let runtime: NodeClientRuntime;

  beforeEach(() => {
    runtime = createNodeClientRuntime({ dbPath: ":memory:", clock });
  });

  afterEach(() => {
    runtime.close();
  });

  describe("首过录入草稿", () => {
    const draft: FirstPassDraftRecord = {
      id: "draft-local-only", spaceId: "space-local-only", unitNumber: 1, listNumber: 2,
      rawText: "仅本机原文", useLanguageModel: false, status: "草稿",
      lastError: null, candidatesJson: null, auditJson: null, unresolvedDescription: null,
      updatedAt: CLOCK_ISO, deviceId: "b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b",
    };

    it("写入和确认只改变本机正文，不进入内容出站队列", () => {
      const before = runtime.contentSyncStore.pendingCount();
      runtime.firstPassDraftStore.upsertDraft(draft);
      expect(runtime.firstPassDraftStore.getDraft(draft.id)?.rawText).toBe(draft.rawText);
      expect(runtime.contentSyncStore.pendingCount()).toBe(before);
      runtime.firstPassDraftStore.upsertDraft({ ...draft, status: "已确认" });
      expect(runtime.firstPassDraftStore.getDraft(draft.id)?.status).toBe("已确认");
      expect(runtime.contentSyncStore.pendingCount()).toBe(before);
    });

    it("旧版遗留草稿出站项不计数也不返回，草稿正文仍可读取", () => {
      runtime.firstPassDraftStore.upsertDraft(draft);
      // 直接装载升级前已持久化的 outbox 行；新版 recordLocal 已拒绝创建草稿项。
      runtime.db.prepare("INSERT INTO content_outbox (entity_type, entity_id, payload_json, next_attempt_at) VALUES (?, ?, ?, ?)")
        .run("draft", draft.id, JSON.stringify(draft), CLOCK_ISO);
      runtime.contentSyncStore.recordLocal("draft", "new-draft", draft);
      expect((runtime.db.prepare("SELECT COUNT(*) AS total FROM content_outbox WHERE entity_type = 'draft'").get() as { total: number }).total).toBe(1);
      expect(runtime.contentSyncStore.pendingCount()).toBe(0);
      expect(runtime.contentSyncStore.dueEntries(CLOCK_ISO, 10)).toEqual([]);
      expect(runtime.firstPassDraftStore.getDraft(draft.id)?.rawText).toBe(draft.rawText);
    });
  });

  describe("学习事件存储（append-only 铁律）", () => {
    it("追加与读取回环一致，metadata 原样保留", () => {
      const event = makeEvent(1);
      runtime.eventStore.appendEvents([event]);

      expect(runtime.eventStore.listAllEvents()).toEqual([event]);
    });

    it("eventId 重复追加抛 DuplicateEventError，不产生半批写入", () => {
      runtime.eventStore.appendEvents([makeEvent(1)]);

      expect(() =>
        runtime.eventStore.appendEvents([makeEvent(2, "b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b")]),
      ).not.toThrow();
      // 同事件重复 → 抛错且第二批未入库（原子）。
      expect(() => runtime.eventStore.appendEvents([makeEvent(3), makeEvent(1)])).toThrow(
        /已存在于本地事件存储/,
      );
      expect(runtime.eventStore.listAllEvents()).toHaveLength(2);
    });

    it("applyPulledEvents 幂等：重复回声不计入新入库数量", () => {
      expect(runtime.eventStore.applyPulledEvents([makeEvent(1), makeEvent(2)])).toBe(2);
      expect(runtime.eventStore.applyPulledEvents([makeEvent(1)])).toBe(0);
      expect(runtime.eventStore.applyPulledEvents([makeEvent(3)])).toBe(1);
      expect(runtime.eventStore.listAllEvents()).toHaveLength(3);
    });

    it("schema 触发器兜底：绕过仓储的 UPDATE/DELETE 被 RAISE(ABORT) 阻止", () => {
      runtime.eventStore.appendEvents([makeEvent(1)]);

      expect(() =>
        runtime.db
          .prepare(`UPDATE learning_events SET learning_day = '2000-01-01'`)
          .run(),
      ).toThrow(/禁止 UPDATE/);
      expect(() =>
        runtime.db.prepare(`DELETE FROM learning_events`).run(),
      ).toThrow(/禁止 DELETE/);
    });
  });

  describe("词内容目录", () => {
    const entry = {
      wordId: "w-1",
      listId: "list-1",
      spaceId: null,
      originalSpelling: "abandon",
      normalizedKey: "abandon",
      manualMeaning: "放弃",
      meanings: [],
      removed: false,
      recordedAt: CLOCK_ISO,
    };

    it("upsert 整体替换且软移除后从查询隐藏、目录仍可见", () => {
      runtime.wordContentStore.upsertEntries([entry]);
      runtime.wordContentStore.markRemoved("w-1", CLOCK_ISO);

      expect(runtime.wordContentStore.getEntry("w-1")?.removed).toBe(true);
      expect(runtime.wordContentStore.listEntriesForList("list-1")).toEqual([]);
      expect(runtime.wordContentStore.listCatalogEntries()).toHaveLength(1);
      expect(runtime.wordContentStore.hasEntriesForSpace("s-1")).toBe(false);
    });

    it("同 Space 不同设备同键冲突保留两条供应用层处理，不阻断完整副本", () => {
      const spaceEntry = (wordId: string): WordContentRecord => ({
        ...entry,
        wordId,
        listId: null,
        spaceId: "s-1",
      });
      runtime.wordContentStore.upsertEntries([spaceEntry("w-1")]);

      // 唯一性仍由录入用例检查，但两台设备离线同时创建的不同 ID 必须都能拉取。
      runtime.wordContentStore.upsertEntries([spaceEntry("w-2")]);
      expect(runtime.wordContentStore.listEntriesForSpace("s-1").map((word) => word.wordId).sort())
        .toEqual(["w-1", "w-2"]);
    });
  });

  describe("Space 元数据", () => {
    const space = (id: string, displayOrder: number): import("@ebbinghaus/domain").Space => ({
      id,
      kind: null,
      displayOrder,
      name: `Space-${id}`,
      archivedAt: null,
      createdAt: CLOCK_ISO,
      updatedAt: CLOCK_ISO,
      learningMode: "词书模式",
    });

    it("listSpaces 按 displayOrder 升序稳定返回；update 不存在时抛错", () => {
      runtime.spaceStore.addSpace(space("s-2", 2));
      runtime.spaceStore.addSpace(space("s-1", 1));

      expect(runtime.spaceStore.listSpaces().map((s) => s.id)).toEqual(["s-1", "s-2"]);
      expect(() =>
        runtime.spaceStore.updateSpace(space("missing", 9)),
      ).toThrow(/不存在/);
    });
  });

  describe("测试会话（设备本地）", () => {
    const session = {
      sessionId: "sess-1",
      learningMode: "常规模式" as const,
      spaceId: "s-1",
      listId: null,
      learningDay: "2026-07-15",
      groupOrdinal: 1,
      taskId: null,
      words: [
        { wordId: "w-1", plannedTestAt: CLOCK_ISO },
        { wordId: "w-2", plannedTestAt: CLOCK_ISO },
        { wordId: "w-3", plannedTestAt: CLOCK_ISO },
      ],
      currentPosition: 0,
      status: "进行中" as const,
      answeredWordIds: [],
      startedAt: CLOCK_ISO,
      lastActiveAt: CLOCK_ISO,
    };

    it("开启/查询唯一开放会话/更新进度；快照字段不被 update 改写", () => {
      runtime.testSessionStore.addSession(session);
      expect(runtime.testSessionStore.getOpenRegularSession("s-1", "2026-07-15")?.sessionId).toBe("sess-1");

      runtime.testSessionStore.updateSession({
        ...session,
        currentPosition: 1,
        status: "已暂停",
        answeredWordIds: ["w-1"],
        lastActiveAt: CLOCK_ISO,
      });
      const updated = runtime.testSessionStore.getSession("sess-1");
      expect(updated?.status).toBe("已暂停");
      expect(updated?.currentPosition).toBe(1);
      // words 快照保持开场定格（update 只改进度/状态/已答/活跃时间）。
      expect(updated?.words).toEqual(session.words);
      expect(updated?.startedAt).toBe(CLOCK_ISO);
    });

    it("点错了只持久化现有计划的顺序，不改位置、结果或成员", () => {
      runtime.testSessionStore.addSession(session);
      const reordered = {
        ...session,
        words: [session.words[0]!, session.words[2]!, session.words[1]!],
        lastActiveAt: "2026-07-15T09:05:00.000Z",
      };

      runtime.testSessionStore.reorderSessionWords(reordered);

      const updated = runtime.testSessionStore.getSession("sess-1");
      expect(updated?.words).toEqual(reordered.words);
      expect(updated?.currentPosition).toBe(session.currentPosition);
      expect(updated?.answeredWordIds).toEqual(session.answeredWordIds);
      expect(updated?.status).toBe(session.status);
      expect(updated?.startedAt).toBe(session.startedAt);
      expect(updated?.lastActiveAt).toBe(reordered.lastActiveAt);
    });

    it("队列重排不能增删或改写 Word 计划", () => {
      runtime.testSessionStore.addSession(session);
      expect(() => runtime.testSessionStore.reorderSessionWords({
        ...session,
        words: [...session.words.slice(0, 2), { wordId: "other", plannedTestAt: CLOCK_ISO }],
      })).toThrow(/不得增删或改写/);
      expect(runtime.testSessionStore.getSession("sess-1")?.words).toEqual(session.words);
    });
  });

  describe("同步设置通道", () => {
    const entry = (key: string, value: unknown): import("@ebbinghaus/protocol").SettingEntry => ({
      key,
      value,
      updatedAt: CLOCK_ISO,
      deviceId: "b7e2f3a4-1c5d-4e8f-9a0b-2c3d4e5f6a7b",
    });

    it("save 本地收敛 + outbox 入队同批发生；applyMerged 不入队", () => {
      runtime.syncedSettingsStore.save([entry("learning.timezone", "Asia/Shanghai")]);
      expect(runtime.syncedSettingsStore.getAll()).toHaveLength(1);
      expect(runtime.outbox.pendingCount()).toBe(1);

      runtime.syncedSettingsStore.applyMerged([entry("learning.timezone", "Asia/Tokyo")]);
      expect(runtime.syncedSettingsStore.getAll()[0]?.value).toBe("Asia/Tokyo");
      // applyMerged 是拉取侧落地路径，绝不产生出站条目。
      expect(runtime.outbox.pendingCount()).toBe(1);
    });

    it("过时写入经协议 LWW 落败，不覆盖较新值", () => {
      runtime.syncedSettingsStore.save([entry("learning.timezone", "Asia/Tokyo")]);
      runtime.syncedSettingsStore.save([
        { ...entry("learning.timezone", "Asia/Shanghai"), updatedAt: "2026-07-14T09:00:00.000Z" },
      ]);

      expect(runtime.syncedSettingsStore.getAll()[0]?.value).toBe("Asia/Tokyo");
    });
  });

  describe("设备身份与序号（重启延续）", () => {
    it("deviceId 持久化；deviceSeq 跨连接严格递增", () => {
      // 文件路径库才能跨连接延续（:memory: 每连接独立），临时目录随测试进程清理。
      const tempDir = mkdtempSync(join(tmpdir(), "ebb-persist-"));
      const dbPath = join(tempDir, "device.db");
      const fileRuntime = createNodeClientRuntime({ dbPath, clock });
      const first = fileRuntime.deviceIdentity.getDeviceId();
      expect(fileRuntime.deviceSeqAllocator.nextSeq()).toBe(1);
      expect(fileRuntime.deviceSeqAllocator.nextSeq()).toBe(2);
      fileRuntime.close();

      // 重新打开同一文件库：模拟进程重启。
      const reopened = createNodeClientRuntime({ dbPath, clock });
      try {
        expect(reopened.deviceIdentity.getDeviceId()).toBe(first);
        expect(reopened.deviceSeqAllocator.nextSeq()).toBe(3);
      } finally {
        reopened.close();
      }
    });
  });

  describe("LLM 服务配置（设备本地，密文落库）", () => {
    it("密钥三态：更新/保留（null）/清空（空串）；密文落库", () => {
      runtime.llmConfigurationStore.save({
        baseUrl: "https://api.example.com",
        modelName: "deepseek-v4-flash",
        apiKey: "sk-secret-123",
        thinkingEnabled: true,
      });
      // 库里只有密文（TransparentSecretCipher 恒等——形态合同由 cipher 实现承担）。
      const raw = runtime.db
        .prepare(`SELECT api_key_cipher FROM llm_configuration WHERE id = 1`)
        .get() as { api_key_cipher: string };
      expect(raw.api_key_cipher).toBe("sk-secret-123");
      expect(runtime.llmConfigurationStore.load()?.apiKey).toBe("sk-secret-123");

      // null = 保留既有密钥，同时更新其他字段。
      runtime.llmConfigurationStore.save({
        baseUrl: "https://api2.example.com",
        modelName: "kimi-code",
        apiKey: null,
        thinkingEnabled: false,
      });
      const kept = runtime.llmConfigurationStore.load();
      expect(kept?.apiKey).toBe("sk-secret-123");
      expect(kept?.baseUrl).toBe("https://api2.example.com");
      expect(kept?.thinkingEnabled).toBe(false);

      // 空串 = 清空。
      runtime.llmConfigurationStore.save({
        baseUrl: "https://api2.example.com",
        modelName: "kimi-code",
        apiKey: "",
        thinkingEnabled: false,
      });
      expect(runtime.llmConfigurationStore.load()?.apiKey).toBe("");
    });
  });

  describe("每日计划", () => {
    it("upsert 覆盖同 (day, space) 行；listRecent 返回 beforeDay 之前降序截断", () => {
      const plan = (day: string): import("@ebbinghaus/application").DailyPlanRecord => ({
        learningDay: day,
        spaceId: "s-1",
        targetCapacity: 3,
        suggestedFirstPassCount: 1,
        actualFirstPassCount: 0,
        actualCompletedWorkload: 0,
        predictionWindowDays: 21,
        algorithmVersion: "capacity-monte-carlo-v2",
        dueSnapshot: {
          dueWorkload: 0,
          overdueWorkload: 0,
          tasks: [],
          candidateActiveWordCount: 6,
        },
        riskMetrics: {
          recentActualDailyWorkload: null,
          recentActualSampleCount: 0,
          historyWindowDays: 14,
          riskCapacity: 3,
          riskQuantile: 0.85,
          reserveWorkload: 1,
          sampleCount: 300,
          randomSeed: 42,
          inputFingerprint: "abc",
          selectedCandidate: {
            newListCount: 1,
            expectedWorkloadByDay: [],
            riskQuantileWorkloadByDay: [],
            overloadProbability: 0,
            expectedMaxBacklog: 0,
            riskQuantileMaxBacklog: 0,
            expectedClearanceDays: null,
          },
          candidates: [],
        },
      });

      runtime.dailyPlanStore.upsert(plan("2026-07-10"));
      runtime.dailyPlanStore.upsert(plan("2026-07-11"));
      runtime.dailyPlanStore.upsert({ ...plan("2026-07-10"), targetCapacity: 5 });

      expect(runtime.dailyPlanStore.get({ learningDay: "2026-07-10", spaceId: "s-1" })?.targetCapacity).toBe(5);
      expect(
        runtime.dailyPlanStore
          .listRecent({ spaceId: "s-1", beforeDay: "2026-07-15", limit: 1 })
          .map((p) => p.learningDay),
      ).toEqual(["2026-07-11"]);
    });
  });
});

// TransparentSecretCipher 的导入自检：该类是开发形态的显式选择，防止误删导出。
describe("密钥加密端口", () => {
  it("透传实现按合同恒等转换（生产必须替换）", () => {
    const cipher = new TransparentSecretCipher();
    expect(cipher.encrypt("abc")).toBe("abc");
    expect(cipher.decrypt("abc")).toBe("abc");
  });
});
