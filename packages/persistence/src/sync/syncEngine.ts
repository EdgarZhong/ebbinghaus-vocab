/**
 * 同步引擎：outbox 消费 + 增量拉取 + settings 收敛的唯一编排点。
 *
 * 语义铁律（AGENTS.md "数据与同步"）：
 * - **断网不改变应用模式**：runCycle 绝不向调用方抛错——所有失败折叠为结果对象
 *   里的错误摘要，由界面决定展示与否；调用时机（启动/回前台/轮询）由组合根控制。
 * - **推送**：自动轮先消费 outbox 到期条目（退避由数据表达，见 outboxStore.ts）；
 *   用户显式重试可跳过到期时间，但失败后仍按真实时间退避。
 *   避免手机随时进入后台时把本地写入排在多页拉取之后；事件批量单往返，
 *   settings 批量单 PUT；服务器 accepted/duplicated 都算成功并清队。
 * - **拉取**：以 pull_cursor（sync_state）为高水位逐页推进，页间落盘游标——任意
 *   时刻崩溃/断线，重启后从断点继续（断点续传硬性要求）。事件经 applyPulledEvents
 *   幂等落库（本机已推事件的服务器回声不重复），新事件落地后触发 onEventsApplied
 *   钩子（组合根接领域重放刷新派生状态）。
 * - **settings 收敛**：GET 全量 → 协议 LWW 合并写回本地（不入 outbox，避免回声）；
 *   本设备变更经 outbox 的 settings 条目 PUT 上送。全量对账在个人规模下数据量极小
 *   （判断文件 D2），不引入 settings 版本游标。
 */

import type { Clock } from "@ebbinghaus/application";

import type { SyncGateway } from "./httpGateway.ts";
import type { OutboxStore } from "../outbox/outboxStore.ts";
import { SyncError } from "../errors.ts";
import type { ContentSyncStore } from "./contentStore.ts";

/** 单次推送批量上限：单事件数百字节，200 条约数十 KB，gzip 后往返成本可控。 */
const PUSH_BATCH_SIZE = 200;
/** 单次拉取页大小（与服务器默认一致）。 */
const PULL_PAGE_SIZE = 500;
/** outbox 单轮消费上限：防止单轮占用过久，剩余条目留给下一轮。 */
const DRAIN_LIMIT = 500;
/** 显式同步读取全部待推内容时使用的上界；失败收尾仍以真实时钟重新计算退避。 */
const MANUAL_RETRY_CUTOFF = "9999-12-31T23:59:59.999Z";

export interface SyncCycleOptions {
  /** 用户主动重试时跳过出站退避；定时轮询与本地写入触发保持原退避规则。 */
  readonly forcePush?: boolean;
}

/** 一轮同步的结果摘要（runCycle 永不抛错，失败折叠于此）。 */
export interface SyncCycleResult {
  /** 本轮拉取并新落库的事件数（触发重放的依据）。 */
  readonly pulledEventCount: number;
  readonly pulledContentCount: number;
  /** 本轮成功清队的 outbox 条目数。 */
  readonly pushedEntryCount: number;
  readonly pushedContentCount: number;
  /** 本轮 settings 全量对账是否成功执行。 */
  readonly settingsReconciled: boolean;
  /** 各阶段失败摘要（空数组 = 全部成功）；仅为观测，不驱动控制流。 */
  readonly errors: readonly string[];
}

/** 拉取事件幂等落地所需的最小能力（SQLite 与内存实现共同满足）。 */
export interface PulledEventApplier {
  applyPulledEvents(events: readonly import("@ebbinghaus/application").ApplicationEvent[]): number;
}

/** settings 合并结果写回所需的最小能力（不入 outbox 的落地路径）。 */
export interface MergedSettingsApplier {
  applyMerged(entries: readonly import("@ebbinghaus/protocol").SettingEntry[]): void;
}

export interface SyncEngineDeps {
  readonly gateway: SyncGateway;
  readonly eventStore: PulledEventApplier;
  readonly settingsStore: MergedSettingsApplier;
  readonly contentStore?: ContentSyncStore;
  readonly outbox: OutboxStore;
  readonly clock: Clock;
  /** 拉取游标（sync_state）存取：断点续传的载体。 */
  readonly pullCursor: { readonly read: () => number; readonly write: (value: number) => void };
  /** 拉取到新事件后的组合根钩子（重放/派生刷新）；引擎不关心其内部实现。 */
  readonly onEventsApplied?: (appliedCount: number) => void;
  readonly onContentApplied?: (appliedCount: number) => void;
}

export class SyncEngine {
  private readonly deps: SyncEngineDeps;

  constructor(deps: SyncEngineDeps) {
    this.deps = deps;
  }

  /** 当前拉取游标（sync_state.pull_cursor）。 */
  private readCursor(): number {
    return this.deps.pullCursor.read();
  }

  private writeCursor(value: number): void {
    this.deps.pullCursor.write(value);
  }

  /**
   * 执行一轮完整同步：本地待发送内容与事件 → settings 对账 → 增量拉取。
   * 手机写入后可能很快失去网络，先处理已落盘的出站队列可避免弱网中的多次
   * 拉取延迟推送；各阶段仍独立降级，失败条目按原退避规则保留。
   */
  async runCycle(options: SyncCycleOptions = {}): Promise<SyncCycleResult> {
    const errors: string[] = [];
    let settingsReconciled = false;
    let pulledEventCount = 0;
    let pulledContentCount = 0;
    let pushedEntryCount = 0;
    let pushedContentCount = 0;

    // 1) 内容先于事件推送：其他设备获得学习事实时，其身份目录应已存在于云端。
    if (this.deps.contentStore !== undefined) {
      const nowIso = this.deps.clock.now().toISOString();
      // 内容仓储的到期查询同时覆盖 SQLite 与浏览器内存实现。显式重试用最晚
      // ISO 时间读取待推项目，但 markFailed 始终传真实 nowIso，失败后仍继续退避。
      const due = this.deps.contentStore.dueEntries(
        options.forcePush ? MANUAL_RETRY_CUTOFF : nowIso, DRAIN_LIMIT,
      );
      for (let offset = 0; offset < due.length; offset += PUSH_BATCH_SIZE) {
        const batch = due.slice(offset, offset + PUSH_BATCH_SIZE);
        try {
          const response = await this.deps.gateway.putContent(batch.map((item) => item.entry));
          this.deps.contentStore.applyRemote(response.contents);
          for (const item of batch) {
            this.deps.contentStore.markSucceeded(item);
            pushedContentCount += 1;
          }
        } catch (error) {
          for (const item of batch) this.deps.contentStore.markFailed(item, describeSyncError(error), nowIso);
          errors.push(`内容推送失败：${describeSyncError(error)}`);
        }
      }
    }

    // 2) 学习事件与 settings 出站；内容失败不阻断学习操作，失败留在本地重试。
    try {
      pushedEntryCount = await this.drainOutbox(errors, options.forcePush === true);
    } catch (error) {
      errors.push(`推送失败：${describeSyncError(error)}`);
    }

    // 3) settings 全量对账。出站完成后再拉取权威合并结果，减少设备切换等待。
    try {
      const remote = await this.deps.gateway.getSettings();
      this.deps.settingsStore.applyMerged(remote.settings);
      settingsReconciled = true;
    } catch (error) {
      errors.push(`settings 对账失败：${describeSyncError(error)}`);
    }

    // 4) 内容先于事件拉取：领域重放需要已齐备的 Space/Word 目录作为输入。
    if (this.deps.contentStore !== undefined) {
      try {
        for (;;) {
          const page = await this.deps.gateway.pullContent(this.deps.contentStore.readCursor(), PULL_PAGE_SIZE);
          const applied = this.deps.contentStore.applyRemote(page.contents);
          this.deps.contentStore.writeCursor(page.nextCursor);
          pulledContentCount += applied;
          if (applied > 0) this.deps.onContentApplied?.(applied);
          if (!page.hasMore) break;
        }
      } catch (error) {
        errors.push(`内容拉取失败：${describeSyncError(error)}`);
      }
    }

    // 5) 事件增量拉取（断点续传：逐页推进并落盘游标）。
    try {
      for (;;) {
        const page = await this.deps.gateway.pull(this.readCursor(), PULL_PAGE_SIZE);
        const applied = this.deps.eventStore.applyPulledEvents(page.events);
        this.writeCursor(page.nextCursor);
        pulledEventCount += applied;
        if (applied > 0) {
          this.deps.onEventsApplied?.(applied);
        }
        if (!page.hasMore) {
          break;
        }
      }
    } catch (error) {
      errors.push(`事件拉取失败：${describeSyncError(error)}`);
    }

    return { pulledEventCount, pulledContentCount, pushedEntryCount, pushedContentCount, settingsReconciled, errors };
  }

  /** 自动取到期条目，手动取待发条目；失败逐条退避，绝不清队。 */
  private async drainOutbox(errors: string[], forcePush: boolean): Promise<number> {
    const nowIso = this.deps.clock.now().toISOString();
    // 事件与设置队列已有完整待发视图；手动模式只绕过时间门，不改变单轮
    // 上限、服务器幂等回执和失败条目的退避收尾。
    const due = forcePush
      ? this.deps.outbox.listPending().slice(0, DRAIN_LIMIT)
      : this.deps.outbox.dueEntries(nowIso, DRAIN_LIMIT);
    if (due.length === 0) {
      return 0;
    }

    let succeeded = 0;
    const failedIds = new Set<number>();

    // 3a) 事件条目：解析载荷 → 批量 push → 对账回执。
    const eventEntries = due.filter((entry) => entry.entryType === "event");
    for (let offset = 0; offset < eventEntries.length; offset += PUSH_BATCH_SIZE) {
      const batch = eventEntries.slice(offset, offset + PUSH_BATCH_SIZE);
      try {
        const events = batch.map((entry) => JSON.parse(entry.payloadJson));
        const acknowledged = await this.deps.gateway.push(events);
        for (const entry of batch) {
          if (entry.eventId !== null && acknowledged.has(entry.eventId)) {
            this.deps.outbox.markSucceeded(entry.entryId);
            succeeded += 1;
          } else {
            // 服务器确认集合缺本条：异常状态，按失败退避重试（幂等保证无害）。
            failedIds.add(entry.entryId);
            this.deps.outbox.markFailed(entry.entryId, "服务器回执缺少本事件", nowIso);
          }
        }
      } catch (error) {
        for (const entry of batch) {
          if (!failedIds.has(entry.entryId)) {
            this.deps.outbox.markFailed(entry.entryId, describeSyncError(error), nowIso);
          }
        }
        errors.push(`事件推送失败：${describeSyncError(error)}`);
      }
    }

    // 3b) settings 条目：全部到期条目合并为一次 PUT（服务器逐键 LWW 幂等）。
    const settingsEntries = due.filter((entry) => entry.entryType === "settings");
    if (settingsEntries.length > 0) {
      try {
        const entries = settingsEntries.map((entry) => JSON.parse(entry.payloadJson));
        const merged = await this.deps.gateway.putSettings(entries);
        // 服务器合并结果写回本地收敛视图（不入 outbox），本机视图与权威库对齐。
        this.deps.settingsStore.applyMerged(merged.settings);
        for (const entry of settingsEntries) {
          this.deps.outbox.markSucceeded(entry.entryId);
          succeeded += 1;
        }
      } catch (error) {
        for (const entry of settingsEntries) {
          this.deps.outbox.markFailed(entry.entryId, describeSyncError(error), nowIso);
        }
        errors.push(`settings 推送失败：${describeSyncError(error)}`);
      }
    }

    return succeeded;
  }
}

/** 把同步异常折叠为简短摘要（结果对象观测用）。 */
function describeSyncError(error: unknown): string {
  if (error instanceof SyncError) {
    return `${error.name}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
