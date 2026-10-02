/**
 * 今日看板用例：任务汇总（按活动 Space 模式分发）+ 容量视图 + 每日目标保存
 * （移植 V1 application/desktop.py 的 dashboard/task_items/save_active_space_daily_target 部分）。
 *
 * 核心不变量（V1 test_desktop_dashboard_tasks.py 固化）：看板必须复用测试页的
 * 模式分发——常规模式没有 List 任务，若直接读取词书用例会把已到期的 FSRS 测试组
 * 误显示为"暂无任务"；词书模式则仍由统一入口刷新 List 任务。`taskItems` 与
 * `dashboardSnapshot` 走同一条模式分发路径，两者任务列表逐项一致。
 *
 * 容量两段式：看板读取走 `getTodaysCapacityView`（纯缓存读，绝不阻塞模拟）；
 * `capacityStale` 标记输入已变化，组合根应后台调用 `refreshTodaysPlan` 完成后
 * 重新取快照（AGENTS.md 固定交互语义）。
 */

import type { LearningMode } from "@ebbinghaus/domain";
import type { SettingsService } from "./settingsFacade.ts";
import type { SpaceStore } from "./ports.ts";
import type {
  CapacityPlanSnapshot,
  TodaysCapacityView,
} from "./capacityPlanning.ts";
import type { DashboardSnapshot, TaskItemSnapshot, TaskItemsPage } from "./dto.ts";

/** 词书模式任务列表提供者端口：词书逐词任务接线在后续阶段，注入点先固定。 */
export interface BookTaskItemsProvider {
  /** 返回词书模式活动 Space 的任务列表（后续阶段由词书测试用例实现）。 */
  bookTaskItems(spaceId: string): readonly TaskItemSnapshot[];
}

/** 常规模式任务列表提供者端口（由 RegularLearningService 实现）。 */
export interface RegularTaskItemsProvider {
  regularTaskItems(): readonly TaskItemSnapshot[];
}

/** 容量视图提供者端口（由 CapacityPlanningService 实现；测试注入假实现）。 */
export interface DashboardCapacityProvider {
  getTodaysCapacityView(input: {
    readonly spaceId: string;
    readonly targetCapacity: number;
    readonly learningDaySettings: import("@ebbinghaus/domain").LearningDaySettings;
  }): TodaysCapacityView;
  refreshTodaysPlan(input: {
    readonly spaceId: string;
    readonly targetCapacity: number;
    readonly learningDaySettings: import("@ebbinghaus/domain").LearningDaySettings;
  }): CapacityPlanSnapshot;
}

export interface DashboardServiceDeps {
  readonly spaceStore: SpaceStore;
  readonly settings: SettingsService;
  readonly capacity: DashboardCapacityProvider;
  readonly regularTasks: RegularTaskItemsProvider;
  /** 词书任务提供者；未注入时词书模式任务入口明确报未接入（不静默返回空）。 */
  readonly bookTasks?: BookTaskItemsProvider | null;
}

export class DashboardService {
  private readonly deps: DashboardServiceDeps;

  constructor(deps: DashboardServiceDeps) {
    this.deps = deps;
  }

  /**
   * 测试页任务数据源：按活动 Space 的学习模式分发。
   * 同一门面入口既是测试页数据源，也是看板的任务数据源，两者必须逐项一致。
   */
  taskItems(): readonly TaskItemSnapshot[] {
    return this.dispatchTaskItems().tasks;
  }

  /** 测试页任务列表（带模式标签）。 */
  taskItemsPage(): TaskItemsPage {
    return this.dispatchTaskItems();
  }

  /**
   * 看板快照：容量视图 + 当前模式任务的统一输出。
   * 容量只读缓存视图；`capacityStale=true` 时由组合根触发后台刷新。
   */
  dashboardSnapshot(): DashboardSnapshot {
    const spaceId = this.deps.settings.getActiveSpaceId();
    const space = this.deps.spaceStore.getSpace(spaceId);
    if (space === null) {
      throw new Error("活动 Space 不存在");
    }
    const spaceSettings = this.deps.settings.getSpaceLearningSettings(spaceId);
    const view = this.deps.capacity.getTodaysCapacityView({
      spaceId,
      targetCapacity: spaceSettings.dailyTarget,
      learningDaySettings: this.deps.settings.getLearningDaySettings(),
    });
    const tasks = this.taskItems();
    const snapshot = view.snapshot;
    return {
      targetCapacity: snapshot?.targetCapacity ?? spaceSettings.dailyTarget,
      recentActualDailyWorkload: snapshot?.recentActualDailyWorkload ?? null,
      recentActualSampleCount: snapshot?.recentActualSampleCount ?? 0,
      overdueWorkload: snapshot?.overdueWorkload ?? 0,
      dueWorkload: snapshot?.dueWorkload ?? 0,
      remainingCapacity: snapshot?.remainingCapacity ?? spaceSettings.dailyTarget,
      suggestedFirstPassCount: snapshot?.suggestedFirstPassCount ?? 0,
      riskCapacity: snapshot?.riskCapacity ?? 0,
      predictionWindowDays: snapshot?.predictionWindowDays ?? 21,
      riskQuantilePercent: snapshot?.riskQuantilePercent ?? 85,
      reserveWorkload: snapshot?.reserveWorkload ?? 1,
      overloadProbability: snapshot?.overloadProbability ?? 0,
      expectedMaxBacklog: snapshot?.expectedMaxBacklog ?? 0,
      riskQuantileMaxBacklog: snapshot?.riskQuantileMaxBacklog ?? 0,
      expectedClearanceDays: snapshot?.expectedClearanceDays ?? null,
      riskWorkloadByDay: snapshot?.riskWorkloadByDay ?? [],
      capacityAlgorithmVersion: snapshot?.algorithmVersion ?? "",
      capacityStale: view.stale,
      // 2026-10-02 口径：任务列表只含测试任务（复习不是任务），原复习/测试计数移除。
      tasks,
      learningMode: space.learningMode,
    };
  }

  /**
   * 触发今日容量后台刷新并返回刷新后的最新快照。
   * 组合根在后台任务中调用本方法，完成后界面重新 `dashboardSnapshot`。
   */
  refreshCapacity(): CapacityPlanSnapshot {
    const spaceId = this.deps.settings.getActiveSpaceId();
    const spaceSettings = this.deps.settings.getSpaceLearningSettings(spaceId);
    return this.deps.capacity.refreshTodaysPlan({
      spaceId,
      targetCapacity: spaceSettings.dailyTarget,
      learningDaySettings: this.deps.settings.getLearningDaySettings(),
    });
  }

  /**
   * 从今日看板保存当前 Space 的每日目标，避免高频计划决策藏进全局设置。
   * 保存后目标输入变化、缓存必然过期，返回的看板快照携带 stale 标记。
   */
  saveActiveSpaceDailyTarget(dailyTarget: number): DashboardSnapshot {
    if (!Number.isInteger(dailyTarget) || dailyTarget < 0) {
      throw new Error("每日学习目标不能小于 0");
    }
    this.deps.settings.saveSpaceDailyTarget(this.deps.settings.getActiveSpaceId(), dailyTarget);
    return this.dashboardSnapshot();
  }

  /** 模式分发：常规模式返回 FSRS 到期测试组；词书模式委托词书任务提供者。 */
  private dispatchTaskItems(): TaskItemsPage {
    const spaceId = this.deps.settings.getActiveSpaceId();
    const space = this.deps.spaceStore.getSpace(spaceId);
    if (space === null) {
      throw new Error("活动 Space 不存在");
    }
    const learningMode: LearningMode = space.learningMode;
    if (learningMode === "常规模式") {
      return { learningMode, tasks: this.deps.regularTasks.regularTaskItems() };
    }
    if (!this.deps.bookTasks) {
      throw new Error("词书模式任务列表尚未接线：请注入词书任务提供者");
    }
    return { learningMode, tasks: this.deps.bookTasks.bookTaskItems(spaceId) };
  }
}
