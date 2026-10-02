/**
 * 应用根组件：服务注入 → 路由分发 → 外壳渲染。
 *
 * services 通过 props 注入（生产由 main.tsx 传 getRuntime() 单例；测试传确定性
 * 测试服务），保证同一套组件树可以在内存运行时的任意实例上运行。
 */

import { useEffect, useState, type ReactNode } from "react";
import { getRuntime, type AppServices } from "./composition.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { AppShell } from "./shell/AppShell.tsx";
import { ToastProvider } from "./shell/ToastContext.tsx";
import { rememberReturnPath, routes, useHashRoute, type RoutePath } from "./router.tsx";
import { ServicesProvider } from "./services/servicesContext.tsx";
import { FirstPassPage } from "./pages/FirstPassPage.tsx";
import { ReviewPage } from "./pages/ReviewPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SpaceManagementPage } from "./pages/SpaceManagementPage.tsx";
import { TestPage } from "./pages/TestPage.tsx";
import { TodayPage } from "./pages/TodayPage.tsx";
import { VocabularyPage } from "./pages/VocabularyPage.tsx";
import { PageShell } from "./ui/PageShell.tsx";

export interface AppProps {
  /** 缺省使用生产组合根单例；测试注入独立实例。 */
  readonly services?: AppServices;
  /** 组件业务测试可跳过视觉帧调度；正式应用默认始终先绘制切页骨架。 */
  readonly deferPageMount?: boolean;
}

function renderPage(path: RoutePath, returnPath: RoutePath): ReactNode {
  switch (path) {
    case routes.today:
      return <TodayPage />;
    case routes.review:
      return <ReviewPage />;
    case routes.test:
      return <TestPage />;
    case routes.firstPass:
      return <FirstPassPage />;
    case routes.vocabulary:
      return <VocabularyPage />;
    case routes.spaces:
      return <SpaceManagementPage returnPath={returnPath} />;
    case routes.settings:
      return <SettingsPage />;
  }
}

const PAGE_NAMES: Readonly<Record<RoutePath, string>> = {
  [routes.today]: "今日",
  [routes.review]: "复习",
  [routes.test]: "测试",
  [routes.firstPass]: "录入",
  [routes.vocabulary]: "词汇",
  [routes.spaces]: "Space 管理",
  [routes.settings]: "设置",
};

/**
 * 切页时先呈现轻量页面框架。真实数据页读取本地 SQLite 时仍可能有同步桥接
 * 开销，因此必须先让导航和标题完成一次绘制；骨架仅表示本地视图准备中，
 * 不等待或触发任何云端请求。
 */
function PageLoading({ path }: { readonly path: RoutePath }): ReactNode {
  return (
    <PageShell title={PAGE_NAMES[path]}>
      <div className="page-loading" role="status" aria-label={`${PAGE_NAMES[path]}内容加载中`} data-testid="route-skeleton">
        <div className="page-loading-line" />
        <div className="page-loading-card" />
        <div className="page-loading-card short" />
      </div>
    </PageShell>
  );
}

export function App({ services = getRuntime(), deferPageMount = true }: AppProps): ReactNode {
  const path = useHashRoute();
  // 初次挂载也需要先绘制骨架，不能在首帧直接冷读业务数据。组件业务测试可显式
  // 关闭帧调度，正式应用与切页共用下方两帧流程，保证外壳已有一次实际绘制机会。
  const [readyPath, setReadyPath] = useState<RoutePath | null>(deferPageMount ? null : path);
  useEffect(() => {
    if (!deferPageMount || path === readyPath) return;
    // 第二帧再挂载数据页，保证第一帧的外壳/骨架能真正显示；快速连续导航时
    // 取消旧目标，避免过期页面闪现或仍执行其昂贵的本地读取。
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setReadyPath(path));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [path, readyPath, deferPageMount]);
  // "进入 Space 管理页之前的页面"：只在非 /spaces 路由时刷新记录，
  // 保证从设置页进入 Space 管理后返回设置页（规格第 2 章口径 5）。
  const [returnPath, setReturnPath] = useState<RoutePath>(routes.today);
  useEffect(() => {
    if (path !== routes.spaces) {
      rememberReturnPath(path);
      setReturnPath(path);
    }
  }, [path]);

  return (
    <ServicesProvider services={services}>
      <ToastProvider>
        <ErrorBoundary>
          <AppShell readyRoute={!deferPageMount || readyPath === path ? path : null}>
            {!deferPageMount || readyPath === path ? renderPage(path, returnPath) : <PageLoading path={path} />}
          </AppShell>
        </ErrorBoundary>
      </ToastProvider>
    </ServicesProvider>
  );
}
