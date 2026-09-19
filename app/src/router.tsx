/**
 * 自实现 hash 路由。
 *
 * 选型理由（相对于引入 react-router）：
 * 1. 本应用一级路由恰好 7 个、全平铺，无嵌套路由、路径参数与 loader 需求，
 *    引入路由库的收益低于其依赖面；
 * 2. 生产宿主是 Tauri 的 asset 协议（file:// 形态），hash 路由零服务端依赖、
 *    深链刷新可靠，是 Tauri 生态的默认稳妥选择；
 * 3. 键盘可达性由原生 <a href="#/..."> 天然保证，无需库级 Link 抽象。
 *
 * 未知 hash 一律渲染默认页（今日），不做运行时报错。
 */

import { useEffect, useState } from "react";

/** 全部一级路由（与界面设计规格第 4 章信息架构一一对应）。 */
export const routes = {
  today: "/today",
  review: "/review",
  test: "/test",
  firstPass: "/first-pass",
  vocabulary: "/vocabulary",
  spaces: "/spaces",
  settings: "/settings",
} as const;

export type RoutePath = (typeof routes)[keyof typeof routes];

const KNOWN_PATHS: readonly string[] = Object.values(routes);
const DEFAULT_PATH: RoutePath = routes.today;

/** 读取当前 hash 对应的已知路由；无 hash 或未知 hash 回退默认页。 */
function readHashPath(): RoutePath {
  const hash = window.location.hash;
  if (hash.startsWith("#")) {
    const candidate = hash.slice(1);
    if (KNOWN_PATHS.includes(candidate)) {
      return candidate as RoutePath;
    }
  }
  return DEFAULT_PATH;
}

/** 程序化导航（快捷键、Space 切换返回等场景）。 */
export function navigate(path: RoutePath): void {
  window.location.hash = `#${path}`;
}

/** 订阅 hash 变化，返回当前路由路径。 */
export function useHashRoute(): RoutePath {
  const [path, setPath] = useState<RoutePath>(readHashPath);
  useEffect(() => {
    const onHashChange = (): void => {
      setPath(readHashPath());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);
  return path;
}

// ---------------------------------------------------------------------------
// 返回路径记忆：Space 管理页是"从某页临时进入的管理页"，选择 Space 后必须
// 回到进入前的页面（规格 2 章口径 5）。模块级记录最近一次非 /spaces 的路由。
// ---------------------------------------------------------------------------

let lastNonSpacePath: RoutePath = routes.today;

/** 记录"进入 Space 管理页之前"的路径；App 在路由变化时调用。 */
export function rememberReturnPath(path: RoutePath): void {
  if (path !== routes.spaces) {
    lastNonSpacePath = path;
  }
}

/** Space 管理页选择 Space 后应返回的路径。 */
export function peekReturnPath(): RoutePath {
  return lastNonSpacePath;
}
