/**
 * 主题模式（跟随系统 / 浅色 / 深色）的读写与应用。
 *
 * 存储归宿：设备本地 KV（DeviceLocalStore 端口，键 ui.themeMode）——界面偏好属于
 * "本设备自己的状态"（ports.ts DeviceLocalStore 注释 A5 预留的典型用例），不进入
 * settings 同步通道。index.html 中的内联脚本用同一个键在首帧前设置 data-theme，
 * 避免深色用户看到浅色闪屏；两处键名必须保持一致。
 */

import { useEffect, useState } from "react";
import type { DeviceLocalStore } from "@ebbinghaus/application";

export type ThemeMode = "system" | "light" | "dark";

/** 与 index.html 内联脚本共享的设备本地键。 */
export const THEME_MODE_KEY = "ui.themeMode";

export function readThemeMode(store: DeviceLocalStore): ThemeMode {
  const raw = store.getString(THEME_MODE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

/** 解析出实际生效的主题；system 模式跟随系统偏好，无 matchMedia 环境按浅色。 */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    if (typeof window.matchMedia !== "function") {
      return "light";
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

/** 把解析结果写到文档根元素（tokens.css 按 data-theme 切换变量组）。 */
export function applyTheme(resolved: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", resolved);
}

/** 订阅系统明暗偏好变化；环境不支持时立即返回空取消函数。 */
function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

/**
 * 主题模式 hook：从设备本地 KV 初始化，跟随系统偏好变化，用户手动选择时
 * 立即持久化回 KV。
 */
export function useThemeMode(store: DeviceLocalStore): {
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode(mode: ThemeMode): void;
} {
  const [mode, setModeState] = useState<ThemeMode>(() => readThemeMode(store));
  const [systemDark, setSystemDark] = useState<boolean>(() => resolveTheme(mode) === "dark");

  // 跟随系统模式下监听系统偏好；任何模式变化都重新应用 data-theme。
  useEffect(() => {
    const unsubscribe = watchSystemTheme(() => {
      setSystemDark(resolveTheme("system") === "dark");
    });
    return unsubscribe;
  }, []);

  const resolved: "light" | "dark" =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setMode = (next: ThemeMode): void => {
    setModeState(next);
    store.setString(THEME_MODE_KEY, next);
  };

  return { mode, resolved, setMode };
}
