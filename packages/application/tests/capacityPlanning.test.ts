/**
 * 两段式容量规划用例测试（移植 V1 application/capacity_planning.rebuild_today 的
 * 指纹与复用口径；两段式拆分本身是 V2 对 AGENTS.md 固定交互的实现，V1 无对应
 * 独立测试，断言口径取自 V1 tests/unit/domain/test_capacity.py 的确定性与
 * 建议规则，以及 desktop 门面对 DailyPlan 快照字段的消费方式）。
 *
 * 覆盖口径：
 * - 读侧铁律：getTodaysCapacityView 绝不触发蒙特卡洛（用可计数的 predictCapacity
 *   包装探针做硬断言）；无落盘计划时 snapshot=null + stale=true；
 * - 有落盘计划：指纹一致 stale=false；指纹不一致返回旧快照且 stale=true
 *   （"显示最近缓存结果"语义）；
 * - 更新侧：refreshTodaysPlan 指纹命中复用（内存缓存与跨"进程重启"的落盘命中
 *   都不再模拟、不再写库）；输入变化（当日实际完成量、目标容量）才重算；
 * - 候选缺失抛错且不产生半成品落盘；Space 之间缓存互不串扰。
 */
import { describe, expect, it, vi } from "vitest";

import type { CapacityPrediction } from "@ebbinghaus/domain";

/**
 * predictCapacity 探针：记录调用次数，并可强制返回"建议下标越界"的异常预测，
 * 用于触发应用层"候选缺失"守卫。vi.hoisted 保证在 vi.mock 工厂执行前初始化。
 */
const predictControl = vi.hoisted(() => ({
  calls: 0,
  omitSuggestedCandidate: false,
}));

vi.mock("@ebbinghaus/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ebbinghaus/domain")>();
  return {
    ...actual,
    predictCapacity: (request: Parameters<typeof actual.predictCapacity>[0]): CapacityPrediction => {
      predictControl.calls += 1;
      const prediction = actual.predictCapacity(request);
      if (predictControl.omitSuggestedCandidate) {
        // 建议值越界等价于 candidates[建议数] 缺失，模拟候选数组异常形态。
        return { ...prediction, suggestedFirstPassCount: prediction.candidates.length + 10 };
      }
      return prediction;
    },
  };
});

import {
  CapacityPlanningService,
} from "../src/capacityPlanning.ts";
import { SchedulingService } from "../src/scheduling.ts";
import { LearningEventRecorder } from "../src/eventRecorder.ts";
import { SettingsService } from "../src/settingsFacade.ts";
import {
  FixedClock,
  InMemoryBookCatalogStore,
  InMemoryDailyPlanStore,
  InMemoryDeviceLocalStore,
  InMemoryEventStore,
  InMemorySpaceStore,
  InMemorySyncedSettingsStore,
  InMemoryWordContentStore,
  SequentialDeviceSeqAllocator,
  SequentialIdGenerator,
  StaticDeviceIdentity,
} from "./helpers/fakes.ts";
import { LEARNING_DAY_SETTINGS } from "./helpers/assemble.ts";

const CLOCK_ISO = "2026-07-15T09:00:00Z";
const SPACE_ID = "space-daily";

/** 组装被测服务与全部端口假实现；探针计数按用例归零，保证绝对断言确定。 */
function buildWorld() {
  predictControl.calls = 0;
  const clock = new FixedClock(CLOCK_ISO);
  const eventStore = new InMemoryEventStore();
  const wordContentStore = new InMemoryWordContentStore();
  const bookCatalogStore = new InMemoryBookCatalogStore();
  const dailyPlanStore = new InMemoryDailyPlanStore();
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
  const capacity = new CapacityPlanningService({
    clock,
    eventStore,
    wordContentStore,
    bookCatalogStore,
    dailyPlanStore,
    scheduling,
  });
  return {
    clock,
    eventStore,
    eventRecorder,
    wordContentStore,
    bookCatalogStore,
    dailyPlanStore,
    spaceStore,
    settings,
    scheduling,
    capacity,
  };
}

/** 固定输入的刷新/读取参数（目标容量 8）。 */
function planInput(spaceId = SPACE_ID, targetCapacity = 8) {
  return { spaceId, targetCapacity, learningDaySettings: LEARNING_DAY_SETTINGS };
}

describe("getTodaysCapacityView：读侧铁律", () => {
  it("无缓存无落盘时返回 snapshot=null + stale=true，且绝不运行蒙特卡洛", () => {
    const world = buildWorld();
    const callsBefore = predictControl.calls;

    const view = world.capacity.getTodaysCapacityView(planInput());

    expect(view.snapshot).toBeNull();
    expect(view.stale).toBe(true);
    // 两段式铁律：读路径零模拟（探针计数不变）。
    expect(predictControl.calls).toBe(callsBefore);
  });

  it("刷新后指纹一致：返回落盘快照且 stale=false", () => {
    const world = buildWorld();
    const refreshed = world.capacity.refreshTodaysPlan(planInput());

    const view = world.capacity.getTodaysCapacityView(planInput());

    expect(view.stale).toBe(false);
    expect(view.snapshot).not.toBeNull();
    expect(view.snapshot).toEqual(refreshed);
  });

  it("指纹过期时返回旧快照并标记 stale=true（显示最近缓存结果语义）", () => {
    const world = buildWorld();
    const refreshed = world.capacity.refreshTodaysPlan(planInput());
    // 新增当日完成事实：指纹后缀中的实际完成量变化，缓存随之过期。
    const event = world.eventRecorder.record({
      eventType: "firstPassRecorded",
      targetType: "条目",
      targetId: "entry-1",
      source: "常规模式录入",
      metadata: { workload: 3 },
    });
    world.eventStore.appendEvents([event]);

    const view = world.capacity.getTodaysCapacityView(planInput());

    // 展示值仍是最近缓存结果（不阻塞、不丢弃），由 stale 标记提示组合根刷新。
    expect(view.stale).toBe(true);
    expect(view.snapshot).toEqual(refreshed);
    expect(predictControl.calls).toBe(1);
  });
});

describe("refreshTodaysPlan：指纹命中与重算", () => {
  it("首次刷新运行一次模拟并落盘；快照字段与常量口径一致", () => {
    const world = buildWorld();

    const snapshot = world.capacity.refreshTodaysPlan(planInput());

    expect(predictControl.calls).toBe(1);
    expect(world.dailyPlanStore.upsertCount).toBe(1);
    expect(snapshot.targetCapacity).toBe(8);
    // 空空间：无到期任务、无历史样本；剩余容量等于目标。
    expect(snapshot.dueWorkload).toBe(0);
    expect(snapshot.overdueWorkload).toBe(0);
    expect(snapshot.remainingCapacity).toBe(8);
    expect(snapshot.recentActualDailyWorkload).toBeNull();
    expect(snapshot.recentActualSampleCount).toBe(0);
    expect(snapshot.predictionWindowDays).toBe(21);
    expect(snapshot.riskQuantilePercent).toBe(85);
    expect(snapshot.algorithmVersion).toBe("capacity-monte-carlo-v2");
    // 建议值是候选下标：必然落在候选数组范围内。
    expect(Number.isInteger(snapshot.suggestedFirstPassCount)).toBe(true);
    expect(snapshot.suggestedFirstPassCount).toBeGreaterThanOrEqual(0);
    expect(snapshot.riskWorkloadByDay).toHaveLength(21);
  });

  it("无任何输入变化时命中内存缓存：不重新模拟、不重复落盘", () => {
    const world = buildWorld();
    const first = world.capacity.refreshTodaysPlan(planInput());
    const callsAfterFirst = predictControl.calls;
    const upsertsAfterFirst = world.dailyPlanStore.upsertCount;

    const second = world.capacity.refreshTodaysPlan(planInput());

    expect(second).toEqual(first);
    expect(predictControl.calls).toBe(callsAfterFirst);
    expect(world.dailyPlanStore.upsertCount).toBe(upsertsAfterFirst);
  });

  it("跨进程重启（新服务实例共享存储）命中落盘指纹：直接复用不重算", () => {
    const world = buildWorld();
    const first = world.capacity.refreshTodaysPlan(planInput());
    const callsAfterFirst = predictControl.calls;
    const upsertsAfterFirst = world.dailyPlanStore.upsertCount;

    const restarted = new CapacityPlanningService({
      clock: world.clock,
      eventStore: world.eventStore,
      wordContentStore: world.wordContentStore,
      bookCatalogStore: world.bookCatalogStore,
      dailyPlanStore: world.dailyPlanStore,
      scheduling: world.scheduling,
    });
    const second = restarted.refreshTodaysPlan(planInput());

    expect(second).toEqual(first);
    expect(predictControl.calls).toBe(callsAfterFirst);
    expect(world.dailyPlanStore.upsertCount).toBe(upsertsAfterFirst);
  });

  it("当日实际完成量变化指纹：重新模拟并落盘，实际值进入计划记录", () => {
    const world = buildWorld();
    world.capacity.refreshTodaysPlan(planInput());
    const callsAfterFirst = predictControl.calls;
    const upsertsAfterFirst = world.dailyPlanStore.upsertCount;
    // 当日完成 1 个首过、工作量 3：firstPassRecorded（条目级）只看学习日。
    const event = world.eventRecorder.record({
      eventType: "firstPassRecorded",
      targetType: "条目",
      targetId: "entry-1",
      source: "常规模式录入",
      metadata: { workload: 3 },
    });
    world.eventStore.appendEvents([event]);

    const snapshot = world.capacity.refreshTodaysPlan(planInput());

    expect(predictControl.calls).toBe(callsAfterFirst + 1);
    expect(world.dailyPlanStore.upsertCount).toBe(upsertsAfterFirst + 1);
    expect(snapshot.dueWorkload).toBe(0);
    const stored = world.dailyPlanStore.get({ learningDay: "2026-07-15", spaceId: SPACE_ID });
    expect(stored?.actualFirstPassCount).toBe(1);
    expect(stored?.actualCompletedWorkload).toBe(3);
  });

  it("目标容量变化属于模拟输入：指纹变化触发重算", () => {
    const world = buildWorld();
    world.capacity.refreshTodaysPlan(planInput(SPACE_ID, 8));
    const callsAfterFirst = predictControl.calls;

    const snapshot = world.capacity.refreshTodaysPlan(planInput(SPACE_ID, 12));

    expect(predictControl.calls).toBe(callsAfterFirst + 1);
    expect(snapshot.targetCapacity).toBe(12);
    expect(snapshot.remainingCapacity).toBe(12);
  });

  it("固定种子下同一事实状态的建议不抖动（两次独立模拟结果一致）", () => {
    const world = buildWorld();
    const first = world.capacity.refreshTodaysPlan(planInput());

    // 清空内存缓存路径：换目标再换回，强制两次真实模拟对比确定性。
    const altered = world.capacity.refreshTodaysPlan(planInput(SPACE_ID, 9));
    const back = world.capacity.refreshTodaysPlan(planInput(SPACE_ID, 8));

    expect(back.suggestedFirstPassCount).toBe(first.suggestedFirstPassCount);
    expect(back.suggestedFirstPassCount).toBeGreaterThanOrEqual(0);
    expect(altered.targetCapacity).toBe(9);
  });
});

describe("refreshTodaysPlan：异常与隔离", () => {
  it("候选缺失时抛错且不产生半成品落盘", () => {
    const world = buildWorld();
    predictControl.omitSuggestedCandidate = true;
    const upsertsBefore = world.dailyPlanStore.upsertCount;

    try {
      expect(() => world.capacity.refreshTodaysPlan(planInput())).toThrow(
        "容量预测候选缺失，无法构造每日计划",
      );
    } finally {
      predictControl.omitSuggestedCandidate = false;
    }
    expect(world.dailyPlanStore.upsertCount).toBe(upsertsBefore);
    expect(world.dailyPlanStore.get({ learningDay: "2026-07-15", spaceId: SPACE_ID })).toBeNull();
  });

  it("Space 之间互不串扰：A 的缓存不等于 B 的视图", () => {
    const world = buildWorld();
    world.capacity.refreshTodaysPlan(planInput("space-a"));

    const viewB = world.capacity.getTodaysCapacityView(planInput("space-b"));

    expect(viewB.snapshot).toBeNull();
    expect(viewB.stale).toBe(true);
  });
});
