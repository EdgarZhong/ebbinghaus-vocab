/**
 * Space 选择、创建、重命名、归档、恢复与空 Space 删除用例
 * （移植 V1 application/space_management.py，行为与错误文案逐字保留）。
 *
 * V2 口径差异：活动 Space 是设备本地状态（判断文件 A1 第 5 项），读写走
 * `SettingsService` 的设备本地通道，不产生同步事件；V1 存在 user_settings 行中。
 *
 * "空 Space"判定从 V1 的仓储计数改为内容目录谓词：登记过任何条目或建过任何
 * List（含已软移除）即视为有学习数据，其他内容必须通过归档保留。
 */

import {
  createSpace,
  isSpaceArchived,
  spaceDisplayName,
  type LearningMode,
  type Space,
  type SpaceKind,
} from "@ebbinghaus/domain";
import type {
  BookCatalogStore,
  Clock,
  IdGenerator,
  SpaceStore,
  UnitOfWork,
  WordContentStore,
} from "./ports.ts";
import type { SettingsService } from "./settingsFacade.ts";

export interface SpaceManagementServiceDeps {
  readonly spaceStore: SpaceStore;
  readonly wordContentStore: WordContentStore;
  readonly bookCatalogStore: BookCatalogStore;
  readonly settings: SettingsService;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly unitOfWork: UnitOfWork;
}

export class SpaceManagementService {
  private readonly deps: SpaceManagementServiceDeps;

  constructor(deps: SpaceManagementServiceDeps) {
    this.deps = deps;
  }

  /**
   * 创建自定义 Space 并原子设为活动项，避免出现创建成功但仍停留在旧上下文。
   * 显示顺序接续现有最大值，创建时间与更新时间取自注入时钟。
   */
  createAndActivate(input: { readonly name: string; readonly learningMode: LearningMode }): Space {
    const name = this.validatedUniqueName(input.name);
    const spaces = this.deps.spaceStore.listSpaces();
    const now = this.deps.clock.now().toISOString();
    const space = createSpace({
      id: this.deps.idGenerator.nextId(),
      kind: null,
      displayOrder: Math.max(0, ...spaces.map((item) => item.displayOrder)) + 1,
      name,
      createdAt: now,
      updatedAt: now,
      learningMode: input.learningMode,
    });
    this.deps.unitOfWork.run(() => {
      this.deps.spaceStore.addSpace(space);
      this.deps.settings.setActiveSpaceId(space.id);
    });
    return space;
  }

  /** 更新用户名称；未归档 Space 之间按去空白、忽略大小写比较唯一性。 */
  rename(input: { readonly spaceId: string; readonly name: string }): Space {
    const current = this.requireSpace(input.spaceId);
    const name = this.validatedUniqueName(input.name, { excludingSpaceId: input.spaceId });
    const updated: Space = {
      ...current,
      name,
      updatedAt: this.deps.clock.now().toISOString(),
    };
    this.deps.unitOfWork.run(() => {
      this.deps.spaceStore.updateSpace(updated);
    });
    return updated;
  }

  /**
   * 归档非当前 Space；数据与顺序完整保留，日常任务入口不再显示。
   * 归档活动 Space 必须先切换；只剩一个可用 Space 时禁止归档。
   */
  archive(input: { readonly spaceId: string }): Space {
    const current = this.requireSpace(input.spaceId);
    if (isSpaceArchived(current)) {
      return current;
    }
    if (input.spaceId === this.requireActiveSpaceId()) {
      throw new Error(`请先切换到另一个 Space，再归档“${spaceDisplayName(current)}”。`);
    }
    const activeSpaces = this.deps.spaceStore.listSpaces().filter((space) => !isSpaceArchived(space));
    if (activeSpaces.length <= 1) {
      throw new Error("至少保留一个可用的 Space。");
    }
    const now = this.deps.clock.now().toISOString();
    const updated: Space = { ...current, archivedAt: now, updatedAt: now };
    this.deps.unitOfWork.run(() => {
      this.deps.spaceStore.updateSpace(updated);
    });
    return updated;
  }

  /** 恢复归档 Space；若名称已被新的活动 Space 使用，先要求用户解决冲突。 */
  restore(input: { readonly spaceId: string }): Space {
    const current = this.requireSpace(input.spaceId);
    if (!isSpaceArchived(current)) {
      return current;
    }
    this.validatedUniqueName(spaceDisplayName(current), { excludingSpaceId: input.spaceId });
    const updated: Space = {
      ...current,
      archivedAt: null,
      updatedAt: this.deps.clock.now().toISOString(),
    };
    this.deps.unitOfWork.run(() => {
      this.deps.spaceStore.updateSpace(updated);
    });
    return updated;
  }

  /** 只删除完全无学习数据且非当前的 Space，其他内容必须通过归档保留。 */
  deleteEmpty(input: { readonly spaceId: string }): void {
    const current = this.requireSpace(input.spaceId);
    if (input.spaceId === this.requireActiveSpaceId()) {
      throw new Error("请先切换到另一个 Space，再删除当前 Space。");
    }
    if (!isSpaceArchived(current)) {
      const activeSpaces = this.deps.spaceStore
        .listSpaces()
        .filter((space) => !isSpaceArchived(space));
      if (activeSpaces.length <= 1) {
        throw new Error("至少保留一个可用的 Space。");
      }
    }
    if (this.spaceHasLearningData(input.spaceId)) {
      throw new Error(`“${spaceDisplayName(current)}”已有学习记录，只能归档，不能删除。`);
    }
    this.deps.unitOfWork.run(() => {
      this.deps.spaceStore.deleteSpace(input.spaceId);
    });
  }

  /**
   * 统一名称清理与唯一性，界面和持久层唯一约束共享同一业务口径：
   * 去首尾空白；与全部未归档 Space（可排除自身）按 casefold 忽略大小写比较。
   */
  private validatedUniqueName(
    name: string,
    options?: { readonly excludingSpaceId?: string },
  ): string {
    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new Error("请输入 Space 名称。");
    }
    const normalizedKey = normalizedName.toLowerCase();
    for (const space of this.deps.spaceStore.listSpaces()) {
      if (space.id === options?.excludingSpaceId || isSpaceArchived(space)) {
        continue;
      }
      if (spaceDisplayName(space).toLowerCase() === normalizedKey) {
        throw new Error(`已有名为“${normalizedName}”的 Space，请换一个名称。`);
      }
    }
    return normalizedName;
  }

  private requireSpace(spaceId: string): Space {
    const space = this.deps.spaceStore.getSpace(spaceId);
    if (space === null) {
      throw new Error("Space 不存在。");
    }
    return space;
  }

  /** 活动 Space 由设备本地设置承载；缺失属于装配错误而非用户可恢复错误。 */
  private requireActiveSpaceId(): string {
    return this.deps.settings.getActiveSpaceId();
  }

  /** 只要登记过条目（含已移除）或建过 List，就视为有学习数据。 */
  private spaceHasLearningData(spaceId: string): boolean {
    return (
      this.deps.wordContentStore.hasEntriesForSpace(spaceId) ||
      this.deps.bookCatalogStore.hasListsForSpace(spaceId)
    );
  }
}

// ---------------------------------------------------------------------------
// 首次启动默认数据
// ---------------------------------------------------------------------------

/** 首次启动固定的四个默认 Space 定义（id/kind/顺序/名称/学习模式）。 */
export interface DefaultSpaceDefinition {
  readonly id: string;
  readonly kind: SpaceKind | null;
  readonly displayOrder: number;
  readonly name: string | null;
  readonly learningMode: LearningMode;
}

/**
 * V1 initialize_default_application_data 的默认 Space 清单（顺序与名称保留）。
 *
 * id 必须是 UUIDv4 形态：Space 级设置键 `space.<spaceId>.*` 由协议强制 UUIDv4
 * （ensureSpaceLearningDefaults 走 spaceSettingKey），V1 式可读 id（"space-required"）
 * 无法通过协议校验，会使首次初始化必然失败。这里用确定性 UUIDv4（版本位 4、变体位 8、
 * 尾号 1–4 递增），跨设备、跨安装稳定——幂等补建语义依赖 id 永不改变。
 */
export const DEFAULT_SPACE_DEFINITIONS: readonly DefaultSpaceDefinition[] = [
  {
    id: "a1f0c3d4-0000-4000-8000-000000000001",
    kind: "必考词",
    displayOrder: 1,
    name: null,
    learningMode: "词书模式",
  },
  {
    id: "a1f0c3d4-0000-4000-8000-000000000002",
    kind: "常考词",
    displayOrder: 2,
    name: null,
    learningMode: "词书模式",
  },
  {
    id: "a1f0c3d4-0000-4000-8000-000000000003",
    kind: "偶考词",
    displayOrder: 3,
    name: null,
    learningMode: "词书模式",
  },
  {
    id: "a1f0c3d4-0000-4000-8000-000000000004",
    kind: null,
    displayOrder: 4,
    name: "日常积累",
    learningMode: "常规模式",
  },
] as const;

/**
 * 首次启动原子建立固定 Space 与默认设置，重复启动不覆盖用户选择。
 *
 * ensure 语义（与 V1 ensure_user_settings 一致）：
 * - 缺失的默认 Space 才补建；
 * - 学习日设置只在键缺失时写入默认值；
 * - 活动 Space 只在本设备从未设置过时缺省到第一个默认 Space（设备本地状态）。
 */
export function initializeDefaultApplicationData(deps: {
  readonly spaceStore: SpaceStore;
  readonly settings: SettingsService;
  readonly clock: Clock;
  readonly unitOfWork: UnitOfWork;
}): void {
  deps.unitOfWork.run(() => {
    const existingByIid = new Set(deps.spaceStore.listSpaces().map((space) => space.id));
    for (const definition of DEFAULT_SPACE_DEFINITIONS) {
      if (existingByIid.has(definition.id)) {
        continue;
      }
      const now = deps.clock.now().toISOString();
      deps.spaceStore.addSpace(
        createSpace({
          id: definition.id,
          kind: definition.kind,
          displayOrder: definition.displayOrder,
          name: definition.name,
          createdAt: now,
          updatedAt: now,
          learningMode: definition.learningMode,
        }),
      );
    }
    deps.settings.ensureLearningDayDefaults();
    for (const definition of DEFAULT_SPACE_DEFINITIONS) {
      deps.settings.ensureSpaceLearningDefaults(definition.id);
    }
    if (deps.settings.getActiveSpaceIdOrNull() === null) {
      deps.settings.setActiveSpaceId(
      DEFAULT_SPACE_DEFINITIONS[0]?.id ?? "a1f0c3d4-0000-4000-8000-000000000001",
    );
    }
  });
}
