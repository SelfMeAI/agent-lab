import type { RemoteBrowserInput } from "../../../../packages/contracts/src/remote-agent";

type Command = { method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText"; params: Record<string, unknown> };
const number = (value: unknown, min: number, max: number, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("浏览器输入参数无效");
  return value;
};
const integer = (value: unknown, max: number, fallback?: number): number => {
  const result = number(value, 0, max, fallback); if (!Number.isInteger(result)) throw new Error("浏览器输入参数无效"); return result;
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || value.length > max) throw new Error("浏览器输入文字无效"); return value;
};

/** Validate the whole batch before forwarding any input. Never expose raw CDP. */
export function browserInputCommands(events: unknown): Array<Command | null> {
  if (!Array.isArray(events) || !events.length || events.length > 64 || JSON.stringify(events).length > 64 * 1024) throw new Error("浏览器输入无效");
  return events.map((event: RemoteBrowserInput) => {
    if (!event || typeof event !== "object") throw new Error("浏览器输入无效");
    if (event.kind === "release") return null;
    if (event.kind === "text") return { method: "Input.insertText", params: { text: text(event.text, 32_000) } };
    if (event.kind === "key") {
      if (!["down", "up"].includes(event.type)) throw new Error("浏览器按键无效");
      const key = text(event.key, 64), modifiers = integer(event.modifiers, 15);
      // CDP needs a carriage-return character to perform Enter's default
      // editing action. A key code alone dispatches the event, but inserts
      // no newline. Modified shortcuts must not receive this fallback.
      const characters = event.text === undefined ? key === "Enter" && (modifiers & 7) === 0 ? "\r" : undefined : text(event.text, 64);
      return { method: "Input.dispatchKeyEvent", params: { type: event.type === "down" ? "keyDown" : "keyUp", key, code: text(event.code, 64), windowsVirtualKeyCode: integer(event.keyCode, 255), modifiers, ...(event.type === "down" && characters ? { text: characters } : {}) } };
    }
    if (event.kind !== "mouse" || !["move", "down", "up", "wheel"].includes(event.type) || (event.button !== undefined && !["left", "middle", "right"].includes(event.button))) throw new Error("浏览器鼠标输入无效");
    return { method: "Input.dispatchMouseEvent", params: {
      type: { move: "mouseMoved", down: "mousePressed", up: "mouseReleased", wheel: "mouseWheel" }[event.type],
      x: number(event.x, 0, 16_384), y: number(event.y, 0, 16_384), button: event.button ?? "none", buttons: integer(event.buttons, 7, 0), modifiers: integer(event.modifiers, 15, 0),
      ...(event.type === "down" || event.type === "up" ? { clickCount: integer(event.clickCount, 2, 1) } : {}),
      ...(event.type === "wheel" ? { deltaX: number(event.deltaX, -16_384, 16_384, 0), deltaY: number(event.deltaY, -16_384, 16_384, 0) } : {}),
    } };
  });
}

/** Only the already-running, container-local managed page can receive input. */
export function browserInputEndpoint(base: string, targetId: string, target: { id?: string; type?: string; webSocketDebuggerUrl?: string }): string {
  const http = new URL(base), ws = new URL(target.webSocketDebuggerUrl ?? "");
  const local = (hostname: string) => ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  if (http.protocol !== "http:" || !local(http.hostname) || http.username || http.password || target.id !== targetId || target.type !== "page" || ws.protocol !== "ws:" || !local(ws.hostname) || ws.port !== http.port || ws.username || ws.password || ws.search || ws.hash || decodeURIComponent(ws.pathname) !== `/devtools/page/${targetId}`) throw new Error("浏览器输入连接不是当前远端页面");
  return ws.href;
}

/** An authenticated lease owns this input-only channel, not the browser itself. */
export class BrowserInputChannel {
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly keys = new Map<string, Record<string, unknown>>();
  private readonly buttons = new Map<string, Record<string, unknown>>();
  private sequence = 0;
  closed = false;
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("浏览器输入连接超时")); this.close(); }, 5000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("浏览器输入连接失败")); this.close(); }, { once: true });
      this.socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("浏览器输入连接已关闭")); this.close(); }, { once: true });
    });
    // A disconnect may precede the caller awaiting this channel.
    void this.ready.catch(() => {});
    this.socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(String(event.data)), call = this.pending.get(message.id);
        if (!call) return;
        clearTimeout(call.timer); this.pending.delete(message.id);
        if (message.error) call.reject(new Error("远端浏览器未能处理此输入")); else call.resolve();
      } catch { this.close(); }
    });
  }
  private async send(command: Command, authorize: () => void): Promise<void> {
    await this.ready; authorize();
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error("浏览器输入连接已关闭");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("浏览器输入响应超时")); this.close(); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      try { authorize(); this.socket.send(JSON.stringify({ id, ...command })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async input(commands: Array<Command | null>, authorize: () => void): Promise<void> {
    for (const command of commands) {
      authorize();
      if (!command) { await this.release(authorize); continue; }
      await this.send(command, authorize);
      if (command.method === "Input.dispatchKeyEvent") {
        const code = String(command.params.code);
        if (command.params.type === "keyDown") this.keys.set(code, command.params); else this.keys.delete(code);
      } else if (command.method === "Input.dispatchMouseEvent") {
        const button = String(command.params.button);
        if (command.params.type === "mousePressed") this.buttons.set(button, command.params);
        else if (command.params.type === "mouseReleased") this.buttons.delete(button);
      }
    }
  }
  private async release(authorize: () => void): Promise<void> {
    for (const params of this.keys.values()) await this.send({ method: "Input.dispatchKeyEvent", params: { ...params, type: "keyUp", text: undefined, modifiers: 0 } }, authorize);
    for (const params of this.buttons.values()) await this.send({ method: "Input.dispatchMouseEvent", params: { ...params, type: "mouseReleased", buttons: 0, modifiers: 0 } }, authorize);
    this.keys.clear(); this.buttons.clear();
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    // Releasing held buttons/keys on revocation is cleanup, never new input.
    try {
      if (this.socket.readyState === WebSocket.OPEN) {
        for (const params of this.keys.values()) this.socket.send(JSON.stringify({ id: ++this.sequence, method: "Input.dispatchKeyEvent", params: { ...params, type: "keyUp", text: undefined, modifiers: 0 } }));
        for (const params of this.buttons.values()) this.socket.send(JSON.stringify({ id: ++this.sequence, method: "Input.dispatchMouseEvent", params: { ...params, type: "mouseReleased", buttons: 0, modifiers: 0 } }));
      }
    } catch { /* A socket can disconnect during best-effort input cleanup. */ }
    this.keys.clear(); this.buttons.clear();
    try { this.socket.close(); } catch { /* Already disconnected. */ }
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error("浏览器输入连接已关闭")); }
    this.pending.clear();
  }
}
