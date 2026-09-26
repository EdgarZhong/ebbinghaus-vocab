//! 云同步的本机 HTTPS 出口。前端复用共享协议网关；本命令只转发该网关需要的
//! 五类路径，固定目标域名，禁止将设备令牌带到用户提供的任意地址或写入日志。

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE};
use serde::Serialize;
use std::time::Duration;

const ORIGIN: &str = "https://eb-data.edgarzhong.fyi";
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

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
    method: String,
    path: String,
    auth_token: String,
    body: Option<Vec<u8>>,
    content_encoding: Option<String>,
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
    let url = reqwest::Url::parse(&format!("{ORIGIN}{path}"))
        .map_err(|_| "sync:云同步请求地址无效".to_string())?;
    // 即使路径白名单将来扩展，也保留域名和 HTTPS 双重断言，防止 URL 解析规则
    // 将协议相对地址、凭据或端口解释成新的外发目的地。
    if url.scheme() != "https" || url.host_str() != Some("eb-data.edgarzhong.fyi")
        || url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err("sync:云同步请求目的地无效".into());
    }
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "sync:云同步请求方法无效".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        // Bearer 只能到固定域名；服务端若误配 3xx，原样返回给网关作为本轮失败。
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "sync:网络客户端初始化失败".to_string())?;
    let mut request = client.request(method, url)
        .header(ACCEPT, "application/json")
        .header(AUTHORIZATION, format!("Bearer {auth_token}"));
    if let Some(payload) = body {
        request = request.header(CONTENT_TYPE, "application/json").body(payload);
    }
    if content_encoding.as_deref() == Some("gzip") {
        request = request.header(CONTENT_ENCODING, "gzip");
    }
    let mut response = request.send().await.map_err(|error| {
        if error.is_timeout() { "sync:云同步请求超时".to_string() }
        else { "sync:无法连接云同步服务".to_string() }
    })?;
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|size| size > MAX_RESPONSE_BYTES as u64) {
        return Err("sync:云同步响应超过大小上限".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "sync:读取云同步响应失败".to_string())? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("sync:云同步响应超过大小上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "sync:云同步响应不是 UTF-8".to_string())?;
    Ok(SyncHttpResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::allowed_path;

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
}
