/**
 * 常规模式录入、到期分组、朗读复习与测试会话闭环测试（移植 V1
 * application/regular_learning.py 的行为口径；断言口径对应 V1
 * tests/unit/application/test_unified_entry_workflow.py 的确认条目规则与
 * 领域层已固化的 FSRS 两档映射、软掌握派生规则）。
 *
 * 覆盖口径：
 * - 录入事件链：整理候选 → ConfirmedEntry → recordEntries → firstPassRecorded
 *   事件（经 LearningEventRecorder，信封与学习日口径全协议合规）+ 内容记录 +
 *   初始 FSRS 卡片（Learning 态、零累计认识）；
 * - Space 内不静默覆盖：冲突必须逐条交由用户决定（覆盖 = 先写不可变 wordRemoved
 *   再软移除并录入新条目；跳过 = 本次不录入），同批重复词条自动合并义项；
 * - 当日组切分：默认每组 20 条、Space 设置可覆盖，组只是当天显示切分；
 * - 朗读复习零工作量语义：当日录入条目只进只读朗读分组，从不进入 FSRS 测试候选；
 * - 测试会话闭环：开始/暂停/恢复、开放会话唯一性、确认即调 FSRS、改判审计、
 *   会话进度推进与完成。
 */
import { describe, expect, it, vi } from "vitest";

import {
  ENTRY_ORGANIZER_SCHEMA_VERSION,
  FsrsRegularScheduler,
  PartOfSpeech,
  TestJudgement,
  validateEntryOrganizerPayload,
  type StructuredMeaning,
} from "@ebbinghaus/domain";
import { uuidV4Schema } from "@ebbinghaus/protocol";

import { ConfirmedEntry } from "../src/entryOrganizing.ts";
import { RegularLearningService } from "../src/regularLearning.ts";
import { LearningEventRecorder } from "../src/eventRecorder.ts";
import { SettingsService } from "../src/settingsFacade.ts";
import { TestSessionExecutionStatus } from "../src/ports.ts";
import type { WordContentRecord } from "../src/ports.ts";
import { SpaceEntryConflictError } from "../src/errors.ts";
import {
  FixedClock,
  InMemoryDeviceLocalStore,
  InMemoryEventStore,
  InMemoryFsrsCardStore,
  InMemorySpaceStore,
  InMemorySyncedSettingsStore,
  InMemoryTestSessionStore,
  InMemoryWordContentStore,
  SequentialDeviceSeqAllocator,
  SequentialIdGenerator,
  StaticDeviceIdentity,
} from "./helpers/fakes.ts";
import { seedSpace } from "./helpers/assemble.ts";

const CLOCK_ISO = "2026-07-15T09:00:00Z";
const CLOCK_ISO_MS = "2026-07-15T09:00:00.000Z";
// Space 级设置键（space.<spaceId>.*）强制 UUIDv4：测试 Space 必须使用确定性 UUID。
const SPACE_ID = "b1e5f6a4-0000-4000-8000-0000000000a1";
const BOOK_SPACE_ID = "b1e5f6a4-0000-4000-8000-0000000000b2";

/** 组装被测服务与全部端口假实现（活动 Space 缺省指向常规模式 Space）。 */
function buildWorld() {
  const clock = new FixedClock(CLOCK_ISO);
  const eventStore = new InMemoryEventStore();
  const wordContentStore = new InMemoryWordContentStore();
  const spaceStore = new InMemorySpaceStore();
  const sessionStore = new InMemoryTestSessionStore();
  const fsrsCardStore = new InMemoryFsrsCardStore();
  const settings = new SettingsService({
    syncedSettings: new InMemorySyncedSettingsStore(),
    deviceLocal: new InMemoryDeviceLocalStore(),
    clock,
    deviceIdentity: new StaticDeviceIdentity(),
  });
  const eventRecorder = new LearningEventRecorder({
    clock,
    idGenerator: new SequentialIdGenerator(),
    deviceIdentity: new StaticDeviceIdentity(),
    deviceSeqAllocator: new SequentialDeviceSeqAllocator(),
    readLearningDaySettings: () => settings.getLearningDaySettings(),
  });
  const scheduler = new FsrsRegularScheduler();
  const service = new RegularLearningService({
    clock,
    idGenerator: new SequentialIdGenerator(),
    eventRecorder,
    eventStore,
    wordContentStore,
    spaceStore,
    sessionStore,
    fsrsCardStore,
    settings,
    scheduler,
  });
  const space = seedSpace(spaceStore, { id: SPACE_ID, learningMode: "常规模式", name: "日常积累" });
  settings.setActiveSpaceId(space.id);
  return {
    clock,
    eventStore,
    eventRecorder,
    wordContentStore,
    spaceStore,
    sessionStore,
    fsrsCardStore,
    settings,
    scheduler,
    service,
  };
}

type World = ReturnType<typeof buildWorld>;

/** 手录义项的便捷构造。 */
function meaning(partOfSpeech: PartOfSpeech, definition: string): StructuredMeaning {
  return { partOfSpeech, definition, usage: null };
}

/** 用合法 v3 载荷构造整理结果，再形成确认条目（整理候选 → 确认的正式路径）。 */
function confirmedFromOrganized(rawText: string, term: string, definition: string): ConfirmedEntry {
  const result = validateEntryOrganizerPayload(rawText, {
    schema_version: ENTRY_ORGANIZER_SCHEMA_VERSION,
    global_warning: null,
    entries: [
      {
        term: { value: term, source_excerpt: term },
        meanings: [
          {
            part_of_speech: { value: "n.", source_excerpt: "名词" },
            definition: { value: definition, source_excerpt: definition },
            usage: null,
          },
        ],
      },
    ],
  });
  const candidate = result.candidates[0]!;
  return new ConfirmedEntry(
    candidate.term.value as string,
    candidate.meanings.map((item) => item.meaning),
  );
}

/**
 * 播种一条"已到期"条目：录入 → 历史测试事件（重放侧 regularDueAt/最近判断的唯一
 * 来源）→ 与历史一致的本地 FSRS 卡片。dueAt 早于当前时刻即进入当日测试候选。
 */
function seedDueEntry(
  world: World,
  input: {
    readonly term: string;
    readonly recordedAtIso: string;
    readonly judgedAtIso: string;
    readonly dueAtIso: string;
    readonly finalJudgement: TestJudgement;
    readonly cumulativeRecognizedCount: number;
  },
): string {
  world.clock.setInstant(input.recordedAtIso);
  const records = world.service.recordEntries({
    spaceId: SPACE_ID,
    entries: [confirmedFromOrganized(`${input.term} 名词 释义`, input.term, "释义")],
  });
  const wordId = records[0]!.wordId;
  // 历史事件的 afterState.dueAt 已是本轮计划到期时间；测试卡片快照必须
  // 与这一已确认事实一致，才能模拟真实客户端的 beforeState.dueAt。
  const initialCardJson = world.scheduler.newCardSnapshotJson({ createdAt: input.recordedAtIso });
  const cardJson = JSON.stringify({ ...JSON.parse(initialCardJson), due: input.dueAtIso });
  world.fsrsCardStore.upsert({
    wordId,
    cardJson,
    dueAt: FsrsRegularScheduler.cardDueAt(cardJson),
    schedulerJson: world.scheduler.schedulerSnapshotJson({ desiredRetention: 0.95 }),
    algorithmVersion: world.scheduler.algorithmVersion,
    libraryVersion: world.scheduler.libraryVersion,
    updatedAt: input.recordedAtIso,
    cardState: "Learning",
    cumulativeRecognizedCount: input.cumulativeRecognizedCount,
    lastFinalJudgement: input.finalJudgement,
  });
  world.clock.setInstant(input.judgedAtIso);
  const event = world.eventRecorder.record({
    eventType: "testAnswered",
    targetType: "条目",
    targetId: wordId,
    source: "常规模式测试",
    metadata: {
      sessionId: "session-history",
      groupOrdinal: 1,
      wordId,
      initialJudgement: input.finalJudgement,
      finalJudgement: input.finalJudgement,
      answerRevised: false,
      beforeState: {},
      afterState: { dueAt: input.dueAtIso, masteryStatus: "未掌握", nextIntervalDays: 1 },
      workload: 1,
      algorithmVersion: world.scheduler.algorithmVersion,
    },
  });
  world.eventStore.appendEvents([event]);
  return wordId;
}

describe("录入：整理候选到确认入库的事件链", () => {
  it("确认条目入库：firstPassRecorded 事件、内容记录与初始 FSRS 卡片齐全", () => {
    const world = buildWorld();

    const created = world.service.recordEntries({
      spaceId: SPACE_ID,
      entries: [confirmedFromOrganized("mentor 名词 导师", "mentor", "导师")],
    });

    expect(created).toHaveLength(1);
    const record = created[0]!;
    expect(uuidV4Schema.safeParse(record.wordId).success).toBe(true);
    expect(record.listId).toBeNull();
    expect(record.spaceId).toBe(SPACE_ID);
    expect(record.originalSpelling).toBe("mentor");
    expect(record.normalizedKey).toBe("mentor");
    expect(record.manualMeaning).toBe("n. 导师");
    expect(record.removed).toBe(false);
    expect(record.recordedAt).toBe(CLOCK_ISO_MS);

    // 事件经 LearningEventRecorder 产出：信封、学习日与工作量口径协议合规。
    const events = world.eventStore.listAllEvents();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.eventType).toBe("firstPassRecorded");
    expect(event.targetType).toBe("条目");
    expect(event.targetId).toBe(record.wordId);
    expect(event.source).toBe("常规模式录入");
    expect(event.learningDay).toBe("2026-07-15");
    expect(event.metadata["workload"]).toBe(1);
    expect(event.metadata["removedExistingWords"]).toEqual([]);
    expect(event.metadata["skippedIncomingWords"]).toEqual([]);

    // 初始卡片：Learning 态、零累计认识、无最终判断历史。
    const card = world.fsrsCardStore.get(record.wordId);
    expect(card).not.toBeNull();
    expect(card?.cardState).toBe("Learning");
    expect(card?.cumulativeRecognizedCount).toBe(0);
    expect(card?.lastFinalJudgement).toBeNull();
    expect(card?.algorithmVersion).toBe(world.scheduler.algorithmVersion);
    expect(card?.dueAt).toBe(FsrsRegularScheduler.cardDueAt(card?.cardJson ?? ""));
  });

  it("同一批次内的重复词条自动合并义项，保持首次出现顺序", () => {
    const world = buildWorld();

    const created = world.service.recordEntries({
      spaceId: SPACE_ID,
      entries: [
        new ConfirmedEntry("take over", [meaning("vt.", "接管")]),
        new ConfirmedEntry("Take  over", [meaning("n.", "接手"), meaning("vt.", "接管")]),
      ],
    });

    // 规范键相同 → 只入库一条，义项并集去重且首现顺序保持。
    expect(created).toHaveLength(1);
    const record = created[0]!;
    expect(record.normalizedKey).toBe("take over");
    expect(record.meanings).toEqual([meaning("vt.", "接管"), meaning("n.", "接手")]);
    expect(record.manualMeaning).toBe("vt. 接管；n. 接手");
    expect(world.eventStore.listAllEvents()).toHaveLength(1);
  });

  it("空确认批次被拒绝", () => {
    const world = buildWorld();

    expect(() => world.service.recordEntries({ spaceId: SPACE_ID, entries: [] })).toThrow(
      "请至少确认一个条目",
    );
  });
});

describe("录入冲突：Space 内禁止静默覆盖", () => {
  it("未处理冲突时拒绝写入，错误携带既有词条定位", () => {
    const world = buildWorld();
    const [existingRecord] = world.service.recordEntries({
      spaceId: SPACE_ID,
      entries: [confirmedFromOrganized("mentor 名词 导师", "mentor", "导师")],
    });

    // 大小写与空白差异不改变规范键：属于同一词条的重复录入。
    expect(() =>
      world.service.recordEntries({
        spaceId: SPACE_ID,
        entries: [confirmedFromOrganized("Mentor 名词 导师", "Mentor", "导师")],
      }),
    ).toThrow(SpaceEntryConflictError);

    try {
      world.service.recordEntries({
        spaceId: SPACE_ID,
        entries: [confirmedFromOrganized("Mentor 名词 导师", "Mentor", "导师")],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SpaceEntryConflictError);
      const conflicts = (error as SpaceEntryConflictError).conflicts;
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.normalizedKey).toBe("mentor");
      expect(conflicts[0]?.existingWordId).toBe(existingRecord!.wordId);
      expect(conflicts[0]?.existingSpelling).toBe("mentor");
      expect(conflicts[0]?.incomingSpelling).toBe("Mentor");
    }
    // 拒绝写入：Space 内仍然只有原条目。
    expect(world.wordContentStore.listEntriesForSpace(SPACE_ID)).toHaveLength(1);
  });

  it("用户选择覆盖：先写不可变 wordRemoved 事件再软移除并录入新条目", () => {
    const world = buildWorld();
    const [existingRecord] = world.service.recordEntries({
      spaceId: SPACE_ID,
      entries: [confirmedFromOrganized("mentor 名词 导师", "mentor", "导师")],
    });
    world.clock.setInstant("2026-07-16T09:00:00Z");

    const created = world.service.recordEntries({
      spaceId: SPACE_ID,
      entries: [confirmedFromOrganized("Mentor 名词 主教练", "Mentor", "主教练")],
      conflictResolutions: [{ normalizedKey: "mentor", removeExisting: true }],
    });

    // 新条目入库，旧条目软移除（历史与审计保留）。
    expect(created).toHaveLength(1);
    expect(created[0]!.wordId).not.toBe(existingRecord!.wordId);
    const entries: WordContentRecord[] = world.wordContentStore.listCatalogEntries();
    expect(entries).toHaveLength(2);
    const removedEntry = entries.find((entry) => entry.wordId === existingRecord!.wordId);
    expect(removedEntry?.removed).toBe(true);
    // 事件顺序：wordRemoved 在前，新条目 firstPassRecorded 在后（先写不可变移除事件）。
    const events = world.eventStore.listAllEvents();
    expect(events.map((event) => event.eventType)).toEqual(["firstPassRecorded", "wordRemoved", "firstPassRecorded"]);
    const removal = events[1]!;
    expect(removal.targetId).toBe(existingRecord!.wordId);
    expect(removal.metadata["spaceId"]).toBe(SPACE_ID);
    expect(removal.metadata["normalizedKey"]).toBe("mentor");
    expect(removal.metadata["reason"]).toBe("重复录入冲突，用户选择覆盖");
    // 新条目事件记录被覆盖与跳过的词条键（审计口径）。
    expect(events[2]!.metadata["removedExistingWords"]).toEqual(["mentor"]);
  });

  it("用户选择本次不录入：跳过新条目，不产生移除事件", () => {
    const world = buildWorld();
    world.service.recordEntries({
      spaceId: SPACE_ID,
      entries: [confirmedFromOrganized("mentor 名词 导师", "mentor", "导师")],
    });

    const created = world.service.recordEntries({
      spaceId: SPACE_ID,
      entries: [confirmedFromOrganized("Mentor 名词 主教练", "Mentor", "主教练")],
      conflictResolutions: [{ normalizedKey: "mentor", removeExisting: false }],
    });

    expect(created).toHaveLength(0);
    expect(world.wordContentStore.listEntriesForSpace(SPACE_ID)).toHaveLength(1);
    expect(world.eventStore.listAllEvents()).toHaveLength(1);
  });
});

describe("当日组切分与朗读复习", () => {
  it("默认每组 20 条：不足一组时单组完整容纳", () => {
    const world = buildWorld();
    const dueAt = "2026-07-16T09:00:00.000Z";
    for (const term of ["alpha", "beta", "gamma"]) {
      seedDueEntry(world, {
        term,
        recordedAtIso: CLOCK_ISO,
        judgedAtIso: "2026-07-15T10:00:00.000Z",
        dueAtIso: dueAt,
        finalJudgement: TestJudgement.Recognized,
        cumulativeRecognizedCount: 1,
      });
    }
    world.clock.setInstant("2026-07-16T09:00:00Z");

    const groups = world.service.dueGroups({ spaceId: SPACE_ID });

    expect(world.settings.getSpaceLearningSettings(SPACE_ID).regularGroupSize).toBe(20);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ordinal).toBe(1);
    expect(groups[0]!.learningDay).toBe("2026-07-16");
    expect(groups[0]!.wordIds).toHaveLength(3);
  });

  it("每组条目数设置生效：到期序列切分为多组且组序号连续", () => {
    const world = buildWorld();
    // 到期排序四段键：都不认识时按 dueAt 早者在前——beta(08:00) → alpha(09:00) → gamma(10:00)。
    const byTerm = {
      alpha: "2026-07-16T09:00:00.000Z",
      beta: "2026-07-16T08:00:00.000Z",
      gamma: "2026-07-16T10:00:00.000Z",
    };
    const wordIds = new Map<string, string>();
    for (const term of ["alpha", "beta", "gamma"] as const) {
      wordIds.set(
        term,
        seedDueEntry(world, {
          term,
          recordedAtIso: CLOCK_ISO,
          judgedAtIso: "2026-07-15T10:00:00.000Z",
          dueAtIso: byTerm[term],
          finalJudgement: TestJudgement.NotRecognized,
          cumulativeRecognizedCount: 0,
        }),
      );
    }
    world.settings.saveRegularGroupSize(SPACE_ID, 2);
    // 时钟必须走到全部到期时刻之后（gamma 到期 10:00），否则 gamma 被到期过滤剔除。
    world.clock.setInstant("2026-07-16T12:00:00Z");

    const groups = world.service.dueGroups({ spaceId: SPACE_ID });

    expect(groups.map((group) => group.wordIds)).toEqual([
      [wordIds.get("beta"), wordIds.get("alpha")],
      [wordIds.get("gamma")],
    ]);
    expect(groups.map((group) => group.ordinal)).toEqual([1, 2]);
  });

  it("到期排序四段键：最近不认识者优先，其次 dueAt 早者在前", () => {
    const world = buildWorld();
    seedDueEntry(world, {
      term: "recognized",
      recordedAtIso: CLOCK_ISO,
      judgedAtIso: "2026-07-15T10:00:00.000Z",
      dueAtIso: "2026-07-16T07:00:00.000Z",
      finalJudgement: TestJudgement.Recognized,
      cumulativeRecognizedCount: 1,
    });
    seedDueEntry(world, {
      term: "forgotten",
      recordedAtIso: CLOCK_ISO,
      judgedAtIso: "2026-07-15T11:00:00.000Z",
      dueAtIso: "2026-07-16T12:00:00.000Z",
      finalJudgement: TestJudgement.NotRecognized,
      cumulativeRecognizedCount: 0,
    });
    world.clock.setInstant("2026-07-16T12:00:00Z");

    const groups = world.service.dueGroups({ spaceId: SPACE_ID });

    // 不认识的 forgotten 虽然到期最晚，仍排在最前（尽快回到复习）。
    expect(groups[0]!.wordIds).toHaveLength(2);
    const forgottenFirst = groups[0]!.wordIds[0];
    const forgottenEntry = world.wordContentStore.getEntry(forgottenFirst!);
    expect(forgottenEntry?.originalSpelling).toBe("forgotten");
  });

  it("朗读复习零工作量语义：当日录入只进只读分组，从不进入 FSRS 测试候选", () => {
    const world = buildWorld();
    world.service.recordEntries({
      spaceId: SPACE_ID,
      entries: [
        confirmedFromOrganized("mentor 名词 导师", "mentor", "导师"),
        confirmedFromOrganized("pupil 名词 学生", "pupil", "学生"),
      ],
    });

    const reviewGroups = world.service.recordedTodayReviewGroups({ spaceId: SPACE_ID });

    // 朗读分组覆盖当日全部录入（按录入时刻排序），学习日为当日。
    expect(reviewGroups).toHaveLength(1);
    expect(reviewGroups[0]!.learningDay).toBe("2026-07-15");
    expect(reviewGroups[0]!.wordIds).toHaveLength(2);

    // 当日录入从下一个学习日才开始参与测试（规格 11.7）：当日测试候选为空。
    const due = world.service.dueGroups({ spaceId: SPACE_ID });
    expect(due).toHaveLength(0);

    // 朗读复习不产生任何测试/工作量事件：事件仍只有两条录入事实。
    expect(world.eventStore.listAllEvents().map((event) => event.eventType)).toEqual([
      "firstPassRecorded",
      "firstPassRecorded",
    ]);
  });
});

describe("新条目首次测试可达性（2026-09-20 集成修复回归）", () => {
  it("从未测试的新条目在录入次日起进入到期序列，排序键为资格日起始时刻", () => {
    const world = buildWorld();
    // 当日录入：走正式路径（整理候选 → 确认 → recordEntries），不注入任何 testAnswered。
    world.service.recordEntries({
      spaceId: SPACE_ID,
      entries: [confirmedFromOrganized("fresh 名词 新鲜的", "fresh", "新鲜的")],
      conflictResolutions: [],
    });
    expect(world.wordContentStore.listEntriesForSpace(SPACE_ID)).toHaveLength(1);

    // 录入当日：资格过滤（次日 + 1）未到，新条目不可测。
    expect(world.service.dueGroups({ spaceId: SPACE_ID })).toHaveLength(0);

    // 次日（含资格日整个学习日）：新条目必须可达（修复前 regularDueAt=null 被过滤，规格 11.7 不可达）。
    world.clock.setInstant("2026-07-16T09:00:00Z");
    const groups = world.service.dueGroups({ spaceId: SPACE_ID });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.wordIds).toHaveLength(1);
    expect(groups[0]!.learningDay).toBe("2026-07-16");
  });

  it("新条目与有历史条目混合时：历史条目按四段键优先，新条目排在之后", () => {
    const world = buildWorld();
    const testedId = seedDueEntry(world, {
      term: "tested",
      recordedAtIso: "2026-07-10T09:00:00.000Z",
      judgedAtIso: "2026-07-14T10:00:00.000Z",
      dueAtIso: "2026-07-16T08:00:00.000Z",
      finalJudgement: TestJudgement.NotRecognized,
      cumulativeRecognizedCount: 0,
    });
    world.service.recordEntries({
      spaceId: SPACE_ID,
      entries: [confirmedFromOrganized("fresh 名词 新鲜的", "fresh", "新鲜的")],
      conflictResolutions: [],
    });
    world.clock.setInstant("2026-07-16T09:00:00Z");

    const groups = world.service.dueGroups({ spaceId: SPACE_ID });
    const wordIds = groups.flatMap((group) => group.wordIds);
    // 四段键第一段：有历史优先于从未测试。
    expect(wordIds).toHaveLength(2);
    expect(wordIds[0]).toBe(testedId);
  });
});

describe("测试会话闭环", () => {
  /** 播种两条到期条目并返回（排序稳定的）会话成员词标识序列。 */
  function seedTwoDueEntries(world: World): { wordIds: readonly string[]; learningDay: string } {
    const dueAt = "2026-07-16T09:00:00.000Z";
    const first = seedDueEntry(world, {
      term: "alpha",
      recordedAtIso: CLOCK_ISO,
      judgedAtIso: "2026-07-15T10:00:00.000Z",
      dueAtIso: dueAt,
      finalJudgement: TestJudgement.Recognized,
      cumulativeRecognizedCount: 1,
    });
    const second = seedDueEntry(world, {
      term: "beta",
      recordedAtIso: CLOCK_ISO,
      judgedAtIso: "2026-07-15T11:00:00.000Z",
      dueAtIso: dueAt,
      finalJudgement: TestJudgement.Recognized,
      cumulativeRecognizedCount: 1,
    });
    // 同判断、同累计次数：dueAt 相同时按稳定 Word 标识排序（录入顺序即标识顺序）。
    return { wordIds: [first, second], learningDay: "2026-07-16" };
  }

  /** 用另一终端已确认的结果模拟拉取落库；会话游标仍停留在本机旧快照。 */
  function appendConfirmedAnswer(world: World, wordId: string, beforeDueAt: string): void {
    const event = world.eventRecorder.record({
      eventType: "testAnswered",
      targetType: "条目",
      targetId: wordId,
      source: "常规模式测试",
      occurredAt: world.clock.now(),
      metadata: {
        sessionId: "remote-session",
        groupOrdinal: 1,
        wordId,
        initialJudgement: TestJudgement.Recognized,
        finalJudgement: TestJudgement.Recognized,
        answerRevised: false,
        beforeState: { dueAt: beforeDueAt },
        afterState: { dueAt: "2026-07-20T09:00:00.000Z", masteryStatus: "未掌握", nextIntervalDays: 4 },
        workload: 1,
        algorithmVersion: world.scheduler.algorithmVersion,
      },
    });
    world.eventStore.appendEvents([event]);
  }

  /** 三条同到期时间条目，便于检验非连续远端作答后的稳定分区。 */
  function seedThreeDueEntries(world: World): readonly string[] {
    const seeded = seedTwoDueEntries(world);
    const third = seedDueEntry(world, {
      term: "gamma",
      recordedAtIso: CLOCK_ISO,
      judgedAtIso: "2026-07-15T12:00:00.000Z",
      dueAtIso: "2026-07-16T09:00:00.000Z",
      finalJudgement: TestJudgement.Recognized,
      cumulativeRecognizedCount: 1,
    });
    return [...seeded.wordIds, third];
  }

  it("开始会话：成员顺序快照定格、任务标识稳定、当前词指向队首", () => {
    const world = buildWorld();
    const seeded = seedTwoDueEntries(world);
    world.clock.setInstant("2026-07-16T09:00:00Z");
    const taskId = `regular-group|${SPACE_ID}|${seeded.learningDay}|1`;

    const snapshot = world.service.startOrResumeRegularTest({ taskId });

    expect(snapshot.sessionId).toBeTruthy();
    expect(snapshot.taskId).toBe(taskId);
    expect(snapshot.status).toBe(TestSessionExecutionStatus.InProgress);
    expect(snapshot.currentPosition).toBe(0);
    expect(snapshot.totalCount).toBe(2);
    expect(snapshot.currentWord?.wordId).toBe(seeded.wordIds[0]);
    // 会话是设备本地执行状态：除播种的两条录入与两条历史测试事实外，不产生任何事件。
    expect(world.eventStore.listAllEvents()).toHaveLength(4);
  });

  it("暂停与恢复保留进度并写入审计事件；其他组的开始请求被拒绝", () => {
    const world = buildWorld();
    const seeded = seedTwoDueEntries(world);
    world.clock.setInstant("2026-07-16T09:00:00Z");
    const taskId = `regular-group|${SPACE_ID}|${seeded.learningDay}|1`;
    const started = world.service.startOrResumeRegularTest({ taskId });

    const paused = world.service.pauseRegularTest({ sessionId: started.sessionId });
    expect(paused.status).toBe(TestSessionExecutionStatus.Paused);
    expect(paused.currentPosition).toBe(0);

    // 暂停期间其他组不可开启：开放会话唯一。
    expect(() =>
      world.service.startOrResumeRegularTest({
        taskId: `regular-group|${SPACE_ID}|${seeded.learningDay}|2`,
      }),
    ).toThrow("当前已有其他测试组正在进行的会话");

    const resumed = world.service.startOrResumeRegularTest({ taskId });
    expect(resumed.sessionId).toBe(started.sessionId);
    expect(resumed.status).toBe(TestSessionExecutionStatus.InProgress);
    expect(resumed.currentPosition).toBe(0);

    const events = world.eventStore.listAllEvents();
    // 播种历史（每条：录入 + 历史测试交替）之后只新增暂停与恢复两条审计事件。
    expect(events.map((event) => event.eventType)).toEqual([
      "firstPassRecorded",
      "testAnswered",
      "firstPassRecorded",
      "testAnswered",
      "testSessionPaused",
      "testSessionResumed",
    ]);
    expect(events[4]!.metadata["groupOrdinal"]).toBe(1);
    expect(events[5]!.metadata["groupOrdinal"]).toBe(1);
    // 该 Space 当日唯一开放会话始终是同一个。
    expect(world.sessionStore.getOpenRegularSession(SPACE_ID, seeded.learningDay)?.sessionId).toBe(
      started.sessionId,
    );
  });

  it("确认答案：立即调用 FSRS、产出协议事件并推进进度，全部完成后会话关闭", () => {
    const world = buildWorld();
    const seeded = seedTwoDueEntries(world);
    world.clock.setInstant("2026-07-16T09:00:00Z");
    const taskId = `regular-group|${SPACE_ID}|${seeded.learningDay}|1`;
    const started = world.service.startOrResumeRegularTest({ taskId });

    const afterFirst = world.service.confirmRegularTestAnswer({
      sessionId: started.sessionId,
      expectedWordId: seeded.wordIds[0]!,
      initialJudgement: TestJudgement.Recognized,
      finalJudgement: TestJudgement.Recognized,
    });

    // 进度推进一格，当前词切换到第二个成员。
    expect(afterFirst.currentPosition).toBe(1);
    expect(afterFirst.status).toBe(TestSessionExecutionStatus.InProgress);
    expect(afterFirst.currentWord?.wordId).toBe(seeded.wordIds[1]);

    // 卡片按两档封闭映射更新：新卡认识（Good）→ Review 态、累计认识次数 +1。
    const firstWordId = seeded.wordIds[0]!;
    const card = world.fsrsCardStore.get(firstWordId);
    expect(card?.cardState).toBe("Review");
    expect(card?.cumulativeRecognizedCount).toBe(2);
    expect(card?.lastFinalJudgement).toBe(TestJudgement.Recognized);

    // 事件口径：当日只有一条新 testAnswered（播种的两条历史事件属于前一学习日）。
    const events = world.eventStore.listAllEvents();
    const answered = events.filter(
      (event) => event.eventType === "testAnswered" && event.learningDay === "2026-07-16",
    );
    expect(answered).toHaveLength(1);
    const answerEvent = answered[0]!;
    expect(answerEvent.targetId).toBe(firstWordId);
    expect(answerEvent.learningDay).toBe("2026-07-16");
    expect(answerEvent.metadata["sessionId"]).toBe(started.sessionId);
    expect(answerEvent.metadata["groupOrdinal"]).toBe(1);
    expect(answerEvent.metadata["workload"]).toBe(1);
    expect(answerEvent.metadata["answerRevised"]).toBe(false);
    expect((answerEvent.metadata["afterState"] as Record<string, unknown>)["dueAt"]).toBe(card?.dueAt);

    const afterSecond = world.service.confirmRegularTestAnswer({
      sessionId: started.sessionId,
      expectedWordId: seeded.wordIds[1]!,
      initialJudgement: TestJudgement.Recognized,
      finalJudgement: TestJudgement.Recognized,
    });
    expect(afterSecond.currentPosition).toBe(2);
    expect(afterSecond.status).toBe(TestSessionExecutionStatus.Completed);
    expect(afterSecond.currentWord).toBeNull();
    // 完成后会话不再开放：同 Space 当日可以开启新的会话。
    expect(world.sessionStore.getOpenRegularSession(SPACE_ID, seeded.learningDay)).toBeNull();
  });

  it("点错了暂缓当前条目且不写事件；下一条答完后回到该条目", () => {
    const world = buildWorld();
    const seeded = seedTwoDueEntries(world);
    world.clock.setInstant("2026-07-16T09:00:00Z");
    const taskId = `regular-group|${SPACE_ID}|${seeded.learningDay}|1`;
    const started = world.service.startOrResumeRegularTest({ taskId });
    const eventCount = world.eventStore.listAllEvents().length;
    const deferred = world.service.deferRegularTestWord({
      sessionId: started.sessionId, expectedWordId: seeded.wordIds[0]!,
    });
    expect(deferred.currentWord?.wordId).toBe(seeded.wordIds[1]);
    expect(deferred.currentPosition).toBe(0);
    expect(world.sessionStore.getSession(started.sessionId)?.words.map((word) => word.wordId)).toEqual([
      seeded.wordIds[1], seeded.wordIds[0],
    ]);
    expect(world.eventStore.listAllEvents()).toHaveLength(eventCount);
    const afterSecond = world.service.confirmRegularTestAnswer({
      sessionId: started.sessionId, expectedWordId: seeded.wordIds[1]!,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    expect(afterSecond.currentWord?.wordId).toBe(seeded.wordIds[0]);
    expect(afterSecond.status).toBe(TestSessionExecutionStatus.InProgress);
  });

  it("只剩一个待测条目时拒绝点错暂缓，避免下一题仍是当前条目", () => {
    const world = buildWorld();
    const seeded = seedTwoDueEntries(world);
    world.clock.setInstant("2026-07-16T09:00:00Z");
    const taskId = `regular-group|${SPACE_ID}|${seeded.learningDay}|1`;
    const started = world.service.startOrResumeRegularTest({ taskId });
    const first = world.service.confirmRegularTestAnswer({
      sessionId: started.sessionId, expectedWordId: seeded.wordIds[0]!,
      initialJudgement: TestJudgement.Recognized, finalJudgement: TestJudgement.Recognized,
    });
    const beforeEvents = world.eventStore.listAllEvents().length;
    expect(() => world.service.deferRegularTestWord({
      sessionId: started.sessionId, expectedWordId: seeded.wordIds[1]!,
    })).toThrow("这是最后一个待测条目，没有下一条可先测");
    const latest = world.service.getRegularTestSessionSnapshot(started.sessionId);
    expect(latest.currentWord?.wordId).toBe(seeded.wordIds[1]);
    expect(latest.currentPosition).toBe(1);
    expect(latest.currentPosition).toBe(first.currentPosition);
    expect(world.eventStore.listAllEvents()).toHaveLength(beforeEvents);
  });

  it("改判：认识改不认识追加 answerRevised 审计事件；不认识不得改回认识", () => {
    const world = buildWorld();
    const seeded = seedTwoDueEntries(world);
    world.clock.setInstant("2026-07-16T09:00:00Z");
    const taskId = `regular-group|${SPACE_ID}|${seeded.learningDay}|1`;
    const started = world.service.startOrResumeRegularTest({ taskId });

    // 初判不认识改回认识：方向被禁止（防止把已遗忘的条目误标为认识）。
    expect(() =>
      world.service.confirmRegularTestAnswer({
        sessionId: started.sessionId,
        expectedWordId: seeded.wordIds[0]!,
        initialJudgement: TestJudgement.NotRecognized,
        finalJudgement: TestJudgement.Recognized,
      }),
    ).toThrow("初判不认识不得改回认识");

    const revised = world.service.confirmRegularTestAnswer({
      sessionId: started.sessionId,
      expectedWordId: seeded.wordIds[0]!,
      initialJudgement: TestJudgement.Recognized,
      finalJudgement: TestJudgement.NotRecognized,
    });

    // 改判合法：会话继续推进。
    expect(revised.currentPosition).toBe(1);
    const events = world.eventStore.listAllEvents();
    const todays = events.filter((event) => event.learningDay === "2026-07-16");
    expect(todays.filter((event) => event.eventType === "testAnswered")).toHaveLength(1);
    const revision = todays.filter((event) => event.eventType === "answerRevised");
    expect(revision).toHaveLength(1);
    expect(revision[0]!.targetId).toBe(seeded.wordIds[0]);
    // 改判与确认共享同一 metadata（协议五类逐词测试事件共用形态）。
    expect(revision[0]!.metadata).toEqual(
      todays.find((event) => event.eventType === "testAnswered")!.metadata,
    );
  });

  it("会话状态校验：暂停中不能提交答案、未知会话报错、空组不能开始", () => {
    const world = buildWorld();
    const seeded = seedTwoDueEntries(world);
    world.clock.setInstant("2026-07-16T09:00:00Z");
    const taskId = `regular-group|${SPACE_ID}|${seeded.learningDay}|1`;
    const started = world.service.startOrResumeRegularTest({ taskId });
    world.service.pauseRegularTest({ sessionId: started.sessionId });

    expect(() =>
      world.service.confirmRegularTestAnswer({
        sessionId: started.sessionId,
        expectedWordId: seeded.wordIds[0]!,
        initialJudgement: TestJudgement.Recognized,
        finalJudgement: TestJudgement.Recognized,
      }),
    ).toThrow("测试会话当前不能提交答案");

    expect(() =>
      world.service.confirmRegularTestAnswer({
        sessionId: "00000000-0000-4000-8000-000000000099",
        expectedWordId: seeded.wordIds[0]!,
        initialJudgement: TestJudgement.Recognized,
        finalJudgement: TestJudgement.Recognized,
      }),
    ).toThrow("常规模式测试会话不存在");

    // 非法任务标识：明确报错而非静默创建。
    expect(() => world.service.startOrResumeRegularTest({ taskId: "book-task" })).toThrow(
      "常规测试组标识无效",
    );

    // 已有开放会话（暂停中）时，任何其他组（含不存在的组序号）都被唯一性守卫拦截。
    expect(() =>
      world.service.startOrResumeRegularTest({
        taskId: `regular-group|${SPACE_ID}|${seeded.learningDay}|9`,
      }),
    ).toThrow("当前已有其他测试组正在进行的会话");
  });

  it("没有开放会话时，无到期条目的组不能开始", () => {
    const world = buildWorld();
    const seeded = seedTwoDueEntries(world);
    world.clock.setInstant("2026-07-16T12:00:00Z");

    expect(() =>
      world.service.startOrResumeRegularTest({
        taskId: `regular-group|${SPACE_ID}|${seeded.learningDay}|9`,
      }),
    ).toThrow("该测试组没有到期条目");
  });

  it("远端确认队首后，读取、任务行及恢复都跳过旧条目，旧确认请求不产生事件", () => {
    const world = buildWorld();
    const wordIds = seedThreeDueEntries(world);
    world.clock.setInstant("2026-07-16T09:00:01Z");
    const taskId = `regular-group|${SPACE_ID}|2026-07-16|1`;
    const started = world.service.startOrResumeRegularTest({ taskId });
    const updates = vi.spyOn(world.sessionStore, "updateSession");
    expect(world.sessionStore.getSession(started.sessionId)?.words.map((word) => word.plannedTestAt)).toEqual([
      "2026-07-16T09:00:00.000Z",
      "2026-07-16T09:00:00.000Z",
      "2026-07-16T09:00:00.000Z",
    ]);
    appendConfirmedAnswer(world, wordIds[0]!, "2026-07-16T09:00:00.000Z");
    const eventCount = world.eventStore.listAllEvents().length;

    const snapshot = world.service.getRegularTestSessionSnapshot(started.sessionId);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(snapshot.currentPosition).toBe(1);
    expect(snapshot.currentWord?.wordId).toBe(wordIds[1]);
    expect(world.service.regularTaskItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId,
        totalCount: 3,
        completedCount: 1,
        activeWords: expect.arrayContaining([expect.objectContaining({ wordId: wordIds[1] })]),
      }),
    ]));
    expect(world.service.regularTaskItems().find((item) => item.taskId === taskId)?.activeWords.map((word) => word.wordId)).toEqual(wordIds.slice(1));
    expect(world.service.startOrResumeRegularTest({ taskId }).currentWord?.wordId).toBe(wordIds[1]);
    // 仅首次发现远端事实时更新本机会话；重复刷新不得产生额外持久化写入。
    expect(updates).toHaveBeenCalledTimes(1);
    expect(() => world.service.confirmRegularTestAnswer({
      sessionId: started.sessionId,
      expectedWordId: wordIds[0]!,
      initialJudgement: TestJudgement.Recognized,
      finalJudgement: TestJudgement.Recognized,
    })).toThrow("当前条目已变化");
    expect(world.eventStore.listAllEvents()).toHaveLength(eventCount);
    expect(world.sessionStore.getSession(started.sessionId)?.answeredWordIds).toEqual([wordIds[0]]);
  });

  it("非连续远端结果按原会话顺序移到已答前缀，暂停会话保留暂停态，全答后关闭", () => {
    const world = buildWorld();
    const wordIds = seedThreeDueEntries(world);
    world.clock.setInstant("2026-07-16T09:00:01Z");
    const started = world.service.startOrResumeRegularTest({ taskId: `regular-group|${SPACE_ID}|2026-07-16|1` });
    world.service.pauseRegularTest({ sessionId: started.sessionId });
    appendConfirmedAnswer(world, wordIds[2]!, "2026-07-16T09:00:00.000Z");
    appendConfirmedAnswer(world, wordIds[0]!, "2026-07-16T09:00:00.000Z");

    const paused = world.service.getRegularTestSessionSnapshot(started.sessionId);
    expect(paused.status).toBe(TestSessionExecutionStatus.Paused);
    expect(paused.currentPosition).toBe(2);
    expect(paused.currentWord?.wordId).toBe(wordIds[1]);
    expect(world.sessionStore.getSession(started.sessionId)?.words.map((word) => word.wordId)).toEqual([
      wordIds[0], wordIds[2], wordIds[1],
    ]);
    expect(world.service.regularTaskItems().find((item) => item.taskId === started.taskId)?.activeWords.map((word) => word.wordId)).toEqual([wordIds[1]]);
    expect(world.service.startOrResumeRegularTest({ taskId: started.taskId }).status).toBe(TestSessionExecutionStatus.InProgress);
    appendConfirmedAnswer(world, wordIds[1]!, "2026-07-16T09:00:00.000Z");
    const count = world.eventStore.listAllEvents().length;
    // 任务列表首次读取时就应完成收敛并移除旧组；不能先闪现完成行再消失。
    expect(world.service.regularTaskItems()).toEqual([]);
    expect(world.service.getRegularTestSessionSnapshot(started.sessionId)).toEqual(expect.objectContaining({
      status: TestSessionExecutionStatus.Completed,
      currentPosition: 3,
      currentWord: null,
    }));
    expect(world.sessionStore.getOpenRegularSession(SPACE_ID, "2026-07-16")).toBeNull();
    expect(world.eventStore.listAllEvents()).toHaveLength(count);
  });

  it("不同计划到期时间的测试事件不能提前跳过当前条目；旧快照仅按启动后事件降级收敛", () => {
    const world = buildWorld();
    const wordIds = seedTwoDueEntries(world).wordIds;
    world.clock.setInstant("2026-07-16T09:00:01Z");
    const started = world.service.startOrResumeRegularTest({ taskId: `regular-group|${SPACE_ID}|2026-07-16|1` });
    appendConfirmedAnswer(world, wordIds[0]!, "2026-07-16T08:00:00.000Z");
    expect(world.service.getRegularTestSessionSnapshot(started.sessionId).currentWord?.wordId).toBe(wordIds[0]);

    // 旧版本所有 plannedTestAt 都等于 startedAt，无法识别 dueAt，只能用启动时间作保守边界。
    const persisted = world.sessionStore.getSession(started.sessionId)!;
    world.sessionStore.updateSession({
      ...persisted,
      words: persisted.words.map((word) => ({ ...word, plannedTestAt: persisted.startedAt })),
    });
    expect(world.service.getRegularTestSessionSnapshot(started.sessionId).currentWord?.wordId).toBe(wordIds[1]);
  });

  it("到期组已被远端结果清空但旧会话尚未收敛时，任务行仍显示原计划及未答条目", () => {
    const world = buildWorld();
    const wordIds = seedTwoDueEntries(world).wordIds;
    world.clock.setInstant("2026-07-16T09:00:01Z");
    const started = world.service.startOrResumeRegularTest({ taskId: `regular-group|${SPACE_ID}|2026-07-16|1` });
    // 这两条事件来自另一轮到期计划，故只能改变当前到期组，不能替本会话代答。
    for (const wordId of wordIds) {
      appendConfirmedAnswer(world, wordId, "2026-07-16T08:00:00.000Z");
    }
    expect(world.service.dueGroups({ spaceId: SPACE_ID })).toHaveLength(0);

    const row = world.service.regularTaskItems().find((item) => item.taskId === started.taskId);
    expect(row).toEqual(expect.objectContaining({
      totalCount: 2,
      completedCount: 0,
      sessionStatus: TestSessionExecutionStatus.InProgress,
    }));
    expect(row?.activeWords.map((word) => word.wordId)).toEqual(wordIds);
  });
});

describe("模式与 Space 边界", () => {
  it("词书模式 Space 上调用常规用例被拒绝", () => {
    const world = buildWorld();
    const bookSpace = seedSpace(world.spaceStore, {
      id: BOOK_SPACE_ID,
      learningMode: "词书模式",
      name: "考研词汇",
      displayOrder: 2,
    });

    expect(() => world.service.dueGroups({ spaceId: bookSpace.id })).toThrow("当前 Space 不是常规模式");
    expect(() =>
      world.service.recordEntries({ spaceId: bookSpace.id, entries: [new ConfirmedEntry("mentor", [meaning("n.", "导师")])] }),
    ).toThrow("当前 Space 不是常规模式");
  });

  it("不存在的 Space 被拒绝", () => {
    const world = buildWorld();

    expect(() =>
      world.service.dueGroups({ spaceId: "99999999-9999-4999-8999-999999999999" }),
    ).toThrow("Space 不存在");
  });
});
