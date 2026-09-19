/**
 * 浏览器模式入口：挂载 React 应用并引入设计令牌。
 * 组合根（composition.ts 的 getRuntime）是唯一的内部包装配出口。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { getRuntime } from "./composition.ts";
import "./theme/tokens.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("找不到 #root 挂载点");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 浏览器验收种子钩子：Playwright 冒烟在真实构建产物上运行，内存运行时无外部
// 注入通道，经该全局引用访问组合根服务播种验收数据（只在浏览器模式存在；
// Tauri 生产壳不加载本入口，敏感操作不受影响）。组件仍只经 useServices 消费。
(window as unknown as Record<string, unknown>)["__ebbinghaus"] = getRuntime();
