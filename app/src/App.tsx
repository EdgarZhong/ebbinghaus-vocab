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

export interface AppProps {
  /** 缺省使用生产组合根单例；测试注入独立实例。 */
  readonly services?: AppServices;
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

export function App({ services = getRuntime() }: AppProps): ReactNode {
  const path = useHashRoute();
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
          <AppShell>{renderPage(path, returnPath)}</AppShell>
        </ErrorBoundary>
      </ToastProvider>
    </ServicesProvider>
  );
}
