//! 官方 SQL 插件的最窄事务补足层。
//!
//! 插件的 execute/select 对每条语句分别从连接池取连接，前端连续 await 多次并不
//! 构成一个 SQLite 事务。学习事件和 outbox 必须同生共死，因此这里仅开放受限的
//! 参数化写语句批次；常规读写仍由官方 SQL 插件承担，业务决策绝不进入 Rust。

use serde::Deserialize;
use serde_json::Value;
use sqlx::{Connection, SqliteConnection};
use std::time::Duration;
use tauri::Manager;

const DATABASE_FILE: &str = "ebbinghaus-v2.sqlite3";
const MAX_STATEMENTS: usize = 256;
const MAX_SQL_BYTES: usize = 16_384;
const MAX_BIND_VALUES: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SqliteWrite {
    sql: String,
    values: Vec<Value>,
}

/// 只接受一个 INSERT/UPDATE/DELETE 语句，禁止调用者借批次入口执行 DDL 或多语句。
/// 参数值必须是标量；复杂业务结构由 TypeScript 明确序列化为 JSON 字符串。
fn validate_batch(statements: &[SqliteWrite]) -> Result<(), String> {
    if statements.is_empty() || statements.len() > MAX_STATEMENTS {
        return Err("SQLite 批次语句数量不在允许范围内".into());
    }
    for statement in statements {
        let sql = statement.sql.trim();
        let verb = sql.split_ascii_whitespace().next().unwrap_or("").to_ascii_uppercase();
        if !matches!(verb.as_str(), "INSERT" | "UPDATE" | "DELETE")
            || sql.len() > MAX_SQL_BYTES
            || statement.values.len() > MAX_BIND_VALUES
            || sql.contains(';')
            || sql.contains("--")
            || sql.contains("/*")
        {
            return Err("SQLite 批次只允许受限的单条参数化写语句".into());
        }
        if statement
            .values
            .iter()
            .any(|value| value.is_array() || value.is_object())
        {
            return Err("SQLite 绑定值必须是标量".into());
        }
    }
    Ok(())
}

/// 单一连接上执行整批写入；任一执行失败时 sqlx 的事务析构自动回滚。
async fn run_batch(
    connection: &mut SqliteConnection,
    statements: &[SqliteWrite],
) -> Result<Vec<u64>, String> {
    validate_batch(statements)?;
    let mut transaction = connection.begin().await.map_err(|error| error.to_string())?;
    let mut rows_affected = Vec::with_capacity(statements.len());
    for statement in statements {
        let mut query = sqlx::query(&statement.sql);
        for value in &statement.values {
            query = match value {
                Value::Null => query.bind(Option::<String>::None),
                Value::Bool(value) => query.bind(i64::from(*value)),
                Value::Number(value) if value.is_i64() => {
                    query.bind(value.as_i64().ok_or("SQLite 整数参数无效")?)
                }
                Value::Number(value) if value.is_u64() => {
                    let number = i64::try_from(value.as_u64().ok_or("SQLite 整数参数无效")?)
                        .map_err(|_| "SQLite 整数参数超出范围")?;
                    query.bind(number)
                }
                Value::Number(value) => query.bind(value.as_f64().ok_or("SQLite 小数参数无效")?),
                Value::String(value) => query.bind(value.as_str()),
                Value::Array(_) | Value::Object(_) => unreachable!("已在入口校验"),
            };
        }
        let result = query
            .execute(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
        rows_affected.push(result.rows_affected());
    }
    transaction.commit().await.map_err(|error| error.to_string())?;
    Ok(rows_affected)
}

/// 路径与 tauri-plugin-sql 2.4.1 的 `sqlite:ebbinghaus-v2.sqlite3` 映射严格一致：
/// 两边都取 Tauri app_config_dir，Rust 不接受前端传入的数据库路径。
#[tauri::command]
pub(crate) async fn execute_sqlite_transaction(
    app: tauri::AppHandle,
    statements: Vec<SqliteWrite>,
) -> Result<Vec<u64>, String> {
    validate_batch(&statements)?;
    let directory = app.path().app_config_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let file = directory.join(DATABASE_FILE);
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(file)
        .create_if_missing(true)
        // SQL 插件与本命令各自持有连接；等待短暂写锁，避免正常并发被误判为故障。
        .busy_timeout(Duration::from_secs(5))
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| error.to_string())?;
    run_batch(&mut connection, &statements).await
}

#[cfg(test)]
mod tests {
    use super::{run_batch, SqliteWrite};
    use sqlx::{Connection, Executor, SqliteConnection};

    #[test]
    fn batch_rolls_back_every_write_after_constraint_failure() {
        tauri::async_runtime::block_on(async {
            let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            connection
                .execute("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)")
                .await
                .unwrap();
            let statements = vec![
                SqliteWrite {
                    sql: "INSERT INTO entries (id, value) VALUES ($1, $2)".into(),
                    values: vec!["same".into(), "first".into()],
                },
                SqliteWrite {
                    sql: "INSERT INTO entries (id, value) VALUES ($1, $2)".into(),
                    values: vec!["same".into(), "second".into()],
                },
            ];
            assert!(run_batch(&mut connection, &statements).await.is_err());
            let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM entries")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(count, 0);
        });
    }

    #[test]
    fn batch_commits_all_writes_on_success() {
        tauri::async_runtime::block_on(async {
            let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            connection
                .execute("CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)")
                .await
                .unwrap();
            let statements = vec![
                SqliteWrite {
                    sql: "INSERT INTO entries (id, value) VALUES ($1, $2)".into(),
                    values: vec!["a".into(), "first".into()],
                },
                SqliteWrite {
                    sql: "INSERT INTO entries (id, value) VALUES ($1, $2)".into(),
                    values: vec!["b".into(), "second".into()],
                },
            ];
            assert_eq!(run_batch(&mut connection, &statements).await.unwrap(), vec![1, 1]);
            let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM entries")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(count, 2);
        });
    }
}
