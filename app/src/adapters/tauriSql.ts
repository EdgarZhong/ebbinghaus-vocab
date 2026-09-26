/**
 * Tauri 官方 SQL 插件的最小生产接线探针。
 *
 * 应用层仓储端口目前仍是同步接口，不能把插件的 Promise 强行伪装成同步写入。
 * 因此本模块只完成真实 SQLite 打开和设备身份持久化验证；业务页面必须等端口与
 * 用例整体迁至异步后才能接入。数据库由插件解析到应用配置目录，不拼接本机路径。
 */
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

const DATABASE_URL = "sqlite:ebbinghaus-v2.sqlite3";
const DEVICE_ID_KEY = "device_id";
const BOOT_COUNT_KEY = "desktop_boot_count";

interface DeviceStateRow {
  readonly value: string;
}

export interface TauriSqlConnection {
  readonly database: Database;
  readonly deviceId: string;
  readonly bootCount: number;
}

/** 单条参数化写入；对象值须由调用方明确序列化为字符串。 */
export interface SqliteWrite {
  readonly sql: string;
  readonly values: readonly (string | number | boolean | null)[];
}

/**
 * 把事件、内容变更和 outbox 条目交给同一个 Rust SQLite 事务。
 * 官方 SQL 插件的每次 execute 可能使用不同连接，不能靠连续 await 实现此承诺。
 */
export async function executeTauriSqlTransaction(
  statements: readonly SqliteWrite[],
): Promise<readonly number[]> {
  return invoke<number[]>("execute_sqlite_transaction", { statements });
}

/**
 * 打开应用唯一 SQLite 文件并持久化设备 UUID。
 * INSERT OR IGNORE 保证未来多个启动路径同时进入时不会覆盖已创建的身份；二次
 * SELECT 以数据库实际值为准，避免把一次本机候选 UUID 误认作已持久化结果。
 */
export async function openTauriSqlConnection(): Promise<TauriSqlConnection> {
  const database = await Database.load(DATABASE_URL);
  await database.execute(`
    CREATE TABLE IF NOT EXISTS device_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await database.execute(
    "INSERT OR IGNORE INTO device_state (key, value) VALUES ($1, $2)",
    [DEVICE_ID_KEY, crypto.randomUUID()],
  );
  // 从 Rust 原子批次命令写入，再用官方 SQL 插件读取：两种入口必须指向同一个
  // 应用配置目录里的 SQLite 文件，否则启动立即报错而不是默默产生第二份数据。
  await executeTauriSqlTransaction([
    {
      sql: "INSERT INTO device_state (key, value) VALUES ($1, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
      values: [BOOT_COUNT_KEY],
    },
  ]);
  const rows = await database.select<DeviceStateRow[]>(
    "SELECT value FROM device_state WHERE key = $1",
    [DEVICE_ID_KEY],
  );
  const deviceId = rows[0]?.value;
  if (deviceId === undefined) {
    throw new Error("本地 SQLite 已打开，但设备标识未能持久化");
  }
  const bootRows = await database.select<DeviceStateRow[]>(
    "SELECT value FROM device_state WHERE key = $1",
    [BOOT_COUNT_KEY],
  );
  const bootCount = Number(bootRows[0]?.value);
  if (!Number.isSafeInteger(bootCount) || bootCount < 1) {
    throw new Error("本地 SQLite 启动计数无效");
  }
  return { database, deviceId, bootCount };
}
