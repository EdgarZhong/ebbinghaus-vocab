/**
 * 浏览器模式入口：挂载 React 应用并引入设计令牌。
 * 组合根（composition.ts 的 getRuntime）是唯一的内部包装配出口。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
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
