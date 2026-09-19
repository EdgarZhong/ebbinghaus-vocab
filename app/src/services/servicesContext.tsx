/**
 * AppServices 的 React 注入层：组件一律经 useServices() 取用例服务，
 * 经 useActiveSpace() 订阅活动 Space——任何组件不得直接触碰端口对象。
 */

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { Space } from "@ebbinghaus/domain";
import type { AppServices } from "../composition.ts";

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  services: AppServices;
  children: ReactNode;
}): ReactNode {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

/** 取应用服务门面；忘记包 Provider 属于编程错误，立即失败而非静默。 */
export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (services === null) {
    throw new Error("useServices 必须在 ServicesProvider 内使用");
  }
  return services;
}

/**
 * 订阅当前活动 Space：经 useSyncExternalStore 绑定服务版本号，任何页面切换
 * Space（或用例内部改变了活动 Space）都会让全部业务页面同步刷新。
 */
export function useActiveSpace(): Space | null {
  const services = useServices();
  useSyncExternalStore(services.subscribeChanged, services.getVersion, services.getVersion);
  return services.getActiveSpace();
}
