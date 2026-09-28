/**
 * 设置页（功能完整）。
 *
 * 布局与文案对应界面设计规格第 13 章；读写一律经应用层：
 * - 同步设置（时区、换日时间、智能整理、在线词典、复习参数）走
 *   SettingsService（settingsFacade）；
 * - 大语言模型四项配置（基础地址 / 模型名称 / API 密钥 / 思考开关）是设备本地
 *   数据（需求规格 6.9、判断文件 A1 第 11–14 项），走 LlmConfigurationService；
 *   API 密钥只以脱敏形态展示，不提供查看明文入口，仅提供"清空并重新填写"。
 *
 * 保存语义按 V1 实际页面：密钥行独立保存，目标保持率需两次确认并独立保存；
 * “保存设置”按钮提交其余设置。失败保留用户当前输入。
 *
 * 当前按正式 V1 桌面设置页提供联网辅助总开关，不暴露词典来源选择；两源并发
 * 的选择属于后台适配器行为。
 */

import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { LlmConfigurationSnapshot } from "@ebbinghaus/application";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { PageShell } from "../ui/PageShell.tsx";
import { Modal } from "../ui/Modal.tsx";

interface FieldErrors {
  timezone?: string;
  rollover?: string;
  baseUrl?: string;
  modelName?: string;
  retention?: string;
}

type SaveStatus = "idle" | "saved" | "retention-saved" | "key-saved" | "failed";
type ConnectionState = { readonly busy: boolean; readonly message: string; readonly failed: boolean };

/** API 密钥输入状态：masked=脱敏展示；refill=清空后待重填。 */
type ApiKeyState =
  | { readonly phase: "masked" }
  | { readonly phase: "refill"; readonly draft: string };

/** 浏览器验收环境没有云端控制器，仍保持 Hook 调用顺序与订阅函数稳定。 */
const subscribeNoCloudStatus = (): (() => void) => () => {};
const getNoCloudStatusVersion = (): number => 0;

export function SettingsPage(): ReactNode {
  const services = useServices();
  const activeSpace = useActiveSpace();

  // ---- 初始草稿：全部来自应用层快照（同步读取，内存运行时无异步加载）。 ----
  const schedule = services.settings.getLearningScheduleSettings();
  const flags = services.settings.getFeatureFlags();
  const spaceSettings =
    activeSpace === null ? null : services.settings.getSpaceLearningSettings(activeSpace.id);
  const llmSnapshot = services.llm.configurationSnapshot();

  const [timezoneName, setTimezoneName] = useState(schedule.timezoneName);
  const [dayRolloverTime, setDayRolloverTime] = useState(schedule.dayRolloverTime);
  const [desiredRetention, setDesiredRetention] = useState(
    String(spaceSettings?.fsrsParameters.desiredRetention ?? 0.95),
  );
  const [currentRetention, setCurrentRetention] = useState(
    spaceSettings?.fsrsParameters.desiredRetention ?? 0.95,
  );
  const [retentionConfirmation, setRetentionConfirmation] = useState<0 | 1 | 2>(0);
  const [smartOrganizing, setSmartOrganizing] = useState(flags.smartOrganizing);
  const [onlineDictionary, setOnlineDictionary] = useState(flags.onlineDictionary);
  const [llmBaseUrl, setLlmBaseUrl] = useState(llmSnapshot.baseUrl);
  const [llmModelName, setLlmModelName] = useState(llmSnapshot.modelName);
  const [thinkingEnabled, setThinkingEnabled] = useState(llmSnapshot.thinkingEnabled);
  const [apiKey, setApiKey] = useState<ApiKeyState>(
    llmSnapshot.hasApiKey ? { phase: "masked" } : { phase: "refill", draft: "" },
  );

  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [llmDisplay, setLlmDisplay] = useState<LlmConfigurationSnapshot>(llmSnapshot);
  const [connection, setConnection] = useState<ConnectionState>({ busy: false, message: "", failed: false });
  const [cloudTokenDraft, setCloudTokenDraft] = useState("");
  const [cloudTokenEditing, setCloudTokenEditing] = useState(false);
  const [cloudMessage, setCloudMessage] = useState("");
  // 后台同步仅刷新本卡片状态；输入草稿和其他页面不受空轮询影响。
  useSyncExternalStore(
    services.cloudSync?.subscribeStatus ?? subscribeNoCloudStatus,
    services.cloudSync?.getStatusVersion ?? getNoCloudStatusVersion,
    getNoCloudStatusVersion,
  );
  const cloudStatus = services.cloudSync?.getStatus();

  /** 任一字段编辑后清除全局保存状态，避免过期提示。 */
  const touch = (): void => {
    setStatus("idle");
  };

  const isRegularMode = activeSpace?.learningMode === "常规模式";

  /** 客户端先做形态校验（就地提示），全部通过后再交给应用层用例保存。 */
  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    const trimmedTimezone = timezoneName.trim();
    if (!trimmedTimezone) {
      next.timezone = "时区不能为空。";
    } else {
      try {
        // 用 timeZone 选项校验 IANA 时区名（locale 固定 "en" 仅做合法性探针）。
        // 刻意不用 `new Intl.DateTimeFormat(时区名)`：那是 locale 参数，会把时区名
        // 误当 locale 解析（真实浏览器与 jsdom 都会拒绝合法 IANA 名称）。
        new Intl.DateTimeFormat("en", { timeZone: trimmedTimezone });
      } catch {
        next.timezone = "时区名称无效，请输入 IANA 时区名称，例如 Asia/Shanghai。";
      }
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dayRolloverTime)) {
      next.rollover = "换日时间必须是 HH:mm 格式的本地时间。";
    }
    const trimmedBaseUrl = llmBaseUrl.trim();
    if (!trimmedBaseUrl.startsWith("https://")) {
      next.baseUrl = "基础地址必须使用 HTTPS。";
    }
    if (!llmModelName.trim()) {
      next.modelName = "模型名称不能为空。";
    }
    return next;
  };

  /** V1 的目标保持率是独立危险设置：只接受完整数值且与其他字段分开提交。 */
  const retentionCandidate = Number(desiredRetention.trim());
  const retentionChanged = isRegularMode && Number.isFinite(retentionCandidate)
    && Math.abs(retentionCandidate - currentRetention) >= 1e-9;
  const retentionError = isRegularMode && (
    desiredRetention.trim() === "" || !Number.isFinite(retentionCandidate)
    || retentionCandidate < 0.8 || retentionCandidate > 0.99
  ) ? "目标保持率必须在 0.80 至 0.99 之间" : undefined;

  /** API 密钥行独立保存；留空明确清空，取消只退出填写状态。 */
  const saveApiKey = (): void => {
    if (apiKey.phase !== "refill") return;
    const llmErrors: FieldErrors = {};
    if (!llmBaseUrl.trim().startsWith("https://")) llmErrors.baseUrl = "基础地址必须使用 HTTPS。";
    if (!llmModelName.trim()) llmErrors.modelName = "模型名称不能为空。";
    setErrors(llmErrors);
    if (Object.keys(llmErrors).length > 0) { setStatus("failed"); return; }
    try {
      const snapshot = apiKey.draft.trim() === ""
        ? services.llm.clearApiKey({ thinkingEnabled })
        : services.llm.saveConfiguration({
            baseUrl: llmBaseUrl.trim(), modelName: llmModelName.trim(),
            apiKey: apiKey.draft.trim(), thinkingEnabled,
          });
      setLlmDisplay(snapshot);
      setLlmBaseUrl(snapshot.baseUrl);
      setLlmModelName(snapshot.modelName);
      setThinkingEnabled(snapshot.thinkingEnabled);
      setApiKey(snapshot.hasApiKey ? { phase: "masked" } : { phase: "refill", draft: "" });
      services.notifyChanged();
      setStatus("key-saved");
    } catch {
      setStatus("failed");
    }
  };

  const confirmRetention = (): void => {
    if (retentionConfirmation === 1) { setRetentionConfirmation(2); return; }
    if (retentionConfirmation !== 2 || activeSpace === null) return;
    try {
      services.settings.saveRegularDesiredRetention(activeSpace.id, retentionCandidate);
      setCurrentRetention(retentionCandidate);
      services.notifyChanged();
      setStatus("retention-saved");
    } catch {
      setStatus("failed");
    } finally {
      setRetentionConfirmation(0);
    }
  };

  /** 先同步读取已保存配置，再异步探测；编辑框里的未保存密钥不参与连接测试。 */
  const testConnection = (): void => {
    if (connection.busy) return;
    let probe: () => Promise<string>;
    try {
      probe = services.llm.prepareConnectionTest();
    } catch (cause) {
      setConnection({ busy: false, failed: true,
        message: cause instanceof Error ? cause.message : "无法准备连接测试" });
      return;
    }
    setConnection({ busy: true, failed: false, message: "正在测试连接…" });
    void probe().then(
      (message) => setConnection({ busy: false, failed: false, message }),
      (cause: unknown) => setConnection({ busy: false, failed: true,
        message: cause instanceof Error ? cause.message : "无法连接大语言模型服务" }),
    );
  };

  /** 云令牌独立提交；不与学习设置或 LLM 密钥共用底部保存按钮。 */
  const saveCloudToken = (): void => {
    const token = cloudTokenDraft.trim();
    if (!token || services.cloudSync === null) {
      setCloudMessage("请输入云端访问令牌。");
      return;
    }
    try {
      services.cloudSync.configureToken(token);
      setCloudTokenDraft("");
      setCloudTokenEditing(false);
      // 控制器在已启动时自行发起同步；结果由专属状态订阅回显。
      setCloudMessage("");
    } catch {
      setCloudMessage("访问令牌保存失败，请重试。");
    }
  };

  const syncCloudNow = (): void => {
    if (services.cloudSync === null) return;
    // 同步错误与恢复直接取控制器最新状态，避免一次手动失败留下过期红字。
    setCloudMessage("");
    void services.cloudSync.syncNow();
  };

  const save = (): void => {
    // V1 在目标保持率被修改时只处理这项危险设置；两次确认结束后，用户需再点
    // “保存设置”才会提交其他草稿，避免一次点击混入两类不同风险的修改。
    if (retentionError !== undefined) {
      setErrors({ retention: retentionError });
      setStatus("failed");
      return;
    }
    if (retentionChanged) {
      setRetentionConfirmation(1);
      return;
    }
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setStatus("failed");
      return;
    }
    try {
      services.settings.saveLearningDaySettings({
        timezoneName: timezoneName.trim(),
        dayRolloverTime,
      });
      services.settings.saveFeatureFlags({ smartOrganizing, onlineDictionary });
      // V1 底部保存只提交地址、模型和思考开关；密钥行须显式点“保存”，
      // 未提交的明文输入不能因保存其他设置而意外落库。
      const snapshot = services.llm.saveConfiguration({
        baseUrl: llmBaseUrl.trim(),
        modelName: llmModelName.trim(),
        apiKey: null,
        thinkingEnabled,
      });
      setLlmDisplay(snapshot);
      services.notifyChanged();
      setStatus("saved");
    } catch (cause) {
      // 应用层校验失败（如换日时间越界）：保留用户输入，给统一失败提示；
      // 原因仅进控制台供开发定位，不进入界面（规格第 15 章禁止内部术语上屏）。
      console.error("保存设置失败", cause);
      setStatus("failed");
    }
  };

  return (
    <PageShell title="设置" description="调整学习节奏和联网辅助">
      <section className="card settings-section" aria-labelledby="settings-learning-day">
        <h2 className="card-section-title" id="settings-learning-day">
          学习日
        </h2>
        <div className="settings-row">
          <div className="field">
            <label className="field-label" htmlFor="settings-timezone">
              时区
            </label>
            <input
              id="settings-timezone"
              className="field-input"
              value={timezoneName}
              onChange={(event) => {
                setTimezoneName(event.target.value);
                touch();
              }}
              data-testid="settings-timezone"
            />
            {errors.timezone === undefined ? null : (
              <p className="field-error" role="alert">
                {errors.timezone}
              </p>
            )}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="settings-rollover">
              新的一天从
            </label>
            {/* 内联行（输入框 + "开始"）：min-width:0 后 412px 视口可收缩，
                移动端不随外层设置行竖排（否则"开始"孤立成行，语义断裂）。 */}
            <div className="settings-row settings-inline-row">
              <input
                id="settings-rollover"
                className="field-input"
                type="time"
                value={dayRolloverTime}
                onChange={(event) => {
                  setDayRolloverTime(event.target.value);
                  touch();
                }}
                data-testid="settings-rollover"
              />
              <span>开始</span>
            </div>
            {errors.rollover === undefined ? null : (
              <p className="field-error" role="alert">
                {errors.rollover}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="card settings-section" aria-labelledby="settings-online">
        <h2 className="card-section-title" id="settings-online">
          联网辅助
        </h2>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={smartOrganizing}
            onChange={(event) => {
              setSmartOrganizing(event.target.checked);
              touch();
            }}
            data-testid="feature-smart-organizing"
          />
          智能整理录入内容
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={onlineDictionary}
            onChange={(event) => {
              setOnlineDictionary(event.target.checked);
              touch();
            }}
            data-testid="feature-online-dictionary"
          />
          查询在线词典
        </label>
      </section>

      <section className="card settings-section" aria-labelledby="settings-llm">
        <h2 className="card-section-title" id="settings-llm">
          大语言模型
        </h2>
        <div className="field">
          <label className="field-label" htmlFor="llm-base-url">
            基础地址
          </label>
          <input
            id="llm-base-url"
            className="field-input"
            value={llmBaseUrl}
            onChange={(event) => {
              setLlmBaseUrl(event.target.value);
              touch();
            }}
            data-testid="llm-base-url"
          />
          {errors.baseUrl === undefined ? null : (
            <p className="field-error" role="alert">
              {errors.baseUrl}
            </p>
          )}
        </div>
        <div className="field">
          <label className="field-label" htmlFor="llm-model-name">
            模型名称
          </label>
          <input
            id="llm-model-name"
            className="field-input"
            value={llmModelName}
            onChange={(event) => {
              setLlmModelName(event.target.value);
              touch();
            }}
            data-testid="llm-model-name"
          />
          {errors.modelName === undefined ? null : (
            <p className="field-error" role="alert">
              {errors.modelName}
            </p>
          )}
        </div>
        <div className="api-key-row">
          <span className="field-label">API 密钥</span>
          {apiKey.phase === "masked" ? (
            <>
              <span className="api-key-value" data-testid="llm-api-key-masked">
                {llmDisplay.hasApiKey ? llmDisplay.maskedApiKey : "未配置"}
              </span>
              {llmDisplay.hasApiKey ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setApiKey({ phase: "refill", draft: "" });
                    touch();
                  }}
                  data-testid="llm-clear-api-key"
                >
                  清空并重新填写
                </button>
              ) : null}
            </>
          ) : (
            <><input
              className="field-input"
              type="password"
              value={apiKey.draft}
              onChange={(event) => {
                setApiKey({ phase: "refill", draft: event.target.value });
                touch();
              }}
              aria-label="输入新的 API 密钥"
              data-testid="llm-api-key-input"
            />
            <button type="button" className="btn btn-primary" onClick={saveApiKey}
              data-testid="llm-save-api-key">保存</button>
            {llmDisplay.hasApiKey ? <button type="button" className="btn btn-secondary"
              onClick={() => setApiKey({ phase: "masked" })}
              data-testid="llm-cancel-refill">取消</button> : null}</>
          )}
        </div>
        <p className="field-hint">密钥只在本机保存；重新填写后点击同一行的“保存”才生效。</p>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={thinkingEnabled}
            onChange={(event) => {
              setThinkingEnabled(event.target.checked);
              touch();
            }}
            data-testid="llm-thinking-checkbox"
          />
          允许大语言模型思考
        </label>
        <p className="field-hint">服务连接在本设备上保存，不随学习数据同步。</p>
        <div className="settings-row">
          <button type="button" className="btn btn-secondary" onClick={testConnection}
            disabled={connection.busy} data-testid="llm-test-connection">测试连接</button>
          {connection.message ? <p className={connection.failed ? "field-error" : "field-hint"}
            role="status" data-testid="llm-test-result">{connection.message}</p> : null}
        </div>
      </section>

      {isRegularMode && activeSpace !== null ? (
        <section className="card settings-section" aria-labelledby="settings-retention-heading">
          <h2 className="card-section-title" id="settings-retention-heading">复习参数（仅常规模式生效）</h2>
          <div className="field">
            <label className="field-label" htmlFor="settings-retention">目标保持率</label>
            <input id="settings-retention" className="field-input" inputMode="decimal"
              value={desiredRetention} data-testid="settings-retention"
              onChange={(event) => { setDesiredRetention(event.target.value); touch(); }} />
            <p className="field-hint">范围 0.80 至 0.99，不推荐修改。修改后只影响后续排期。</p>
            {errors.retention === undefined ? null : <p className="field-error" role="alert">{errors.retention}</p>}
          </div>
        </section>
      ) : null}

      <div className="settings-row">
        <button type="button" className="btn btn-primary" onClick={save} data-testid="settings-save">
          保存设置
        </button>
        {status === "saved" ? (
          <p className="field-hint" role="status" data-testid="settings-status">
            设置已保存。
          </p>
        ) : null}
        {status === "retention-saved" || status === "key-saved" ? (
          <p className="field-hint" role="status" data-testid="settings-status">
            {status === "retention-saved" ? "复习参数已保存" : llmDisplay.hasApiKey ? "API 密钥已保存" : "API 密钥已清空"}
          </p>
        ) : null}
        {status === "failed" ? (
          <p className="field-error" role="alert" data-testid="settings-status">
            没有保存成功，请检查输入后重试。
          </p>
        ) : null}
      </div>
      {/* 云端托管有独立令牌保存和同步操作，放在普通设置保存区之后，避免误以为底部按钮会提交云端配置。 */}
      {services.cloudSync === null ? null : (
        <section className="card settings-section" aria-labelledby="settings-cloud-heading">
          <h2 className="card-section-title" id="settings-cloud-heading">云端数据托管</h2>
          <p className="field-hint">数据端点：eb-data.edgarzhong.fyi。本机仍可离线使用，联网后自动同步。</p>
          {cloudStatus?.configured && !cloudTokenEditing ? (
            <div className="settings-row">
              <span>访问令牌已保存在本机</span>
              <button type="button" className="btn btn-secondary" onClick={() => setCloudTokenEditing(true)}
                data-testid="cloud-change-token">更新访问令牌</button>
            </div>
          ) : (
            <div className="field">
              <label className="field-label" htmlFor="cloud-sync-token">云端访问令牌</label>
              <input id="cloud-sync-token" className="field-input" type="password"
                value={cloudTokenDraft} onChange={(event) => setCloudTokenDraft(event.target.value)}
                autoComplete="off" data-testid="cloud-sync-token" />
              <div className="settings-row">
                <button type="button" className="btn btn-primary" onClick={saveCloudToken}
                  data-testid="cloud-save-token">保存并同步</button>
                {cloudStatus?.configured ? <button type="button" className="btn btn-secondary"
                  onClick={() => { setCloudTokenEditing(false); setCloudTokenDraft(""); }}>
                  取消
                </button> : null}
              </div>
            </div>
          )}
          {cloudStatus?.configured ? (
            <div className="settings-row">
              <button type="button" className="btn btn-secondary" onClick={syncCloudNow}
                disabled={cloudStatus.running} data-testid="cloud-sync-now">立即同步</button>
              <span>待同步项目：{cloudStatus.pendingOutboxCount}</span>
            </div>
          ) : null}
          {cloudStatus?.lastSuccessAt ? <p className="field-hint">上次同步：{new Date(cloudStatus.lastSuccessAt).toLocaleString()}</p> : null}
          {cloudStatus?.running ? <p className="field-hint" role="status" data-testid="cloud-sync-status">正在同步…</p> : null}
          {cloudStatus?.lastError ? <p className="field-error" role="status">{cloudStatus.lastError}</p> : null}
          {cloudMessage ? <p className="field-error" role="status">{cloudMessage}</p> : null}
        </section>
      )}
      {retentionConfirmation > 0 ? (
        <Modal title="确认修改目标保持率" onClose={() => setRetentionConfirmation(0)}>
          <p>{retentionConfirmation === 1
            ? `目标保持率改为 ${retentionCandidate.toFixed(2)}？`
            : "目标保持率影响复习调度，修改后历史排期不变。再次确认修改？"}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setRetentionConfirmation(0)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={confirmRetention}
              data-testid="confirm-retention">确认修改</button>
          </div>
        </Modal>
      ) : null}
    </PageShell>
  );
}
