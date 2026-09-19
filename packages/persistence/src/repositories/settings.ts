/**
 * 设置通道仓储：同步 settings 收敛视图（LWW + outbox 同事务入队）、设备本地 KV、
 * LLM 服务配置（设备本地）。
 *
 * 三方合同来源：ports.ts（语义）、判断文件 A1/B2（键归宿与"settings 不进事件流"）、
 * protocol mergeSettings（唯一合并规则——本文件绝不自建 LWW 变体）。
 */

import type Database from "better-sqlite3";

import { mergeSettings, type SettingEntry } from "@ebbinghaus/protocol";
import type {
  Clock,
  DeviceLocalStore,
  LlmConfigurationRecord,
  LlmConfigurationStore,
  SyncedSettingsStore,
} from "@ebbinghaus/application";

import type { OutboxStore } from "../outbox/outboxStore.ts";

// ---------------------------------------------------------------------------
// 同步 settings 收敛视图
// ---------------------------------------------------------------------------

interface SettingRow {
  readonly key: string;
  readonly value_json: string;
  readonly updated_at: string;
  readonly device_id: string;
}

function rowToEntry(row: SettingRow): SettingEntry {
  return {
    key: row.key,
    value: JSON.parse(row.value_json) as unknown,
    updatedAt: row.updated_at,
    deviceId: row.device_id,
  };
}

export class SqliteSyncedSettingsStore implements SyncedSettingsStore {
  private readonly db: Database.Database;
  private readonly outbox: OutboxStore;

  private readonly upsertStmt;
  private readonly listStmt;

  constructor(db: Database.Database, outbox: OutboxStore) {
    this.db = db;
    this.outbox = outbox;
    this.upsertStmt = this.db.prepare(`
      INSERT INTO synced_settings (key, value_json, updated_at, device_id)
      VALUES (@key, @valueJson, @updatedAt, @deviceId)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at,
        device_id = excluded.device_id
    `);
    this.listStmt = this.db.prepare(
      `SELECT key, value_json, updated_at, device_id FROM synced_settings ORDER BY key`,
    );
  }

  getAll(): SettingEntry[] {
    return (this.listStmt.all() as SettingRow[]).map(rowToEntry);
  }

  /**
   * 保存（本设备产生的变更）：同事务内完成①本地 LWW 收敛写入②outbox 入队，
   * 落实 ports.ts 合同"事件/设置写入与出站入队同生共死"——绝不允许出现
   * "设置已改而推送丢失"的静默不同步窗口。
   */
  save(entries: readonly SettingEntry[]): void {
    const run = this.db.transaction((batch: readonly SettingEntry[]) => {
      // LWW 决胜只用协议 mergeSettings：本地已有条目与写入条目逐键合并，
      // 过时写入自然落败（时间戳单调性由 SettingsService 护栏保证）。
      const merged = mergeSettings(this.getAll(), batch);
      for (const entry of merged) {
        this.upsertStmt.run({
          key: entry.key,
          valueJson: JSON.stringify(entry.value),
          updatedAt: entry.updatedAt,
          deviceId: entry.deviceId,
        });
      }
      // 一条一入队（OutboxStore 合同）：载荷存入队时刻的原文，后续本地修改不改写它。
      for (const entry of batch) {
        this.outbox.enqueueSettingsEntry(entry);
      }
    });
    run(entries);
  }

  /**
   * 拉取侧落地：把（与服务器合并后的）条目写回本地收敛视图，**不入 outbox**——
   * 这些变更的推送责任在产生它们的设备；本设备若再入队会把回声推向服务器，
   * 虽然服务器 LWW 幂等无害，但徒增流量与队列噪声。
   */
  applyMerged(entries: readonly SettingEntry[]): void {
    const run = this.db.transaction((batch: readonly SettingEntry[]) => {
      const merged = mergeSettings(this.getAll(), batch);
      for (const entry of merged) {
        this.upsertStmt.run({
          key: entry.key,
          valueJson: JSON.stringify(entry.value),
          updatedAt: entry.updatedAt,
          deviceId: entry.deviceId,
        });
      }
    });
    run(entries);
  }
}

// ---------------------------------------------------------------------------
// 设备本地 KV
// ---------------------------------------------------------------------------

export class SqliteDeviceLocalStore implements DeviceLocalStore {
  private readonly db: Database.Database;

  private readonly getStmt;
  private readonly setStmt;

  constructor(db: Database.Database) {
    this.db = db;
    this.getStmt = this.db.prepare(`SELECT value FROM device_local_kv WHERE key = ?`);
    this.setStmt = this.db.prepare(`
      INSERT INTO device_local_kv (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
  }

  getString(key: string): string | null {
    const row = this.getStmt.get(key) as { readonly value: string } | undefined;
    return row === undefined ? null : row.value;
  }

  setString(key: string, value: string): void {
    this.setStmt.run(key, value);
  }
}

// ---------------------------------------------------------------------------
// LLM 服务配置（设备本地；密文落库）
// ---------------------------------------------------------------------------

/**
 * 密钥加密端口：`apiKey` 的密文/明文转换。
 *
 * 端口合同（ports.ts）：apiKey 必须密文落库、明文不外泄。加密实现与密钥派生
 * 属于平台能力：Tauri 生产环境必须注入基于 Stronghold/本机绑定的真实实现；
 * 本包不内置任何"伪加密"默认值——需要明文形态的测试与开发运行时显式传入
 * `TransparentSecretCipher`，让"没有真实加密"在代码里可见而不是被掩盖。
 */
export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/** 开发/浏览器测试用明文透传实现：命名与注释刻意直白，生产环境禁止使用。 */
export class TransparentSecretCipher implements SecretCipher {
  encrypt(plaintext: string): string {
    return plaintext;
  }

  decrypt(ciphertext: string): string {
    return ciphertext;
  }
}

interface LlmConfigRow {
  readonly base_url: string;
  readonly model_name: string;
  readonly api_key_cipher: string;
  readonly thinking_enabled: number;
}

export class SqliteLlmConfigurationStore implements LlmConfigurationStore {
  private readonly db: Database.Database;
  private readonly cipher: SecretCipher;
  private readonly clock: Clock;

  private readonly upsertStmt;
  private readonly loadStmt;

  constructor(db: Database.Database, cipher: SecretCipher, clock: Clock) {
    this.db = db;
    this.cipher = cipher;
    this.clock = clock;
    this.upsertStmt = this.db.prepare(`
      INSERT INTO llm_configuration (id, base_url, model_name, api_key_cipher, thinking_enabled, updated_at)
      VALUES (1, @baseUrl, @modelName, @apiKeyCipher, @thinkingEnabled, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url,
        model_name = excluded.model_name,
        api_key_cipher = excluded.api_key_cipher,
        thinking_enabled = excluded.thinking_enabled,
        updated_at = excluded.updated_at
    `);
    this.loadStmt = this.db.prepare(
      `SELECT base_url, model_name, api_key_cipher, thinking_enabled FROM llm_configuration WHERE id = 1`,
    );
  }

  load(): LlmConfigurationRecord | null {
    const row = this.loadStmt.get() as LlmConfigRow | undefined;
    if (row === undefined) {
      return null;
    }
    const cipherText = row.api_key_cipher;
    return {
      baseUrl: row.base_url,
      modelName: row.model_name,
      // 空密文表示"已清空"；其余密文解密回明文（内存中短暂存在，不落日志）。
      apiKey: cipherText === "" ? "" : this.cipher.decrypt(cipherText),
      thinkingEnabled: row.thinking_enabled === 1,
    };
  }

  /**
   * 保存：null = 保留既有密钥原值；空字符串 = 清空（存空密文）；非空 = 更新。
   * 与应用层假实现同口径（ports.ts 合同），null 绝不误存为空覆盖既有密钥。
   */
  save(record: LlmConfigurationRecord): void {
    const existing = this.load();
    let apiKey: string | null;
    if (record.apiKey === null) {
      apiKey = existing?.apiKey ?? null;
    } else {
      apiKey = record.apiKey;
    }
    this.upsertStmt.run({
      baseUrl: record.baseUrl,
      modelName: record.modelName,
      apiKeyCipher: apiKey === null || apiKey === "" ? "" : this.cipher.encrypt(apiKey),
      thinkingEnabled: record.thinkingEnabled ? 1 : 0,
      // updated_at 仅审计用；时间经注入 Clock（持久化层同样不读系统时间）。
      updatedAt: this.clock.now().toISOString(),
    });
  }
}
