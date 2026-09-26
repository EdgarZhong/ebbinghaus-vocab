/**
 * 录入页（功能完整）：Space 模式分流。页面正式名称"录入"（V1 已验证口径：
 * 词书模式录入词汇、常规模式录入条目，共用同一入口）；"首过"是线下学习动作
 * 的概念名，不是页面名。内部标识符（FirstPassPage/routes.firstPass/nav-first-pass）
 * 保留首轮命名，属遗留标识，不影响用户可见面。
 *
 * - 词书模式：首过在纸质词书上完成，软件只接收结果；Unit/List 位置只用于保存，
 *   智能整理请求仍只含原始转写，不上传书中位置或学习历史。
 * - 常规模式（规格 11.5 两步任务流"输入 → 检查并保存"）：
 *   第一步只有一个大文本框与"智能整理并检查"主要操作；整理调用经应用层
 *   EntryOrganizerService，浏览器模式未装配整理端口时按规格 6.9 如实降级——
 *   显示失败提示并提供"重试"与"改为手动填写"，原文保留在原处。
 *   第二步上方是候选摘要列表，下方只编辑当前选中的一个条目；字段变化同步回
 *   候选列表，底部固定整批保存。这与 V1 的实际录入页阅读顺序一致。
 * - 保存走 RegularLearningService.recordEntries：Space 内不允许重复录入，与既有
 *   条目冲突时弹出冲突处理对话框，逐条独立选择"覆盖旧条目 / 本次不录入"，
 *   取消则整体返回表单且不产生任何写入（三态交互，规格 6.8）。
 * - 保存成功后留在录入页并显示短暂反馈，立即可以开始下一批录入。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ConfirmedEntry,
  BookEntryConflictError,
  SpaceEntryConflictError,
  type ConflictingWord,
  type WordConflictResolution,
} from "@ebbinghaus/application";
import { FORMAL_PARTS_OF_SPEECH, type PartOfSpeech, type StructuredMeaning } from "@ebbinghaus/domain";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { useToast } from "../shell/ToastContext.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Modal } from "../ui/Modal.tsx";
import { PageShell } from "../ui/PageShell.tsx";

/** 智能整理失败后的降级说明（规格 11.4/11.5 文案组合，不暴露内部原因）。 */
const ORGANIZE_UNAVAILABLE = "智能整理暂时不可用。你的输入已经保留，可以重试或改为手动填写。";

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
  /** 模型证据树的订正与补全警告必须随候选进入可编辑预览。 */
  warnings?: readonly string[];
}

/** 冲突对话框状态：待决定冲突 + 已决定的项（逐条累计，全部决定后自动重试保存）。 */
interface ConflictState {
  readonly conflicts: readonly ConflictingWord[];
  readonly built: ConfirmedEntry[];
  readonly decided: readonly WordConflictResolution[];
}

/**
 * 常规模式没有词书草稿仓储，V1 在普通导航中却保留未提交批次。缓存以组合根实例
 * 与活动 Space 为边界，只服务页面卸载后重新挂载；应用重启不承诺恢复常规临时表单。
 */
interface RegularBatchSnapshot {
  readonly spaceId: string;
  readonly step: "input" | "form";
  readonly rawText: string;
  readonly entries: DraftEntry[];
  readonly selectedEntryKey: number | null;
  readonly organizationWarning: string | null;
  readonly organizeError: string | null;
}

const regularBatchCache = new WeakMap<object, RegularBatchSnapshot>();

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

/** V1 的空白编辑器不算候选；已有有效条目时也不让未填写的新条目阻断整批保存。 */
function entryIsBlank(entry: DraftEntry): boolean {
  return entry.term.trim() === "" && entry.meanings.every((meaning) =>
    meaning.partOfSpeech === "" && meaning.definition.trim() === "" && meaning.usage.trim() === "");
}

/** V1 的总览只收录至少有拼写和一条释义的条目；未完成的当前编辑仍留在下方。 */
function entryIsCandidate(entry: DraftEntry): boolean {
  return entry.term.trim() !== "" && entry.meanings.some((meaning) => meaning.definition.trim() !== "");
}

/** 草稿候选属于持久数据，旧版本结构无效时回到空表单并保留原始转写。 */
function restoredEntries(raw: string | null | undefined): DraftEntry[] {
  if (raw === null || raw === undefined) return [emptyEntry()];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [emptyEntry()];
    const valid = parsed.every((entry) =>
      entry !== null && typeof entry === "object" &&
      typeof entry.term === "string" && Array.isArray(entry.meanings));
    return valid ? parsed as DraftEntry[] : [emptyEntry()];
  } catch {
    return [emptyEntry()];
  }
}

/**
 * 把表单草稿构造成应用层确认条目（纯函数）：校验失败时把错误逐条定位回卡片
 * （nextEntries 携带 error 字段），返回 built=null 表示有错误、不得写入。
 * 不触碰任何 state——状态回写由调用方（saveEntries）完成，便于测试推演与复査。
 */
function buildConfirmedEntries(
  drafts: readonly DraftEntry[],
  allowEmptyList: boolean,
): { nextEntries: DraftEntry[]; built: ConfirmedEntry[] | null } {
  const built: ConfirmedEntry[] = [];
  let hasError = false;
  const nonblankCount = drafts.filter((entry) => !entryIsBlank(entry)).length;
  const nextEntries = drafts.map((entry) => {
    // V1 中「添加条目」先打开空白编辑器，只有填写有效后才加入候选；
    // 因此尾部全空编辑器不会成为一个待保存的条目。空批次仍需显式确认。
    if (entryIsBlank(entry) && (nonblankCount > 0 || allowEmptyList)) {
      return { ...entry, error: null };
    }
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
  const existingBookDraft = !isRegularMode && activeSpace !== null
    ? services.bookDrafts.listOpenDrafts(activeSpace.id)[0] ?? null : null;
  const cachedRegularBatch = isRegularMode && activeSpace !== null
    ? regularBatchCache.get(services) : null;
  const regularBatch = cachedRegularBatch?.spaceId === activeSpace?.id ? cachedRegularBatch : null;
  const draftId = useRef<string | null>(existingBookDraft?.id ?? null);
  // 代数防护与 V1 工作线程语义相同：取消或离页后，旧请求的晚到结果不再更新页面。
  const organizeGeneration = useRef(0);

  // ---- 批次草稿状态：保存成功后清空；普通导航恢复同 Space 的未提交内容。 ----
  const [step, setStep] = useState<"input" | "form">(
    regularBatch?.step ?? (existingBookDraft?.candidatesJson !== null && existingBookDraft?.candidatesJson !== undefined
      ? "form" : !smartOrganizingEnabled ? "form" : "input")
  );
  const [unitNumber, setUnitNumber] = useState(String(existingBookDraft?.unitNumber ?? 1));
  const [listNumber, setListNumber] = useState(String(existingBookDraft?.listNumber ?? 1));
  const [confirmEmptyList, setConfirmEmptyList] = useState(false);
  const [organizationWarning, setOrganizationWarning] = useState<string | null>(regularBatch?.organizationWarning ?? null);
  const [rawText, setRawText] = useState(regularBatch?.rawText ?? existingBookDraft?.rawText ?? "");
  const [organizeError, setOrganizeError] = useState<string | null>(regularBatch?.organizeError ?? null);
  const [organizing, setOrganizing] = useState(false);
  const [entries, setEntries] = useState<DraftEntry[]>(() => regularBatch?.entries ?? restoredEntries(existingBookDraft?.candidatesJson));
  const [selectedEntryKey, setSelectedEntryKey] = useState<number | null>(regularBatch?.selectedEntryKey ?? entries[0]?.key ?? null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => () => {
    organizeGeneration.current += 1;
    services.entryOrganizer.cancel();
  }, [services]);
  useEffect(() => {
    if (!isRegularMode || activeSpace === null) return;
    // 页面普通导航会卸载 React 组件。保留未提交输入与编辑位置，回到录入时继续原批次；
    // 若活动 Space 已变化，挂载时不会命中旧快照，避免把旧内容写到新 Space。
    regularBatchCache.set(services, {
      spaceId: activeSpace.id, step, rawText, entries, selectedEntryKey,
      organizationWarning, organizeError,
    });
  }, [activeSpace, entries, isRegularMode, organizationWarning, organizeError, rawText, selectedEntryKey, services, step]);
  useEffect(() => {
    if (isRegularMode || activeSpace === null) return;
    // 未开始输入时不生成空草稿；一旦有内容，原文和可编辑预览均随页面状态保存。
    const hasEntry = entries.some((entry) => entry.term.trim() !== "" ||
      entry.meanings.some((meaning) => meaning.definition.trim() !== ""));
    if (rawText.trim() === "" && !hasEntry && draftId.current === null) return;
    const unit = Number(unitNumber);
    const list = Number(listNumber);
    if (!Number.isSafeInteger(unit) || unit < 1 || !Number.isSafeInteger(list) || list < 1) return;
    const saved = services.bookDrafts.saveDraft({
      id: draftId.current, spaceId: activeSpace.id,
      unitNumber: unit, listNumber: list, rawText,
      useLanguageModel: smartOrganizingEnabled,
      status: organizeError === null ? step === "form" && rawText.trim() !== "" ? "已解析" : "草稿" : "解析失败",
      lastError: organizeError,
      candidatesJson: step === "form" ? JSON.stringify(entries) : null,
      auditJson: null,
      unresolvedDescription: organizationWarning,
    });
    draftId.current = saved.id;
  }, [activeSpace, entries, isRegularMode, listNumber, organizeError, organizationWarning, rawText, services, smartOrganizingEnabled, step, unitNumber]);

  if (activeSpace === null) {
    // 尚未选择 Space 时模式未知，标题用统一入口名"录入"（对齐 V1 导航口径）。
    return (
      <PageShell title="录入" description="录入词汇或日常积累条目。">
        <EmptyState title="还没有选择 Space" description="从侧边栏顶部选择一个 Space，再回到这里录入。" />
      </PageShell>
    );
  }

  const spaceId = activeSpace.id;
  const previewEntries = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entryIsCandidate(entry));
  const selectedEntryIndex = entries.findIndex((entry) => entry.key === selectedEntryKey);
  const selectedEntry = selectedEntryIndex >= 0 ? entries[selectedEntryIndex] ?? null : null;

  /** 第一步：调用应用层智能整理用例；端口未装配时按规格降级为本地手动填写。 */
  const organize = async (): Promise<void> => {
    setOrganizeError(null);
    if (rawText.trim() === "") {
      setOrganizeError("请先输入要整理的内容");
      return;
    }
    const generation = ++organizeGeneration.current;
    setOrganizing(true);
    services.entryOrganizer.prepareCancellation();
    try {
      const result = await services.entryOrganizer.organize(rawText);
      if (generation !== organizeGeneration.current) return;
      const candidates: DraftEntry[] = result.candidates.map((candidate) => ({
        key: nextDraftKey(), term: candidate.title,
        meanings: candidate.meanings.map((meaning) => ({
          key: nextDraftKey(), partOfSpeech: meaning.meaning.partOfSpeech ?? "",
          definition: meaning.meaning.definition, usage: meaning.meaning.usage ?? "",
        })),
        error: null, warnings: candidate.warnings,
      }));
      setEntries(candidates);
      setSelectedEntryKey(candidates[0]?.key ?? null);
      setOrganizationWarning(result.globalWarning);
      setStep("form");
    } catch {
      if (generation !== organizeGeneration.current) return;
      // 网络、配置、响应格式失败都保留原文；用户可重试或手动填写。
      setOrganizeError(ORGANIZE_UNAVAILABLE);
    } finally {
      if (generation === organizeGeneration.current) setOrganizing(false);
    }
  };

  /** V1 取消语义：先释放界面，旧网络请求自行收尾，原文与手动入口仍可用。 */
  const cancelOrganize = (): void => {
    organizeGeneration.current += 1;
    services.entryOrganizer.cancel();
    setOrganizing(false);
    setOrganizeError("已取消整理，原文仍在，可以重新整理或改为手动填写。");
  };

  /** 降级入口：改为手动填写，直接进入表单并保留一个空白条目。 */
  const switchToManual = (): void => {
    if (organizing) cancelOrganize();
    setOrganizeError(null);
    const blank = emptyEntry();
    setEntries([blank]);
    setSelectedEntryKey(blank.key);
    setOrganizationWarning(null);
    setStep("form");
  };

  // ---- 草稿编辑回调（rerender-functional-setstate：一律函数式更新，不读闭包旧值） ----
  // useCallback 空依赖 ⇒ 引用恒定，传给条目卡片不会因父级重渲染造成无效 diff。
  const updateEntry = useCallback((entryKey: number, updater: (entry: DraftEntry) => DraftEntry): void => {
    setEntries((current) => current.map((item) => (item.key === entryKey ? updater(item) : item)));
  }, []);

  const removeEntry = (entryKey: number): void => {
    const remaining = entries.filter((item) => item.key !== entryKey);
    // V1 删除最后一项后仍保留空白编辑器，用户可以立即改填或勾选空 List。
    const next = remaining.length > 0 ? remaining : [emptyEntry()];
    setEntries(next);
    if (selectedEntryKey === entryKey) setSelectedEntryKey(next[0]?.key ?? null);
  };

  const addEntry = useCallback((): void => {
    const blank = emptyEntry();
    setEntries((current) => [...current, blank]);
    setSelectedEntryKey(blank.key);
  }, []);

  /** 第二步：保存本次录入（可携带冲突决定），成功后清空批次并留在录入页。 */
  const saveEntries = (resolutions?: readonly WordConflictResolution[]): void => {
    setSaveError(null);
    const { nextEntries, built } = buildConfirmedEntries(entries, !isRegularMode && confirmEmptyList);
    // 校验结果（含逐条错误）回写表单；有错误时停在本步，不产生任何写入。
    setEntries(nextEntries);
    if (built === null) {
      return;
    }
    try {
      const created = isRegularMode
        ? services.regularLearning.recordEntries({ spaceId, entries: built, conflictResolutions: resolutions })
        : services.bookLearning.recordFirstPass({
          spaceId, unitNumber: Number(unitNumber), listNumber: Number(listNumber),
          entries: built, confirmEmptyList, conflictResolutions: resolutions,
        }).words;
      if (!isRegularMode && draftId.current !== null) {
        services.bookDrafts.confirmDraft(draftId.current);
        // 已确认草稿不能再编辑；下一批输入必须创建新草稿，否则自动保存会抛错。
        draftId.current = null;
      }
      services.notifyChanged();
      showToast(isRegularMode ? `已录入 ${created.length} 个条目。` : `Unit ${unitNumber} · List ${listNumber} 已录入 ${created.length} 个词。`);
      const blank = emptyEntry();
      setEntries([blank]);
      setSelectedEntryKey(blank.key);
      setRawText("");
      setConflict(null);
      setConfirmEmptyList(false);
      setOrganizationWarning(null);
      setOrganizeError(null);
      setStep(smartOrganizingEnabled ? "input" : "form");
    } catch (cause) {
      if (cause instanceof SpaceEntryConflictError || cause instanceof BookEntryConflictError) {
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
      <PageShell title={isRegularMode ? "录入条目" : "录入词汇"} description={isRegularMode ? "第一步输入，第二步检查并保存。" : "先在纸质词书完成首过，再录入重点 Word。"}>
        <p className="firstpass-steps">步骤 1 / 2 · 输入</p>
        <section className="card section" data-testid="firstpass-input-step">
          {!isRegularMode ? (
            <div className="settings-inline-row" data-testid="firstpass-book-location">
              <label className="field-label">Unit 编号
                <input className="field-input" type="number" min="1" value={unitNumber} onChange={(event) => setUnitNumber(event.target.value)} data-testid="firstpass-unit-number" />
              </label>
              <label className="field-label">List 编号
                <input className="field-input" type="number" min="1" value={listNumber} onChange={(event) => setListNumber(event.target.value)} data-testid="firstpass-list-number" />
              </label>
            </div>
          ) : null}
          <h2 className="card-section-title">任意粘贴或输入</h2>
          <p className="field-hint">任意输入或语音转写单词的词性释义与用法，大模型将为你整理词条</p>
          <textarea
            className="field-input firstpass-textarea"
            value={rawText}
            disabled={organizing}
            onChange={(event) => {
              setRawText(event.target.value);
              setOrganizeError(null);
            }}
            aria-label="录入内容"
            data-testid="firstpass-raw-input"
          />
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={organizing ? cancelOrganize : () => { void organize(); }} data-testid="firstpass-organize">
              {organizing ? "取消整理" : isRegularMode ? "智能整理并检查" : "整理并检查"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={switchToManual} data-testid="firstpass-direct-manual">
              {isRegularMode ? "改为手动填写" : "直接手动填写"}
            </button>
          </div>
          {organizing ? <p role="status" data-testid="firstpass-organizing-status">正在整理…</p> : null}
          {organizeError === null ? null : (
            <>
              <p className="field-error" role="alert" data-testid="firstpass-organize-error">
                {organizeError}
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => { void organize(); }}
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

  // ---- 第二步：填写/编辑表单 ----
  return (
    <PageShell title={isRegularMode ? "录入条目" : "录入词汇"} description="第二步检查并保存。">
      {!isRegularMode ? (
        <div className="settings-inline-row" data-testid="firstpass-book-location">
          <label className="field-label">Unit 编号
            <input className="field-input" type="number" min="1" value={unitNumber} onChange={(event) => setUnitNumber(event.target.value)} data-testid="firstpass-unit-number" />
          </label>
          <label className="field-label">List 编号
            <input className="field-input" type="number" min="1" value={listNumber} onChange={(event) => setListNumber(event.target.value)} data-testid="firstpass-list-number" />
          </label>
        </div>
      ) : null}
      <p className="firstpass-steps" data-testid="firstpass-step-label">
        {smartOrganizingEnabled ? "步骤 2 / 2 · 检查并保存" : "手动填写并保存"} · 当前共 {previewEntries.length} 个{isRegularMode ? "条目" : "词"}
      </p>
      {rawText.trim() === "" ? null : (
        <details className="firstpass-transcript" data-testid="firstpass-transcript">
          <summary>本轮原始转写</summary>
          <p>{rawText}</p>
        </details>
      )}
      <section className="card section firstpass-review" aria-label="检查后保存">
        <div className="entry-card-header">
          <div>
            <h2 className="card-section-title">检查后保存</h2>
            <p className="field-hint">选择下方{isRegularMode ? "条目" : "词汇"}卡片，再在同一页面继续编辑</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={addEntry} data-testid="firstpass-add-entry">
            添加{isRegularMode ? "条目" : "词汇"}
          </button>
        </div>
        <div className="firstpass-entry-list" data-testid="firstpass-entry-list" aria-label="本次录入候选">
          {previewEntries.length === 0 ? <p className="field-hint">还没有条目，请先填写下方表单</p> : null}
          {previewEntries.map(({ entry, index }) => (
            <button
              key={entry.key}
              type="button"
              className={`firstpass-preview-item${entry.key === selectedEntryKey ? " is-selected" : ""}`}
              onClick={() => setSelectedEntryKey(entry.key)}
              aria-pressed={entry.key === selectedEntryKey}
              data-testid={`firstpass-preview-${index}`}
            >
              <strong>{entry.term.trim() || "未填写英文词条"}</strong>
              {entry.meanings.filter((meaning) => meaning.definition.trim() !== "").map((meaning) => (
                <span key={meaning.key}>{meaning.partOfSpeech === "" ? "" : `${meaning.partOfSpeech} `}{meaning.definition}{meaning.usage.trim() === "" ? "" : ` · ${meaning.usage}`}</span>
              ))}
              {entry.warnings?.map((warning, warningIndex) => (
                <em key={warningIndex} data-testid={`firstpass-warning-${index}-${warningIndex}`}>{warning}</em>
              ))}
              {entry.error === null ? null : <em>{entry.error}</em>}
            </button>
          ))}
        </div>
        {selectedEntry === null ? null : (
          <div className="firstpass-editor-panel" data-testid="firstpass-editor-panel">
            <h3 className="card-section-title">{entryIsBlank(selectedEntry) ? `填写新${isRegularMode ? "条目" : "词汇"}` : `编辑${isRegularMode ? "条目" : "词汇"} · ${selectedEntry.term}`}</h3>
            <EntryCard
              key={selectedEntry.key}
              entry={selectedEntry}
              entryIndex={selectedEntryIndex}
              onUpdateEntry={updateEntry}
              onRemoveEntry={removeEntry}
            />
          </div>
        )}
        {!isRegularMode ? (
          <label className="field-label"><input type="checkbox" checked={confirmEmptyList} onChange={(event) => setConfirmEmptyList(event.target.checked)} data-testid="firstpass-confirm-empty-list" /> 这个 List 没有需要记录的词</label>
        ) : null}
        {organizationWarning === null ? null : <p className="firstpass-global-warning" role="status" data-testid="firstpass-organization-warning">{organizationWarning}</p>}
      </section>
      {saveError === null ? null : (
        <p className="field-error" role="alert" data-testid="firstpass-save-error">
          {saveError}
        </p>
      )}
      <div className="firstpass-save-bar">
        {smartOrganizingEnabled ? (
          <button type="button" className="btn btn-secondary" onClick={() => setStep("input")} data-testid="firstpass-back-to-raw">
            返回修改原文
          </button>
        ) : null}
        <button type="button" className="btn btn-primary" onClick={() => saveEntries()} data-testid="firstpass-save">
          {isRegularMode ? "保存本次录入" : "保存这组词汇"}
        </button>
      </div>
      {conflict === null ? null : (
        <Modal title="处理重复条目" onClose={() => setConflict(null)}>
          <p className="modal-message">以下条目与{isRegularMode ? "这个 Space" : "这个 List"}已有条目重复，请逐条选择处理方式。</p>
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
      {entry.warnings?.map((warning, index) => <p className="field-hint" key={index} data-testid={`firstpass-warning-${entryIndex}-${index}`}>{warning}</p>)}
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
