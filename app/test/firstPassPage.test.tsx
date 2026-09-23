/**
 * 录入页测试：Space 模式分流（词书引导占位 / 常规两步流）、智能整理如实
 * 降级、本地表单校验、保存写入与冲突三态交互（覆盖 / 本次不录入 / 取消）。
 */

import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { renderApp } from "./helpers.tsx";
import { seedRegularDueServices } from "./seed.ts";

describe("录入页：Space 模式分流", () => {
  it("词书模式显示线下首过引导占位，不提供表单", async () => {
    renderApp();
    await userEvent.setup().click(screen.getByTestId("nav-first-pass"));
    expect(screen.getByText("词书批量录入将在后续版本提供")).toBeInTheDocument();
    expect(screen.queryByTestId("firstpass-raw-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("firstpass-save")).not.toBeInTheDocument();
  });

  it("智能整理开启时第一步只有输入框与整理按钮；失败后原文保留", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices([], { spaceName: "录入空间" });
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    expect(screen.getByTestId("firstpass-raw-input")).toBeInTheDocument();
    expect(screen.queryByTestId("firstpass-save")).not.toBeInTheDocument();

    await user.type(screen.getByTestId("firstpass-raw-input"), "abandon v. 放弃");
    await user.click(screen.getByTestId("firstpass-organize"));
    expect(screen.getByTestId("firstpass-organize-error")).toBeInTheDocument();
    // 原文保留在原处（规格 6.9/11.5）。
    expect(screen.getByTestId("firstpass-raw-input")).toHaveValue("abandon v. 放弃");
    expect(screen.getByTestId("firstpass-organize-retry")).toBeInTheDocument();
    expect(screen.getByTestId("firstpass-switch-manual")).toBeInTheDocument();
  });
});

describe("录入页：常规模式手动填写与保存", () => {
  it("填写条目保存：写入内容目录与首过事件，完成反馈按规格文案", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices([], { spaceName: "录入空间" });
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    await user.click(screen.getByTestId("firstpass-organize"));
    await user.click(screen.getByTestId("firstpass-switch-manual"));

    await user.type(screen.getByTestId("firstpass-term-0"), "abandon");
    await user.type(screen.getByTestId("firstpass-def-0-0"), "放弃");
    await user.type(screen.getByTestId("firstpass-usage-0-0"), "abandon hope");
    await user.click(screen.getByTestId("firstpass-save"));

    // 完成反馈（规格 11.5）+ toast。
    expect(screen.getByTestId("empty-state")).toHaveTextContent("已录入 1 个条目。它们会从明天开始进入测试安排。");
    // 写入断言：内容目录 + 事件。
    const spaceId = services.getActiveSpace()?.id ?? "";
    const stored = services.runtime.wordContentStore.listEntriesForSpace(spaceId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.originalSpelling).toBe("abandon");
    // 词性留空时义项文本不含词性前缀。
    expect(stored[0]?.manualMeaning).toBe("放弃");
    expect(
      services.runtime.eventStore
        .listAllEvents()
        .some((event) => event.eventType === "firstPassRecorded"),
    ).toBe(true);
  });

  it("缺少中文释义时就地提示且不写入", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices([], { spaceName: "录入空间" });
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    await user.click(screen.getByTestId("firstpass-organize"));
    await user.click(screen.getByTestId("firstpass-switch-manual"));

    await user.type(screen.getByTestId("firstpass-term-0"), "abandon");
    // 释义留空：ConfirmedEntry 校验失败，错误附着到条目卡片。
    await user.click(screen.getByTestId("firstpass-save"));
    expect(screen.getByTestId("firstpass-entry-error-0")).toBeInTheDocument();
    const spaceId = services.getActiveSpace()?.id ?? "";
    expect(services.runtime.wordContentStore.listEntriesForSpace(spaceId)).toHaveLength(0);
  });

  it("冲突三态：本次不录入保留旧条目，覆盖旧条目写入新条目", async () => {
    const user = userEvent.setup();
    // 先造一条既有条目 abandon。
    const { services } = seedRegularDueServices(["abandon"], { spaceName: "录入空间" });
    const spaceId = services.getActiveSpace()?.id ?? "";
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    await user.click(screen.getByTestId("firstpass-organize"));
    await user.click(screen.getByTestId("firstpass-switch-manual"));

    await user.type(screen.getByTestId("firstpass-term-0"), "abandon");
    await user.type(screen.getByTestId("firstpass-def-0-0"), "抛弃");
    await user.click(screen.getByTestId("firstpass-save"));

    // 冲突对话框出现（逐条独立决定）。
    const conflictRow = screen.getByTestId(/conflict-row-abandon/);
    expect(conflictRow).toHaveTextContent("已有条目：abandon");

    // 态一：本次不录入 → 旧条目保留，新批次不写入。
    await user.click(screen.getByTestId("conflict-skip-abandon"));
    expect(screen.getByTestId("empty-state")).toHaveTextContent("已录入 0 个条目");
    expect(services.runtime.wordContentStore.listEntriesForSpace(spaceId)).toHaveLength(1);

    // 态二：继续录入（回到第一步），再次经降级进入表单并选择覆盖旧条目。
    await user.click(screen.getByTestId("firstpass-continue"));
    await user.click(screen.getByTestId("firstpass-organize"));
    await user.click(screen.getByTestId("firstpass-switch-manual"));
    await user.type(screen.getByTestId("firstpass-term-0"), "abandon");
    await user.type(screen.getByTestId("firstpass-def-0-0"), "抛弃");
    await user.click(screen.getByTestId("firstpass-save"));
    await user.click(screen.getByTestId("conflict-overwrite-abandon"));
    expect(screen.getByTestId("empty-state")).toHaveTextContent("已录入 1 个条目");
    const afterOverwrite = services.runtime.wordContentStore.listEntriesForSpace(spaceId);
    expect(afterOverwrite).toHaveLength(1);
    expect(afterOverwrite[0]?.manualMeaning).toBe("抛弃");
    // 覆盖写入了不可变移除事件（审计保留）。
    expect(
      services.runtime.eventStore.listAllEvents().some((event) => event.eventType === "wordRemoved"),
    ).toBe(true);
  });

  it("冲突取消：整体返回表单且不产生任何写入", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices(["abandon"], { spaceName: "录入空间" });
    const spaceId = services.getActiveSpace()?.id ?? "";
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    await user.click(screen.getByTestId("firstpass-organize"));
    await user.click(screen.getByTestId("firstpass-switch-manual"));

    await user.type(screen.getByTestId("firstpass-term-0"), "abandon");
    await user.type(screen.getByTestId("firstpass-def-0-0"), "抛弃");
    await user.click(screen.getByTestId("firstpass-save"));
    await user.click(screen.getByTestId("conflict-cancel"));

    // 回到表单页，草稿保留，无写入。
    expect(screen.getByTestId("firstpass-save")).toBeInTheDocument();
    expect(screen.getByTestId("firstpass-term-0")).toHaveValue("abandon");
    expect(services.runtime.wordContentStore.listEntriesForSpace(spaceId)).toHaveLength(1);
    expect(
      services.runtime.eventStore
        .listAllEvents()
        .filter((event) => event.eventType === "firstPassRecorded"),
    ).toHaveLength(1); // 只有种子那一条。
  });

  it("智能整理关闭时直接进入表单（规格 11.5）", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices([], { spaceName: "录入空间" });
    services.settings.saveFeatureFlags({ smartOrganizing: false, onlineDictionary: true });
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    // 不显示第一步输入框，直接是表单。
    expect(screen.queryByTestId("firstpass-raw-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("firstpass-term-0")).toBeInTheDocument();
    expect(screen.queryByTestId("firstpass-back-to-raw")).not.toBeInTheDocument();
  });
});
