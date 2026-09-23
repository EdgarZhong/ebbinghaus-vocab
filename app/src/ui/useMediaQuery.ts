/**
 * 媒体查询订阅 hook：以 React 19 的 useSyncExternalStore 绑定 window.matchMedia。
 *
 * 业务用途：应用外壳按视口宽度分流桌面/移动两种结构（AppShell 的
 * "(max-width: 900px)" 断点）。断点判断必须落在 JS 而不是纯 CSS 显隐——
 * 移动端抽屉的打开状态、焦点管理与 body 滚动锁都是命令式行为，只有 JS 驱动
 * 的结构分流才能保证这些行为可测试、可清理。
 *
 * 降级路径：jsdom（Vitest 组件测试环境）与非浏览器环境不提供 matchMedia，
 * 此时稳定返回 false。调用方据此把"查不到视口"一律视为桌面端（宽布局是
 * 安全默认：所有控件恒可见，只是不够紧凑）。getServerSnapshot 同样返回
 * false，与服务端渲染/首帧直出口径一致。
 */

import { useCallback, useSyncExternalStore } from "react";

/** matchMedia 不存在（jsdom/非浏览器）时的恒定结果：按桌面端处理。 */
const FALLBACK_MATCHES = false;

export function useMediaQuery(query: string): boolean {
  // subscribe 必须随 query 稳定（useCallback），否则每次渲染都会退订再订阅，
  // 造成无意义的监听器抖动；change 事件只负责通知快照失效，值仍在 getSnapshot 重取。
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => undefined;
      }
      const mediaQueryList = window.matchMedia(query);
      mediaQueryList.addEventListener("change", onStoreChange);
      return () => {
        mediaQueryList.removeEventListener("change", onStoreChange);
      };
    },
    [query],
  );

  const getSnapshot = useCallback((): boolean => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return FALLBACK_MATCHES;
    }
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => FALLBACK_MATCHES);
}
