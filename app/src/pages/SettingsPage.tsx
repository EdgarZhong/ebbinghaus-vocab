/**
 * 设置页（功能完整）。
 *
 * 布局与文案对应界面设计规格第 13 章；读写一律经应用层：
 * - 同步设置（时区、换日时间、每日目标、词典来源、智能整理、在线词典）走
 *   SettingsService（settingsFacade）；
 * - 大语言模型四项配置（基础地址 / 模型名称 / API 密钥 / 思考开关）是设备本地
 *   数据（需求规格 6.9、判断文件 A1 第 11–14 项），走 LlmConfigurationService；
 *   API 密钥只以脱敏形态展示，不提供查看明文入口，仅提供"清空并重新填写"。
 *
 * 保存语义：统一使用底部"保存设置"按钮一次提交；成功提示"设置已保存。"，
 * 失败提示"没有保存成功，请检查输入后重试。"并保留用户当前输入。
 *
 * 范围说明：规格第 13 章的"复习参数（目标保持率）"卡片不在本阶段交付范围
 * （任务口径仅要求学习日/每日目标/词典来源/联网辅助/LLM 四项），留待 UI-2。
 */

import { useState, type ReactNode } from "react";
import type { LlmConfigurationSnapshot } from "@ebbinghaus/application";
import { useActiveSpace, useServices } from "../services/servicesContext.tsx";
import { StepperInput } from "../ui/StepperInput.tsx";
import { PageShell } from "../ui/PageShell.tsx";

/** 词典来源选项（需求规格核心概念表：在线词典并发查询有道词典与维基词典）。 */
const DICTIONARY_PROVIDERS: readonly string[] = ["维基词典", "有道词典"];

interface FieldErrors {
  timezone?: string;
  rollover?: string;
  dailyTarget?: string;
  baseUrl?: string;
  modelName?: string;
}

type SaveStatus = "idle" | "saved" | "failed";

/** API 密钥输入状态：masked=脱敏展示；refill=清空后待重填。 */
type ApiKeyState =
  | { readonly phase: "masked" }
  | { readonly phase: "refill"; readonly draft: string };

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
  const [dailyTarget, setDailyTarget] = useState(
    spaceSettings === null ? "0" : String(spaceSettings.dailyTarget),
  );
  const [smartOrganizing, setSmartOrganizing] = useState(flags.smartOrganizing);
  const [onlineDictionary, setOnlineDictionary] = useState(flags.onlineDictionary);
  const [dictionaryProvider, setDictionaryProvider] = useState(
    services.settings.getDictionaryProvider(),
  );
  const [llmBaseUrl, setLlmBaseUrl] = useState(llmSnapshot.baseUrl);
  const [llmModelName, setLlmModelName] = useState(llmSnapshot.modelName);
  const [thinkingEnabled, setThinkingEnabled] = useState(llmSnapshot.thinkingEnabled);
  const [apiKey, setApiKey] = useState<ApiKeyState>({ phase: "masked" });

  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [llmDisplay, setLlmDisplay] = useState<LlmConfigurationSnapshot>(llmSnapshot);

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
    const parsedTarget = Number.parseInt(dailyTarget, 10);
    if (Number.isNaN(parsedTarget) || parsedTarget < 0 || String(parsedTarget) !== dailyTarget.trim()) {
      next.dailyTarget = "每日学习目标必须是不小于 0 的整数。";
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

  const save = (): void => {
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
      services.settings.saveDictionaryProvider(dictionaryProvider);
      if (activeSpace !== null) {
        // 每日目标属于当前活动 Space（规格第 13 章），按 Space 级设置保存。
        services.settings.saveSpaceDailyTarget(activeSpace.id, Number.parseInt(dailyTarget, 10));
      }
      // LLM 四项在同一保存动作中提交；apiKey：masked 态传 null=保留既有密钥，
      // refill 态传当前输入（空串=明确清空，非空=更新）。
      const snapshot = services.llm.saveConfiguration({
        baseUrl: llmBaseUrl.trim(),
        modelName: llmModelName.trim(),
        apiKey: apiKey.phase === "refill" ? apiKey.draft : null,
        thinkingEnabled,
      });
      setLlmDisplay(snapshot);
      setApiKey({ phase: "masked" });
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
    <PageShell title="设置" description="学习日、联网辅助与大语言模型服务连接。">
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

      <section className="card settings-section" aria-labelledby="settings-daily-target">
        <h2 className="card-section-title" id="settings-daily-target">
          每日目标
        </h2>
        {activeSpace === null || spaceSettings === null ? (
          <p className="field-hint">当前没有可用的 Space，暂时无法设置每日目标。</p>
        ) : (
          <StepperInput
            id="settings-daily-target"
            label={isRegularMode ? "每天希望完成（个条目）" : "每天希望完成（份学习）"}
            value={dailyTarget}
            onValueChange={(value) => {
              setDailyTarget(value);
              touch();
            }}
            min={0}
            error={errors.dailyTarget ?? null}
            hint={
              isRegularMode
                ? "录入和测试各算 1 个条目；复习只供朗读，不计入工作量。"
                : "首过或单独复习算 1 份；测试并复习算 2 份。"
            }
            testId="settings-daily-target"
          />
        )}
        <p className="field-hint">每日目标按当前 Space 保存：{activeSpace === null ? "—" : activeSpace.learningMode === "常规模式" ? "常规模式按条目计量" : "词书模式按份计量"}。</p>
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
        <div className="field">
          <label className="field-label" htmlFor="dictionary-provider">
            词典来源
          </label>
          <select
            id="dictionary-provider"
            className="field-input"
            value={dictionaryProvider}
            onChange={(event) => {
              setDictionaryProvider(event.target.value);
              touch();
            }}
            data-testid="dictionary-provider"
          >
            {DICTIONARY_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </div>
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
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setApiKey({ phase: "refill", draft: "" });
                    touch();
                  }}
                  data-testid="llm-fill-api-key"
                >
                  填写 API 密钥
                </button>
              )}
            </>
          ) : (
            <input
              className="field-input"
              type="password"
              value={apiKey.draft}
              onChange={(event) => {
                setApiKey({ phase: "refill", draft: event.target.value });
                touch();
              }}
              aria-label="输入新的 API 密钥"
              autoFocus
              data-testid="llm-api-key-input"
            />
          )}
        </div>
        {apiKey.phase === "refill" ? (
          <>
            <p className="field-hint">
              重新输入的密钥将随“保存设置”一并保存；留空保存会清除已存密钥。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setApiKey({ phase: "masked" })}
                data-testid="llm-cancel-refill"
              >
                取消重新填写
              </button>
            </div>
          </>
        ) : llmDisplay.hasApiKey ? null : (
          <p className="field-hint">尚未配置 API 密钥，智能整理暂时无法使用。</p>
        )}
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
      </section>

      <div className="settings-row">
        <button type="button" className="btn btn-primary" onClick={save} data-testid="settings-save">
          保存设置
        </button>
        {status === "saved" ? (
          <p className="field-hint" role="status" data-testid="settings-status">
            设置已保存。
          </p>
        ) : null}
        {status === "failed" ? (
          <p className="field-error" role="alert" data-testid="settings-status">
            没有保存成功，请检查输入后重试。
          </p>
        ) : null}
      </div>
    </PageShell>
  );
}
