/**
 * AppServices 的 React 注入层：组件一律经 useServices() 取用例服务，
 * 经 useActiveSpace() 订阅活动 Space——任何组件不得直接触碰端口对象。
 */

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
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
  const version = useSyncExternalStore(services.subscribeChanged, services.getVersion, services.getVersion);
  // 活动 Space 只随业务通知变更；揭示答案、输入文本等局部重绘不需要同步访问
  // SQLite。沿用现有业务版本订阅，既避免阻塞查询，也保持对象引用稳定，防止
  // 依赖 activeSpace 的 effect 在每次局部点击时重新执行。切换与远端更新仍立即重读。
  return useMemo(() => services.getActiveSpace(), [services, version]);
}
