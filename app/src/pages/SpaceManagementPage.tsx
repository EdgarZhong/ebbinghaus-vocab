/**
 * Space 管理页（功能完整）。
 *
 * 交互语义严格对应界面设计规格第 2 章"已确认口径"与第 7 章：
 * - 入口在侧边栏顶部当前 Space 行的箭头（AppShell），本页在主内容区打开；
 * - 点击整行即选择 Space（不是小单选框）；当前 Space 行显示"当前使用"，
 *   不再提供重复的"选择"按钮；
 * - 选择成功后返回进入本页之前的页面、刷新内容，并显示非阻塞反馈
 *   "已切换到{名称}"；
 * - 创建表单：标题"创建 Space"、字段"名称"、主要按钮"创建并使用"；
 *   创建成功后新 Space 成为活动 Space 并返回原页面；
 * - 编辑表单：主要按钮"保存名称"，次要操作"归档 Space"，空 Space 额外提供
 *   危险操作"删除 Space"；归档与删除都有明确确认对话，错误文案直接展示
 *   用例层返回的用户可读信息（重名、归档当前 Space、最后一个 Space 等）；
 * - 归档 Space 单独折叠展示并允许恢复，恢复成功提示"已恢复“{名称}”。"。
 *
 * 学习模式选择（词书模式 / 常规模式）来自需求规格核心概念表"学习模式：Space
 * 创建时选择且之后不可修改"；规格第 7.3 节表单只画了名称字段，这里补上该
 * 必要语义，默认词书模式。
 */

import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { spaceDisplayName, type LearningMode } from "@ebbinghaus/domain";
import type { RoutePath } from "../router.tsx";
import { navigate } from "../router.tsx";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import type { SpaceSummary } from "../composition.ts";
import { useToast } from "../shell/ToastContext.tsx";
import { Modal } from "../ui/Modal.tsx";
import { PageShell } from "../ui/PageShell.tsx";

/** 学习模式选项：创建 Space 时必选，创建后不可更改（核心概念表口径）。 */
const LEARNING_MODE_OPTIONS: readonly { value: LearningMode; label: string; hint: string }[] = [
  { value: "词书模式", label: "词书模式", hint: "配合纸质词书，按 Unit 与 List 学习。" },
  { value: "常规模式", label: "常规模式", hint: "自由积累单词与短语，没有 Unit 和 List。" },
];

/** 行内元信息：归档态、条目/List 计数（行为语言，不用内部术语）。 */
function spaceMetaText(summary: SpaceSummary): string {
  if (summary.archived) {
    return "已归档";
  }
  if (summary.space.learningMode === "常规模式") {
    return summary.entryCount === 0 ? "还没有条目" : `${summary.entryCount} 个条目`;
  }
  return summary.listCount === 0 ? "还没有 List" : `${summary.listCount} 个 List`;
}

type SpaceDialogState =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly spaceId: string }
  | { readonly kind: "archive"; readonly spaceId: string }
  | { readonly kind: "delete"; readonly spaceId: string };

export function SpaceManagementPage({ returnPath }: { returnPath: RoutePath }): ReactNode {
  const services = useServices();
  const { showToast } = useToast();
  const activeSpace = useActiveSpace();

  // 版本号订阅：本页或其它用例改动 Space 数据后整体重读。
  const version = useSyncExternalStore(services.subscribeChanged, services.getVersion, services.getVersion);
  const summaries = useMemo(
    () => services.listSpaceSummaries(),
    // eslint 语义：services 与 version 都是合法依赖——version 变化意味着需要重读。
    [services, version],
  );

  const [dialog, setDialog] = useState<SpaceDialogState | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  /** 行级操作（恢复）失败时的就地错误，附着在归档区块上方。 */
  const [actionError, setActionError] = useState<string | null>(null);

  const activeSummaries = summaries.filter((summary) => !summary.archived);
  const archivedSummaries = summaries.filter((summary) => summary.archived);

  /** 选择 Space：立即切换全局上下文并返回原页面（规格第 2 章口径 5）。 */
  const selectSpace = (summary: SpaceSummary): void => {
    services.setActiveSpaceId(summary.space.id);
    showToast(`已切换到${spaceDisplayName(summary.space)}`);
    navigate(returnPath);
  };

  const restore = (summary: SpaceSummary): void => {
    try {
      services.spaces.restore({ spaceId: summary.space.id });
      services.notifyChanged();
      setActionError(null);
      showToast(`已恢复“${spaceDisplayName(summary.space)}”。`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const dialogSummary =
    dialog === null || dialog.kind === "create"
      ? null
      : services.getSpaceSummary(dialog.spaceId);

  return (
    <PageShell
      title="Space 管理"
      description="选择、创建或整理你的学习范围。当前 Space 决定所有页面的学习内容。"
      actions={
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setDialog({ kind: "create" })}
          data-testid="create-space-button"
        >
          创建 Space
        </button>
      }
    >
      <section className="card section">
        <h2 className="card-section-title">管理学习范围</h2>
        <div className="row-list" data-testid="space-list">
          {activeSummaries.map((summary) => {
            const name = spaceDisplayName(summary.space);
            const isCurrent = summary.space.id === activeSpace?.id;
            return (
              <div
                key={summary.space.id}
                className={`space-row${isCurrent ? " current" : ""}`}
                data-testid={`space-row-${name}`}
              >
                {isCurrent ? (
                  <div className="space-row-select">
                    <span className="space-row-name">{name}</span>
                    <span className="space-row-meta">
                      <span className="badge">当前使用</span>
                      <span>{spaceMetaText(summary)}</span>
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="space-row-select"
                    onClick={() => selectSpace(summary)}
                    aria-label={`切换到${name}`}
                    data-testid={`space-select-${name}`}
                  >
                    <span className="space-row-name">{name}</span>
                    <span className="space-row-meta">{spaceMetaText(summary)}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setDialog({ kind: "edit", spaceId: summary.space.id })}
                  aria-label={`编辑${name}`}
                  data-testid={`space-edit-${name}`}
                >
                  编辑
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card section">
        <button
          type="button"
          className="archived-toggle"
          aria-expanded={archivedOpen}
          onClick={() => setArchivedOpen((open) => !open)}
          data-testid="archived-section-toggle"
        >
          <span aria-hidden="true">{archivedOpen ? "▾" : "▸"}</span> 已归档（{archivedSummaries.length}）
        </button>
        {actionError === null ? null : (
          <p className="field-error" role="alert" data-testid="space-action-error">
            {actionError}
          </p>
        )}
        {archivedOpen ? (
          archivedSummaries.length === 0 ? (
            <p className="field-hint">没有已归档的 Space。</p>
          ) : (
            <div className="row-list">
              {archivedSummaries.map((summary) => {
                const name = spaceDisplayName(summary.space);
                return (
                  <div key={summary.space.id} className="space-row" data-testid={`space-row-${name}`}>
                    <div className="space-row-select">
                      <span className="space-row-name">{name}</span>
                      <span className="space-row-meta">
                        <span className="badge badge-muted">已归档</span>
                        <span>{spaceMetaText(summary)}</span>
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => restore(summary)}
                      aria-label={`恢复${name}`}
                      data-testid={`space-restore-${name}`}
                    >
                      恢复
                    </button>
                  </div>
                );
              })}
            </div>
          )
        ) : null}
      </section>

      {dialog?.kind === "create" ? (
        <CreateSpaceDialog
          returnPath={returnPath}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "edit" && dialogSummary !== null ? (
        <EditSpaceDialog
          summary={dialogSummary}
          onClose={() => setDialog(null)}
          onArchive={() => setDialog({ kind: "archive", spaceId: dialog.spaceId })}
          onDelete={() => setDialog({ kind: "delete", spaceId: dialog.spaceId })}
        />
      ) : null}
      {dialog?.kind === "archive" && dialogSummary !== null ? (
        <ConfirmArchiveDialog summary={dialogSummary} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "delete" && dialogSummary !== null ? (
        <ConfirmDeleteDialog summary={dialogSummary} onClose={() => setDialog(null)} />
      ) : null}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// 创建 Space
// ---------------------------------------------------------------------------

function CreateSpaceDialog({
  returnPath,
  onClose,
}: {
  returnPath: RoutePath;
  onClose(): void;
}): ReactNode {
  const services = useServices();
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [learningMode, setLearningMode] = useState<LearningMode>("词书模式");
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    try {
      // 用例内部原子完成"创建 + 设为活动 Space"，避免创建成功仍停留旧上下文。
      const space = services.spaces.createAndActivate({ name, learningMode });
      services.notifyChanged();
      showToast(`已创建并切换到${spaceDisplayName(space)}`);
      navigate(returnPath);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Modal title="创建 Space" onClose={onClose}>
      <div className="field">
        <label className="field-label" htmlFor="space-name-input">
          名称
        </label>
        <input
          id="space-name-input"
          className="field-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：核心词汇"
          autoFocus
          data-testid="space-name-input"
        />
        {error === null ? null : (
          <p className="field-error" role="alert" data-testid="space-name-error">
            {error}
          </p>
        )}
      </div>
      <fieldset className="mode-fieldset">
        <legend className="field-label">学习模式（创建后不可更改）</legend>
        {LEARNING_MODE_OPTIONS.map((option) => (
          <label key={option.value} className="checkbox-field">
            <input
              type="radio"
              name="learning-mode"
              value={option.value}
              checked={learningMode === option.value}
              onChange={() => setLearningMode(option.value)}
              data-testid={`space-mode-${option.value}`}
            />
            <span>
              {option.label}
              <span className="field-hint">（{option.hint}）</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-primary" onClick={submit} data-testid="space-create-submit">
          创建并使用
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 编辑 Space（重命名 + 归档/删除入口）
// ---------------------------------------------------------------------------

function EditSpaceDialog({
  summary,
  onClose,
  onArchive,
  onDelete,
}: {
  summary: SpaceSummary | null;
  onClose(): void;
  onArchive(): void;
  onDelete(): void;
}): ReactNode {
  const services = useServices();
  const [name, setName] = useState(summary === null ? "" : spaceDisplayName(summary.space));
  const [error, setError] = useState<string | null>(null);

  if (summary === null) {
    return null;
  }

  const submit = (): void => {
    try {
      services.spaces.rename({ spaceId: summary.space.id, name });
      services.notifyChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Modal title="编辑 Space" onClose={onClose}>
      <div className="field">
        <label className="field-label" htmlFor="space-rename-input">
          名称
        </label>
        <input
          id="space-rename-input"
          className="field-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          data-testid="space-rename-input"
        />
        {error === null ? null : (
          <p className="field-error" role="alert" data-testid="space-rename-error">
            {error}
          </p>
        )}
      </div>
      <div className="modal-actions">
        {/* 危险操作组靠左（规格 14.1：危险操作不得缩成难以点击的文字链接）。 */}
        <span className="modal-actions-spacer" />
        {!summary.hasLearningData ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={onDelete}
            data-testid="space-delete-button"
          >
            删除 Space
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onArchive}
          data-testid="space-archive-button"
        >
          归档 Space
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          data-testid="space-rename-submit"
        >
          保存名称
        </button>
      </div>
      {summary.hasLearningData ? (
        <p className="field-hint">这个 Space 已有学习记录，只能归档，不能删除。</p>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 归档确认
// ---------------------------------------------------------------------------

function ConfirmArchiveDialog({ summary, onClose }: { summary: SpaceSummary; onClose(): void }): ReactNode {
  const services = useServices();
  const { showToast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const spaceId = summary.space.id;
  const name = spaceDisplayName(summary.space);

  const confirm = (): void => {
    try {
      services.spaces.archive({ spaceId });
      services.notifyChanged();
      showToast(`已归档“${name}”。`);
      onClose();
    } catch (cause) {
      // 归档当前 Space / 最后一个可用 Space 的限制文案由用例给出，就地展示。
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Modal title="归档 Space" onClose={onClose}>
      <p className="modal-message">归档“{name}”？学习记录会保留，之后可以恢复。</p>
      {error === null ? null : (
        <p className="field-error" role="alert" data-testid="space-archive-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={confirm}
          data-testid="space-archive-confirm"
        >
          确认归档
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 删除确认（仅空 Space 可达）
// ---------------------------------------------------------------------------

function ConfirmDeleteDialog({ summary, onClose }: { summary: SpaceSummary; onClose(): void }): ReactNode {
  const services = useServices();
  const { showToast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const spaceId = summary.space.id;
  const name = spaceDisplayName(summary.space);

  const confirm = (): void => {
    try {
      services.spaces.deleteEmpty({ spaceId });
      services.notifyChanged();
      showToast(`已删除“${name}”。`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Modal title="删除 Space" onClose={onClose}>
      <p className="modal-message">删除“{name}”？这个 Space 为空，删除后不再保留。</p>
      {error === null ? null : (
        <p className="field-error" role="alert" data-testid="space-delete-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={confirm}
          data-testid="space-delete-confirm"
        >
          确认删除
        </button>
      </div>
    </Modal>
  );
}
