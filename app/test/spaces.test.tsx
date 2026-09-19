/**
 * Space 管理页全操作测试：首次初始化、选择与返回语义、创建、重命名、归档、
 * 恢复与空 Space 删除；错误文案逐字对应规格第 7.4 节。
 */

import { describe, expect, it } from "vitest";
import { userEvent } from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import { createTestServices, renderApp } from "./helpers.tsx";
import type { AppServices } from "../src/composition.ts";

/** 渲染 → 进入设置页 → 打开 Space 管理：验证"返回进入前页面"语义的标准路径。 */
async function openSpacesFromSettings(user: ReturnType<typeof userEvent.setup>): Promise<AppServices> {
  const services = createTestServices();
  renderApp(services);
  await user.click(screen.getByTestId("nav-settings"));
  await user.click(screen.getByTestId("space-switcher"));
  expect(screen.getByRole("heading", { level: 1, name: "Space 管理" })).toBeInTheDocument();
  return services;
}

/** Toast 会堆叠（产品语义）：断言一律针对最新一条。 */
function latestToast(): HTMLElement {
  const toasts = screen.getAllByTestId("toast");
  return toasts[toasts.length - 1]!;
}

describe("Space 管理页", () => {
  it("首次初始化创建四个默认 Space，当前为必考词", async () => {
    const user = userEvent.setup();
    await openSpacesFromSettings(user);
    const list = screen.getByTestId("space-list");
    for (const name of ["必考词", "常考词", "偶考词", "日常积累"]) {
      expect(within(list).getByTestId(`space-row-${name}`)).toBeInTheDocument();
    }
    expect(within(list).getByText("当前使用")).toBeInTheDocument();
    expect(screen.getByTestId("archived-section-toggle")).toHaveTextContent("已归档（0）");
  });

  it("点击整行选择 Space：立即切换上下文、返回进入前页面并给出非阻塞反馈", async () => {
    const user = userEvent.setup();
    await openSpacesFromSettings(user);
    await user.click(screen.getByTestId("space-select-常考词"));
    // 返回进入管理页之前的页面（设置页），侧边栏与提示同步更新。
    expect(screen.getByRole("heading", { level: 1, name: "设置" })).toBeInTheDocument();
    expect(screen.getByTestId("space-switcher")).toHaveTextContent("常考词");
    expect(latestToast()).toHaveTextContent("已切换到常考词");
  });

  it("创建 Space：成为活动 Space 并返回原页面", async () => {
    const user = userEvent.setup();
    await openSpacesFromSettings(user);
    await user.click(screen.getByTestId("create-space-button"));
    await user.type(screen.getByTestId("space-name-input"), "考研冲刺");
    await user.click(screen.getByTestId("space-create-submit"));
    expect(screen.getByRole("heading", { level: 1, name: "设置" })).toBeInTheDocument();
    expect(screen.getByTestId("space-switcher")).toHaveTextContent("考研冲刺");
    expect(latestToast()).toHaveTextContent("已创建并切换到考研冲刺");
  });

  it("创建 Space：名称为空与重名给出规格文案，不关闭表单", async () => {
    const user = userEvent.setup();
    await openSpacesFromSettings(user);
    await user.click(screen.getByTestId("create-space-button"));
    await user.click(screen.getByTestId("space-create-submit"));
    expect(screen.getByTestId("space-name-error")).toHaveTextContent("请输入 Space 名称。");

    await user.type(screen.getByTestId("space-name-input"), "必考词");
    await user.click(screen.getByTestId("space-create-submit"));
    expect(screen.getByTestId("space-name-error")).toHaveTextContent(
      "已有名为“必考词”的 Space，请换一个名称。",
    );
    // 仍在 Space 管理页（未返回原页面）。
    expect(screen.getByRole("heading", { level: 1, name: "Space 管理" })).toBeInTheDocument();
  });

  it("重命名 Space：列表立即更新", async () => {
    const user = userEvent.setup();
    await openSpacesFromSettings(user);
    await user.click(screen.getByTestId("space-edit-偶考词"));
    const input = screen.getByTestId("space-rename-input");
    await user.clear(input);
    await user.type(input, "偶考词加强");
    await user.click(screen.getByTestId("space-rename-submit"));
    expect(screen.queryByTestId(`space-row-偶考词`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`space-row-偶考词加强`)).toBeInTheDocument();
  });

  it("归档非当前 Space：进入已归档折叠区，可恢复并提示", async () => {
    const user = userEvent.setup();
    await openSpacesFromSettings(user);
    await user.click(screen.getByTestId("space-edit-偶考词"));
    await user.click(screen.getByTestId("space-archive-button"));
    expect(screen.getByText("归档“偶考词”？学习记录会保留，之后可以恢复。")).toBeInTheDocument();
    await user.click(screen.getByTestId("space-archive-confirm"));

    expect(screen.queryByTestId("space-row-偶考词")).not.toBeInTheDocument();
    expect(latestToast()).toHaveTextContent("已归档“偶考词”。");

    await user.click(screen.getByTestId("archived-section-toggle"));
    expect(screen.getByTestId("archived-section-toggle")).toHaveTextContent("已归档（1）");
    await user.click(screen.getByTestId("space-restore-偶考词"));
    expect(await screen.findByTestId("space-row-偶考词")).toBeInTheDocument();
    expect(latestToast()).toHaveTextContent("已恢复“偶考词”。");
  });

  it("归档当前 Space 被用例拒绝，展示规格文案", async () => {
    const user = userEvent.setup();
    await openSpacesFromSettings(user);
    await user.click(screen.getByTestId("space-edit-必考词"));
    await user.click(screen.getByTestId("space-archive-button"));
    await user.click(screen.getByTestId("space-archive-confirm"));
    expect(screen.getByTestId("space-archive-error")).toHaveTextContent(
      "请先切换到另一个 Space，再归档“必考词”。",
    );
  });

  it("空 Space 可删除：确认后从列表移除", async () => {
    const user = userEvent.setup();
    await openSpacesFromSettings(user);
    // 创建"临时空间"（自动成为活动），随后切回必考词，使临时空间变为非当前。
    await user.click(screen.getByTestId("create-space-button"));
    await user.type(screen.getByTestId("space-name-input"), "临时空间");
    await user.click(screen.getByTestId("space-create-submit"));
    await user.click(screen.getByTestId("space-switcher"));
    await user.click(screen.getByTestId("space-select-必考词"));
    expect(latestToast()).toHaveTextContent("已切换到必考词");
    // 规格 2.5：切换后返回进入管理页之前的页面（设置页）；重新经箭头进入管理页继续操作。
    await user.click(screen.getByTestId("space-switcher"));

    await user.click(screen.getByTestId("space-edit-临时空间"));
    expect(screen.getByTestId("space-delete-button")).toBeInTheDocument();
    await user.click(screen.getByTestId("space-delete-button"));
    expect(screen.getByText("删除“临时空间”？这个 Space 为空，删除后不再保留。")).toBeInTheDocument();
    await user.click(screen.getByTestId("space-delete-confirm"));
    expect(screen.queryByTestId("space-row-临时空间")).not.toBeInTheDocument();
    expect(latestToast()).toHaveTextContent("已删除“临时空间”。");
  });

  it("非空 Space 不提供删除入口，并解释只能归档", async () => {
    const user = userEvent.setup();
    const services = await openSpacesFromSettings(user);
    // 给"常考词"登记一个 List（内容目录谓词判定为有学习数据）。
    services.runtime.bookCatalogStore.addList({
      listId: "list-constant-1",
      spaceId: "a1f0c3d4-0000-4000-8000-000000000002",
      unitId: "unit-constant-1",
      unitNumber: 1,
      listNumber: 1,
    });
    services.notifyChanged();

    await user.click(screen.getByTestId("space-edit-常考词"));
    expect(screen.queryByTestId("space-delete-button")).not.toBeInTheDocument();
    expect(screen.getByText("这个 Space 已有学习记录，只能归档，不能删除。")).toBeInTheDocument();
  });

  it("重命名冲突展示规格文案且不关闭表单", async () => {
    const user = userEvent.setup();
    await openSpacesFromSettings(user);
    await user.click(screen.getByTestId("space-edit-偶考词"));
    const input = screen.getByTestId("space-rename-input");
    await user.clear(input);
    await user.type(input, "必考词");
    await user.click(screen.getByTestId("space-rename-submit"));
    expect(screen.getByTestId("space-rename-error")).toHaveTextContent(
      "已有名为“必考词”的 Space，请换一个名称。",
    );
  });

  it("归档最后一个可用 Space 被拒绝（最后一个可用必为当前 Space，命中先切换守卫）", async () => {
    const user = userEvent.setup();
    const services = await openSpacesFromSettings(user);
    // 直接归档另外三个，只剩"必考词"可用——它同时必是活动 Space。
    for (const name of ["常考词", "偶考词", "日常积累"]) {
      const spaceId =
        services
          .listSpaceSummaries()
          .find((item) => (item.space.name ?? item.space.kind) === name)?.space.id ?? "";
      services.spaces.archive({ spaceId });
    }
    services.notifyChanged();
    await user.click(screen.getByTestId("space-edit-必考词"));
    await user.click(screen.getByTestId("space-archive-button"));
    await user.click(screen.getByTestId("space-archive-confirm"));
    // "至少保留一个可用的 Space。"是档案守卫的纵深防御（最后一个可用必是活动，
    // 先命中"请先切换"）；界面用户可见的拒绝路径即本文案。
    expect(screen.getByTestId("space-archive-error")).toHaveTextContent(
      "请先切换到另一个 Space，再归档“必考词”。",
    );
  });
});
