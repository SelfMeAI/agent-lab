import { useEffect, useMemo, useState, type JSX } from "react";
import type { JevExperimentDecision, JevExperimentId, ProviderStatus } from "../../../../../../packages/contracts/src/index";
import { jevExperimentIds, jevExperiments } from "../../../jev-experiments/catalog";
import { goToLab } from "../../app/navigation";
import { LabIcon } from "../../shell/LabIcon";
import "./jev-experiments.css";

interface Props {
  experimentId: JevExperimentId;
  onOpenSettings?(): void;
  providerRevision?: number;
}

const percentage = (value: number | null | undefined): string => value == null ? "—" : `${Math.round(value * 100)}%`;
const numberText = (value: number | null | undefined): string => value == null ? "—" : String(value);

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /u, "");
}

export function ExperimentWorkbench({ experimentId, onOpenSettings, providerRevision }: Props): JSX.Element {
  const definition = jevExperiments[experimentId];
  const [caseId, setCaseId] = useState(definition.cases[0].id);
  const [state, setState] = useState(definition.cases[0].state);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [result, setResult] = useState<JevExperimentDecision | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    let active = true;
    if (!window.agentLab) return;
    void window.agentLab.getProviderStatus("jev")
      .then((status) => { if (active) setProvider(status); })
      .catch(() => { if (active) setProvider(null); });
    return () => { active = false; };
  }, [providerRevision]);

  const sampleCase = definition.cases.find((item) => item.id === caseId) ?? definition.cases[0];
  const expectedActionId = state === sampleCase.state ? sampleCase.expectedAction : null;
  const expectedAction = definition.actions.find((action) => action.id === expectedActionId);
  const selectedAction = definition.actions.find((action) => action.id === result?.actionId);
  const probabilities = useMemo(() => result ? definition.actions
    .map((action) => ({ ...action, probability: result.probabilities[action.id] ?? null }))
    .sort((left, right) => (right.probability ?? -1) - (left.probability ?? -1)) : [], [definition, result]);

  function selectCase(id: string): void {
    const next = definition.cases.find((item) => item.id === id);
    if (!next) return;
    setCaseId(id);
    setState(next.state);
    setResult(null);
    setError(null);
  }

  async function run(): Promise<void> {
    if (running || !state.trim()) return;
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      if (!window.agentLab) throw new Error("桌面端接口不可用");
      const decision = await window.agentLab.runJevExperiment(experimentId, state);
      setResult(decision);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setRunning(false);
    }
  }

  return <section className="jev-experiment-page">
    <header className="jev-experiment-heading"><LabIcon labId="jev-lab" /><h1>JEV LAB</h1><span>{definition.shortTitle}</span></header>
    <div className="jev-experiment-toolbar">
      <nav aria-label="JEV 实验项目" className="jev-experiment-tabs">
        {jevExperimentIds.map((id) => <button key={id} type="button" className={id === experimentId ? "active" : ""} onClick={() => goToLab("jev-lab", id)}>{jevExperiments[id].shortTitle}</button>)}
      </nav>
      <div className="jev-experiment-safety"><span aria-hidden="true">◇</span><div><strong>OBSERVATION ONLY</strong><small>只观察决策，不执行真实操作</small></div></div>
    </div>
    <div className="jev-experiment-body">
      <section className="jev-experiment-panel jev-experiment-input" aria-label="案例输入">
        <div className="jev-experiment-panel__title"><h2>CASE INPUT</h2><span>{definition.title}</span></div>
        <div className="jev-experiment-input__body">
          <p className="jev-experiment-description">{definition.description}</p>
          <label htmlFor="jev-case-select">预设案例</label>
          <select id="jev-case-select" value={caseId} disabled={running} onChange={(event) => selectCase(event.target.value)}>{definition.cases.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
          <label htmlFor="jev-case-state">案例内容 <small>可编辑</small></label>
          <textarea id="jev-case-state" value={state} disabled={running} maxLength={12000} spellCheck={false} onChange={(event) => { setState(event.target.value); setResult(null); setError(null); }} />
          <div className="jev-experiment-input__bottom"><small>{expectedActionId ? "预设案例 · 可对照" : "已编辑 · 不与预设答案比较"}</small><small>{state.length} / 12000</small></div>
          <p className="jev-experiment-privacy">输入会发送到当前配置的 JEV 服务。请勿粘贴真实密钥、客户或财务敏感资料。</p>
          <button type="button" className="jev-experiment-run" disabled={running || !provider?.configured || state.trim().length < 20} onClick={() => void run()}>{running ? "决策中…" : "▶  运行决策"}</button>
          {!provider?.configured && <button type="button" className="jev-experiment-config" onClick={onOpenSettings}>先配置 JEV 连接 →</button>}
          {error && <p className="jev-experiment-error" role="alert">{error}</p>}
        </div>
      </section>
      <section className="jev-experiment-panel jev-experiment-output" aria-label="JEV 决策结果">
        <div className="jev-experiment-panel__title"><h2>DECISION</h2><span>{provider?.configured ? "● JEV CONFIGURED" : "● NOT CONFIGURED"}</span></div>
        <div className="jev-experiment-output__body">
          <div className="jev-experiment-summary">
            <div className={`jev-experiment-choice${result ? " has-result" : ""}`}><small>JEV ACTION</small><strong>{selectedAction?.label ?? (running ? "正在判断…" : "等待首次决策")}</strong><span>{result ? `选择置信度 ${percentage(result.confidence)}` : "选择案例并运行，展示在线模型结果"}</span></div>
            <div className="jev-experiment-expected"><small>EXPECTED · 预设期望</small><strong>{expectedAction?.label ?? "无对照"}</strong><span>{!expectedAction ? "编辑后的内容不沿用预设期望" : result ? result.actionId === expectedActionId ? "与预设期望一致" : "与预设期望不同，值得复核" : "仅供对照，不代表唯一正确答案"}</span></div>
          </div>
          <div className="jev-experiment-probabilities"><div className="jev-experiment-section-title"><h3>PROBABILITIES</h3><small>各预设动作</small></div>{result ? probabilities.map((action) => <div key={action.id} className={`jev-experiment-probability${action.id === result.actionId ? " chosen" : ""}`}><span>{action.label}</span><div className="jev-experiment-probability__bar"><i style={{ width: action.probability == null ? "0%" : `${action.probability * 100}%` }} /></div><b>{percentage(action.probability)}</b></div>) : <p className="jev-experiment-empty">运行后显示模型返回的概率；未返回的值不会补算。</p>}</div>
          <div className="jev-experiment-metrics"><div><small>URGENCY · 紧急度</small><strong>{result?.urgencyScore == null ? "—" : `${result.urgencyScore.toFixed(2)} / 3`}</strong></div><div><small>ANOMALY · 异常概率</small><strong>{percentage(result?.anomalyProbability)}</strong></div><div><small>LATENCY · 耗时</small><strong>{result ? `${result.durationMs} ms` : "—"}</strong></div></div>
          <button type="button" className="jev-experiment-details-toggle" onClick={() => setDetailsOpen((open) => !open)} aria-expanded={detailsOpen}>DETAILS <span>{detailsOpen ? "⌃" : "⌄"}</span></button>
          {detailsOpen && <div className="jev-experiment-details"><span>模型：{result?.model ?? provider?.model ?? "—"}</span><span>输入 / 输出：{numberText(result?.inputTokens)} / {numberText(result?.outputTokens)} tokens</span><span>紧急度置信度：{percentage(result?.urgencyConfidence)}</span><span>动作 ID：{result?.actionId ?? "—"}</span></div>}
        </div>
      </section>
    </div>
  </section>;
}
