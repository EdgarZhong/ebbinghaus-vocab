//! 桌面业务仓储的同步 SQLite 桥。
//!
//! 既有应用用例和 SQLite 仓储均为同步事务接口。WebView 的 Tauri invoke 是异步的，
//! 因此桥只在 127.0.0.1 随机端口接受带本次启动随机令牌的 SQL 调用；全部请求在
//! 同一数据库连接上串行执行，让 JS 仓储的 BEGIN/SAVEPOINT/COMMIT 保持原子性。
//! 桥不实现任何学习规则，数据库路径固定为 Tauri 应用配置目录。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
#[cfg(not(target_os = "android"))]
use scrypt::{scrypt, Params as ScryptParams};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqliteRow};
use sqlx::{Column, Connection, Row, TypeInfo, ValueRef};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;
#[cfg(target_os = "android")]
use std::os::unix::fs::OpenOptionsExt;

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const DATABASE_FILE: &str = "ebbinghaus-v2.sqlite3";
#[cfg(not(target_os = "android"))]
const SECRET_SALT: &[u8] = b"ebbinghaus-v2-llm-api-key";
const SECRET_AAD: &[u8] = b"ebbinghaus-v2-llm-key-cipher-v1";
static BRIDGE: OnceLock<BridgeInfo> = OnceLock::new();
#[cfg(target_os = "android")]
static ANDROID_SECRET_KEY: OnceLock<[u8; 32]> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeInfo {
    port: u16,
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    token: String,
    action: String,
    sql: Option<String>,
    parameters: Option<Vec<Value>>,
}

/// 启动一次性本机桥；令牌仅经 Tauri command 返回给当前受信 WebView。
#[tauri::command]
pub(crate) async fn start_sqlite_bridge(app: tauri::AppHandle) -> Result<BridgeInfo, String> {
    if let Some(existing) = BRIDGE.get() {
        return Ok(existing.clone());
    }
    let directory = app.path().app_config_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    // Android 没有 macOS 的 /bin/hostname；密钥只在应用私有目录首次生成，
    // 后续进程启动从同一文件读取，才能解密已保存的设备本地连接配置。
    #[cfg(target_os = "android")]
    initialize_android_secret_key(&directory)?;
    let options = SqliteConnectOptions::new()
        .filename(directory.join(DATABASE_FILE))
        .create_if_missing(true)
        .busy_timeout(Duration::from_secs(5))
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .foreign_keys(true);
    let connection = SqliteConnection::connect_with(&options)
        .await.map_err(|error| error.to_string())?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let info = BridgeInfo { port, token: uuid::Uuid::new_v4().to_string() };
    let thread_info = info.clone();
    std::thread::Builder::new()
        .name("ebbinghaus-sqlite-bridge".into())
        .spawn(move || serve(listener, connection, thread_info))
        .map_err(|error| error.to_string())?;
    let _ = BRIDGE.set(info.clone());
    Ok(info)
}

fn serve(listener: TcpListener, mut connection: SqliteConnection, info: BridgeInfo) {
    for stream in listener.incoming() {
        if let Ok(mut stream) = stream {
            let answer = match read_request(&mut stream) {
                Ok(request) if request.token == info.token =>
                    tauri::async_runtime::block_on(execute(&mut connection, request)),
                Ok(_) => Err("本机数据库令牌无效".into()),
                Err(error) => Err(error),
            };
            let response = match answer {
                Ok(value) => json!({"ok": true, "value": value}),
                Err(message) => json!({"ok": false, "error": message}),
            };
            let body = response.to_string();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len(),
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    let mut header_end = None;
    loop {
        let mut chunk = [0u8; 4096];
        let count = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 { return Err("数据库请求不完整".into()); }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > MAX_BODY_BYTES + 32_768 { return Err("数据库请求过大".into()); }
        if let Some(offset) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = Some(offset + 4);
            break;
        }
    }
    let end = header_end.ok_or("数据库请求缺少 HTTP 头")?;
    let header = std::str::from_utf8(&bytes[..end]).map_err(|_| "数据库 HTTP 头无效")?;
    if !header.starts_with("POST /query HTTP/1.1") { return Err("数据库请求路径无效".into()); }
    let length = header.lines()
        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(str::trim).map(str::to_owned))
        .ok_or("数据库请求缺少长度")?
        .parse::<usize>().map_err(|_| "数据库请求长度无效")?;
    if length > MAX_BODY_BYTES { return Err("数据库请求过大".into()); }
    while bytes.len() - end < length {
        let mut chunk = [0u8; 4096];
        let count = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 { return Err("数据库请求正文不完整".into()); }
        bytes.extend_from_slice(&chunk[..count]);
    }
    serde_json::from_slice(&bytes[end..end + length]).map_err(|_| "数据库请求 JSON 无效".into())
}

async fn execute(connection: &mut SqliteConnection, request: Request) -> Result<Value, String> {
    let sql = request.sql.as_deref().unwrap_or("");
    if sql.len() > MAX_BODY_BYTES { return Err("SQL 语句过大".into()); }
    match request.action.as_str() {
        // 密钥操作走与 SQL 相同的本机随机令牌入口，但在 Rust 内完成 KDF 与
        // AES-GCM；WebView 只得到密文或解密结果，数据库仓储始终只写密文。
        "encrypt_secret" => Ok(Value::String(encrypt_secret(sql)?)),
        "decrypt_secret" => Ok(Value::String(decrypt_secret(sql)?)),
        "exec" => {
            sqlx::raw_sql(sql).execute(&mut *connection).await.map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "run" | "get" | "all" => {
            let mut query = sqlx::query(sql);
            for parameter in request.parameters.unwrap_or_default() {
                query = match parameter {
                    Value::Null => query.bind(Option::<String>::None),
                    Value::Bool(value) => query.bind(i64::from(value)),
                    Value::Number(value) if value.is_i64() => query.bind(value.as_i64().unwrap()),
                    Value::Number(value) if value.is_u64() => {
                        query.bind(i64::try_from(value.as_u64().unwrap()).map_err(|_| "SQLite 整数超出范围")?)
                    }
                    Value::Number(value) => query.bind(value.as_f64().ok_or("SQLite 小数无效")?),
                    Value::String(value) => query.bind(value),
                    _ => return Err("SQLite 参数必须是标量".into()),
                };
            }
            match request.action.as_str() {
                "run" => {
                    let result = query.execute(&mut *connection).await.map_err(|error| error.to_string())?;
                    Ok(json!({"changes": result.rows_affected(), "lastInsertRowid": result.last_insert_rowid()}))
                }
                "get" => {
                    let row = query.fetch_optional(&mut *connection).await.map_err(|error| error.to_string())?;
                    Ok(row.map(row_to_json).unwrap_or(Value::Null))
                }
                _ => {
                    let rows = query.fetch_all(&mut *connection).await.map_err(|error| error.to_string())?;
                    Ok(Value::Array(rows.into_iter().map(row_to_json).collect()))
                }
            }
        }
        _ => Err("数据库动作无效".into()),
    }
}

/// 与 V1 一样使用本机主机名做机器绑定，scrypt 提高离线猜测成本；该标识只在内存
/// 中参与派生。用户更改主机名后须重新填写密钥，学习数据本身不受影响。
#[cfg(not(target_os = "android"))]
fn machine_key() -> Result<[u8; 32], String> {
    let output = std::process::Command::new("/bin/hostname")
        .output().map_err(|_| "无法读取本机标识")?;
    if !output.status.success() { return Err("无法读取本机标识".into()); }
    let hostname = String::from_utf8(output.stdout).map_err(|_| "本机标识无效")?;
    let hostname = hostname.trim();
    if hostname.is_empty() { return Err("本机标识为空".into()); }
    let params = ScryptParams::new(14, 8, 1, 32).map_err(|_| "密钥派生参数无效")?;
    let mut key = [0u8; 32];
    scrypt(hostname.as_bytes(), SECRET_SALT, &params, &mut key)
        .map_err(|_| "无法派生本机密钥")?;
    Ok(key)
}

/// Android 应用沙盒内先获取私有锁，完整写入同目录临时文件，再以 rename 原子发布。
/// 发布前中断不会留下半写的正式密钥；并发进程持锁重查后只读取已完整发布的文件。
/// 系统安全随机源提供 256 位密钥，文件权限限定当前应用读写，自动备份已关闭。
#[cfg(target_os = "android")]
fn initialize_android_secret_key(directory: &std::path::Path) -> Result<(), String> {
    if ANDROID_SECRET_KEY.get().is_some() { return Ok(()); }
    let path = directory.join("device-secret-key-v1");
    // Android SELinux 禁止应用数据文件之间的 hard_link，因此使用跨进程文件锁
    // 串行化首次创建；进程异常退出时系统会释放锁，下一次启动可重新生成。
    let lock_path = directory.join("device-secret-key-v1.lock");
    let lock_file = std::fs::OpenOptions::new().write(true).create(true).mode(0o600)
        .open(&lock_path).map_err(|_| "无法创建 Android 本机密钥锁")?;
    lock_file.lock().map_err(|_| "无法锁定 Android 本机密钥")?;
    let key = if path.exists() {
        read_android_secret_key(&path)?
    } else {
        let temporary = directory.join(format!(".device-secret-key-v1-{}.tmp", uuid::Uuid::new_v4()));
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).map_err(|_| "无法生成 Android 本机密钥")?;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600)
            .open(&temporary).map_err(|_| "无法创建 Android 本机密钥临时文件")?;
        file.write_all(&key).map_err(|_| "无法保存 Android 本机密钥")?;
        file.sync_all().map_err(|_| "无法持久化 Android 本机密钥")?;
        drop(file);
        std::fs::rename(&temporary, &path).map_err(|_| "无法发布 Android 本机密钥")?;
        std::fs::File::open(directory).and_then(|dir| dir.sync_all())
            .map_err(|_| "无法确认 Android 本机密钥已持久化")?;
        key
    };
    drop(lock_file);
    let _ = ANDROID_SECRET_KEY.set(key);
    Ok(())
}

#[cfg(target_os = "android")]
fn read_android_secret_key(path: &std::path::Path) -> Result<[u8; 32], String> {
    let mut file = std::fs::File::open(path).map_err(|_| "无法读取 Android 本机密钥")?;
    let mut key = [0u8; 32];
    file.read_exact(&mut key).map_err(|_| "Android 本机密钥长度无效")?;
    let mut extra = [0u8; 1];
    if file.read(&mut extra).map_err(|_| "无法核验 Android 本机密钥")? != 0 {
        return Err("Android 本机密钥长度无效".into());
    }
    Ok(key)
}

#[cfg(target_os = "android")]
fn machine_key() -> Result<[u8; 32], String> {
    ANDROID_SECRET_KEY.get().copied().ok_or_else(|| "Android 本机密钥未初始化".into())
}

fn encrypt_secret(plaintext: &str) -> Result<String, String> {
    let key = machine_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "加密初始化失败")?;
    let random = uuid::Uuid::new_v4();
    let nonce_bytes = &random.as_bytes()[..12];
    let nonce = Nonce::from_slice(nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, Payload { msg: plaintext.as_bytes(), aad: SECRET_AAD })
        .map_err(|_| "密钥加密失败")?;
    let mut packed = Vec::with_capacity(12 + ciphertext.len());
    packed.extend_from_slice(nonce_bytes);
    packed.extend_from_slice(&ciphertext);
    Ok(format!("v2:{}", BASE64.encode(packed)))
}

fn decrypt_secret(blob: &str) -> Result<String, String> {
    let encoded = blob.strip_prefix("v2:").ok_or("密钥密文版本无效")?;
    let packed = BASE64.decode(encoded).map_err(|_| "密钥密文编码无效")?;
    if packed.len() < 28 { return Err("密钥密文长度不足".into()); }
    let key = machine_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "解密初始化失败")?;
    let nonce = Nonce::from_slice(&packed[..12]);
    let plaintext = cipher.decrypt(nonce, Payload { msg: &packed[12..], aad: SECRET_AAD })
        .map_err(|_| "密钥密文验证失败，请重新填写 API 密钥")?;
    String::from_utf8(plaintext).map_err(|_| "密钥明文编码无效".into())
}

fn row_to_json(row: SqliteRow) -> Value {
    let mut object = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let value = row.try_get_raw(index).ok().map(|raw| {
            if raw.is_null() { return Value::Null; }
            match raw.type_info().name() {
                "INTEGER" => row.try_get::<i64, _>(index).map(|value| json!(value)).unwrap_or(Value::Null),
                "REAL" => row.try_get::<f64, _>(index).map(|value| json!(value)).unwrap_or(Value::Null),
                _ => row.try_get::<String, _>(index).map(|value| json!(value)).unwrap_or(Value::Null),
            }
        }).unwrap_or(Value::Null);
        object.insert(column.name().to_owned(), value);
    }
    Value::Object(object)
}
