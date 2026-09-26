/**
 * 录入页测试：Space 模式分流（词书首过 / 常规两步流）、智能整理如实
 * 降级、本地表单校验、保存写入与冲突三态交互（覆盖 / 本次不录入 / 取消）。
 */

import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { act, screen } from "@testing-library/react";
import { validateEntryOrganizerPayload, type EntryOrganizationResult } from "@ebbinghaus/domain";
import { renderApp } from "./helpers.tsx";
import { createTestServices } from "./helpers.tsx";
import { seedRegularDueServices } from "./seed.ts";

describe("录入页：Space 模式分流", () => {
  it("词书模式手动录入 Unit/List 后保存首过内容与不可变事件", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    expect(screen.getByTestId("firstpass-book-location")).toBeInTheDocument();
    await user.click(screen.getByTestId("firstpass-direct-manual"));
    await user.type(screen.getByTestId("firstpass-term-0"), "abandon");
    await user.type(screen.getByTestId("firstpass-def-0-0"), "放弃");
    expect(screen.getByTestId("firstpass-preview-0")).toHaveTextContent("abandon");
    expect(screen.getAllByTestId(/^firstpass-editor-panel$/)).toHaveLength(1);
    await user.click(screen.getByTestId("firstpass-save"));
    expect(screen.getByTestId("toast")).toHaveTextContent("Unit 1 · List 1 已录入 1 个词");
    expect(screen.getByTestId("firstpass-raw-input")).toHaveValue("");
    expect(screen.queryByText("录入完成")).not.toBeInTheDocument();
    const spaceId = services.getActiveSpace()?.id ?? "";
    const list = services.runtime.bookCatalogStore.listListsForSpace(spaceId)[0];
    expect(list?.listNumber).toBe(1);
    expect(services.runtime.wordContentStore.listEntriesForList(list?.listId ?? "")[0]?.originalSpelling).toBe("abandon");
    expect(services.runtime.eventStore.listAllEvents().some((event) => event.eventType === "firstPassRecorded")).toBe(true);

    // 已确认的草稿 ID 必须释放；直接开始第二批时可再次自动保存和确认。
    await user.click(screen.getByTestId("firstpass-direct-manual"));
    await user.type(screen.getByTestId("firstpass-term-0"), "retain");
    await user.type(screen.getByTestId("firstpass-def-0-0"), "保留");
    await user.click(screen.getByTestId("firstpass-save"));
    expect(services.runtime.wordContentStore.listEntriesForList(list?.listId ?? "")).toHaveLength(2);
    expect(screen.getByTestId("firstpass-raw-input")).toHaveValue("");
  });

  it("词书模式空 List 必须由用户显式勾选，保存后仍回到录入输入页", async () => {
    const user = userEvent.setup();
    const services = createTestServices();
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    await user.click(screen.getByTestId("firstpass-direct-manual"));
    expect(screen.getByTestId("firstpass-entry-list")).toHaveTextContent("还没有条目，请先填写下方表单");
    await user.click(screen.getByTestId("firstpass-confirm-empty-list"));
    await user.click(screen.getByTestId("firstpass-save"));
    expect(screen.getByTestId("firstpass-raw-input")).toHaveValue("");
    expect(screen.getByTestId("toast")).toHaveTextContent("Unit 1 · List 1 已录入 0 个词");
  });

  it("智能整理开启时第一步只有输入框与整理按钮；失败后原文保留", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices([], { spaceName: "录入空间" });
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    expect(screen.getByTestId("firstpass-raw-input")).toBeInTheDocument();
    expect(screen.queryByTestId("firstpass-save")).not.toBeInTheDocument();

    // V1 在原文为空时只给出输入提示，不会发起联网请求或误报服务不可用。
    await user.click(screen.getByTestId("firstpass-organize"));
    expect(screen.getByTestId("firstpass-organize-error")).toHaveTextContent("请先输入要整理的内容");

    await user.type(screen.getByTestId("firstpass-raw-input"), "abandon v. 放弃");
    await user.click(screen.getByTestId("firstpass-organize"));
    expect(await screen.findByTestId("firstpass-organize-error")).toBeInTheDocument();
    // 原文保留在原处（规格 6.9/11.5）。
    expect(screen.getByTestId("firstpass-raw-input")).toHaveValue("abandon v. 放弃");
    expect(screen.getByTestId("firstpass-organize-retry")).toBeInTheDocument();
    expect(screen.getByTestId("firstpass-switch-manual")).toBeInTheDocument();
  });

  it("异步整理期间可取消；旧请求晚到时不推进页面，新请求可成功进入检查", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices([], { spaceName: "录入空间" });
    const rawText = "mentor 名词 导师";
    const organized = validateEntryOrganizerPayload(rawText, {
      schema_version: "entry-organizer-v3", global_warning: null,
      entries: [{
        term: { value: "mentor", source_excerpt: "mentor" },
        meanings: [{
          part_of_speech: { value: "n.", source_excerpt: "名词" },
          definition: { value: "导师", source_excerpt: "导师" }, usage: null,
        }],
      }],
    });
    // 解析函数由异步回调赋值；用对象承载，避免 TS 把当前同步控制流里的变量缩成 null。
    const oldRequest: { resolve?: (value: EntryOrganizationResult) => void } = {};
    let calls = 0;
    services.entryOrganizer.replaceOrganizer({
      organize: async () => {
        calls += 1;
        if (calls > 1) return organized;
        return new Promise<EntryOrganizationResult>((resolve) => { oldRequest.resolve = resolve; });
      },
      cancel: () => {},
    });
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    await user.type(screen.getByTestId("firstpass-raw-input"), rawText);
    await user.click(screen.getByTestId("firstpass-organize"));
    expect(screen.getByTestId("firstpass-organizing-status")).toHaveTextContent("正在整理");
    expect(screen.getByTestId("firstpass-organize")).toHaveTextContent("取消整理");

    await user.click(screen.getByTestId("firstpass-organize"));
    expect(screen.getByTestId("firstpass-raw-input")).toHaveValue(rawText);
    expect(screen.getByTestId("firstpass-organize-error")).toHaveTextContent("已取消整理");
    await act(async () => { oldRequest.resolve?.(organized); });
    expect(screen.queryByTestId("firstpass-editor-panel")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("firstpass-organize"));
    expect(await screen.findByTestId("firstpass-preview-0")).toHaveTextContent("mentor");
  });
});

describe("录入页：常规模式手动填写与保存", () => {
  it("填写条目保存：写入内容目录与首过事件，短暂反馈后保持录入就绪", async () => {
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

    // 保存后无需经过结果页或再点击“继续录入”。
    expect(screen.getByTestId("toast")).toHaveTextContent("已录入 1 个条目。");
    expect(screen.getByTestId("firstpass-raw-input")).toHaveValue("");
    expect(screen.queryByText("录入完成")).not.toBeInTheDocument();
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
    expect(screen.getByTestId("toast")).toHaveTextContent("已录入 0 个条目");
    expect(services.runtime.wordContentStore.listEntriesForSpace(spaceId)).toHaveLength(1);

    // 态二：页面已经回到第一步，再次经降级进入表单并选择覆盖旧条目。
    await user.click(screen.getByTestId("firstpass-organize"));
    await user.click(screen.getByTestId("firstpass-switch-manual"));
    await user.type(screen.getByTestId("firstpass-term-0"), "abandon");
    await user.type(screen.getByTestId("firstpass-def-0-0"), "抛弃");
    await user.click(screen.getByTestId("firstpass-save"));
    await user.click(screen.getByTestId("conflict-overwrite-abandon"));
    expect(screen.getAllByTestId("toast").at(-1)).toHaveTextContent("已录入 1 个条目");
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

  it("第二步只编辑当前候选，切换候选不丢义项，空白新增项不阻断保存", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices([], { spaceName: "录入空间" });
    services.settings.saveFeatureFlags({ smartOrganizing: false, onlineDictionary: true });
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));

    // 空白编辑器尚未进入候选列表；填完词条与释义后才可在上方选择。
    expect(screen.getByTestId("firstpass-entry-list")).toHaveTextContent("还没有条目，请先填写下方表单");
    await user.type(screen.getByTestId("firstpass-term-0"), "abandon");
    expect(screen.queryByTestId("firstpass-preview-0")).not.toBeInTheDocument();
    await user.type(screen.getByTestId("firstpass-def-0-0"), "放弃");
    expect(screen.getByTestId("firstpass-preview-0")).toHaveTextContent("abandon");

    await user.click(screen.getByTestId("firstpass-add-entry"));
    expect(screen.getByTestId("firstpass-term-1")).toBeInTheDocument();
    expect(screen.queryByTestId("firstpass-term-0")).not.toBeInTheDocument();
    // 还没填的新条目不进入候选，也不阻止整批保存 V1 已确认的条目。
    expect(screen.queryByTestId("firstpass-preview-1")).not.toBeInTheDocument();
    await user.type(screen.getByTestId("firstpass-term-1"), "retain");
    await user.type(screen.getByTestId("firstpass-def-1-0"), "保留");
    await user.click(screen.getByTestId("firstpass-preview-0"));
    expect(screen.getByTestId("firstpass-term-0")).toHaveValue("abandon");
    await user.click(screen.getByTestId("firstpass-preview-1"));
    expect(screen.getByTestId("firstpass-term-1")).toHaveValue("retain");
    await user.click(screen.getByTestId("firstpass-add-entry"));
    await user.click(screen.getByTestId("firstpass-save"));

    const spaceId = services.getActiveSpace()?.id ?? "";
    expect(services.runtime.wordContentStore.listEntriesForSpace(spaceId)).toHaveLength(2);
    // 关闭智能整理时 V1 保存后仍回到可直接手填的空白表单。
    expect(screen.getByTestId("firstpass-entry-list")).toHaveTextContent("还没有条目，请先填写下方表单");
    expect(screen.getByTestId("firstpass-term-0")).toHaveValue("");
  });

  it("常规模式普通切页后保留未提交原文与正在编辑的条目", async () => {
    const user = userEvent.setup();
    const { services } = seedRegularDueServices([], { spaceName: "录入空间" });
    renderApp(services);
    await user.click(screen.getByTestId("nav-first-pass"));
    await user.type(screen.getByTestId("firstpass-raw-input"), "grateful 形容词 感激的");
    await user.click(screen.getByTestId("nav-today"));
    await user.click(screen.getByTestId("nav-first-pass"));
    expect(screen.getByTestId("firstpass-raw-input")).toHaveValue("grateful 形容词 感激的");

    await user.click(screen.getByTestId("firstpass-direct-manual"));
    await user.type(screen.getByTestId("firstpass-term-0"), "grateful");
    await user.type(screen.getByTestId("firstpass-def-0-0"), "感激的");
    await user.click(screen.getByTestId("nav-today"));
    await user.click(screen.getByTestId("nav-first-pass"));
    expect(screen.getByTestId("firstpass-term-0")).toHaveValue("grateful");
    expect(screen.getByTestId("firstpass-def-0-0")).toHaveValue("感激的");
    expect(screen.getByTestId("firstpass-preview-0")).toHaveTextContent("grateful");
  });
});
