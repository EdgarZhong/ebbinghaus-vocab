//! 云同步的本机 HTTPS 出口。前端复用共享协议网关；本命令只转发该网关需要的
//! 五类路径。目标源（origin）由前端按构建期配置传入，此处仍独立校验 HTTPS、
//! 裸源形态与凭据约束，禁止把设备令牌带到路径注入产生的其他目的地或写入日志。

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE};
use serde::Serialize;
use std::error::Error as _;
use std::io::ErrorKind;
use std::time::Duration;

const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_ATTEMPTS: usize = 3;

/// 只重试超时和明确的临时传输故障。证书校验、请求格式、代理配置等错误即使发生在
/// 连接阶段也可能包装为 reqwest::Error，不能仅凭 is_connect() 重试它们。
fn retryable_io_kind(kind: ErrorKind) -> bool {
    matches!(kind,
        ErrorKind::TimedOut | ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted
        | ErrorKind::ConnectionRefused | ErrorKind::NotConnected | ErrorKind::BrokenPipe
        | ErrorKind::UnexpectedEof | ErrorKind::Interrupted | ErrorKind::WouldBlock
    )
}

fn retryable_transport(error: &reqwest::Error) -> bool {
    if error.is_timeout() { return true; }
    let mut cause = error.source();
    while let Some(source) = cause {
        if let Some(io_error) = source.downcast_ref::<std::io::Error>() {
            return retryable_io_kind(io_error.kind());
        }
        cause = source.source();
    }
    false
}

fn retry_delay(attempt: usize) -> Duration {
    // 只会在前两次失败后调用；短退避让无线网络/代理恢复，同时限制后台队列等待。
    if attempt == 0 { Duration::from_millis(200) } else { Duration::from_millis(600) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncHttpResponse {
    status: u16,
    body: String,
}

/// 限定方法和路径组合。查询参数只允许用于两个增量拉取端点，其他任何路径均拒绝。
fn allowed_path(method: &str, path: &str) -> bool {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let query_allowed = !query.contains('#') && !query.contains('/') && !query.contains('\\');
    if !query_allowed || path.contains('#') { return false; }
    match (method, route) {
        ("POST", "/sync/push") | ("PUT", "/settings") | ("PUT", "/content") => query.is_empty(),
        ("GET", "/settings") => query.is_empty(),
        ("GET", "/sync/pull") | ("GET", "/content") => true,
        _ => false,
    }
}

#[tauri::command]
pub(crate) async fn sync_http_request(
    webview: tauri::Webview,
    method: String,
    path: String,
    auth_token: String,
    body: Option<Vec<u8>>,
    content_encoding: Option<String>,
    origin: String,
) -> Result<SyncHttpResponse, String> {
    if !allowed_path(&method, &path) {
        return Err("sync:不允许的云同步请求路径".into());
    }
    if auth_token.is_empty() || auth_token.len() > 4096 || !auth_token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("sync:云端令牌无效".into());
    }
    if body.as_ref().is_some_and(|payload| payload.len() > MAX_REQUEST_BYTES) {
        return Err("sync:云同步请求超过大小上限".into());
    }
    if content_encoding.as_deref().is_some_and(|value| value != "gzip") {
        return Err("sync:不支持的云同步请求编码".into());
    }
    let url = reqwest::Url::parse(&format!("{}{}", origin.trim_end_matches('/'), path))
        .map_err(|_| "sync:云同步请求地址无效".to_string())?;
    // 即使路径白名单将来扩展，也保留 HTTPS、裸源与凭据三重断言，防止 URL 解析规则
    // 将协议相对地址、凭据或路径注入解释成新的外发目的地。origin 必须是解析后
    // 与完整地址一致的裸源（可带非默认端口），不能夹带路径、查询或片段。
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != origin.trim_end_matches('/')
        || !url.username().is_empty() || url.password().is_some() {
        return Err("sync:云同步请求目的地无效".into());
    }
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "sync:云同步请求方法无效".to_string())?;
    // 同一代理下的各次尝试共用连接池；每轮重试重新读取 Android 系统代理，
    // 使退避期间发生的代理切换也能立刻换用新 Client。
    // POST 的事件由服务端 event_id 去重，PUT 是同值覆盖，
    // 因此服务端已提交但响应中途断开时，可以重新发送同一份可克隆请求体。
    // 已收到 HTTP 4xx/5xx 后不再重试，避免把业务拒绝当作网络故障。
    'attempts: for attempt in 0..MAX_ATTEMPTS {
        let client = crate::http_client::sync_client(&webview, &url, REQUEST_TIMEOUT).await
            .map_err(|_| "sync:网络客户端初始化失败".to_string())?;
        let mut request = client.request(method.clone(), url.clone())
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {auth_token}"));
        if let Some(payload) = body.as_ref() {
            request = request.header(CONTENT_TYPE, "application/json").body(payload.clone());
        }
        if content_encoding.as_deref() == Some("gzip") {
            request = request.header(CONTENT_ENCODING, "gzip");
        }
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(error) if attempt + 1 < MAX_ATTEMPTS && retryable_transport(&error) => {
                tokio::time::sleep(retry_delay(attempt)).await;
                continue;
            }
            Err(error) => {
                // 传输细节可能含目标路径；只向界面返回稳定类别，绝不输出令牌。
                return Err(if error.is_timeout() { "sync:云同步请求超时".into() }
                    else { "sync:无法连接云同步服务".into() });
            }
        };
        let status = response.status().as_u16();
        if response.content_length().is_some_and(|size| size > MAX_RESPONSE_BYTES as u64) {
            return Err("sync:云同步响应超过大小上限".into());
        }
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                        return Err("sync:云同步响应超过大小上限".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(error) if status < 300 && attempt + 1 < MAX_ATTEMPTS
                    && retryable_transport(&error) => {
                    tokio::time::sleep(retry_delay(attempt)).await;
                    continue 'attempts;
                }
                Err(error) => return Err(if error.is_timeout() {
                    "sync:云同步请求超时".into()
                } else {
                    "sync:读取云同步响应失败".into()
                }),
            }
        }
        let body = String::from_utf8(bytes).map_err(|_| "sync:云同步响应不是 UTF-8".to_string())?;
        return Ok(SyncHttpResponse { status, body });
    }
    unreachable!("最后一次尝试必须返回响应或错误")
}

#[cfg(test)]
mod tests {
    use super::{allowed_path, retryable_io_kind};
    use std::io::ErrorKind;

    #[test]
    fn only_protocol_routes_are_allowed() {
        assert!(allowed_path("POST", "/sync/push"));
        assert!(allowed_path("GET", "/sync/pull?after_seq=0&limit=500"));
        assert!(allowed_path("GET", "/content?after_seq=0&limit=500"));
        assert!(allowed_path("PUT", "/content"));
        assert!(!allowed_path("GET", "//evil.example/"));
        assert!(!allowed_path("PUT", "/sync/push"));
        assert!(!allowed_path("GET", "/content/../settings"));
        assert!(!allowed_path("GET", "/sync/pull#fragment"));
    }

    #[test]
    fn retry_is_limited_to_transient_io_kinds() {
        assert!(retryable_io_kind(ErrorKind::ConnectionReset));
        assert!(retryable_io_kind(ErrorKind::TimedOut));
        assert!(!retryable_io_kind(ErrorKind::InvalidData));
        assert!(!retryable_io_kind(ErrorKind::PermissionDenied));
    }
}
