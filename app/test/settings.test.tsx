/**
 * 设置页测试：同步设置读写（学习日 / 每日目标 / 词典来源 / 联网辅助）、
 * LLM 四项配置（设备本地）、API 密钥脱敏与"清空并重新填写"语义、
 * 客户端校验失败时的就地提示。
 */

import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { fireEvent, screen } from "@testing-library/react";
import { createTestServices, renderApp } from "./helpers.tsx";
import type { AppServices } from "../src/composition.ts";

async function openSettings(user: ReturnType<typeof userEvent.setup>): Promise<AppServices> {
  const services = createTestServices();
  renderApp(services);
  await user.click(screen.getByTestId("nav-settings"));
  return services;
}

describe("设置页：同步设置", () => {
  it("初始展示默认值：东八区、04:00 换日、联网辅助开启、维基词典", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);
    expect(screen.getByTestId("settings-timezone")).toHaveValue("Asia/Shanghai");
    expect(screen.getByTestId("settings-rollover")).toHaveValue("04:00");
    expect(screen.getByTestId("feature-smart-organizing")).toBeChecked();
    expect(screen.getByTestId("feature-online-dictionary")).toBeChecked();
    expect(screen.getByTestId("dictionary-provider")).toHaveValue("维基词典");
    // 默认 Space（必考词）的每日目标初始为 0。
    expect(screen.getByTestId("settings-daily-target")).toHaveValue("0");
    void services;
  });

  it("修改换日时间与每日目标后保存，写入同步设置", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    fireEvent.change(screen.getByTestId("settings-rollover"), { target: { value: "05:30" } });
    const targetInput = screen.getByTestId("settings-daily-target");
    await user.clear(targetInput);
    await user.type(targetInput, "12");
    await user.click(screen.getByTestId("settings-save"));

    expect(screen.getByTestId("settings-status")).toHaveTextContent("设置已保存。");
    expect(services.settings.getLearningDaySettings().rolloverTime).toBe("05:30");
    expect(
      services.settings.getSpaceLearningSettings("a1f0c3d4-0000-4000-8000-000000000001").dailyTarget,
    ).toBe(12);
  });

  it("切换词典来源与联网辅助开关后保存，写入同步设置", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    await user.selectOptions(screen.getByTestId("dictionary-provider"), "有道词典");
    await user.click(screen.getByTestId("feature-smart-organizing"));
    await user.click(screen.getByTestId("settings-save"));

    expect(screen.getByTestId("settings-status")).toHaveTextContent("设置已保存。");
    expect(services.settings.getDictionaryProvider()).toBe("有道词典");
    expect(services.settings.getFeatureFlags()).toMatchObject({
      smartOrganizing: false,
      onlineDictionary: true,
    });
  });

  it("换日时间格式非法时阻止保存并就地提示", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    fireEvent.change(screen.getByTestId("settings-rollover"), { target: { value: "" } });
    await user.click(screen.getByTestId("settings-save"));

    expect(screen.getByTestId("settings-status")).toHaveTextContent("没有保存成功，请检查输入后重试。");
    // 未写入：换日时间仍是初始默认值。
    expect(services.settings.getLearningDaySettings().rolloverTime).toBe("04:00");
  });
});

describe("设置页：大语言模型配置", () => {
  it("未配置密钥时显示未配置并提供填写入口", async () => {
    const user = userEvent.setup();
    await openSettings(user);
    expect(screen.getByTestId("llm-api-key-masked")).toHaveTextContent("未配置");
    expect(screen.getByTestId("llm-fill-api-key")).toBeInTheDocument();
    expect(screen.getByTestId("llm-base-url")).toHaveValue(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
    expect(screen.getByTestId("llm-model-name")).toHaveValue("deepseek-v4-flash");
    expect(screen.getByTestId("llm-thinking-checkbox")).toBeChecked();
  });

  it("填写并保存密钥：密文可回读，界面只显示脱敏形态", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    await user.click(screen.getByTestId("llm-fill-api-key"));
    await user.type(screen.getByTestId("llm-api-key-input"), "sk-test-abcd1234");
    await user.click(screen.getByTestId("settings-save"));

    const snapshot = services.llm.configurationSnapshot();
    expect(snapshot.hasApiKey).toBe(true);
    // 脱敏规则：保留前三位与末四位（maskApiKey 用例口径）。
    expect(snapshot.maskedApiKey).toBe(`sk-${"*".repeat(9)}1234`);
    expect(screen.getByTestId("llm-api-key-masked")).toHaveTextContent(snapshot.maskedApiKey);
    // 明文绝不出现在界面。
    expect(document.body.textContent).not.toContain("sk-test-abcd1234");
    expect(screen.queryByTestId("llm-api-key-input")).not.toBeInTheDocument();
  });

  it("清空并重新填写：留空保存清除密钥，取消不影响思考开关", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    await user.click(screen.getByTestId("llm-fill-api-key"));
    await user.type(screen.getByTestId("llm-api-key-input"), "sk-live-99887766");
    await user.click(screen.getByTestId("settings-save"));
    expect(services.llm.configurationSnapshot().hasApiKey).toBe(true);

    await user.click(screen.getByTestId("llm-clear-api-key"));
    await user.click(screen.getByTestId("llm-cancel-refill"));
    expect(services.llm.configurationSnapshot().hasApiKey).toBe(true);

    await user.click(screen.getByTestId("llm-clear-api-key"));
    await user.click(screen.getByTestId("settings-save"));
    expect(screen.getByTestId("settings-status")).toHaveTextContent("设置已保存。");
    expect(services.llm.configurationSnapshot().hasApiKey).toBe(false);
    expect(screen.getByTestId("llm-api-key-masked")).toHaveTextContent("未配置");
  });

  it("思考开关随保存持久化到设备本地配置", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    await user.click(screen.getByTestId("llm-thinking-checkbox"));
    await user.click(screen.getByTestId("settings-save"));
    expect(services.llm.configurationSnapshot().thinkingEnabled).toBe(false);
  });

  it("基础地址非 HTTPS 时阻止保存并就地提示", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    await user.clear(screen.getByTestId("llm-base-url"));
    await user.type(screen.getByTestId("llm-base-url"), "http://insecure.example.com");
    await user.click(screen.getByTestId("settings-save"));

    expect(screen.getByTestId("settings-status")).toHaveTextContent("没有保存成功，请检查输入后重试。");
    expect(screen.getByText("基础地址必须使用 HTTPS。")).toBeInTheDocument();
    // 未写入：配置仍是默认地址。
    expect(services.llm.configurationSnapshot().baseUrl).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
  });
});
