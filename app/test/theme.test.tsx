/**
 * 主题测试：跟随系统默认、手动切换持久化到设备本地 KV、重挂载后恢复选择。
 */

import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { createTestServices, renderApp } from "./helpers.tsx";

describe("主题切换", () => {
  it("默认跟随系统；jsdom 无 matchMedia 时按浅色", () => {
    renderApp();
    expect(screen.getByTestId("theme-system")).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("手动切换深色：立即生效并写入设备本地 KV", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    renderApp(services);

    await user.click(screen.getByTestId("theme-dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "true");
    expect(services.deviceLocal.getString("ui.themeMode")).toBe("dark");
  });

  it("重挂载后从设备本地 KV 恢复上次的主题选择", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    const first = renderApp(services);
    await user.click(screen.getByTestId("theme-light"));
    first.unmount();

    renderApp(services);
    expect(screen.getByTestId("theme-light")).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
