/**
 * 词书模式调度用例测试：事件重放 → 任务派生 → 稳定标识与排序（移植 V1
 * application/scheduling 的行为口径；V1 无独立调度应用层测试文件，断言口径取自
 * V1 tests/unit/domain/test_scheduling.py 的任务聚合用例与
 * tests/unit/application/test_desktop_dashboard_tasks.py 的任务视图口径）。
 *
 * 覆盖口径：
 * - refreshSpaceTasks：从不可变事件重放派生当日任务（首过 → T0+1 短期测试）；
 * - 稳定任务标识幂等：deriveListTaskId 同输入同标识，重复刷新、跨服务实例
 *   （等价"进程重启"）得到完全一致的任务标识序列；
 * - 逾期折叠：计划日保持不变、逾期天数按计划日累计，多日积压折叠为唯一任务，
 *   绝不生成虚拟补做任务（V1 test_overdue_demands_fold_without_virtual_catch_up_tasks）；
 * - 仅复习任务工作量 1、测试类任务工作量 2 的聚合口径；
 * - 排序稳定：先按计划日、再按任务标识；
 * - projectSpaceLists：目录是空间归属权威（目录外的 List 不进投影）、软移除词
 *   不参与、已掌握 List 退出投影。
 */
import { describe, expect, it } from "vitest";

import { TaskType } from "@ebbinghaus/domain";

import { LearningEventRecorder, deriveListTaskId } from "../src/eventRecorder.ts";
import {
  SchedulingService,
  activeSpaceWordStates,
  replayWordStates,
} from "../src/scheduling.ts";
import type { WordContentRecord } from "../src/ports.ts";
import { SettingsService } from "../src/settingsFacade.ts";
import {
  FixedClock,
  InMemoryBookCatalogStore,
  InMemoryDeviceLocalStore,
  InMemoryEventStore,
  InMemorySpaceStore,
  InMemorySyncedSettingsStore,
  InMemoryWordContentStore,
  SequentialDeviceSeqAllocator,
  SequentialIdGenerator,
  StaticDeviceIdentity,
} from "./helpers/fakes.ts";
import { LEARNING_DAY_SETTINGS, seedSpace } from "./helpers/assemble.ts";

/** 全部锚点（上海 04:00 换日，学习日 = UTC+8 日历日）。 */
const CLOCK_ISO = "2026-07-15T09:00:00Z";
const SPACE_ID = "space-book";
const LIST_A = "list-a";
const LIST_B = "list-b";

/** 组装被测服务与全部端口假实现（事件工厂与设置门面共享同一时钟与学习日设置）。 */
function buildWorld() {
  const clock = new FixedClock(CLOCK_ISO);
  const eventStore = new InMemoryEventStore();
  const wordContentStore = new InMemoryWordContentStore();
  const bookCatalogStore = new InMemoryBookCatalogStore();
  const spaceStore = new InMemorySpaceStore();
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
  const scheduling = new SchedulingService({
    clock,
    eventStore,
    wordContentStore,
    bookCatalogStore,
  });
  return {
    clock,
    eventStore,
    eventRecorder,
    wordContentStore,
    bookCatalogStore,
    spaceStore,
    settings,
    scheduling,
  };
}

type World = ReturnType<typeof buildWorld>;

/** 登记词书目录与首过事件：把 listId 挂到词书 Space 并为指定词写入首过事实。 */
function seedFirstPass(
  world: World,
  input: {
    readonly listId: string;
    readonly wordIds: readonly string[];
    /** 首过时刻（同时是该批词的 T0）；调用前需把时钟拨到该时刻。 */
    readonly atIso: string;
  },
): void {
  world.bookCatalogStore.addList({
    listId: input.listId,
    spaceId: SPACE_ID,
    unitId: "unit-1",
    unitNumber: 1,
    listNumber: input.listId === LIST_A ? 1 : 2,
  });
  const entries: WordContentRecord[] = input.wordIds.map((wordId) => ({
    wordId,
    listId: input.listId,
    // 词书词的 spaceId 为 null：空间归属由目录承载（src/scheduling.ts 注释口径）。
    spaceId: null,
    originalSpelling: `word-${wordId}`,
    normalizedKey: `word-${wordId}`,
    manualMeaning: "词义",
    meanings: [],
    removed: false,
    recordedAt: input.atIso,
  }));
  world.wordContentStore.upsertEntries(entries);
  const event = world.eventRecorder.record({
    eventType: "firstPassRecorded",
    targetType: "List",
    targetId: input.listId,
    source: "首过预览保存",
    metadata: { workload: 1, wordCount: input.wordIds.length, draftId: `draft-${input.listId}` },
  });
  world.eventStore.appendEvents([event]);
}

/** 写入一条词书模式历史测试事件（afterState 快照是重放侧的权威派生输入）。 */
function seedBookTestAnswer(
  world: World,
  input: {
    readonly wordId: string;
    readonly atIso: string;
    readonly afterState: Record<string, unknown>;
  },
): void {
  const event = world.eventRecorder.record({
    eventType: "testAnswered",
    targetType: "Word",
    targetId: input.wordId,
    source: "词书模式测试",
    metadata: {
      sessionId: "session-history",
      taskId: "task-history",
      initialJudgement: "认识",
      finalJudgement: "认识",
      answerRevised: false,
      beforeState: { shortTermPassCount: 0, masteryStatus: "未掌握" },
      afterState: input.afterState,
      algorithmVersion: "scheduler-v1",
    },
  });
  world.eventStore.appendEvents([event]);
}

describe("refreshSpaceTasks：事件重放到任务派生", () => {
  it("首过次日派生 T0+1 短期测试任务：工作量 2、原因与算法版本齐全", () => {
    const world = buildWorld();
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
    // 首过发生在 2026-07-15（学习日口径），T0 = 07-15，测试需求 T0+1 = 07-16。
    seedFirstPass(world, { listId: LIST_A, wordIds: ["w-1"], atIso: CLOCK_ISO });
    world.clock.setInstant("2026-07-16T09:00:00Z");

    const result = world.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    expect(result.learningDay).toBe("2026-07-16");
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    expect(task.listId).toBe(LIST_A);
    expect(task.taskType).toBe(TaskType.ShortTermTest);
    expect(task.scheduledDay).toBe("2026-07-16");
    // 只要存在测试需求，同日/逾期的仅复习由测试后整 List 纸质复习一并满足：工作量固定 2。
    expect(task.workload).toBe(2);
    expect(task.overdueDays).toBe(0);
    expect(task.algorithmVersion).toBe("scheduler-v1");
    expect(task.payload.testDemands).toHaveLength(1);
    expect(task.payload.testDemands[0]?.wordId).toBe("w-1");
    expect(task.payload.testDemands[0]?.reason).toBe("T0 + 1 第一次短期测试");
    expect(task.dueReason).toBe("T0 + 1 第一次短期测试");
    // 任务标识由稳定派生函数生成，形态与输入一一对应。
    expect(task.taskId).toBe(
      deriveListTaskId({
        algorithmVersion: "scheduler-v1",
        listId: LIST_A,
        taskType: "短期测试",
        scheduledDay: "2026-07-16",
      }),
    );
  });

  it("重复刷新得到同一任务标识集合（派生幂等，不产生第二个任务）", () => {
    const world = buildWorld();
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
    seedFirstPass(world, { listId: LIST_A, wordIds: ["w-1", "w-2"], atIso: CLOCK_ISO });
    world.clock.setInstant("2026-07-16T09:00:00Z");

    const first = world.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });
    const second = world.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    expect(second.tasks.map((task) => task.taskId)).toEqual(first.tasks.map((task) => task.taskId));
    expect(second.tasks).toHaveLength(1);
  });

  it("跨服务实例（等价进程重启）的任务标识序列与派生口径保持一致", () => {
    const world = buildWorld();
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
    seedFirstPass(world, { listId: LIST_A, wordIds: ["w-1"], atIso: CLOCK_ISO });
    world.clock.setInstant("2026-07-16T09:00:00Z");

    const before = world.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });
    // 新建服务实例、共享同一事件与内容存储：任务是从同一事件集确定性重放的派生态。
    const restarted = new SchedulingService({
      clock: world.clock,
      eventStore: world.eventStore,
      wordContentStore: world.wordContentStore,
      bookCatalogStore: world.bookCatalogStore,
    });
    const after = restarted.refreshSpaceTasks({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    expect(after.tasks.map((task) => task.taskId)).toEqual(before.tasks.map((task) => task.taskId));
    expect(after.tasks.map((task) => task.scheduledDay)).toEqual(
      before.tasks.map((task) => task.scheduledDay),
    );
  });

  it("当天没有任何到期需求的 List 不产生任务", () => {
    const world = buildWorld();
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
    // 首过当日：T0+1 尚未到来。
    seedFirstPass(world, { listId: LIST_A, wordIds: ["w-1"], atIso: CLOCK_ISO });

    const result = world.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    expect(result.tasks).toHaveLength(0);
  });
});

describe("refreshSpaceTasks：逾期折叠与工作量聚合", () => {
  it("多日积压折叠为唯一任务：计划日不变、逾期天数按计划日累计（V1 口径）", () => {
    const world = buildWorld();
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
    // T0 = 07-15；打开日 07-20：测试需求（07-16）与仅复习需求（07-17）全部逾期。
    seedFirstPass(world, { listId: LIST_A, wordIds: ["w-1"], atIso: CLOCK_ISO });
    world.clock.setInstant("2026-07-20T09:00:00Z");

    const result = world.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    // 对应 V1 test_overdue_demands_fold_without_virtual_catch_up_tasks：
    // 只有一个任务，计划日保持 07-16，不生成每日一份的虚拟补做任务。
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    expect(task.scheduledDay).toBe("2026-07-16");
    expect(task.overdueDays).toBe(4);
    expect(task.workload).toBe(2);
    // 到期原因 = 测试需求 + 仅复习需求按稳定顺序拼接（"；"连接去重原因集合）。
    expect(task.dueReason).toBe("T0 + 1 第一次短期测试；T0 + 2 仅复习");
    // 逾期不改写任务标识：标识仍由原计划日派生。
    expect(task.taskId).toBe(
      deriveListTaskId({
        algorithmVersion: "scheduler-v1",
        listId: LIST_A,
        taskType: "短期测试",
        scheduledDay: "2026-07-16",
      }),
    );
  });

  it("通过一次短期测试后派生 T1+1 仅复习任务：工作量 1", () => {
    const world = buildWorld();
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
    seedFirstPass(world, { listId: LIST_A, wordIds: ["w-1"], atIso: CLOCK_ISO });
    // 首过当日晚些时候通过第一次短期测试：T1 = 07-15，仅复习需求 T1+1 = 07-16。
    world.clock.setInstant("2026-07-15T10:00:00Z");
    seedBookTestAnswer(world, {
      wordId: "w-1",
      atIso: "2026-07-15T10:00:00.000Z",
      afterState: {
        shortTermPassCount: 1,
        masteryStatus: "未掌握",
        t0: "2026-07-15T09:00:00.000Z",
        t1: "2026-07-15T10:00:00.000Z",
      },
    });
    world.clock.setInstant("2026-07-16T09:00:00Z");

    const result = world.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    // 仅复习没有测试需求：工作量 1（绝不按词需求相加）。
    expect(task.taskType).toBe(TaskType.ReviewOnly);
    expect(task.workload).toBe(1);
    expect(task.scheduledDay).toBe("2026-07-16");
    expect(task.payload.testDemands).toHaveLength(0);
    expect(task.payload.reviewDemands).toHaveLength(1);
    expect(task.payload.reviewDemands[0]?.reason).toBe("T1 + 1 仅复习");
    expect(task.dueReason).toBe("T1 + 1 仅复习");
  });

  it("任务先按计划日、再按任务标识稳定排序", () => {
    const world = buildWorld();
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
    // List A 首过 07-14（测试需求 07-15，已逾期 1 天）；List B 首过 07-15（07-16 到期）。
    // 事件时刻取自注入时钟：逐个播种前必须显式拨表。
    world.clock.setInstant("2026-07-14T09:00:00Z");
    seedFirstPass(world, { listId: LIST_A, wordIds: ["wa-1"], atIso: "2026-07-14T09:00:00.000Z" });
    world.clock.setInstant(CLOCK_ISO);
    seedFirstPass(world, { listId: LIST_B, wordIds: ["wb-1"], atIso: CLOCK_ISO });
    world.clock.setInstant("2026-07-16T09:00:00Z");

    const result = world.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    expect(result.tasks.map((task) => task.listId)).toEqual([LIST_A, LIST_B]);
    expect(result.tasks.map((task) => task.scheduledDay)).toEqual(["2026-07-15", "2026-07-16"]);
  });
});

describe("projectSpaceLists：只读投影", () => {
  it("目录外的 List 不进入投影：目录是空间归属的权威来源", () => {
    const world = buildWorld();
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
    seedFirstPass(world, { listId: LIST_A, wordIds: ["w-1"], atIso: CLOCK_ISO });
    // List B 只有词内容登记、没有目录记录：归属不成立，投影必须排除。
    world.wordContentStore.upsertEntries([
      {
        wordId: "w-orphan",
        listId: LIST_B,
        spaceId: null,
        originalSpelling: "orphan",
        normalizedKey: "orphan",
        manualMeaning: "词义",
        meanings: [],
        removed: false,
        recordedAt: CLOCK_ISO,
      },
    ]);
    const orphanEvent = world.eventRecorder.record({
      eventType: "firstPassRecorded",
      targetType: "List",
      targetId: LIST_B,
      source: "首过预览保存",
      metadata: { workload: 1, wordCount: 1, draftId: "draft-orphan" },
    });
    world.eventStore.appendEvents([orphanEvent]);

    const projections = world.scheduling.projectSpaceLists({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    expect(projections.map((list) => list.listId)).toEqual([LIST_A]);
  });

  it("软移除词不参与调度：只剩软移除词的 List 不产生任何任务", () => {
    const world = buildWorld();
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
    seedFirstPass(world, { listId: LIST_A, wordIds: ["w-1"], atIso: CLOCK_ISO });
    const removedEvent = world.eventRecorder.record({
      eventType: "wordRemoved",
      targetType: "Word",
      targetId: "w-1",
      source: "内容维护",
      metadata: { listId: LIST_A, normalizedKey: "word-w-1" },
    });
    world.eventStore.appendEvents([removedEvent]);
    world.clock.setInstant("2026-07-16T09:00:00Z");

    const projections = world.scheduling.projectSpaceLists({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });
    const result = world.scheduling.refreshSpaceTasks({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    // List 仍在投影中（阶段未完成），但活动词为空 → 无任务。
    expect(projections.map((list) => list.listId)).toEqual([LIST_A]);
    expect(result.tasks).toHaveLength(0);
  });

  it("已掌握 List 退出常规调度投影", () => {
    const world = buildWorld();
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "词书模式", name: "考研词汇" });
    seedFirstPass(world, { listId: LIST_A, wordIds: ["w-1"], atIso: CLOCK_ISO });
    const masteredEvent = world.eventRecorder.record({
      eventType: "listMastered",
      targetType: "List",
      targetId: LIST_A,
      source: "纸质复习完成",
      metadata: { taskId: "task-history", taskType: "长期验证", workload: 2, reviewDemandKeys: [] },
    });
    world.eventStore.appendEvents([masteredEvent]);

    const projections = world.scheduling.projectSpaceLists({
      spaceId: SPACE_ID,
      learningDaySettings: LEARNING_DAY_SETTINGS,
    });

    expect(projections).toHaveLength(0);
  });
});

describe("共享重放工具：replayWordStates 与 activeSpaceWordStates", () => {
  it("按 Space 过滤活动词状态并按 Word 标识稳定排序；软移除词被剔除", () => {
    const world = buildWorld();
    // 常规模式条目（spaceId 非空）用于验证 Space 过滤口径。
    seedSpace(world.spaceStore, { id: SPACE_ID, learningMode: "常规模式", name: "日常积累" });
    const entries: WordContentRecord[] = ["w-2", "w-1", "w-3"].map((wordId) => ({
      wordId,
      listId: null,
      spaceId: SPACE_ID,
      originalSpelling: `entry-${wordId}`,
      normalizedKey: `entry-${wordId}`,
      manualMeaning: "词义",
      meanings: [],
      removed: false,
      recordedAt: CLOCK_ISO,
    }));
    world.wordContentStore.upsertEntries(entries);
    const events = ["w-1", "w-2", "w-3"].map((wordId) =>
      world.eventRecorder.record({
        eventType: "firstPassRecorded",
        targetType: "条目",
        targetId: wordId,
        source: "常规模式录入",
        metadata: { workload: 1 },
      }),
    );
    const removedEvent = world.eventRecorder.record({
      eventType: "wordRemoved",
      targetType: "条目",
      targetId: "w-3",
      source: "录入冲突处理",
      metadata: { spaceId: SPACE_ID, normalizedKey: "entry-w-3", reason: "重复录入冲突，用户选择覆盖" },
    });
    world.eventStore.appendEvents([...events, removedEvent]);

    const states = replayWordStates({
      eventStore: world.eventStore,
      wordContentStore: world.wordContentStore,
    });
    const active = activeSpaceWordStates(states, SPACE_ID);

    // 排序只看 Word 标识；软移除的 w-3 不出现；首过事件使条目获得 T0。
    expect(active.map((state) => state.wordId)).toEqual(["w-1", "w-2"]);
    expect(active[0]?.t0).toBe("2026-07-15T09:00:00.000Z");
    expect(active.every((state) => !state.removed)).toBe(true);
  });
});
