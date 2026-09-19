// Tauri 平台壳的统一启动逻辑（桌面 main 与移动端 mobile_entry_point 共用）。
//
// 本轮（Stretch 冒烟）骨架保持纯净：
// - 不注册任何自定义 command（React UI 与 Rust 壳之间暂无进程内调用需求，
//   UI 通过 devUrl 直接访问现有 Vite 服务）；
// - 不接任何插件——tauri-plugin-sql / http / stronghold / notification 的接入
//   计划见 Cargo.toml 占位注释与 CLAUDE.md「闸门测试清单（Phase 4）」，
//   插件接线属于 Phase 4 闸门测试的交付内容，不属于本轮冒烟范围。

// mobile cfg 由 cargo-mobile2 在 Android/iOS 工程中注入；桌面构建下该属性不生效，
// 由 src/main.rs 调用本函数。移动端工程在 Phase 4 闸门通过后再生成。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // generate_context! 在编译期内嵌 tauri.conf.json、capabilities 与
        // frontendDist（../dist）资产清单；因此 cargo check 前必须存在 Vite 构建产物。
        .run(tauri::generate_context!())
        // 启动失败（如配置非法、devUrl 不可达导致的运行期错误）直接 panic 终止，
        // 属于开发期快速失败的预期行为，不引入额外错误处理依赖。
        .expect("Ebbinghaus：Tauri 应用启动失败，请检查 tauri.conf.json 配置与前端 devUrl 是否可用");
}
