import { useEffect, useRef, type JSX, type KeyboardEvent, type PointerEvent } from "react";
import type { RemoteBrowserInput } from "../../../../../../packages/contracts/src/remote-agent";
import { browserInputModifiers, browserInputPoint } from "./browser-input";
import { remoteError } from "./service-presentation";

export function BrowserInput({ taskId, targetId, image, viewport, allowed, onError, onSize }: {
  taskId: string; targetId: string; image: string; viewport?: { width: number; height: number }; allowed: boolean;
  onError(value: string): void; onSize(value: string): void;
}): JSX.Element {
  const stage = useRef<HTMLDivElement>(null), raster = useRef<HTMLImageElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const permission = useRef(allowed), queue = useRef<RemoteBrowserInput[]>([]), sending = useRef(false), epoch = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragging = useRef(false), composing = useRef(false), lastClick = useRef({ at: 0, x: 0, y: 0, count: 1 });
  const errors = useRef(onError); errors.current = onError; permission.current = allowed;
  useEffect(() => {
    const ticket = ++epoch.current; queue.current = []; sending.current = false;
    const release = () => {
      clearTimeout(timer.current); queue.current = []; dragging.current = false; composing.current = false; input.current?.blur();
      if (allowed) void window.selfmeLab!.inputRemoteBrowser("openclaw", taskId, targetId, [{ kind: "release" }]).catch(() => {});
    };
    const hidden = () => { if (document.visibilityState === "hidden") release(); };
    window.addEventListener("blur", release); document.addEventListener("visibilitychange", hidden);
    return () => { if (epoch.current === ticket) ++epoch.current; release(); window.removeEventListener("blur", release); document.removeEventListener("visibilitychange", hidden); };
  }, [taskId, targetId, allowed]);
  async function drain(): Promise<void> {
    if (sending.current || !permission.current || !queue.current.length) return;
    const ticket = epoch.current; sending.current = true;
    try {
      while (permission.current && epoch.current === ticket && queue.current.length) await window.selfmeLab!.inputRemoteBrowser("openclaw", taskId, targetId, queue.current.splice(0, 64));
    } catch (cause) { if (epoch.current === ticket) { queue.current = []; errors.current(remoteError(cause)); } }
    finally { if (epoch.current === ticket) sending.current = false; }
  }
  function send(event: RemoteBrowserInput): void {
    if (!permission.current) return;
    const previous = queue.current.at(-1);
    if (event.kind === "mouse" && event.type === "move" && previous?.kind === "mouse" && previous.type === "move") queue.current[queue.current.length - 1] = event;
    else if (queue.current.length < 256) queue.current.push(event);
    else { queue.current = [{ kind: "release" }]; errors.current("浏览器输入暂时较慢，请稍后继续操作"); }
    clearTimeout(timer.current); timer.current = setTimeout(() => void drain(), 16);
  }
  function point(event: { clientX: number; clientY: number }, clamp = false) {
    if (!raster.current || !stage.current || !viewport) return;
    return browserInputPoint(event.clientX, event.clientY, stage.current.getBoundingClientRect(), { width: raster.current.naturalWidth, height: raster.current.naturalHeight }, viewport, clamp);
  }
  function pointer(event: PointerEvent<HTMLDivElement>, type: "move" | "down" | "up"): void {
    if (!permission.current || event.pointerType !== "mouse" || (type !== "move" && event.button > 2)) return;
    const position = point(event, dragging.current); if (!position) return;
    if (type === "down") {
      input.current?.focus({ preventScroll: true }); stage.current?.setPointerCapture(event.pointerId); dragging.current = true;
      const old = lastClick.current, at = Date.now();
      lastClick.current = { at, ...position, count: at - old.at < 400 && Math.hypot(position.x - old.x, position.y - old.y) < 5 && old.count === 1 ? 2 : 1 };
    }
    send({ kind: "mouse", type, ...position, button: type === "move" ? undefined : ["left", "middle", "right"][event.button] as "left" | "middle" | "right", buttons: event.buttons & 7, modifiers: browserInputModifiers(event), clickCount: lastClick.current.count });
    if (type === "up") { dragging.current = false; if (stage.current?.hasPointerCapture(event.pointerId)) stage.current.releasePointerCapture(event.pointerId); }
    event.preventDefault();
  }
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  wheelHandler.current = event => {
    const position = point(event); if (!permission.current || !position) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport!.height : 1;
    send({ kind: "mouse", type: "wheel", ...position, deltaX: Math.max(-16_384, Math.min(16_384, event.deltaX * unit)), deltaY: Math.max(-16_384, Math.min(16_384, event.deltaY * unit)), modifiers: browserInputModifiers(event) });
    event.preventDefault();
  };
  useEffect(() => { const host = stage.current; if (!host) return; const wheel = (event: WheelEvent) => wheelHandler.current(event); host.addEventListener("wheel", wheel, { passive: false }); return () => host.removeEventListener("wheel", wheel); }, []);
  function key(event: KeyboardEvent<HTMLTextAreaElement>, type: "down" | "up"): void {
    if (!permission.current || composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process" || event.key === "Dead") return;
    // Paste is handled by the actual clipboard event, including Unicode text.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    const modifiers = browserInputModifiers(event), printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    send({ kind: "key", type, key: event.metaKey && event.key === "Meta" ? "Control" : event.key, code: event.key === "Meta" ? "ControlLeft" : event.code, keyCode: event.key === "Meta" ? 17 : event.keyCode, modifiers, ...(type === "down" && printable ? { text: event.key } : {}) });
    event.preventDefault();
  }
  function insert(text: string): void { if (text && permission.current) { send({ kind: "text", text: text.slice(0, 32_000) }); if (text.length > 32_000) errors.current("单次输入最多 32,000 个字符"); } }
  return <div ref={stage} className={`remote-browser-input${allowed ? " is-controlled" : " is-view-only"}`} title={allowed ? "操作远端浏览器" : "只读观察 · 手动接管后可操作"} onPointerDown={event => pointer(event, "down")} onPointerMove={event => pointer(event, "move")} onPointerUp={event => pointer(event, "up")} onPointerCancel={() => { dragging.current = false; send({ kind: "release" }); }} onContextMenu={event => event.preventDefault()}>
    <img ref={raster} src={image} alt="远端浏览器实时画面" draggable={false} onLoad={event => { const image = event.currentTarget; onSize(`${image.naturalWidth} × ${image.naturalHeight} · 适应窗口`); }} />
    <textarea ref={input} className="remote-browser-keyboard" aria-label="远端浏览器键盘输入" aria-hidden={!allowed} tabIndex={allowed ? 0 : -1} readOnly={!allowed} autoCapitalize="off" autoCorrect="off" spellCheck={false} onKeyDown={event => key(event, "down")} onKeyUp={event => key(event, "up")} onBlur={() => send({ kind: "release" })} onPaste={event => { if (permission.current) { event.preventDefault(); insert(event.clipboardData.getData("text/plain")); } }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; insert(event.data); event.currentTarget.value = ""; }} onInput={event => { if (!composing.current) { insert(event.currentTarget.value); event.currentTarget.value = ""; } }} />
  </div>;
}
