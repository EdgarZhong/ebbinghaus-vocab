/**
 * 浏览器模式组合根（Composition Root）。
 *
 * 职责（AGENTS.md 分层规则）：这是 React 界面与内部包之间的唯一装配出口——
 * - 用 @ebbinghaus/persistence 的内存运行时（createInMemoryRuntime，BrowserTestAdapter
 *   的产品形态）装配全部端口实现；
 * - 在其上构造应用层用例服务（SettingsService / SpaceManagementService /
 *   LlmConfigurationService）与界面只读视图（Space 摘要）；
 * - 执行首次启动初始化（initializeDefaultApplicationData，幂等）。
 *
 * React 组件只经 `useServices()` 消费本文件提供的 AppServices，绝不直接触碰端口
 * 对象，也绝不 import @tauri-apps/*、SQL 或任何记忆算法。
 *
 * 浏览器模式的取舍（TauriProductionAdapter 阶段会整体替换本文件的下述选择）：
 * - clock 用真实系统时钟（注入点保留：createAppServices 的 overrides 参数）；
 * - idGenerator 用 Web Crypto 的 UUIDv4（jsdom 等缺失 randomUUID 的环境回退到
 *   getRandomValues 手工拼装，形态一致）；
 * - secretCipher 用 TransparentSecretCipher 明文透传——**生产环境（Tauri 适配器）
 *   必须替换为基于本机绑定信息派生密钥的真实对称加密实现**，此处"没有加密"是
 *   刻意可见的，不允许静默冒充；
 * - 设备本地 KV 用 localStorage 承载（主题选择、活动 Space），注释与
 *   inMemoryRuntime.ts 的设想一致：浏览器模式下"换底层为 localStorage 即获得
 *   跨刷新稳定"。
 */

import {
  initializeDefaultApplicationData,
  LlmConfigurationService,
  SettingsService,
  SpaceManagementService,
  type Clock,
  type DeviceLocalStore,
  type IdGenerator,
} from "@ebbinghaus/application";
import { isSpaceArchived, type Space } from "@ebbinghaus/domain";
import { createInMemoryRuntime, type InMemoryRuntime } from "@ebbinghaus/persistence/src/adapters/inMemoryRuntime.ts";
import { SystemClock } from "@ebbinghaus/persistence/src/clock.ts";
import { TransparentSecretCipher } from "@ebbinghaus/persistence/src/repositories/settings.ts";

// ---------------------------------------------------------------------------
// 浏览器基础设施（端口实现）
// ---------------------------------------------------------------------------

/**
 * localStorage 底座的设备本地 KV。
 *
 * 读写都包 try/catch：隐私模式或存储被禁时写入失败不致命——状态仍在当前页面
 * 生命周期内有效（内存变量），只是刷新后回退默认值。
 */
class BrowserDeviceLocalStore implements DeviceLocalStore {
  constructor(private readonly storage: Storage) {}

  getString(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  setString(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch {
      // 写入失败保持静默：界面状态仍然成立，仅失去跨刷新持久化。
    }
  }
}

/** Web Crypto UUIDv4 生成器；randomUUID 缺失时用 getRandomValues 手工构造。 */
function createBrowserIdGenerator(): IdGenerator {
  return {
    nextId(): string {
      const webCrypto = globalThis.crypto;
      if (typeof webCrypto.randomUUID === "function") {
        return webCrypto.randomUUID();
      }
      const bytes = webCrypto.getRandomValues(new Uint8Array(16));
      // 版本位 4 与变体位 8/9/A/B，保证 UUIDv4 形态（协议 uuidV4Schema 校验）。
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
    },
  };
}

// ---------------------------------------------------------------------------
// 界面只读视图：Space 摘要（供 Space 管理页展示，不暴露存储端口）
// ---------------------------------------------------------------------------

/** Space 管理页行所需的最小事实集合；计数与"可删除"判定经内容目录谓词完成。 */
export interface SpaceSummary {
  readonly space: Space;
  readonly archived: boolean;
  /** 登记过条目（含已移除）或建过 List 即视为有学习数据（用例同口径）。 */
  readonly hasLearningData: boolean;
  readonly listCount: number;
  readonly entryCount: number;
}

// ---------------------------------------------------------------------------
// AppServices：界面消费的唯一服务门面
// ---------------------------------------------------------------------------

export interface AppServices {
  /** 同步设置 + 设备本地设置的统一门面（设置页读写入口）。 */
  readonly settings: SettingsService;
  /** Space 生命周期用例（Space 管理页读写入口）。 */
  readonly spaces: SpaceManagementService;
  /** 大语言模型服务配置用例（设置页 LLM 卡片读写入口）。 */
  readonly llm: LlmConfigurationService;
  /** 设备本地 KV（主题选择等纯界面偏好）。 */
  readonly deviceLocal: DeviceLocalStore;
  /** 内存运行时（供测试断言与后续同步引擎接线；界面组件不得直接使用）。 */
  readonly runtime: InMemoryRuntime;
  /** Space 管理页行视图。 */
  listSpaceSummaries(): SpaceSummary[];
  /** 单个 Space 摘要；不存在时返回 null。 */
  getSpaceSummary(spaceId: string): SpaceSummary | null;
  /** 当前活动 Space；尚未初始化或指向已不存在 Space 时返回 null。 */
  getActiveSpace(): Space | null;
  /** 切换活动 Space（设备本地状态，立即通知界面刷新）。 */
  setActiveSpaceId(spaceId: string): void;
  /** 订阅任意业务状态变化（版本号单调递增，驱动 useSyncExternalStore）。 */
  getVersion(): number;
  subscribeChanged(listener: () => void): () => void;
  /** 用例内部造成状态变化后由页面显式调用，触发全部订阅者重读。 */
  notifyChanged(): void;
}

export interface CreateAppServicesOptions {
  /** 覆盖系统时钟（测试注入确定性时钟）；缺省用真实系统时钟。 */
  readonly clock?: Clock;
  /** 覆盖设备本地 KV 底座（测试注入内存实现）；缺省用 localStorage。 */
  readonly deviceLocal?: DeviceLocalStore;
  /** 覆盖 ID 生成器（测试注入确定性实现）；缺省用 Web Crypto。 */
  readonly idGenerator?: IdGenerator;
}

export function createAppServices(options: CreateAppServicesOptions = {}): AppServices {
  const clock = options.clock ?? new SystemClock();
  const idGenerator = options.idGenerator ?? createBrowserIdGenerator();
  const deviceLocal = options.deviceLocal ?? new BrowserDeviceLocalStore(window.localStorage);

  const runtime = createInMemoryRuntime({
    clock,
    idGenerator,
    // 生产（Tauri 适配器）必须替换为真实密钥加密实现，见文件头注释。
    secretCipher: new TransparentSecretCipher(),
  });

  // SettingsService 的设备本地通道注入浏览器 KV 底座：活动 Space 跨刷新保留。
  // （运行时内部的 InMemoryDeviceIdentity 只承载 deviceId，生命周期与页面一致，
  // 浏览器模式下可接受；Tauri 阶段整体替换。）
  const settings = new SettingsService({
    syncedSettings: runtime.syncedSettingsStore,
    deviceLocal,
    clock,
    deviceIdentity: runtime.deviceIdentity,
  });

  const spaces = new SpaceManagementService({
    spaceStore: runtime.spaceStore,
    wordContentStore: runtime.wordContentStore,
    bookCatalogStore: runtime.bookCatalogStore,
    settings,
    clock,
    idGenerator,
    unitOfWork: runtime.unitOfWork,
  });

  // 本轮组合根不装配动态整理器/连通性探测（浏览器模式无密钥安全边界），
  // LLM 设置页的读写与脱敏快照仍然完整可用。
  const llm = new LlmConfigurationService({ configurationStore: runtime.llmConfigurationStore });

  // ---- 变化通知（简单版本号 + 订阅者集合） ----
  let version = 0;
  const listeners = new Set<() => void>();
  const notifyChanged = (): void => {
    version += 1;
    for (const listener of listeners) {
      listener();
    }
  };

  // ---- 首次启动初始化（幂等：重复调用不覆盖用户已有数据） ----
  initializeDefaultApplicationData({
    spaceStore: runtime.spaceStore,
    settings,
    clock,
    unitOfWork: runtime.unitOfWork,
  });

  // 浏览器模式修补：localStorage 里遗留的活动 Space 可能指向已不存在的自定义
  // Space（内存 Space 集每次刷新重建为默认值）；此时回退到第一个默认 Space，
  // 避免界面停在"无活动 Space"的悬挂状态。
  const activeSpaceIdOrNull = settings.getActiveSpaceIdOrNull();
  if (activeSpaceIdOrNull !== null && runtime.spaceStore.getSpace(activeSpaceIdOrNull) === null) {
    settings.setActiveSpaceId(runtime.spaceStore.listSpaces()[0]?.id ?? "");
  }

  const services: AppServices = {
    settings,
    spaces,
    llm,
    deviceLocal,
    runtime,
    listSpaceSummaries(): SpaceSummary[] {
      return runtime.spaceStore.listSpaces().map((space) => ({
        space,
        archived: isSpaceArchived(space),
        hasLearningData:
          runtime.wordContentStore.hasEntriesForSpace(space.id) ||
          runtime.bookCatalogStore.hasListsForSpace(space.id),
        listCount: runtime.bookCatalogStore.listListsForSpace(space.id).length,
        entryCount: runtime.wordContentStore.listEntriesForSpace(space.id).length,
      }));
    },
    getSpaceSummary(spaceId: string): SpaceSummary | null {
      return (
        services.listSpaceSummaries().find((summary) => summary.space.id === spaceId) ?? null
      );
    },
    getActiveSpace(): Space | null {
      const activeIdOrNull = settings.getActiveSpaceIdOrNull();
      if (activeIdOrNull === null) {
        return null;
      }
      return runtime.spaceStore.getSpace(activeIdOrNull);
    },
    setActiveSpaceId(spaceId: string): void {
      settings.setActiveSpaceId(spaceId);
      notifyChanged();
    },
    getVersion: () => version,
    subscribeChanged(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notifyChanged,
  };

  return services;
}

// ---------------------------------------------------------------------------
// 生产单例：main.tsx 全程共享同一份服务
// ---------------------------------------------------------------------------

let runtimeSingleton: AppServices | null = null;

/** 应用唯一的组合根出口；React 组件经 useServices() 消费，不得绕过。 */
export function getRuntime(): AppServices {
  if (runtimeSingleton === null) {
    runtimeSingleton = createAppServices();
  }
  return runtimeSingleton;
}
