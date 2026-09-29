import { Chess } from "@weshell/xiangqi.js";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import type { JevDecision, JevStyle, ProviderStatus } from "../../../../../../packages/contracts/src/index";
import { LabIcon } from "../../shell/LabIcon";

type Side = "w" | "b";
type Mode = "human-vs-jev" | "jev-vs-jev";
type Piece = { square: string; type: string; color: Side };
type Move = { color: Side; from: string; to: string; piece: string; captured?: string; zh: string; lan: string; isCheck: boolean };
type HistoryEntry = { ply: number; side: Side; zh: string; lan: string; source: "human" | "jev" | "local-fallback"; captured?: string; isCheck: boolean };
type Trace = JevDecision & { side: Side; fen: string };

const MAX_AUTO_PLIES = 80;
const glyphs: Record<Side, Record<string, string>> = {
  w: { k: "帅", a: "仕", b: "相", n: "马", r: "车", c: "炮", p: "兵" },
  b: { k: "将", a: "士", b: "象", n: "马", r: "车", c: "炮", p: "卒" },
};
const styleNames: Record<JevStyle, string> = { balanced: "均衡", aggressive: "进攻", positional: "稳健" };
const sideName = (side: Side): string => side === "w" ? "红方" : "黑方";
const percentage = (value: number): string => `${Math.round(value * 100)}%`;
const optionalPercentage = (value: number | null | undefined): string => value == null ? "—" : percentage(value);
const optionalNumber = (value: number | null | undefined): string => value == null ? "—" : String(value);
const snapshot = (chess: Chess) => ({
  fen: chess.fen(), board: chess.board() as unknown as (Piece | null)[][],
  turn: chess.turn() as Side, check: chess.isCheck(), over: chess.isGameOver(), draw: chess.isDraw(),
});

interface Props { onOpenSettings?(): void; providerRevision?: number }

export function XiangqiWorkspace({ onOpenSettings, providerRevision }: Props): JSX.Element {
  const game = useRef<Chess>(new Chess());
  const requestGeneration = useRef(0);
  const thinkingRef = useRef(false);
  const [position, setPosition] = useState(() => snapshot(game.current));
  const [mode, setMode] = useState<Mode>("jev-vs-jev");
  const [redStyle, setRedStyle] = useState<JevStyle>("aggressive");
  const [blackStyle, setBlackStyle] = useState<JevStyle>("positional");
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [thinking, setThinking] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [status, setStatus] = useState("已暂停，红方先行");
  const [warning, setWarning] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);

  useEffect(() => {
    let active = true;
    if (!window.selfmeLab) return;
    void window.selfmeLab.getProviderStatus("jev").then((value) => { if (active) setProvider(value); }).catch(() => { if (active) setProvider(null); });
    return () => { active = false; };
  }, [providerRevision]);

  const legalMoves = useMemo(() => game.current.moves({ verbose: true }) as unknown as Move[], [position.fen]);
  const legalTargets = useMemo(() => new Set(legalMoves.filter((move) => move.from === selected).map((move) => move.to)), [legalMoves, selected]);
  const candidates = useMemo(() => {
    if (!trace) return [];
    const sorted = trace.telemetry.candidates
      .map((candidate) => ({ ...candidate, probability: trace.telemetry.probabilities[candidate.id] ?? null }))
      .sort((a, b) => (b.probability ?? -1) - (a.probability ?? -1) || Number(b.id === trace.move.id) - Number(a.id === trace.move.id));
    const visible = sorted.slice(0, 5);
    if (!visible.some((candidate) => candidate.id === trace.move.id)) {
      const chosen = sorted.find((candidate) => candidate.id === trace.move.id);
      if (chosen) visible[visible.length - 1] = chosen;
    }
    return visible;
  }, [trace]);
  const humanTurn = mode === "human-vs-jev" && position.turn === "w" && !thinking && !position.over;
  const modelCanMove = !position.over && !thinking && (mode === "jev-vs-jev" || position.turn === "b");

  const commitMove = useCallback((from: string, to: string, source: HistoryEntry["source"]): Move => {
    const chess = game.current;
    const side = chess.turn() as Side;
    const move = chess.move({ from, to }) as unknown as Move;
    setHistory((previous) => [...previous, { ply: previous.length + 1, side, zh: move.zh, lan: move.lan, source, captured: move.captured, isCheck: move.isCheck }]);
    setPosition(snapshot(chess));
    setSelected(null);
    return move;
  }, []);

  const modelMove = useCallback(async (): Promise<void> => {
    if (thinkingRef.current || game.current.isGameOver()) return;
    thinkingRef.current = true;
    const generation = ++requestGeneration.current;
    const fen = game.current.fen();
    const side = game.current.turn() as Side;
    const style = side === "w" ? redStyle : blackStyle;
    setThinking(true);
    setWarning(null);
    setStatus(`${sideName(side)}决策中…`);
    try {
      if (!window.selfmeLab) throw new Error("桌面端接口不可用");
      const result = await window.selfmeLab.decideJevMove(fen, style);
      if (generation !== requestGeneration.current || game.current.fen() !== fen) return;
      const valid = (game.current.moves({ verbose: true }) as unknown as Move[]).some((move) => move.from === result.move.from && move.to === result.move.to);
      if (!valid) throw new Error("返回着法未通过本地棋规校验");
      const move = commitMove(result.move.from, result.move.to, result.telemetry.source);
      setTrace({ ...result, side, fen });
      setWarning(result.warning ?? null);
      if (result.telemetry.source === "local-fallback") setAutoPlay(false);
      setStatus(game.current.isGameOver() ? game.current.isDraw() ? "和棋，棋局结束" : `${sideName(side)}获胜` : `${sideName(side)}落子 ${move.zh}`);
      if (game.current.isGameOver()) setAutoPlay(false);
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setAutoPlay(false);
      setStatus("决策未完成");
      setWarning(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === requestGeneration.current) {
        thinkingRef.current = false;
        setThinking(false);
      }
    }
  }, [redStyle, blackStyle, commitMove]);

  useEffect(() => {
    if (thinking || position.over) return;
    const replyToHuman = mode === "human-vs-jev" && position.turn === "b";
    const auto = mode === "jev-vs-jev" && autoPlay;
    if (!replyToHuman && !auto) return;
    if (auto && history.length >= MAX_AUTO_PLIES) {
      setAutoPlay(false);
      setStatus(`自动对弈停在第 ${MAX_AUTO_PLIES} 手`);
      return;
    }
    const timer = window.setTimeout(() => void modelMove(), auto ? 550 : 350);
    return () => window.clearTimeout(timer);
  }, [autoPlay, history.length, mode, modelMove, position.fen, position.over, position.turn, thinking]);

  function resetGame(): void {
    requestGeneration.current += 1;
    thinkingRef.current = false;
    game.current = new Chess();
    setPosition(snapshot(game.current));
    setSelected(null); setHistory([]); setTrace(null); setThinking(false); setAutoPlay(false);
    setStatus("已重开，红方先行"); setWarning(null);
  }

  function changeMode(next: Mode): void {
    requestGeneration.current += 1;
    thinkingRef.current = false;
    setMode(next); setAutoPlay(false); setThinking(false); setSelected(null);
    setStatus(next === "human-vs-jev" ? "人类执红，点击棋子落子" : `已暂停，${sideName(position.turn)}行棋`);
  }

  function clickSquare(square: string, piece: Piece | null): void {
    if (!humanTurn) return;
    if (selected && legalTargets.has(square)) {
      const move = commitMove(selected, square, "human");
      setStatus(game.current.isGameOver() ? "红方获胜，棋局结束" : `红方落子 ${move.zh}`);
    } else setSelected(piece?.color === "w" ? (selected === square ? null : square) : null);
  }

  return <section className="jev-workspace">
    <div className="jev-workspace__title"><LabIcon labId="jev-lab" /><h1>JEV LAB</h1><span>XIANGQI</span></div>
    <div className="jev-workspace__grid">
      <aside className="jev-panel jev-controls">
        <div className="jev-modes"><button type="button" className={mode === "human-vs-jev" ? "active" : ""} onClick={() => changeMode("human-vs-jev")}>HUMAN VS JEV</button><button type="button" className={mode === "jev-vs-jev" ? "active" : ""} onClick={() => changeMode("jev-vs-jev")}>JEV VS JEV</button></div>
        <div className="jev-controls__body"><h2>PLAYERS</h2>
          <div className="jev-player"><span className="jev-player__avatar red">帅</span><div><strong>{mode === "human-vs-jev" ? "HUMAN / RED" : "JEV / RED"}</strong><small>{mode === "human-vs-jev" ? "Click a piece to move" : "Strategy"}</small>{mode === "jev-vs-jev" && <select aria-label="红方策略" value={redStyle} onChange={(event) => setRedStyle(event.target.value as JevStyle)}>{Object.entries(styleNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</div></div>
          <div className="jev-player"><span className="jev-player__avatar black">将</span><div><strong>JEV / BLACK</strong><small>Strategy</small><select aria-label="黑方策略" value={blackStyle} onChange={(event) => setBlackStyle(event.target.value as JevStyle)}>{Object.entries(styleNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
          <div className="jev-controls__divider" />
          <div className="jev-controls__status"><span className={thinking ? "busy" : ""} />{thinking ? "THINKING" : autoPlay ? "RUNNING" : "PAUSED"}<i />{sideName(position.turn).toUpperCase()} TO MOVE</div>
          <div className="jev-actions"><button className="primary" type="button" disabled={mode !== "jev-vs-jev" || position.over} onClick={() => setAutoPlay((value) => !value)} aria-label={autoPlay ? "暂停自动对弈" : "开始自动对弈"}>{autoPlay ? "Ⅱ" : "▶"}</button><button type="button" disabled={!modelCanMove || autoPlay} onClick={() => void modelMove()} aria-label="模型单步落子">▷│</button><button type="button" onClick={resetGame} aria-label="重新开始">↻</button></div>
          <div className="jev-counts"><div><strong>{history.length}</strong><span>PLIES</span></div><div><strong>{legalMoves.length}</strong><span>LEGAL MOVES</span></div></div>
          <p className="jev-status" aria-live="polite">{status}</p>{warning && <p className="jev-warning" role="alert">{warning}</p>}
          {!provider?.configured && <button className="jev-config" type="button" onClick={onOpenSettings}>配置 JEV 密钥 →</button>}
        </div>
      </aside>
      <section className="jev-panel jev-board-panel" aria-label="象棋棋盘"><div className="jev-panel__heading"><span>CURRENT POSITION</span><button type="button" title={position.fen} onClick={() => void navigator.clipboard.writeText(position.fen)}>▢ FEN</button></div>
        <div className="jev-board-stage"><div className="jev-board"><div className="jev-board__grid"><svg className="jev-board__lines" viewBox="0 0 800 900" aria-hidden="true"><path d="M0 0H800 M0 100H800 M0 200H800 M0 300H800 M0 400H800 M0 500H800 M0 600H800 M0 700H800 M0 800H800 M0 900H800 M0 0V900 M800 0V900 M100 0V400 M100 500V900 M200 0V400 M200 500V900 M300 0V400 M300 500V900 M400 0V400 M400 500V900 M500 0V400 M500 500V900 M600 0V400 M600 500V900 M700 0V400 M700 500V900 M300 0L500 200 M500 0L300 200 M300 700L500 900 M500 700L300 900" /></svg><span className="jev-river left">楚 河</span><span className="jev-river right">汉 界</span>
          {position.board.flat().map((piece, index) => { const row = Math.floor(index / 9), column = index % 9; const square = piece?.square ?? `${String.fromCharCode(97 + column)}${9 - row}`; const target = legalTargets.has(square); const interactive = humanTurn && (piece?.color === "w" || target); return <button key={square} type="button" className={`jev-square${selected === square ? " selected" : ""}${target ? " target" : ""}`} style={{ "--file": column, "--rank": row } as CSSProperties} onClick={() => clickSquare(square, piece)} disabled={!interactive} aria-label={`${square} ${piece ? glyphs[piece.color][piece.type] : "空位"}`}>{piece && <span className={`jev-piece ${piece.color === "w" ? "red" : "black"}`}><span className="jev-piece__glyph">{glyphs[piece.color][piece.type]}</span></span>}</button>; })}
        </div></div></div><div className="jev-board-panel__footer"><span className={trace?.telemetry.source === "jev" ? "online" : ""}>{trace ? trace.telemetry.source === "jev" ? "● JEV ONLINE" : "● LOCAL FALLBACK" : "● WAITING FOR DECISION"}</span><span>{position.over ? "FINISHED" : autoPlay ? "RUNNING" : "PAUSED"}</span></div></section>
      <aside className="jev-panel jev-trace"><div className="jev-panel__heading">DECISION TRACE</div><div className="jev-trace__inner"><div className="jev-trace__callout"><strong>{trace?.move.zh ?? "等待首次决策"}</strong><span>{trace ? `${trace.telemetry.source === "jev" ? "JEV ONLINE" : "LOCAL FALLBACK"} · ${sideName(trace.side)}` : "模型落子后显示真实结果"}</span></div>
        <div className="jev-metrics"><div><span>Choice confidence</span><strong>{optionalPercentage(trace?.telemetry.choiceConfidence)}</strong></div><div><span>Tactical pressure</span><strong>{optionalPercentage(trace?.telemetry.tacticalPressure)}</strong></div><div><span>Position score</span><strong>{trace?.telemetry.positionScore == null ? "—" : `${trace.telemetry.positionScore.toFixed(2)} / 4`}</strong></div><div><span>Score confidence</span><strong>{optionalPercentage(trace?.telemetry.positionConfidence)}</strong></div></div>
        <div className="jev-candidates"><h2>CANDIDATE MOVES <small>{trace ? `${trace.telemetry.candidates.length} LEGAL` : "—"}</small></h2>{candidates.length ? candidates.map((candidate, index) => <div key={candidate.id} className={`jev-candidate${candidate.id === trace?.move.id ? " chosen" : ""}`}><span>{index + 1}.</span><strong>{candidate.zh}</strong><div className="jev-candidate__bar"><i style={{ width: candidate.probability == null || candidate.probability === 0 ? "0%" : `${Math.max(candidate.probability * 100, 2)}%` }} /></div><b>{optionalPercentage(candidate.probability)}</b></div>) : <p>等待决策数据</p>}</div>
        <button className="jev-details-toggle" type="button" onClick={() => setDetailsOpen((value) => !value)}>DETAILS <span>{detailsOpen ? "⌃" : "⌄"}</span></button>{detailsOpen && <div className="jev-details"><p>模型：{trace?.telemetry.model ?? "—"}</p><p>延迟：{trace ? `${trace.telemetry.durationMs} ms` : "—"}</p><p>输入 / 输出：{optionalNumber(trace?.telemetry.inputTokens)} / {optionalNumber(trace?.telemetry.outputTokens)} tokens</p><p>决策前 FEN：<code>{trace?.fen ?? "—"}</code></p>{trace?.warning && <p>回退原因：{trace.warning}</p>}</div>}
      </div></aside>
    </div>
    <section className="jev-history"><h2>MOVE HISTORY</h2><div>{history.length ? history.map((entry) => <span key={entry.ply} className="jev-history__move"><b className={entry.side === "w" ? "red" : "black"}>{entry.side === "w" ? "帅" : "将"}</b><strong>{entry.ply}. {entry.zh}</strong><em>{entry.source === "human" ? "HUMAN" : entry.source === "jev" ? "JEV" : "LOCAL"}</em><small>({sideName(entry.side)})</small></span>) : <span className="jev-history__empty">新局 · 尚无着法</span>}</div></section>
  </section>;
}
