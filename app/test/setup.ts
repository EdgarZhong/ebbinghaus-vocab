/**
 * Testing Library 测试环境装配：
 * - 引入 @testing-library/jest-dom 的 Vitest 匹配器扩展；
 * - 每个用例结束后卸载组件树并复位 hash 与 localStorage，保证用例互不污染。
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  window.localStorage.clear();
});
