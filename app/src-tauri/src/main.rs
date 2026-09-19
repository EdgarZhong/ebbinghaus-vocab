// 桌面端二进制入口。
//
// Tauri 2 约定：启动逻辑统一放在 lib（ebbinghaus_v2_lib），main 仅做转发——
// 这样桌面与移动端（Android/iOS 经 FFI 调 mobile_entry_point）共享同一套
// Builder 配置，避免两份启动代码漂移。
//
// `windows_subsystem = "windows"`：release 构建下隐藏 Windows 控制台黑窗；
// 对 macOS 无副作用，是官方模板的标准配置。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ebbinghaus_v2_lib::run()
}
