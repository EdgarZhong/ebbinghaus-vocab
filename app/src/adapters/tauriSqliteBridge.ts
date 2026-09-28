/**
 * Tauri 平台 SQLite 同步桥（macOS 与 Android 共用）。业务仓储继续使用既有同步事务接口，实际 SQL
 * 在 Rust 持有的单一连接上执行；每次 XHR 都只走 127.0.0.1 随机端口并带随机令牌。
 * 仅组合根可创建此桥，React 页面不得直接调用 SQL。
 */
import { invoke } from "@tauri-apps/api/core";
import type Database from "better-sqlite3";
import type { SecretCipher } from "@ebbinghaus/persistence/src/repositories/settings.ts";
import { CLIENT_MIGRATIONS } from "@ebbinghaus/persistence/src/sqlite/migrations.ts";

interface BridgeInfo { readonly port: number; readonly token: string }
interface BridgeResponse { readonly ok: boolean; readonly value?: unknown; readonly error?: string }

class DesktopSqliteDatabase {
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(private readonly info: BridgeInfo) {}

  private call(action: string, sql = "", parameters: readonly unknown[] = []): unknown {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `http://127.0.0.1:${this.info.port}/query`, false);
    // text/plain 是简单请求；WebView 无需在同步 XHR 前进行 CORS 预检。
    xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
    xhr.send(JSON.stringify({ token: this.info.token, action, sql, parameters }));
    if (xhr.status !== 200) throw new Error(`本地数据库桥无响应：HTTP ${xhr.status}`);
    const response = JSON.parse(xhr.responseText) as BridgeResponse;
    if (!response.ok) throw new Error(response.error ?? "本地数据库操作失败");
    return response.value;
  }

  exec(sql: string): void { this.call("exec", sql); }

  /** 密钥加解密也经本次启动随机令牌进入 Rust，明文从不写入 SQLite。 */
  encryptSecret(plaintext: string): string { return this.call("encrypt_secret", plaintext) as string; }
  decryptSecret(ciphertext: string): string { return this.call("decrypt_secret", ciphertext) as string; }

  prepare(sql: string): {
    run: (...values: unknown[]) => { changes: number; lastInsertRowid: number };
    get: (...values: unknown[]) => unknown;
    all: (...values: unknown[]) => unknown[];
  } {
    const normalize = (values: unknown[]): { sql: string; parameters: unknown[] } => {
      if (values.length === 1 && Array.isArray(values[0])) values = values[0] as unknown[];
      if (values.length === 1 && values[0] !== null && typeof values[0] === "object") {
        const named = values[0] as Record<string, unknown>;
        const parameters: unknown[] = [];
        const positionalSql = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
          if (!(name in named)) throw new Error(`SQLite 命名参数缺失：${name}`);
          parameters.push(named[name]);
          return "?";
        });
        return { sql: positionalSql, parameters };
      }
      return { sql, parameters: values };
    };
    return {
      run: (...values) => {
        const request = normalize(values);
        return this.call("run", request.sql, request.parameters) as { changes: number; lastInsertRowid: number };
      },
      get: (...values) => {
        const request = normalize(values);
        const result = this.call("get", request.sql, request.parameters);
        return result === null ? undefined : result;
      },
      all: (...values) => {
        const request = normalize(values);
        return this.call("all", request.sql, request.parameters) as unknown[];
      },
    };
  }

  transaction<T extends (...args: never[]) => unknown>(callback: T): T {
    return ((...args: Parameters<T>) => {
      const nested = this.transactionDepth > 0;
      const savepoint = `eb_nested_${++this.savepointSequence}`;
      this.call("run", nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      this.transactionDepth += 1;
      try {
        const result = callback(...args);
        this.call("run", nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        this.call("run", nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");
        if (nested) this.call("run", `RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }) as T;
  }
}

/** 生产密钥端口只能从已启动的 Tauri SQLite 桥创建；测试运行时另行注入测试密码器。 */
export function createTauriSecretCipher(db: Database.Database): SecretCipher {
  const bridge = db as unknown as DesktopSqliteDatabase;
  return {
    encrypt: (plaintext: string) => bridge.encryptSecret(plaintext),
    decrypt: (ciphertext: string) => bridge.decryptSecret(ciphertext),
  };
}

/** 启动桥并逐版本迁移，返回既有仓储可用的同步数据库合同。 */
export async function openTauriBusinessDatabase(): Promise<Database.Database> {
  const info = await invoke<BridgeInfo>("start_sqlite_bridge");
  const db = new DesktopSqliteDatabase(info);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[])
    .map((row) => row.version));
  for (const [index, migration] of CLIENT_MIGRATIONS.entries()) {
    const version = index + 1;
    if (applied.has(version)) continue;
    db.transaction(() => {
      db.exec(migration);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
    })();
  }
  // 类型逃逸只限于桥的组合根；上层沿用同一个 SQLite 仓储合同，实体与事件
  // 操作、嵌套事务和回滚分别通过真实桌面 App 与 Android WebView 验收验证。
  return db as unknown as Database.Database;
}
