/**
 * 设置页测试：同步设置读写（学习日 / 联网辅助 / 复习参数）、
 * LLM 四项配置（设备本地）、API 密钥单独保存与"清空并重新填写"语义、
 * 客户端校验失败时的就地提示与逐项自动保存。
 */

import { describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { act, fireEvent, screen } from "@testing-library/react";
import { createTestServices, renderApp } from "./helpers.tsx";
import { createAppServices, type AppServices, type CloudSyncPort } from "../src/composition.ts";

async function openSettings(user: ReturnType<typeof userEvent.setup>): Promise<AppServices> {
  const services = createTestServices();
  renderApp(services);
  await user.click(screen.getByTestId("nav-settings"));
  return services;
}

describe("设置页：同步设置", () => {
  it("云端托管位于设置页末尾，后台恢复成功后自动清除同步错误", async () => {
    const user = userEvent.setup();
    const listeners = new Set<() => void>();
    let statusVersion = 0;
    let lastError: string | null = "网络暂时不可用";
    const cloudSync: CloudSyncPort = {
      hasToken: () => true,
      configureToken: () => {},
      syncNow: async () => null,
      requestSyncSoon: () => {},
      subscribeStatus(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getStatusVersion: () => statusVersion,
      getStatus: () => ({ configured: true, running: false, lastSuccessAt: null,
        lastAttemptAt: null, lastError, pendingOutboxCount: 0 }),
      start: () => {}, stop: () => {},
    };
    const services = createAppServices({ cloudSync });
    const businessChanged = vi.fn();
    services.subscribeChanged(businessChanged);
    renderApp(services);
    await user.click(screen.getByTestId("nav-settings"));
    const cloudSection = screen.getByRole("heading", { name: "云端数据托管" }).closest("section");
    // 云端操作独立于普通设置，且卡片仍位于页面末尾。
    expect(cloudSection).not.toBeNull();
    if (cloudSection === null) throw new Error("云端数据托管卡片缺失");
    expect(cloudSection.nextElementSibling).toBeNull();
    expect(cloudSection).toHaveTextContent("待同步项目：0");
    expect(screen.getByText("网络暂时不可用")).toBeInTheDocument();
    // 导航到设置页本身会更新活动路由；这里只核对随后静默恢复的增量通知。
    businessChanged.mockClear();
    // 模拟静默轮询成功：只推进状态版本，不经全局业务通知刷新所有页面。
    act(() => {
      lastError = null;
      statusVersion += 1;
      for (const listener of listeners) listener();
    });
    expect(screen.queryByText("网络暂时不可用")).not.toBeInTheDocument();
    expect(businessChanged).not.toHaveBeenCalled();
  });

  it("初始展示默认值：东八区、04:00 换日、联网辅助开启且无来源选择", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);
    expect(screen.getByTestId("settings-timezone")).toHaveValue("Asia/Shanghai");
    expect(screen.getByTestId("settings-rollover")).toHaveValue("04:00");
    expect(screen.getByTestId("feature-smart-organizing")).toBeChecked();
    expect(screen.getByTestId("feature-online-dictionary")).toBeChecked();
    expect(screen.queryByTestId("dictionary-provider")).not.toBeInTheDocument();
    // V1 的每日目标在“今日”页调整，设置页不重复放入口。
    expect(screen.queryByTestId("settings-daily-target")).not.toBeInTheDocument();
    void services;
  });

  it("修改换日时间并失焦后自动写入同步设置", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    fireEvent.change(screen.getByTestId("settings-rollover"), { target: { value: "05:30" } });
    fireEvent.blur(screen.getByTestId("settings-rollover"));

    expect(screen.getByTestId("settings-status")).toHaveTextContent("设置已自动保存。");
    expect(services.settings.getLearningDaySettings().rolloverTime).toBe("05:30");
    expect(screen.queryByTestId("settings-retention-save")).not.toBeInTheDocument();
  });

  it("切换联网辅助开关后立即写入同步设置", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    await user.click(screen.getByTestId("feature-smart-organizing"));
    expect(screen.getByTestId("settings-status")).toHaveTextContent("设置已自动保存。");
    expect(services.settings.getFeatureFlags()).toMatchObject({
      smartOrganizing: false,
      onlineDictionary: true,
    });
  });

  it("换日时间格式非法时失焦不保存并就地提示", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    fireEvent.change(screen.getByTestId("settings-rollover"), { target: { value: "" } });
    fireEvent.blur(screen.getByTestId("settings-rollover"));

    expect(screen.getByTestId("settings-status")).toHaveTextContent("没有保存成功，请检查输入后重试。");
    // 未写入：换日时间仍是初始默认值。
    expect(services.settings.getLearningDaySettings().rolloverTime).toBe("04:00");
  });

  it("一个文本字段无效时，另一个有效字段仍可单独保存", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);
    fireEvent.change(screen.getByTestId("settings-timezone"), { target: { value: "无效时区" } });
    fireEvent.blur(screen.getByTestId("settings-timezone"));
    expect(screen.getByText(/时区名称无效/)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("settings-rollover"), { target: { value: "05:30" } });
    fireEvent.blur(screen.getByTestId("settings-rollover"));
    expect(services.settings.getLearningDaySettings()).toMatchObject({
      timezoneName: "Asia/Shanghai", rolloverTime: "05:30",
    });
    expect(screen.getByTestId("settings-timezone")).toHaveValue("无效时区");
  });
});

describe("设置页：大语言模型配置", () => {
  it("未配置密钥时直接提供输入与独立保存", async () => {
    const user = userEvent.setup();
    await openSettings(user);
    expect(screen.getByTestId("llm-api-key-input")).toBeInTheDocument();
    expect(screen.getByTestId("llm-save-api-key")).toBeInTheDocument();
    expect(screen.getByTestId("llm-base-url")).toHaveValue(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
    expect(screen.getByTestId("llm-model-name")).toHaveValue("deepseek-v4-flash");
    expect(screen.getByTestId("llm-thinking-checkbox")).toBeChecked();
  });

  it("填写并保存密钥：密文可回读，界面只显示脱敏形态", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    await user.type(screen.getByTestId("llm-api-key-input"), "sk-test-abcd1234");
    await user.click(screen.getByTestId("llm-save-api-key"));

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

    await user.type(screen.getByTestId("llm-api-key-input"), "sk-live-99887766");
    await user.click(screen.getByTestId("llm-save-api-key"));
    expect(services.llm.configurationSnapshot().hasApiKey).toBe(true);

    await user.click(screen.getByTestId("llm-clear-api-key"));
    await user.click(screen.getByTestId("llm-cancel-refill"));
    expect(services.llm.configurationSnapshot().hasApiKey).toBe(true);

    await user.click(screen.getByTestId("llm-clear-api-key"));
    await user.click(screen.getByTestId("llm-save-api-key"));
    expect(screen.getByTestId("settings-status")).toHaveTextContent("API 密钥已清空");
    expect(services.llm.configurationSnapshot().hasApiKey).toBe(false);
    expect(screen.getByTestId("llm-api-key-input")).toHaveValue("");
  });

  it("普通设置自动保存不会意外提交密钥行尚未保存的明文草稿", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);
    await user.type(screen.getByTestId("llm-api-key-input"), "sk-unsaved-value");
    await user.click(screen.getByTestId("feature-online-dictionary"));
    expect(services.llm.configurationSnapshot().hasApiKey).toBe(false);
    expect(screen.getByTestId("llm-api-key-input")).toHaveValue("sk-unsaved-value");
  });

  it("思考开关点击后立即持久化到设备本地配置", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    await user.click(screen.getByTestId("llm-thinking-checkbox"));
    expect(services.llm.configurationSnapshot().thinkingEnabled).toBe(false);
  });

  it("基础地址非 HTTPS 时失焦不保存并就地提示", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);

    await user.clear(screen.getByTestId("llm-base-url"));
    await user.type(screen.getByTestId("llm-base-url"), "http://insecure.example.com");
    fireEvent.blur(screen.getByTestId("llm-base-url"));

    expect(screen.getByTestId("settings-status")).toHaveTextContent("没有保存成功，请检查输入后重试。");
    expect(screen.getByText("基础地址必须使用 HTTPS。")).toBeInTheDocument();
    // 未写入：配置仍是默认地址。
    expect(services.llm.configurationSnapshot().baseUrl).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
  });

  it("修改模型名称并失焦仅保存模型，不提交无效地址草稿", async () => {
    const user = userEvent.setup();
    const services = await openSettings(user);
    fireEvent.change(screen.getByTestId("llm-base-url"), { target: { value: "http://invalid.example" } });
    fireEvent.change(screen.getByTestId("llm-model-name"), { target: { value: "new-model" } });
    fireEvent.blur(screen.getByTestId("llm-model-name"));
    expect(services.llm.configurationSnapshot()).toMatchObject({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelName: "new-model",
    });
    expect(screen.getByTestId("llm-base-url")).toHaveValue("http://invalid.example");
  });
});

describe("设置页：目标保持率", () => {
  it("常规模式修改需两次确认，确认后仅保存复习参数", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    const regular = services.spaces.createAndActivate({ name: "日常积累测试", learningMode: "常规模式" });
    renderApp(services);
    await user.click(screen.getByTestId("nav-settings"));
    const retention = screen.getByTestId("settings-retention");
    expect(retention).toHaveValue("0.95");
    await user.clear(retention);
    await user.type(retention, "0.90");
    expect(services.settings.getSpaceLearningSettings(regular.id).fsrsParameters.desiredRetention).toBe(0.95);
    expect(screen.getByRole("button", { name: "保存目标保持率" })).toBeInTheDocument();
    await user.click(screen.getByTestId("settings-retention-save"));
    expect(services.settings.getSpaceLearningSettings(regular.id).fsrsParameters.desiredRetention).toBe(0.95);
    await user.click(screen.getByTestId("confirm-retention"));
    expect(screen.getByText(/再次确认修改/)).toBeInTheDocument();
    await user.click(screen.getByTestId("confirm-retention"));
    expect(services.settings.getSpaceLearningSettings(regular.id).fsrsParameters.desiredRetention).toBe(0.9);
    expect(screen.getByTestId("settings-status")).toHaveTextContent("复习参数已保存");
  });

  it("目标保持率确认只保存复习参数，不提交普通设置草稿", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    const regular = services.spaces.createAndActivate({ name: "常规测试", learningMode: "常规模式" });
    renderApp(services);
    await user.click(screen.getByTestId("nav-settings"));
    fireEvent.change(screen.getByTestId("llm-base-url"), { target: { value: "http://invalid.example" } });
    fireEvent.change(screen.getByTestId("settings-retention"), { target: { value: "0.90" } });
    await user.click(screen.getByTestId("settings-retention-save"));
    await user.click(screen.getByTestId("confirm-retention"));
    await user.click(screen.getByTestId("confirm-retention"));
    expect(services.settings.getSpaceLearningSettings(regular.id).fsrsParameters.desiredRetention).toBe(0.9);
    expect(services.llm.configurationSnapshot().baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(screen.getByTestId("llm-base-url")).toHaveValue("http://invalid.example");
  });

  it("目标保持率超出范围时就地提示且不能进入确认", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    const regular = services.spaces.createAndActivate({ name: "常规测试", learningMode: "常规模式" });
    renderApp(services);
    await user.click(screen.getByTestId("nav-settings"));
    fireEvent.change(screen.getByTestId("settings-retention"), { target: { value: "1.10" } });
    expect(screen.getByText("目标保持率必须在 0.80 至 0.99 之间")).toBeInTheDocument();
    expect(screen.getByTestId("settings-retention-save")).toBeDisabled();
    expect(services.settings.getSpaceLearningSettings(regular.id).fsrsParameters.desiredRetention).toBe(0.95);
  });

  it("词书模式不显示复习参数卡片", async () => {
    const user = userEvent.setup();
    await openSettings(user);
    expect(screen.queryByTestId("settings-retention")).not.toBeInTheDocument();
  });
});
