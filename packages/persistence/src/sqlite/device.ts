/**
 * 设备身份与设备内事件序号的 SQLite 实现。
 *
 * 口径来源（ports.ts + 判断文件 B5 + 协议 events.ts deviceSeq 注释）：
 * - DeviceIdentityProvider：设备首次启动生成 UUIDv4 并持久化于本地库（B5：
 *   无注册机制、不占协议字段），之后所有事件与 settings 条目携带同一标识；
 * - DeviceSeqAllocator：从 1 起严格单调递增，**进程重启后必须延续**（持久化
 *   已分配的最大值），否则同设备重启后产生重复 deviceSeq，破坏领域重放排序
 *   `occurredAt → deviceSeq → deviceId/eventId` 的确定性。分配不要求跨进程
 *   原子——单设备单进程写入（ports.ts 明文）。
 */

import type Database from "better-sqlite3";

import type {
  DeviceIdentityProvider,
  DeviceSeqAllocator,
  IdGenerator,
} from "@ebbinghaus/application";

import { assertUuidV4Shape } from "../ids.ts";

/** device_state 表中承载设备标识的键。 */
const DEVICE_ID_STATE_KEY = "device_id";

/** 设备计数器表中承载设备内事件序号的键。 */
const DEVICE_SEQ_COUNTER_NAME = "device_seq";

/** SQLite 设备身份：首次调用时生成并持久化 UUIDv4，此后稳定返回。 */
export class SqliteDeviceIdentityProvider implements DeviceIdentityProvider {
  private readonly db: Database.Database;
  private readonly idGenerator: IdGenerator;
  /** 进程内缓存：避免每次事件记录都打库（身份在设备生命周期内不变）。 */
  private cachedDeviceId: string | null = null;

  constructor(db: Database.Database, idGenerator: IdGenerator) {
    this.db = db;
    this.idGenerator = idGenerator;
  }

  getDeviceId(): string {
    if (this.cachedDeviceId !== null) {
      return this.cachedDeviceId;
    }
    const selectStmt = this.db.prepare("SELECT value FROM device_state WHERE key = ?");
    const row = selectStmt.get(DEVICE_ID_STATE_KEY) as { value: string } | undefined;
    if (row !== undefined) {
      // 已持久化的身份必须满足 UUIDv4 形态（事件与 settings 的协议校验都依赖它）；
      // 形态损坏说明库被外部改写，立即失败而不是带病继续。
      this.cachedDeviceId = assertUuidV4Shape(row.value, "已持久化的设备标识");
      return this.cachedDeviceId;
    }
    // 首次启动：生成并持久化。INSERT 若与并发初始化竞争（不可能——单进程），
    // 主键冲突会自然抛错暴露。
    const deviceId = this.idGenerator.nextId();
    this.db
      .prepare("INSERT INTO device_state (key, value) VALUES (?, ?)")
      .run(DEVICE_ID_STATE_KEY, deviceId);
    this.cachedDeviceId = deviceId;
    return deviceId;
  }
}

/**
 * SQLite 设备序号分配器：独立计数器表 + UPDATE...RETURNING 原子自增。
 *
 * 计数器值持久化在同一库文件里，进程重启后从表中读出继续 +1，单调性跨重启
 * 一目了然（与 server 的 server_seq 计数器同构）；若调用发生在 UnitOfWork
 * 事务内，分配自然加入该事务（回滚时序号一并回退——事件行不存在了，序号
 * 复用是正确语义）。
 */
export class SqliteDeviceSeqAllocator implements DeviceSeqAllocator {
  private readonly allocateStmt;

  constructor(db: Database.Database) {
    this.allocateStmt = db.prepare(
      "UPDATE device_counters SET value = value + 1 WHERE name = ? RETURNING value",
    );
  }

  nextSeq(): number {
    const row = this.allocateStmt.get(DEVICE_SEQ_COUNTER_NAME) as { value: number };
    return row.value;
  }
}
