//! 在线词典的本机只读网络出口。
//!
//! WebView 直接 fetch 有道与中文维基会遇到跨域限制；本命令只允许两条固定 HTTPS
//! 接口及单个小写英文规范键。请求绝不携带手录释义、学习事件或云同步令牌。

use reqwest::header::ACCEPT;
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[tauri::command]
pub(crate) async fn dictionary_http_get(source: String, normalized_word: String) -> Result<String, String> {
    if normalized_word.is_empty() || !normalized_word.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return Err("response:在线词典只接受小写英文规范键".into());
    }
    let (endpoint, timeout_seconds) = match source.as_str() {
        "youdao" => ("https://dict.youdao.com/jsonapi", 6),
        "wiktionary" => ("https://zh.wiktionary.org/w/api.php", 8),
        _ => return Err("response:未知在线词典来源".into()),
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_seconds))
        .user_agent("Ebbinghaus/0.1 local-desktop-dictionary")
        .build().map_err(|_| "network:在线词典网络客户端初始化失败".to_string())?;
    let request = client.get(endpoint).header(ACCEPT, "application/json");
    let request = if source == "youdao" {
        request.query(&[("q", normalized_word.as_str())])
    } else {
        request.query(&[
            ("action", "parse"), ("page", normalized_word.as_str()),
            ("prop", "wikitext"), ("format", "json"), ("formatversion", "2"),
        ])
    };
    let mut response = request.send().await.map_err(map_network_error)?;
    if !response.status().is_success() {
        return Err(format!("network:在线词典返回 HTTP {}", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|size| size > MAX_RESPONSE_BYTES as u64) {
        return Err("response:在线词典响应超过安全大小上限".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(map_network_error)? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("response:在线词典响应超过安全大小上限".into());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "response:在线词典未返回有效 UTF-8".into())
}

fn map_network_error(error: reqwest::Error) -> String {
    if error.is_timeout() { "timeout:在线词典查询超时".into() }
    else { "network:无法连接在线词典".into() }
}
