/**
 * SQLite 版 UnitOfWork：把一次用例的多笔写入绑定为一个原子事务。
 *
 * 实现要点（ports.ts UnitOfWork 契约的落地方）：
 * - 使用 better-sqlite3 的 `db.transaction()` 而非手写 BEGIN/COMMIT：后者无法
 *   感知嵌套，而本包的仓储方法（事件 append、settings save）自身也包了事务，
 *   嵌套调用时 better-sqlite3 会自动降级为 SAVEPOINT——"UnitOfWork 内调仓储"
 *   与"外部直接调仓储"两条路径因此都原子且互不冲突；
 * - 回调抛错时事务整体回滚并原样传播（绝不吞错）：应用层"多笔写入必须同生共死"
 *   的用例（事件 + 内容 + 卡片 + outbox 入队）由此获得"全有或全无"语义；
 * - better-sqlite3 的事务函数必须是同步的：本包全部仓储方法都是同步写入，HTTP
 *   等异步操作只存在于 SyncEngine 中，且绝不进入 unitOfWork.run 的回调。
 */

import type Database from "better-sqlite3";

import type { UnitOfWork } from "@ebbinghaus/application";

export class SqliteUnitOfWork implements UnitOfWork {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  run(write: () => void): void {
    // 每次调用即时构建事务函数：better-sqlite3 按调用时刻的 inTransaction 状态
    // 决定 BEGIN 还是 SAVEPOINT，嵌套语义由驱动保证。
    this.db.transaction(write)();
  }
}
