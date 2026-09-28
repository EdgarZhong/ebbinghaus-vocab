//! 大语言模型的本机 HTTPS 出口。WebView 不直接向可配置端点发送带密钥的跨域请求；
//! Rust 命令只转发当前用户配置的一次请求，不记录密钥、原文或响应体。

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::oneshot;

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
// 正式整理可能包含较长模型推理；探测只访问模型列表，应更快给出失败反馈。
const POST_TIMEOUT: Duration = Duration::from_secs(90);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

enum RequestSlot {
    Active(oneshot::Sender<()>),
    // JS 的 AbortSignal 可能在 invoke 命令真正登记之前触发；墓碑覆盖这个竞态。
    Cancelled,
}

fn requests() -> &'static Mutex<HashMap<String, RequestSlot>> {
    static REQUESTS: OnceLock<Mutex<HashMap<String, RequestSlot>>> = OnceLock::new();
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub(crate) fn llm_http_cancel(request_id: String) {
    if let Ok(mut active) = requests().lock() {
        match active.remove(&request_id) {
            Some(RequestSlot::Active(sender)) => { let _ = sender.send(()); }
            _ => {
                // 取消早于请求登记时短暂保存标记；随机 request_id 只由本机 UI 生成。
                if active.len() < 128 { active.insert(request_id, RequestSlot::Cancelled); }
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn llm_http_post(
    webview: tauri::Webview,
    request_id: String,
    endpoint: String,
    api_key: String,
    body: String,
) -> Result<String, String> {
    if body.len() > MAX_REQUEST_BYTES || api_key.trim().is_empty() {
        return Err("llm:大语言模型请求内容或密钥无效".into());
    }
    let url = reqwest::Url::parse(&endpoint).map_err(|_| "llm:大语言模型地址无效".to_string())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("llm:大语言模型地址必须使用 HTTPS".into());
    }
    let (sender, receiver) = oneshot::channel();
    {
        let mut active = requests().lock().map_err(|_| "llm:请求状态不可用".to_string())?;
        if matches!(active.remove(&request_id), Some(RequestSlot::Cancelled)) {
            return Err("llm:用户已取消大语言模型整理请求".into());
        }
        active.insert(request_id.clone(), RequestSlot::Active(sender));
    }

    let network = async {
        let client = crate::http_client::builder(&webview, &url).await
            .map_err(|_| "llm:网络客户端初始化失败".to_string())?
            .timeout(POST_TIMEOUT)
            // 模型凭据只发往用户配置的 HTTPS 端点；重定向不能携带它去第二个地址。
            .redirect(reqwest::redirect::Policy::none())
            .build().map_err(|_| "llm:网络客户端初始化失败".to_string())?;
        let response = client.post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(AUTHORIZATION, format!("Bearer {api_key}"))
            .body(body)
            .send().await.map_err(|error| {
                if error.is_timeout() { "llm:大语言模型请求超时".to_string() }
                else { "llm:无法连接大语言模型服务".to_string() }
            })?;
        let status = response.status();
        if !status.is_success() {
            // 错误响应正文可能包含用户输入，绝不从这里返回或记录。
            let message = match status.as_u16() {
                400 | 422 => "大语言模型请求参数错误",
                401 | 403 => "大语言模型 API Key 认证失败",
                402 => "大语言模型账户余额或额度不足",
                429 => "大语言模型请求达到并发限制",
                500 => "大语言模型服务内部错误",
                503 => "大语言模型服务繁忙",
                _ => "大语言模型服务返回 HTTP 错误",
            };
            return Err(format!("llm:{message}"));
        }
        if response.content_length().is_some_and(|size| size > MAX_RESPONSE_BYTES as u64) {
            return Err("llm:大语言模型响应超过大小上限".into());
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "llm:读取大语言模型响应失败".to_string())? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("llm:大语言模型响应超过大小上限".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        String::from_utf8(bytes).map_err(|_| "llm:大语言模型响应不是 UTF-8".into())
    };
    let result = tokio::select! {
        result = network => result,
        _ = receiver => Err("llm:用户已取消大语言模型整理请求".into()),
    };
    if let Ok(mut active) = requests().lock() { active.remove(&request_id); }
    result
}

/// V1 连通性测试只验证模型列表端点可达与鉴权成功，不读取或返回响应正文。
#[tauri::command]
pub(crate) async fn llm_http_probe(webview: tauri::Webview, endpoint: String, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() { return Err("llm:未配置大语言模型 API Key".into()); }
    let url = reqwest::Url::parse(&endpoint).map_err(|_| "llm:大语言模型地址无效".to_string())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("llm:大语言模型地址必须使用 HTTPS".into());
    }
    let client = crate::http_client::builder(&webview, &url).await
        .map_err(|_| "llm:网络客户端初始化失败".to_string())?
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "llm:网络客户端初始化失败".to_string())?;
    let response = client.get(url)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .send().await.map_err(|error| {
            if error.is_timeout() { "llm:大语言模型请求超时".to_string() }
            else { "llm:无法连接大语言模型服务".to_string() }
        })?;
    match response.status().as_u16() {
        200..=299 => Ok(()),
        401 | 403 => Err("llm:大语言模型 API Key 认证失败".into()),
        402 => Err("llm:大语言模型账户余额或额度不足".into()),
        429 => Err("llm:大语言模型请求达到并发限制".into()),
        _ => Err("llm:大语言模型服务返回 HTTP 错误".into()),
    }
}
