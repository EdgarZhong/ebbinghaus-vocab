/**
 * 今日看板用例测试（移植 V1 tests/unit/application/test_desktop_dashboard_tasks.py
 * 的核心回归：看板必须复用测试页的模式分发，两个入口的任务列表逐项一致）。
 *
 * 覆盖口径：
 * - 模式分发：常规模式走 FSRS 到期测试组提供者（绝不读词书任务，防止把已到期的
 *   FSRS 测试组误显示为"暂无任务"）；词书模式委托词书任务提供者；未注入词书
 *   提供者时明确报错（不静默返回空）；
 * - taskItems 与 dashboardSnapshot 走同一条模式分发路径；
 * - 今日视图聚合：容量快照镜像 + 复习/测试任务计数；无缓存时的保守默认值；
 * - 每日目标读写走正确通道：Space 级同步设置 KV（不落设备本地）；保存后返回的
 *   快照反映新目标；容量提供者收到的是 Space 级目标；
 * - refreshCapacity 委托两段式容量用例的更新侧。
 */
import { describe, expect, it } from "vitest";

import { spaceSettingKey } from "@ebbinghaus/protocol";

import {
  DashboardService,
  type BookTaskItemsProvider,
  type DashboardCapacityProvider,
  type RegularTaskItemsProvider,
} from "../src/dashboard.ts";
import type { CapacityPlanSnapshot, TodaysCapacityView } from "../src/capacityPlanning.ts";
import type { TaskItemSnapshot } from "../src/dto.ts";
import type { LearningDaySettings } from "@ebbinghaus/domain";
import { SettingsService } from "../src/settingsFacade.ts";
import {
  FixedClock,
  InMemoryDeviceLocalStore,
  InMemorySpaceStore,
  InMemorySyncedSettingsStore,
  StaticDeviceIdentity,
} from "./helpers/fakes.ts";
import { seedSpace } from "./helpers/assemble.ts";

const CLOCK_ISO = "2026-07-15T09:00:00Z";
/** 常规模式活动 Space（UUID 形态：Space 级设置键强制 UUIDv4）。 */
const REGULAR_SPACE_ID = "d4e5f6a7-0000-4000-8000-0000000000d1";
/** 词书模式 Space。 */
const BOOK_SPACE_ID = "d4e5f6a7-0000-4000-8000-0000000000e2";

/** 常规模式任务夹具：一个 FSRS 到期测试组任务。 */
function regularTestTask(): TaskItemSnapshot {
  return {
    taskId: `regular-group|${REGULAR_SPACE_ID}|2026-07-15|1`,
    listId: "",
    unitNumber: 0,
    listNumber: 1,
    taskType: "短期测试",
    dueReason: "FSRS 到期测试",
    workload: 1,
    overdueDays: 0,
    completedCount: 0,
    totalCount: 5,
    sessionStatus: null,
    activeWords: [],
  };
}

/** 仅复习任务夹具（用于看板的复习/测试计数）。 */
function reviewOnlyTask(): TaskItemSnapshot {
  return {
    taskId: "00000000-0000-4000-8000-000000000101",
    listId: "list-1",
    unitNumber: 1,
    listNumber: 1,
    taskType: "仅复习",
    dueReason: "T1 + 1 仅复习",
    workload: 1,
    overdueDays: 0,
    completedCount: 0,
    totalCount: 1,
    sessionStatus: null,
    activeWords: [],
  };
}

/** 完整容量快照夹具（字段与 V1 CapacityPlanSnapshot 一一对应）。 */
function fullSnapshot(overrides: Partial<CapacityPlanSnapshot> = {}): CapacityPlanSnapshot {
  return {
    targetCapacity: 8,
    recentActualDailyWorkload: 6,
    recentActualSampleCount: 3,
    dueWorkload: 2,
    overdueWorkload: 1,
    remainingCapacity: 5,
    suggestedFirstPassCount: 2,
    riskCapacity: 6,
    predictionWindowDays: 21,
    riskQuantilePercent: 85,
    reserveWorkload: 1,
    overloadProbability: 0.12,
    expectedMaxBacklog: 3.5,
    riskQuantileMaxBacklog: 4,
    expectedClearanceDays: 9,
    riskWorkloadByDay: [3, 4, 5],
    algorithmVersion: "capacity-monte-carlo-v2",
    ...overrides,
  };
}

/** 容量视图假实现：记录读取输入并返回可编程视图。 */
class FakeCapacityProvider implements DashboardCapacityProvider {
  public viewInputs: { spaceId: string; targetCapacity: number }[] = [];
  public refreshInputs: { spaceId: string; targetCapacity: number }[] = [];
  public view: TodaysCapacityView = { snapshot: null, stale: true };
  public refreshedSnapshot: CapacityPlanSnapshot = fullSnapshot();

  getTodaysCapacityView(input: {
    spaceId: string;
    targetCapacity: number;
    learningDaySettings: LearningDaySettings;
  }): TodaysCapacityView {
    this.viewInputs.push({ spaceId: input.spaceId, targetCapacity: input.targetCapacity });
    return this.view;
  }

  refreshTodaysPlan(input: {
    spaceId: string;
    targetCapacity: number;
    learningDaySettings: LearningDaySettings;
  }): CapacityPlanSnapshot {
    this.refreshInputs.push({ spaceId: input.spaceId, targetCapacity: input.targetCapacity });
    return this.refreshedSnapshot;
  }
}

/** 常规任务提供者假实现：记录调用并返回可编程任务列表。 */
class FakeRegularTasks implements RegularTaskItemsProvider {
  public callCount = 0;
  public tasks: readonly TaskItemSnapshot[] = [];

  regularTaskItems(): readonly TaskItemSnapshot[] {
    this.callCount += 1;
    return this.tasks;
  }
}

/** 词书任务提供者假实现：记录每次调用收到的 Space 标识。 */
class FakeBookTasks implements BookTaskItemsProvider {
  public calls: string[] = [];
  public tasks: readonly TaskItemSnapshot[] = [];

  bookTaskItems(spaceId: string): readonly TaskItemSnapshot[] {
    this.calls.push(spaceId);
    return this.tasks;
  }
}

/** 组装看板服务（默认活动 Space 为常规模式，容量视图为空缓存）。 */
function buildWorld(input: { activeSpaceId?: string; withBookTasks?: boolean } = {}) {
  const clock = new FixedClock(CLOCK_ISO);
  const spaceStore = new InMemorySpaceStore();
  const syncedSettings = new InMemorySyncedSettingsStore();
  const deviceLocal = new InMemoryDeviceLocalStore();
  const settings = new SettingsService({
    syncedSettings,
    deviceLocal,
    clock,
    deviceIdentity: new StaticDeviceIdentity(),
  });
  seedSpace(spaceStore, { id: REGULAR_SPACE_ID, learningMode: "常规模式", name: "日常积累" });
  seedSpace(spaceStore, { id: BOOK_SPACE_ID, learningMode: "词书模式", name: "考研词汇", displayOrder: 2 });
  settings.setActiveSpaceId(input.activeSpaceId ?? REGULAR_SPACE_ID);
  const capacity = new FakeCapacityProvider();
  const regularTasks = new FakeRegularTasks();
  const bookTasks = input.withBookTasks === false ? null : new FakeBookTasks();
  const service = new DashboardService({ spaceStore, settings, capacity, regularTasks, bookTasks });
  return { spaceStore, syncedSettings, deviceLocal, settings, capacity, regularTasks, bookTasks, service };
}

describe("模式分发：看板复用测试页的数据源", () => {
  it("常规模式：taskItems 与 dashboardSnapshot 的任务列表逐项一致", () => {
    const world = buildWorld();
    world.regularTasks.tasks = [regularTestTask()];

    const testPageTasks = world.service.taskItems();
    const dashboard = world.service.dashboardSnapshot();

    // V1 核心回归：同一门面入口既是测试页数据源，也是看板的任务数据源。
    expect(dashboard.tasks).toEqual(testPageTasks);
    expect(testPageTasks).toEqual([regularTestTask()]);
    expect(world.regularTasks.callCount).toBe(2);
    // 常规模式绝不读词书任务（词书提供者未注入也不报错）。
    expect(world.bookTasks!.calls).toEqual([]);
  });

  it("词书模式：任务来自词书提供者，参数是活动 Space；常规提供者不被调用", () => {
    const world = buildWorld({ activeSpaceId: BOOK_SPACE_ID });
    world.bookTasks!.tasks = [reviewOnlyTask()];

    const page = world.service.taskItemsPage();

    expect(page.learningMode).toBe("词书模式");
    expect(page.tasks).toEqual([reviewOnlyTask()]);
    expect(world.bookTasks!.calls).toEqual([BOOK_SPACE_ID]);
    expect(world.regularTasks.callCount).toBe(0);
  });

  it("词书模式未注入任务提供者时明确报错，不静默返回空列表", () => {
    const world = buildWorld({ activeSpaceId: BOOK_SPACE_ID, withBookTasks: false });

    expect(() => world.service.taskItems()).toThrow(
      "词书模式任务列表尚未接线：请注入词书任务提供者",
    );
  });

  it("活动 Space 不存在时报装配错误", () => {
    const world = buildWorld();
    world.settings.setActiveSpaceId("e5f6a7b8-0000-4000-8000-0000000000e9");

    expect(() => world.service.taskItems()).toThrow("活动 Space 不存在");
  });
});

describe("今日视图聚合", () => {
  it("有容量快照：字段镜像到看板快照并统计复习/测试任务数", () => {
    const world = buildWorld();
    world.regularTasks.tasks = [regularTestTask(), reviewOnlyTask()];
    world.capacity.view = { snapshot: fullSnapshot(), stale: false };

    const dashboard = world.service.dashboardSnapshot();

    expect(dashboard.targetCapacity).toBe(8);
    expect(dashboard.recentActualDailyWorkload).toBe(6);
    expect(dashboard.recentActualSampleCount).toBe(3);
    expect(dashboard.dueWorkload).toBe(2);
    expect(dashboard.overdueWorkload).toBe(1);
    expect(dashboard.remainingCapacity).toBe(5);
    expect(dashboard.suggestedFirstPassCount).toBe(2);
    expect(dashboard.riskCapacity).toBe(6);
    expect(dashboard.predictionWindowDays).toBe(21);
    expect(dashboard.riskQuantilePercent).toBe(85);
    expect(dashboard.reserveWorkload).toBe(1);
    expect(dashboard.overloadProbability).toBe(0.12);
    expect(dashboard.expectedMaxBacklog).toBe(3.5);
    expect(dashboard.riskQuantileMaxBacklog).toBe(4);
    expect(dashboard.expectedClearanceDays).toBe(9);
    expect(dashboard.riskWorkloadByDay).toEqual([3, 4, 5]);
    expect(dashboard.capacityAlgorithmVersion).toBe("capacity-monte-carlo-v2");
    expect(dashboard.capacityStale).toBe(false);
    expect(dashboard.reviewTaskCount).toBe(1);
    expect(dashboard.testTaskCount).toBe(1);
    expect(dashboard.learningMode).toBe("常规模式");
    // 容量读取使用 Space 级每日目标（默认 0）与活动 Space。
    expect(world.capacity.viewInputs).toEqual([
      { spaceId: REGULAR_SPACE_ID, targetCapacity: 0 },
    ]);
  });

  it("无缓存快照：展示保守默认值并标记 capacityStale=true（两段式固定交互）", () => {
    const world = buildWorld();
    world.settings.saveSpaceDailyTarget(REGULAR_SPACE_ID, 8);
    world.regularTasks.tasks = [regularTestTask()];
    world.capacity.view = { snapshot: null, stale: true };

    const dashboard = world.service.dashboardSnapshot();

    expect(dashboard.targetCapacity).toBe(8);
    expect(dashboard.recentActualDailyWorkload).toBeNull();
    expect(dashboard.recentActualSampleCount).toBe(0);
    expect(dashboard.dueWorkload).toBe(0);
    expect(dashboard.overdueWorkload).toBe(0);
    expect(dashboard.remainingCapacity).toBe(8);
    expect(dashboard.suggestedFirstPassCount).toBe(0);
    expect(dashboard.riskCapacity).toBe(0);
    expect(dashboard.predictionWindowDays).toBe(21);
    expect(dashboard.riskQuantilePercent).toBe(85);
    expect(dashboard.reserveWorkload).toBe(1);
    expect(dashboard.riskWorkloadByDay).toEqual([]);
    expect(dashboard.capacityAlgorithmVersion).toBe("");
    expect(dashboard.capacityStale).toBe(true);
  });

  it("refreshCapacity 委托两段式容量的更新侧并传入 Space 级每日目标", () => {
    const world = buildWorld();
    world.settings.saveSpaceDailyTarget(REGULAR_SPACE_ID, 12);
    world.capacity.refreshedSnapshot = fullSnapshot({ targetCapacity: 12 });

    const refreshed = world.service.refreshCapacity();

    expect(world.capacity.refreshInputs).toEqual([
      { spaceId: REGULAR_SPACE_ID, targetCapacity: 12 },
    ]);
    expect(refreshed.targetCapacity).toBe(12);
  });
});

describe("每日目标：走 Space 级同步设置通道", () => {
  it("保存后目标写入同步设置 KV（不落设备本地），返回的看板快照携带新目标", () => {
    const world = buildWorld();
    world.capacity.view = { snapshot: null, stale: true };

    const dashboard = world.service.saveActiveSpaceDailyTarget(8);

    // 正确通道：Space 级同步设置键存在；设备本地 KV 没有该键。
    expect(world.syncedSettings.getAll().some((entry) => entry.key === spaceSettingKey(REGULAR_SPACE_ID, "dailyTarget"))).toBe(true);
    expect(world.deviceLocal.getString(spaceSettingKey(REGULAR_SPACE_ID, "dailyTarget"))).toBeNull();
    // 读回与快照一致。
    expect(world.settings.getSpaceLearningSettings(REGULAR_SPACE_ID).dailyTarget).toBe(8);
    expect(dashboard.targetCapacity).toBe(8);
    expect(dashboard.learningMode).toBe("常规模式");
  });

  it("非法目标（负数或非整数）被拒绝，且不产生任何写入", () => {
    const world = buildWorld();

    expect(() => world.service.saveActiveSpaceDailyTarget(-1)).toThrow("每日学习目标不能小于 0");
    expect(() => world.service.saveActiveSpaceDailyTarget(1.5)).toThrow("每日学习目标不能小于 0");
    expect(
      world.syncedSettings.getAll().some((entry) => entry.key.endsWith(".dailyTarget")),
    ).toBe(false);
  });

  it("保存后容量输入变化：后续读取携带新目标（缓存由 stale 标记表达过期）", () => {
    const world = buildWorld();

    world.service.saveActiveSpaceDailyTarget(8);
    world.service.dashboardSnapshot();

    // 保存用例内部回读一次快照 + 显式读取一次：每次读取携带的都是 Space 级新目标。
    expect(world.capacity.viewInputs).toHaveLength(2);
    expect(world.capacity.viewInputs.every((input) => input.targetCapacity === 8)).toBe(true);
  });
});
