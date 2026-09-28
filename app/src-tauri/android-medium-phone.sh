#!/usr/bin/env bash
set -euo pipefail

# 固定本轮用户最终确认的 JDK 21 与 Android 工具链，仅影响本次命令及其子进程。
# 不修改系统 Java、用户 shell 配置，也不在仓库保存本机密钥。
export JAVA_HOME="$(rtk mise where java@openjdk-21.0.2)/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"

serial="emulator-5554"
package="com.edgarzhong.ebbinghaus"

# 开发者只需重复同一命令：若模拟器尚未启动，先启动指定 AVD 并等待系统就绪。
if ! rtk adb -s "$serial" get-state >/dev/null 2>&1; then
  rtk "$ANDROID_HOME/emulator/emulator" -avd medium_phone -no-snapshot-load >/dev/null 2>&1 &
  rtk adb -s "$serial" wait-for-device
fi
if ! rtk adb -s "$serial" emu avd name | rtk rg -q '^medium_phone\r?$'; then
  printf '模拟器 %s 不是 medium_phone，已停止部署。\n' "$serial" >&2
  exit 1
fi
for _ in {1..120}; do
  boot_status="$(rtk adb -s "$serial" shell getprop sys.boot_completed)"
  if [[ "${boot_status//$'\r'/}" == "1" ]]; then
    break
  fi
  rtk sleep 2
done
if [[ "${boot_status//$'\r'/}" != "1" ]]; then
  printf 'medium_phone 未在等待期内完成启动。\n' >&2
  exit 1
fi

rtk pnpm tauri android build --debug --apk --target aarch64 --ci
apk="$(rtk find src-tauri/gen/android/app/build/outputs/apk -path '*/debug/*' -name '*.apk' -print -quit)"
if [[ -z "$apk" ]]; then
  printf 'Android 构建成功但未找到 debug APK。\n' >&2
  exit 1
fi
rtk adb -s "$serial" install -r "$apk"
rtk adb -s "$serial" shell am force-stop "$package"
rtk adb -s "$serial" shell am start -n "$package/.MainActivity"
printf '已构建、安装并启动：%s\n' "$apk"
