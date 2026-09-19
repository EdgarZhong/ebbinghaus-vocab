/**
 * 应用外壳：侧边栏（应用名、当前 Space 入口、一级导航、主题切换）+ 主内容区。
 *
 * 布局与交互语义来自界面设计规格第 4/6 章：
 * - 一级导航顺序固定：今日、复习、测试、首过录入、词汇、设置；
 * - 侧边栏顶部显示当前 Space 名称，右侧箭头，点击后在主内容区打开 Space 管理
 *   页（不用下拉菜单，不埋进设置）；
 * - 当前页用强调条 + 浅色选中背景 + 加粗表达，不只靠颜色；
 * - 键盘快捷键 Command+1..5 / Command+, 对应六个页面（Ctrl 同样接受，方便
 *   非 macOS 浏览器验收）；
 * - 数量角标留待任务派生接入（UI-2），为 0 或未知时不显示。
 */

import { useEffect, type ReactNode } from "react";
import { spaceDisplayName } from "@ebbinghaus/domain";
import { navigate, routes, useHashRoute, type RoutePath } from "../router.tsx";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { useThemeMode } from "../theme/theme.ts";

const NAV_ITEMS: readonly { path: RoutePath; label: string; testId: string }[] = [
  { path: routes.today, label: "今日", testId: "nav-today" },
  { path: routes.review, label: "复习", testId: "nav-review" },
  { path: routes.test, label: "测试", testId: "nav-test" },
  { path: routes.firstPass, label: "首过录入", testId: "nav-first-pass" },
  { path: routes.vocabulary, label: "词汇", testId: "nav-vocabulary" },
  { path: routes.settings, label: "设置", testId: "nav-settings" },
];

/** 快捷键 → 路由映射（Command/Ctrl + 数字，设置用逗号）。 */
const SHORTCUT_TARGETS: Readonly<Record<string, RoutePath>> = {
  "1": routes.today,
  "2": routes.review,
  "3": routes.test,
  "4": routes.firstPass,
  "5": routes.vocabulary,
  ",": routes.settings,
};

const THEME_OPTIONS: readonly { mode: "system" | "light" | "dark"; label: string }[] = [
  { mode: "system", label: "跟随系统" },
  { mode: "light", label: "浅色" },
  { mode: "dark", label: "深色" },
];

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const services = useServices();
  const activeSpace = useActiveSpace();
  const { mode, setMode } = useThemeMode(services.deviceLocal);

  // 键盘快捷键：挂在 window 上，输入框聚焦时同样可用（无文本冲突，浏览器
  // 默认行为已由 preventDefault 抑制）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      const target = SHORTCUT_TARGETS[event.key];
      if (target === undefined) {
        return;
      }
      event.preventDefault();
      navigate(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const currentPath = useHashRoute();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-app-name">Ebbinghaus</div>
        <button
          type="button"
          className="space-switcher"
          onClick={() => navigate(routes.spaces)}
          aria-label={
            activeSpace === null
              ? "打开 Space 管理"
              : `打开 Space 管理，当前 Space：${spaceDisplayName(activeSpace)}`
          }
          data-testid="space-switcher"
        >
          <span className="space-switcher-label">
            {activeSpace === null ? "未选择 Space" : spaceDisplayName(activeSpace)}
          </span>
          <span className="arrow" aria-hidden="true">
            ›
          </span>
        </button>
        <hr className="sidebar-divider" />
        <nav className="sidebar-nav" aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.path}
              className="nav-link"
              href={`#${item.path}`}
              aria-current={currentPath === item.path ? "page" : undefined}
              data-testid={item.testId}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-nav-footer">
          <div className="theme-toggle" role="group" aria-label="界面主题" data-testid="theme-toggle">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                aria-pressed={mode === option.mode}
                onClick={() => setMode(option.mode)}
                data-testid={`theme-${option.mode}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </aside>
      <main className="main-area">{children}</main>
    </div>
  );
}
