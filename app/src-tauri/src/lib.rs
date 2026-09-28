// Tauri 平台壳的统一启动逻辑（桌面 main 与移动端 mobile_entry_point 共用）。
//
// 本轮接入官方 SQL 插件：数据库路径由插件限定在应用配置目录，JS 端只能通过
// 异步 API 访问。其余平台能力在客户端同步端口完成异步迁移后逐项接入。

// mobile cfg 由 cargo-mobile2 在 Android/iOS 工程中注入；桌面构建下该属性不生效，
// 由 src/main.rs 调用本函数。Android Gradle 工程已经生成在 gen/android。
mod sqlite_transaction;
mod sqlite_bridge;
mod http_client;
mod dictionary_http;
mod llm_http;
mod sync_http;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // macOS 没有可直接驱动 WKWebView 的系统 WebDriver；仅验收构建启用内嵌驱动。
    // 正式发布构建不启用 wdio-test，因此不会监听测试端口。
    #[cfg(all(feature = "wdio-test", target_os = "macos"))]
    let builder = builder
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(tauri_plugin_wdio::init());

    builder
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            sqlite_transaction::execute_sqlite_transaction,
            sqlite_bridge::start_sqlite_bridge,
            dictionary_http::dictionary_http_get,
            llm_http::llm_http_post,
            llm_http::llm_http_cancel,
            llm_http::llm_http_probe,
            sync_http::sync_http_request,
        ])
        // generate_context! 在编译期内嵌 tauri.conf.json、capabilities 与
        // frontendDist（../dist）资产清单；因此 cargo check 前必须存在 Vite 构建产物。
        .run(tauri::generate_context!())
        // 启动失败（如配置非法、devUrl 不可达导致的运行期错误）直接 panic 终止，
        // 属于开发期快速失败的预期行为，不引入额外错误处理依赖。
        .expect("Ebbinghaus：Tauri 应用启动失败，请检查 tauri.conf.json 配置与前端 devUrl 是否可用");
}
