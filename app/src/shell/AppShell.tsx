/**
 * 应用外壳：一级导航骨架 + 主内容区，按视口宽度分流两种结构。
 *
 * 断点口径：≤900px 视为移动端（useMediaQuery("(max-width: 900px)")，JS 驱动而
 * 非纯 CSS 显隐——抽屉的开关状态、焦点管理、body 滚动锁都是命令式行为，只有
 * JS 分流才能保证可测试、可清理）。jsdom 无 matchMedia，稳定走桌面结构，所以
 * 存量测试断言不受影响。
 *
 * 桌面端（>900px）：侧边栏是浮动玻璃面板（Glass 原语包裹，上下左各 12px 外
 * 边距、圆角 16），主区域背景透明，body 的环境苔绿渐变整屏透出作玻璃折光底。
 *
 * 移动端（≤900px）：侧栏默认隐藏——窄视口下恒驻侧栏会挤占近半屏主内容（本轮
 * 重构要修的既定缺陷）。改为顶栏（汉堡按钮 + 应用名 + 当前 Space 胶囊）+ 按需
 * 滑入的抽屉；抽屉内容与桌面侧栏完全一致（同一 SidebarContent，全部 testid
 * 不变），关闭路径：点导航项（导航同时发生）、点背景罩、按 Escape。
 *
 * 布局与交互语义来自界面设计规格第 4/6 章：
 * - 一级导航顺序固定：今日、复习、测试、首过录入、词汇、设置；
 * - 侧边栏顶部显示当前 Space 名称，点击后在主内容区打开 Space 管理页；
 * - 当前页用强调条 + 浅色选中背景 + 加粗表达，不只靠颜色；
 * - 键盘快捷键 Command+1..5 / Command+, 对应六个页面（Ctrl 同样接受），
 *   桌面与移动端都可用；
 * - 数量角标留待任务派生接入（UI-2），为 0 或未知时不显示。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { spaceDisplayName, type Space } from "@ebbinghaus/domain";
import { navigate, routes, useHashRoute, type RoutePath } from "../router.tsx";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { useThemeMode, type ThemeMode } from "../theme/theme.ts";
import Glass from "../ui/Glass.tsx";
import { useMediaQuery } from "../ui/useMediaQuery.ts";

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

const THEME_OPTIONS: readonly { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: "跟随系统" },
  { mode: "light", label: "浅色" },
  { mode: "dark", label: "深色" },
];

/** 移动/桌面结构分流断点：与 shell.css 中的视觉断点保持一致。 */
const MOBILE_QUERY = "(max-width: 900px)";

interface SidebarContentProps {
  readonly currentPath: RoutePath;
  readonly activeSpace: Space | null;
  readonly themeMode: ThemeMode;
  readonly onThemeModeChange: (mode: ThemeMode) => void;
  /**
   * 点击任一导航链接后的附加动作（不阻止默认 hash 跳转）。移动端抽屉传入
   * "关闭抽屉"——窄屏上导航后抽屉必须让出主内容；桌面恒驻侧栏传 undefined。
   */
  readonly onNavigate?: () => void;
}

/**
 * 侧栏内容（应用名、当前 Space 入口、一级导航、主题切换）：桌面浮动侧栏与
 * 移动端抽屉复用同一份，保证两种结构的功能、文案与 testid 完全一致。
 */
function SidebarContent({
  currentPath,
  activeSpace,
  themeMode,
  onThemeModeChange,
  onNavigate,
}: SidebarContentProps): ReactNode {
  return (
    <>
      <div className="sidebar-app-name">Ebbinghaus</div>
      <button
        type="button"
        className="space-switcher"
        onClick={() => {
          onNavigate?.();
          navigate(routes.spaces);
        }}
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
            onClick={onNavigate}
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
              aria-pressed={themeMode === option.mode}
              onClick={() => onThemeModeChange(option.mode)}
              data-testid={`theme-${option.mode}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const services = useServices();
  const activeSpace = useActiveSpace();
  const { mode, resolved, setMode } = useThemeMode(services.deviceLocal);
  const currentPath = useHashRoute();
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const [drawerOpen, setDrawerOpen] = useState(false);
  /** 汉堡按钮引用：抽屉关闭后焦点回到这里（键盘用户的上下文不丢失）。 */
  const drawerOpenButtonRef = useRef<HTMLButtonElement>(null);
  /** 抽屉框架引用：打开时把焦点送入抽屉内第一个导航链接。 */
  const drawerFrameRef = useRef<HTMLDivElement>(null);

  // 键盘快捷键：挂在 window 上，输入框聚焦时同样可用（无文本冲突，浏览器
  // 默认行为已由 preventDefault 抑制）。两种结构共用，移动端外接键盘一致可用。
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

  // 抽屉默认关闭；任何路由变化（点击导航、快捷键、浏览器前进后退）后保持关闭。
  useEffect(() => {
    setDrawerOpen(false);
  }, [currentPath]);

  // 视口从移动端加宽到桌面端时抽屉结构整体卸载；主动复位状态，保证 body
  // 滚动锁经下方 effect 的清理路径解除，不会残留在桌面结构上。
  useEffect(() => {
    if (!isMobile) {
      setDrawerOpen(false);
    }
  }, [isMobile]);

  // 抽屉打开期间的行为闭环：body 禁止滚动（背景内容不随手势穿透滚动）、
  // 焦点进入抽屉第一个导航链接、Escape 关闭；关闭时恢复滚动并把焦点还给
  // 汉堡按钮。注意真正的滚动容器是 .main-area，但移动端浏览器以 body 为
  // 滚动链根，锁 body 是本场景的约定做法。
  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const firstNavLink = drawerFrameRef.current?.querySelector<HTMLElement>(".nav-link");
    firstNavLink?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      drawerOpenButtonRef.current?.focus();
    };
  }, [drawerOpen]);

  const sidebarContent = (
    <SidebarContent
      currentPath={currentPath}
      activeSpace={activeSpace}
      themeMode={mode}
      onThemeModeChange={setMode}
      onNavigate={isMobile ? () => setDrawerOpen(false) : undefined}
    />
  );

  // 浅色主题下玻璃位于亮背景上，overLight 让库减弱折射并换用亮态高光。
  const glassOverLight = resolved === "light";

  if (isMobile) {
    return (
      <div className="app-shell app-shell-mobile">
        <header className="topbar">
          <button
            ref={drawerOpenButtonRef}
            type="button"
            className="topbar-menu-button"
            aria-label="打开导航菜单"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            data-testid="nav-drawer-open"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M3 5.5h14M3 10h14M3 14.5h14"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <div className="topbar-app-name">Ebbinghaus</div>
          <button
            type="button"
            className="topbar-space"
            onClick={() => navigate(routes.spaces)}
            aria-label={
              activeSpace === null
                ? "打开 Space 管理"
                : `打开 Space 管理，当前 Space：${spaceDisplayName(activeSpace)}`
            }
            data-testid="topbar-space"
          >
            <span className="topbar-space-label">
              {activeSpace === null ? "未选择 Space" : spaceDisplayName(activeSpace)}
            </span>
            <span className="arrow" aria-hidden="true">
              ›
            </span>
          </button>
        </header>
        <main className="main-area">{children}</main>
        {drawerOpen && (
          <div className="drawer-layer">
            {/* 背景罩：半透明压暗主内容，点击即关闭（移动端模态惯例）。 */}
            <div
              className="drawer-backdrop"
              onClick={() => setDrawerOpen(false)}
              data-testid="nav-drawer-backdrop"
            />
            <div
              ref={drawerFrameRef}
              className="drawer-frame"
              role="dialog"
              aria-modal="true"
              aria-label="主导航"
              data-testid="nav-drawer"
            >
              <Glass className="drawer-glass" padding="0" overLight={glassOverLight}>
                <aside className="sidebar">{sidebarContent}</aside>
              </Glass>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* 浮动玻璃侧栏：框架提供尺寸与 12px 外边距并充当已定位祖先，Glass
          在其中填满（shell.css 的 .sidebar-glass 规则组负责 100% 撑满）。 */}
      <div className="sidebar-frame">
        <Glass className="sidebar-glass" padding="0" overLight={glassOverLight}>
          <aside className="sidebar">{sidebarContent}</aside>
        </Glass>
      </div>
      <main className="main-area">{children}</main>
    </div>
  );
}
