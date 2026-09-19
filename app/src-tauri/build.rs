//! Tauri 构建脚本（cargo 会在编译本 crate 前自动执行）。
//!
//! 职责：编译期校验并消费 `tauri.conf.json` 与 `capabilities/` 权限声明，
//! 生成平台胶水（Windows 资源/清单、图标嵌入等），并为源码中的
//! `tauri::generate_context!` 提供配置与资产清单上下文。
//! 不需要在此做任何业务逻辑；保持一行调用即可。
fn main() {
    tauri_build::build()
}
