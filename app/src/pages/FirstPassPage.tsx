/**
 * 首过录入页（功能完整）：Space 模式分流。
 *
 * - 词书模式：规格口径是"首过在线下书完成，软件只接收结果"；词书批量录入属于
 *   后续阶段，本页如实显示引导占位，不提供看似可用实则缺失的表单，文案不误导。
 * - 常规模式（规格 11.5 两步任务流"输入 → 检查并保存"）：
 *   第一步只有一个大文本框与"智能整理并检查"主要操作；整理调用经应用层
 *   EntryOrganizerService，浏览器模式未装配整理端口时按规格 6.9 如实降级——
 *   显示失败提示并提供"重试"与"改为手动填写"，原文保留在原处。
 *   第二步是独立的填写/编辑表单页：条目卡片（词条 + 义项 + 用法）、新增义项、
 *   从本次录入移除、添加条目，唯一主要操作是底部"保存本次录入"。
 * - 保存走 RegularLearningService.recordEntries：Space 内不允许重复录入，与既有
 *   条目冲突时弹出冲突处理对话框，逐条独立选择"覆盖旧条目 / 本次不录入"，
 *   取消则整体返回表单且不产生任何写入（三态交互，规格 6.8）。
 * - 保存成功显示"已录入 {N} 个条目。它们会从明天开始进入测试安排。"
 */

import { useCallback, useState, type ReactNode } from "react";
import {
  ConfirmedEntry,
  SpaceEntryConflictError,
  type ConflictingWord,
  type WordConflictResolution,
} from "@ebbinghaus/application";
import { FORMAL_PARTS_OF_SPEECH, type PartOfSpeech, type StructuredMeaning } from "@ebbinghaus/domain";
import { navigate, routes } from "../router.tsx";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { useToast } from "../shell/ToastContext.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Modal } from "../ui/Modal.tsx";
import { PageShell } from "../ui/PageShell.tsx";

/** 智能整理失败后的降级说明（规格 11.4/11.5 文案组合，不暴露内部原因）。 */
const ORGANIZE_UNAVAILABLE = "智能整理暂时不可用。你的输入已经保留，可以重试或使用本地整理。";

/** 表单草稿中的一个义项（词性空串=未表达词性）。 */
interface DraftMeaning {
  readonly key: number;
  partOfSpeech: PartOfSpeech | "";
  definition: string;
  usage: string;
}

/** 表单草稿中的一个条目。 */
interface DraftEntry {
  readonly key: number;
  term: string;
  meanings: DraftMeaning[];
  /** 本条目的本地校验错误（附着到卡片，不建全局日志区）。 */
  error: string | null;
}

/** 冲突对话框状态：待决定冲突 + 已决定的项（逐条累计，全部决定后自动重试保存）。 */
interface ConflictState {
  readonly conflicts: readonly ConflictingWord[];
  readonly built: ConfirmedEntry[];
  readonly decided: readonly WordConflictResolution[];
}

let draftKeySeq = 1;
function nextDraftKey(): number {
  draftKeySeq += 1;
  return draftKeySeq;
}

/** 新建一个空白义项草稿。 */
function emptyMeaning(): DraftMeaning {
  return { key: nextDraftKey(), partOfSpeech: "", definition: "", usage: "" };
}

/** 新建一个空白条目草稿（自动带一条空义项）。 */
function emptyEntry(): DraftEntry {
  return { key: nextDraftKey(), term: "", meanings: [emptyMeaning()], error: null };
}

/**
 * 把表单草稿构造成应用层确认条目（纯函数）：校验失败时把错误逐条定位回卡片
 * （nextEntries 携带 error 字段），返回 built=null 表示有错误、不得写入。
 * 不触碰任何 state——状态回写由调用方（saveEntries）完成，便于测试推演与复査。
 */
function buildConfirmedEntries(
  drafts: readonly DraftEntry[],
): { nextEntries: DraftEntry[]; built: ConfirmedEntry[] | null } {
  const built: ConfirmedEntry[] = [];
  let hasError = false;
  const nextEntries = drafts.map((entry) => {
    try {
      const meanings: StructuredMeaning[] = entry.meanings
        .filter((meaning) => meaning.definition.trim().length > 0 || meaning.partOfSpeech !== "")
        .map((meaning) => ({
          partOfSpeech: meaning.partOfSpeech === "" ? null : meaning.partOfSpeech,
          definition: meaning.definition.trim(),
          usage: meaning.usage.trim() === "" ? null : meaning.usage.trim(),
        }));
      built.push(new ConfirmedEntry(entry.term.trim(), meanings));
      return { ...entry, error: null };
    } catch (cause) {
      hasError = true;
      return { ...entry, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });
  return { nextEntries, built: hasError ? null : built };
}

export function FirstPassPage(): ReactNode {
  const services = useServices();
  const activeSpace = useActiveSpace();
  const { showToast } = useToast();

  const isRegularMode = activeSpace?.learningMode === "常规模式";
  const smartOrganizingEnabled = services.settings.getFeatureFlags().smartOrganizing;

  // ---- 批次草稿状态：保存成功后清空当前批次；切换 Space 时整页重挂载自然丢弃。 ----
  const [step, setStep] = useState<"input" | "form" | "done">(
    isRegularMode && !smartOrganizingEnabled ? "form" : "input",
  );
  const [rawText, setRawText] = useState("");
  const [organizeError, setOrganizeError] = useState<string | null>(null);
  const [entries, setEntries] = useState<DraftEntry[]>(() => [emptyEntry()]);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);

  if (activeSpace === null) {
    return (
      <PageShell title="首过录入" description="录入新学 List 的重点词。">
        <EmptyState title="还没有选择 Space" description="从侧边栏顶部选择一个 Space，再回到这里录入。" />
      </PageShell>
    );
  }

  if (!isRegularMode) {
    // 词书模式：词书批量录入属后续阶段，如实引导，不误导（任务口径）。
    return (
      <PageShell title="首过录入" description="首过在纸质词书上完成。">
        <EmptyState
          title="首过在线下书完成，软件只接收结果"
          description="先在纸质词书里学习新的 List，软件负责记录学习结果。批量录入将在后续更新中提供，现在可以先完成测试和复习任务。"
          action={
            <button type="button" className="btn btn-primary" onClick={() => navigate(routes.today)}>
              返回今日
            </button>
          }
        />
      </PageShell>
    );
  }

  const spaceId = activeSpace.id;

  /** 第一步：调用应用层智能整理用例；端口未装配时按规格降级为本地手动填写。 */
  const organize = (): void => {
    setOrganizeError(null);
    try {
      services.entryOrganizer.organize(rawText);
      // 浏览器模式没有可用的整理端口，成功路径不可达；真实整理适配器接线后
      // 在此处把整理结果映射为表单草稿再进入第二步。
      setOrganizeError(ORGANIZE_UNAVAILABLE);
    } catch {
      // 统一按"整理不可用"呈现：不区分未配置/网络/解析错误，不给内部原因上屏。
      setOrganizeError(ORGANIZE_UNAVAILABLE);
    }
  };

  /** 降级入口：改为手动填写，直接进入表单并保留一个空白条目。 */
  const switchToManual = (): void => {
    setOrganizeError(null);
    setEntries([emptyEntry()]);
    setStep("form");
  };

  // ---- 草稿编辑回调（rerender-functional-setstate：一律函数式更新，不读闭包旧值） ----
  // useCallback 空依赖 ⇒ 引用恒定，传给条目卡片不会因父级重渲染造成无效 diff。
  const updateEntry = useCallback((entryKey: number, updater: (entry: DraftEntry) => DraftEntry): void => {
    setEntries((current) => current.map((item) => (item.key === entryKey ? updater(item) : item)));
  }, []);

  const removeEntry = useCallback((entryKey: number): void => {
    setEntries((current) => current.filter((item) => item.key !== entryKey));
  }, []);

  const addEntry = useCallback((): void => {
    setEntries((current) => [...current, emptyEntry()]);
  }, []);

  /** 第二步：保存本次录入（可携带冲突决定），成功后进入完成反馈。 */
  const saveEntries = (resolutions?: readonly WordConflictResolution[]): void => {
    setSaveError(null);
    const { nextEntries, built } = buildConfirmedEntries(entries);
    // 校验结果（含逐条错误）回写表单；有错误时停在本步，不产生任何写入。
    setEntries(nextEntries);
    if (built === null) {
      return;
    }
    try {
      const created = services.regularLearning.recordEntries({
        spaceId,
        entries: built,
        conflictResolutions: resolutions,
      });
      services.notifyChanged();
      showToast(`已录入 ${created.length} 个条目。`);
      setSavedCount(created.length);
      setEntries([emptyEntry()]);
      setRawText("");
      setConflict(null);
      setStep("done");
    } catch (cause) {
      if (cause instanceof SpaceEntryConflictError) {
        // Space 内不允许重复录入：进入三态冲突处理（覆盖 / 本次不录入 / 取消）。
        setConflict({ conflicts: cause.conflicts, built, decided: [] });
        return;
      }
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** 冲突行决定：覆盖=软移除旧条目后录入新条目；不录入=保留旧条目跳过本次。 */
  const resolveConflict = (normalizedKey: string, removeExisting: boolean): void => {
    if (conflict === null) {
      return;
    }
    const decided = [...conflict.decided, { normalizedKey, removeExisting }];
    const remaining = conflict.conflicts.filter((item) => item.normalizedKey !== normalizedKey);
    if (remaining.length === 0) {
      // 全部冲突已决定：携带完整决定重试保存（用例要求覆盖全部冲突后才写入）。
      saveEntries(decided);
    } else {
      setConflict({ ...conflict, decided });
    }
  };

  if (step === "input") {
    return (
      <PageShell title="录入条目" description="第一步输入，第二步检查并保存。">
        <section className="card section" data-testid="firstpass-input-step">
          <h2 className="card-section-title">任意粘贴或输入</h2>
          <p className="field-hint">任意输入或语音转写单词的词性释义与用法，大模型将为你整理词条</p>
          <textarea
            className="field-input firstpass-textarea"
            value={rawText}
            onChange={(event) => {
              setRawText(event.target.value);
              setOrganizeError(null);
            }}
            aria-label="录入内容"
            data-testid="firstpass-raw-input"
          />
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={organize} data-testid="firstpass-organize">
              智能整理并检查
            </button>
          </div>
          {organizeError === null ? null : (
            <>
              <p className="field-error" role="alert" data-testid="firstpass-organize-error">
                {organizeError}
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={organize}
                  data-testid="firstpass-organize-retry"
                >
                  重试
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={switchToManual}
                  data-testid="firstpass-switch-manual"
                >
                  改为手动填写
                </button>
              </div>
            </>
          )}
        </section>
      </PageShell>
    );
  }

  if (step === "done") {
    return (
      <PageShell title="录入条目">
        <EmptyState
          title="录入完成"
          description={`已录入 ${savedCount} 个条目。它们会从明天开始进入测试安排。`}
          action={
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep(smartOrganizingEnabled ? "input" : "form")}
                data-testid="firstpass-continue"
              >
                继续录入
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => navigate(routes.today)}
                data-testid="firstpass-back-today"
              >
                返回今日
              </button>
            </>
          }
        />
      </PageShell>
    );
  }

  // ---- 第二步：填写/编辑表单 ----
  return (
    <PageShell title="录入条目" description="第二步检查并保存。">
      <p className="firstpass-steps" data-testid="firstpass-step-label">
        2 检查并保存 · {entries.length} 个条目
      </p>
      {smartOrganizingEnabled ? (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setStep("input")}
          data-testid="firstpass-back-to-raw"
        >
          返回修改原文
        </button>
      ) : null}
      <div className="firstpass-entry-list" data-testid="firstpass-entry-list">
        {entries.length === 0 ? <p className="field-hint">还没有条目。点击"添加条目"开始填写。</p> : null}
        {entries.map((entry, entryIndex) => (
          <EntryCard
            key={entry.key}
            entry={entry}
            entryIndex={entryIndex}
            onUpdateEntry={updateEntry}
            onRemoveEntry={removeEntry}
          />
        ))}
      </div>
      <div className="modal-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={addEntry}
          data-testid="firstpass-add-entry"
        >
          + 添加条目
        </button>
      </div>
      {saveError === null ? null : (
        <p className="field-error" role="alert" data-testid="firstpass-save-error">
          {saveError}
        </p>
      )}
      <div className="firstpass-save-bar">
        <button type="button" className="btn btn-primary" onClick={() => saveEntries()} data-testid="firstpass-save">
          保存本次录入
        </button>
      </div>
      {conflict === null ? null : (
        <Modal title="处理重复条目" onClose={() => setConflict(null)}>
          <p className="modal-message">以下条目与这个 Space 已有条目重复，请逐条选择处理方式。</p>
          <div className="row-list">
            {conflict.conflicts.map((item) => (
              <div
                className="conflict-row"
                key={item.normalizedKey}
                data-testid={`conflict-row-${item.normalizedKey}`}
              >
                <span className="task-row-title">{item.incomingSpelling}</span>
                <span className="task-row-meta">已有条目：{item.existingSpelling}</span>
                <div className="task-row-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => resolveConflict(item.normalizedKey, true)}
                    data-testid={`conflict-overwrite-${item.normalizedKey}`}
                  >
                    覆盖旧条目
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => resolveConflict(item.normalizedKey, false)}
                    data-testid={`conflict-skip-${item.normalizedKey}`}
                  >
                    本次不录入
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConflict(null)}
              data-testid="conflict-cancel"
            >
              取消，返回表单
            </button>
          </div>
        </Modal>
      )}
    </PageShell>
  );
}


// ---------------------------------------------------------------------------
// 条目卡片与义项行（第二步表单）
//
// 提取为模块级组件的理由（rerender-no-inline-components 的反面应用）：原实现把
// 整卡 JSX 内联在 entries.map 里，每条义项的更新都要在三层嵌套 map 闭包里定位
// entry.key + meaning.key，可读性差且每个字段都重复同一段"找到并替换"逻辑。
// 提取后更新语义收口在 onUpdateEntry 的函数式 updater 中；组件不在渲染期定义，
// 不会因父组件重渲染而卸载重建（草稿焦点得以保留）。
// ---------------------------------------------------------------------------

interface EntryCardProps {
  readonly entry: DraftEntry;
  /** 展示序号（仅用于 testid 与 label 关联，与草稿 key 解耦）。 */
  readonly entryIndex: number;
  /** 函数式更新指定条目（FirstPassPage 中 useCallback 固定引用）。 */
  readonly onUpdateEntry: (entryKey: number, updater: (entry: DraftEntry) => DraftEntry) => void;
  readonly onRemoveEntry: (entryKey: number) => void;
}

function EntryCard({ entry, entryIndex, onUpdateEntry, onRemoveEntry }: EntryCardProps): ReactNode {
  /** 本条目的函数式更新快捷入口。 */
  const update = (updater: (entry: DraftEntry) => DraftEntry): void => {
    onUpdateEntry(entry.key, updater);
  };
  return (
    <div className="card entry-card" data-testid={`firstpass-entry-${entryIndex}`}>
      <div className="entry-card-header">
        <label className="field-label" htmlFor={`firstpass-term-${entryIndex}`}>
          英文单词或短语
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onRemoveEntry(entry.key)}
          data-testid={`firstpass-remove-${entryIndex}`}
        >
          从本次录入移除
        </button>
      </div>
      <input
        id={`firstpass-term-${entryIndex}`}
        className="field-input"
        value={entry.term}
        onChange={(event) => update((item) => ({ ...item, term: event.target.value, error: null }))}
        data-testid={`firstpass-term-${entryIndex}`}
      />
      {entry.error === null ? null : (
        <p className="field-error" role="alert" data-testid={`firstpass-entry-error-${entryIndex}`}>
          {entry.error}
        </p>
      )}
      {entry.meanings.map((meaning, meaningIndex) => (
        <MeaningRow
          key={meaning.key}
          entryKey={entry.key}
          entryIndex={entryIndex}
          meaning={meaning}
          meaningIndex={meaningIndex}
          allowRemove={entry.meanings.length > 1}
          onUpdateEntry={onUpdateEntry}
        />
      ))}
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => update((item) => ({ ...item, meanings: [...item.meanings, emptyMeaning()] }))}
        data-testid={`firstpass-add-meaning-${entryIndex}`}
      >
        新增义项
      </button>
    </div>
  );
}

interface MeaningRowProps {
  readonly entryKey: number;
  readonly entryIndex: number;
  readonly meaning: DraftMeaning;
  readonly meaningIndex: number;
  /** 最后一条义项不允许删除（条目至少保留一条义项表达位）。 */
  readonly allowRemove: boolean;
  readonly onUpdateEntry: (entryKey: number, updater: (entry: DraftEntry) => DraftEntry) => void;
}

function MeaningRow({
  entryKey,
  entryIndex,
  meaning,
  meaningIndex,
  allowRemove,
  onUpdateEntry,
}: MeaningRowProps): ReactNode {
  /** 义项字段更新：经条目的函数式 updater 只替换目标义项，其余义项原样保留。 */
  const updateMeaning = (updater: (meaning: DraftMeaning) => DraftMeaning): void => {
    onUpdateEntry(entryKey, (item) => ({
      ...item,
      meanings: item.meanings.map((itemMeaning) =>
        itemMeaning.key === meaning.key ? updater(itemMeaning) : itemMeaning,
      ),
    }));
  };
  return (
    <div className="meaning-row">
      <select
        className="field-input meaning-pos"
        value={meaning.partOfSpeech}
        aria-label={`第 ${meaningIndex + 1} 条义项词性`}
        onChange={(event) =>
          updateMeaning((itemMeaning) => ({ ...itemMeaning, partOfSpeech: event.target.value as PartOfSpeech | "" }))
        }
        data-testid={`firstpass-pos-${entryIndex}-${meaningIndex}`}
      >
        <option value="">（无词性）</option>
        {FORMAL_PARTS_OF_SPEECH.map((pos) => (
          <option key={pos} value={pos}>
            {pos}
          </option>
        ))}
      </select>
      <input
        className="field-input meaning-definition"
        value={meaning.definition}
        placeholder="中文释义"
        aria-label={`第 ${meaningIndex + 1} 条义项释义`}
        onChange={(event) => updateMeaning((itemMeaning) => ({ ...itemMeaning, definition: event.target.value }))}
        data-testid={`firstpass-def-${entryIndex}-${meaningIndex}`}
      />
      <input
        className="field-input meaning-usage"
        value={meaning.usage}
        placeholder="例句/用法（可选）"
        aria-label={`第 ${meaningIndex + 1} 条义项用法`}
        onChange={(event) => updateMeaning((itemMeaning) => ({ ...itemMeaning, usage: event.target.value }))}
        data-testid={`firstpass-usage-${entryIndex}-${meaningIndex}`}
      />
      {allowRemove ? (
        <button
          type="button"
          className="btn btn-secondary"
          aria-label={`删除第 ${meaningIndex + 1} 条义项`}
          onClick={() =>
            onUpdateEntry(entryKey, (item) => ({
              ...item,
              meanings: item.meanings.filter((itemMeaning) => itemMeaning.key !== meaning.key),
            }))
          }
          data-testid={`firstpass-remove-meaning-${entryIndex}-${meaningIndex}`}
        >
          删除义项
        </button>
      ) : null}
    </div>
  );
}
