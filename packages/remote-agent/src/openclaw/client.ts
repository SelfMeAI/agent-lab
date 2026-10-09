import { randomUUID } from "node:crypto";
import type { RemoteBrowserGrant, RemoteDesktopGrant, RemoteItem, RemoteTask, RemoteTaskSnapshot, RemoteTerminal, RemoteTerminalEvent, RemoteUploadedFile } from "../../../contracts/src/remote-agent";
import { actionTitle, clawToolCall, contentText, openClawMessage, record, taskStatus, text, timestamp, toolDiff, toolInput } from "../transcript";
import { RemoteHttp, remoteTaskId } from "../transport/http";
import { OpenClawConnection, type GatewayEvent } from "./connection";
import type { OpenClawIdentity } from "./gateway";

type View = { snapshot: RemoteTaskSnapshot; offset: number; total?: number; earlierItems: RemoteItem[]; loadedEarlier: boolean; refreshing?: Promise<void>; timer?: ReturnType<typeof setTimeout> };
const prefix = "agent:main:selfme:";
function upsert(items: RemoteItem[], item: RemoteItem): RemoteItem[] { return items.some(row => row.id === item.id) ? items.map(row => row.id === item.id ? item : row) : [...items, item]; }
function key(id: string): string { if (!id.startsWith(prefix) || prefix + remoteTaskId(id) !== id) throw new Error("OpenClaw 任务标识无效"); return id; }
export function clawTask(value: unknown): RemoteTask {
  const row = record(value), now = new Date().toISOString();
  return { id: text(row.key), title: text(row.label) || text(row.autoLabel) || text(row.displayName) || text(row.derivedTitle) || "新任务", status: taskStatus(row.status), createdAt: timestamp(row.createdAt) ?? timestamp(row.updatedAt) ?? now, updatedAt: timestamp(row.updatedAt) ?? now };
}

/** Native gateway sessions and custody; the client owns no duplicate task database. */
export class OpenClawTasks {
  private connection?: OpenClawConnection;
  private connecting?: Promise<OpenClawConnection>;
  private epoch = 0;
  private views = new Map<string, View>();
  private opening = new Map<string, symbol>();
  private terminals = new Map<string, string>();
  private terminalSeq = new Map<string, number>();
  private retry?: ReturnType<typeof setTimeout>;
  private hold?: { task: string; id: string; heartbeat: ReturnType<typeof setInterval> };
  constructor(readonly http: RemoteHttp, private readonly credentials: () => Promise<{ sessionApiKey: string; device?: OpenClawIdentity }>,
    private readonly emit: (snapshot: RemoteTaskSnapshot) => void, private readonly terminalEvent: (event: RemoteTerminalEvent) => void) {}
  private async gateway(): Promise<OpenClawConnection> {
    if (!this.connection) {
      if (!this.connecting) {
        const epoch = this.epoch;
        const pending = (async () => {
          const credentials = await this.credentials();
          if (!credentials.device) throw new Error("OpenClaw 设备身份缺失");
          const endpoint = await this.http.base();
          if (epoch !== this.epoch) throw new Error("连接已关闭");
          const connection = new OpenClawConnection(endpoint, credentials.sessionApiKey, credentials.device, event => this.event(event), () => { if (this.connection === connection) this.disconnected(); });
          this.connection = connection; return connection;
        })().finally(() => { if (this.connecting === pending) this.connecting = undefined; });
        this.connecting = pending;
      }
      await this.connecting;
    }
    const connection = this.connection;
    if (!connection) throw new Error("连接已关闭");
    await connection.connect(); return connection;
  }
  async request<T>(method: string, params: unknown = {}): Promise<T> { return (await this.gateway()).request<T>(method, params); }
  async list(): Promise<RemoteTask[]> {
    const tasks: RemoteTask[] = []; let offset = 0;
    for (;;) {
      const result = record(await this.request("sessions.list", { limit: 100, offset, sortBy: "updatedAt", group: "selfme-lab", includeDerivedTitles: true }));
      const rows = Array.isArray(result.sessions) ? result.sessions : [];
      tasks.push(...rows.map(clawTask).filter(task => task.id.startsWith(prefix)));
      if (rows.length < 100) return tasks; offset += rows.length;
    }
  }
  async create(): Promise<RemoteTask> {
    this.assertNotControlled(); const id = randomUUID();
    const workspace = record(await this.request("selfme.workspace.prepare", { id }));
    const result = record(await this.request("sessions.create", { key: prefix + id, idempotencyKey: id, agentId: "main", displayName: "新任务", category: "selfme-lab", permissionMode: "guarded", cwd: workspace.root }));
    const entry = { ...record(result.entry), key: result.key ?? prefix + id };
    return clawTask(entry);
  }
  async open(id: string): Promise<RemoteTaskSnapshot> {
    key(id); const ticket = Symbol(id); this.opening.set(id, ticket); await this.detach(id);
    const task = (await this.list()).find(task => task.id === id); if (!task) throw new Error("任务不存在或已删除");
    if (this.opening.get(id) !== ticket) throw new Error("任务视图已关闭");
    const view: View = { snapshot: { task, items: [], connection: "connected" }, offset: 0, earlierItems: [], loadedEarlier: false }; this.views.set(id, view);
    // Subscribe before the bounded durable tail to avoid a lost event window.
    await this.request("sessions.messages.subscribe", { key: id, includeApprovals: true });
    await this.refresh(id); await this.questions(id);
    return structuredClone(view.snapshot);
  }
  async earlier(id: string): Promise<RemoteTaskSnapshot> { key(id); await this.refresh(id, true); return structuredClone(this.view(id).snapshot); }
  private view(id: string): View { const view = this.views.get(id); if (!view) throw new Error("请先打开任务"); return view; }
  private async refresh(id: string, earlier = false): Promise<void> {
    const view = this.views.get(id); if (!view) return;
    if (view.refreshing) { await view.refreshing; if (!earlier) return; }
    view.refreshing = (async () => {
      const page = record(await this.request("chat.history", { sessionKey: id, limit: 100, maxBytes: 4_000_000, offset: earlier ? view.offset : 0 }));
      if (this.views.get(id) !== view) return;
      const messages = Array.isArray(page.messages) ? page.messages : [];
      const items = messages.flatMap((message, i) => this.messageItems(message, `history-${text(record(page).sessionId)}-${earlier ? view.offset : 0}-${i}`)).map(item => {
        const prior = view.snapshot.items.find(row => row.id === item.id);
        // A history tool-call row alone is not a new start. Retain its native
        // live terminal receipt, especially for nested plugin operations.
        return item.tool?.status === "running" && prior?.tool && prior.tool.status !== "running" ? { ...item, tool: { ...item.tool, ...prior.tool } } : item;
      });
      const transient = view.snapshot.items.filter(item => item.approval || item.question || item.streaming || (item.tool && item.id.startsWith("live:")));
      if (earlier) { view.loadedEarlier = true; view.earlierItems = [...items, ...view.earlierItems]; }
      else if (view.loadedEarlier) view.earlierItems = view.snapshot.items.filter(item => !item.approval && !item.question && !item.streaming);
      const merged = earlier ? [...items, ...view.snapshot.items] : [...view.earlierItems, ...items, ...transient.filter(item => !items.some(durable => durable.id === item.id))];
      view.snapshot.items = merged.reduce(upsert, [] as RemoteItem[]);
      const pagination = record(page.pagination);
      const raw = typeof pagination.rawPageMessages === "number" ? pagination.rawPageMessages : messages.length;
      const total = typeof page.totalMessages === "number" ? page.totalMessages : typeof pagination.totalMessages === "number" ? pagination.totalMessages : undefined;
      // Offsets count backwards from the newest native message. New messages
      // must move an already-loaded older-page cursor, not create a history gap.
      if (!earlier && view.loadedEarlier && total !== undefined && view.total !== undefined) view.offset += Math.max(0, total - view.total);
      if (earlier || !view.loadedEarlier) view.offset = typeof page.nextOffset === "number" ? page.nextOffset : (earlier ? view.offset : 0) + raw;
      if (earlier || !view.loadedEarlier) view.snapshot.hasEarlier = page.hasMore === true;
      if (total !== undefined) view.total = total;
      const info = record(page.sessionInfo);
      if (Object.keys(info).length) view.snapshot.task = { ...view.snapshot.task, ...clawTask({ ...info, key: id }) };
      if (page.inFlightRun) {
        const run = record(page.inFlightRun); view.snapshot.task.status = "running";
        const runText = text(run.text), runId = text(run.runId);
        if (runText && runId && !view.snapshot.items.some(item => item.id === `stream:${runId}`)) view.snapshot.items.push({ id: `stream:${runId}`, role: "assistant", text: runText, streaming: true });
      } else view.snapshot.items = view.snapshot.items.filter(item => !item.streaming);
      view.snapshot.connection = "connected";
      this.publish(view);
    })().finally(() => { view.refreshing = undefined; });
    await view.refreshing;
  }
  private messageItems(value: unknown, fallback: string): RemoteItem[] {
    const message = record(value), msg = record(message.message ?? value);
    const meta = record(msg.__openclaw), stable = text(meta.id) || text(msg.id) || fallback;
    const main = openClawMessage(value, stable), items = main && (main.text || main.tool || main.reasoning) ? [main] : [];
    const parts = Array.isArray(msg.content) ? msg.content.map(record) : [];
    for (const part of parts) {
      if (part.type === "toolCall" || part.type === "tool_use") {
        const call = clawToolCall(text(part.name), record(part.arguments ?? part.input)), { name, args } = call, at = timestamp(part.timestamp ?? msg.timestamp);
        items.push({ id: `live:${text(part.id)}`, role: "tool", text: "", at, tool: { name, title: actionTitle(name, args), input: toolInput(args), diff: toolDiff(args), path: text(args.path) || undefined, status: "running", startedAt: at, parentCallId: text(part.parentToolCallId) || undefined } });
      } else if (part.type === "toolResult" && text(part.toolCallId)) {
        // Native custom trajectory records contain both the nested call and
        // its receipt; omitting the receipt leaves completed tools "running".
        const result = openClawMessage({ ...part, role: "toolResult" }, `result:${text(part.toolCallId)}`);
        if (result?.tool) { result.id = `result:${text(part.toolCallId)}`; result.tool.diff = text(record(part.details).diff) || undefined; result.tool.parentCallId = text(part.parentToolCallId) || undefined; items.push(result); }
      }
    }
    if (main?.tool) { const callId = text(msg.toolCallId); if (callId) main.id = `result:${callId}`; }
    return items;
  }
  private publish(view: View): void {
    if (this.views.get(view.snapshot.task.id) !== view) return;
    // Durable results and live tool rows share a call id, not a renderer-invented action.
    const results = new Map(view.snapshot.items.filter(item => item.id.startsWith("result:")).map(item => [item.id.slice(7), item]));
    const nestedParents = new Set(view.snapshot.items.map(item => item.tool?.parentCallId).filter(Boolean));
    view.snapshot.items = view.snapshot.items.map(item => {
      const result = item.id.startsWith("live:") ? results.get(item.id.slice(5)) : undefined;
      return result?.tool && item.tool ? { ...item, tool: { ...item.tool, output: result.tool.output, status: result.tool.status, endedAt: result.at } } : item;
    }).filter(item => (!item.id.startsWith("result:") || !view.snapshot.items.some(call => call.id === "live:" + item.id.slice(7))) && !(item.id.startsWith("live:") && nestedParents.has(item.id.slice(5))));
    view.snapshot.humanControl = this.hold?.task === view.snapshot.task.id;
    this.emit(structuredClone(view.snapshot));
  }
  private schedule(id: string): void {
    const view = this.views.get(id); if (!view || view.timer) return;
    view.timer = setTimeout(() => { view.timer = undefined; void this.refresh(id).catch(error => { view.snapshot.error = error.message; this.publish(view); }); }, 200);
  }
  private event(event: GatewayEvent): void {
    const p = record(event.payload);
    if (event.event === "terminal.data" || event.event === "terminal.exit") {
      const terminalId = text(p.sessionId), taskId = this.terminals.get(terminalId);
      if (taskId) {
        const seq = typeof p.seq === "number" ? p.seq : undefined;
        if (seq !== undefined && seq <= (this.terminalSeq.get(terminalId) ?? -1)) return;
        if (seq !== undefined) this.terminalSeq.set(terminalId, seq);
        this.terminalEvent({ engine: "openclaw", taskId, terminalId, data: text(p.data), exited: event.event === "terminal.exit" });
      } return;
    }
    if (event.event === "question.requested") { const id = text(p.sessionKey); if (this.views.has(id)) this.addQuestion(id, p); return; }
    if (event.event === "question.resolved") { for (const view of this.views.values()) { view.snapshot.items = view.snapshot.items.filter(item => item.question?.id !== p.id); this.publish(view); } return; }
    const id = text(p.sessionKey), view = this.views.get(id); if (!view) return;
    if (event.event === "session.approval") {
      const approval = record(p.approval), presentation = record(approval.presentation), requestId = text(approval.id);
      view.snapshot.items = view.snapshot.items.filter(item => item.approval?.id !== requestId);
      if (p.phase === "pending") { view.snapshot.items.push({ id: `approval:${requestId}`, role: "notice", text: "", approval: { id: requestId, title: text(presentation.title) || "允许远端操作？", detail: text(presentation.commandText) || text(presentation.summary) || text(presentation.description) || "智能体请求你的确认", canAlways: presentation.kind === "exec", kind: presentation.kind === "exec" ? "exec" : "plugin" } }); view.snapshot.task.status = "waiting"; }
      else this.schedule(id);
    } else if (event.event === "session.tool" || (event.event === "agent" && p.stream === "tool")) {
      const data = record(p.data), toolId = text(data.toolCallId); if (!toolId) return;
      const existing = view.snapshot.items.find(item => item.id === `live:${toolId}`), { name, args } = clawToolCall(text(data.name), record(data.args));
      if (existing?.tool && existing.tool.status !== "running" && ["start", "update", "input_delta"].includes(text(data.phase))) return;
      const item: RemoteItem = { id: `live:${toolId}`, role: "tool", text: "", at: existing?.at ?? timestamp(p.ts), tool: { name, title: actionTitle(name, args), input: Object.keys(args).length ? toolInput(args) : existing?.tool?.input ?? "", output: contentText(record(data.result).content ?? data.result) || contentText(record(data.partialResult).content ?? data.partialResult) || existing?.tool?.output,
        status: data.phase === "result" || data.phase === "end" ? data.isError ? "failed" : "completed" : "running", diff: toolDiff(args) ?? (text(record(data.details).diff) || existing?.tool?.diff), path: text(args.path) || existing?.tool?.path, startedAt: existing?.tool?.startedAt ?? timestamp(p.ts), endedAt: data.phase === "result" || data.phase === "end" ? timestamp(p.ts) : undefined, parentCallId: text(data.parentToolCallId) || existing?.tool?.parentCallId } };
      view.snapshot.items = upsert(view.snapshot.items, item);
    } else if (event.event === "chat") {
      const runId = text(p.runId), streamId = `stream:${runId}`;
      if (p.state === "delta") {
        const old = view.snapshot.items.find(item => item.id === streamId); const delta = text(p.deltaText);
        const item: RemoteItem = { id: streamId, role: "assistant", text: p.replace ? delta : delta ? (old?.text ?? "") + delta : contentText(record(p.message).content), streaming: true };
        view.snapshot.items = upsert(view.snapshot.items, item); view.snapshot.task.status = "running";
      } else if (p.state === "status") view.snapshot.task.status = "running";
      else if (["final", "error", "aborted"].includes(text(p.state))) {
        view.snapshot.task.status = p.state === "error" ? "error" : p.state === "aborted" ? "paused" : "completed";
        if (p.state === "error") view.snapshot.error = text(p.errorMessage) || "远端任务失败，可修改消息后重试";
        view.snapshot.items = view.snapshot.items.map(item => item.id === streamId ? { ...item, streaming: false } : item); this.schedule(id);
      }
    } else if (event.event === "session.message") { this.schedule(id); }
    else if (p.status) view.snapshot.task.status = taskStatus(p.status);
    view.snapshot.task.updatedAt = timestamp(p.ts ?? p.updatedAtMs) ?? view.snapshot.task.updatedAt; this.publish(view);
  }
  private addQuestion(id: string, row: Record<string, unknown>): void {
    const view = this.views.get(id); if (!view || row.status !== "pending") return;
    const requestId = text(row.id); view.snapshot.items = view.snapshot.items.filter(item => item.question?.id !== requestId);
    view.snapshot.items.push({ id: `question:${requestId}`, role: "notice", text: "", question: { id: requestId, questions: (Array.isArray(row.questions) ? row.questions : []).map(record).map(q => ({ id: text(q.questionId), title: text(q.header), prompt: text(q.question), options: (Array.isArray(q.options) ? q.options : []).map(record).map(o => ({ label: text(o.label), description: text(o.description) || undefined })), multiple: q.multiSelect === true, other: q.isOther !== false, secret: q.isSecret === true })) } });
    view.snapshot.task.status = "waiting"; this.publish(view);
  }
  private async questions(id: string): Promise<void> { const result = record(await this.request("question.list")); for (const row of (Array.isArray(result.questions) ? result.questions : []).map(record)) if (row.sessionKey === id) this.addQuestion(id, row); }
  async answer(id: string, requestId: string, answers: Record<string, string[]> | null): Promise<void> {
    key(id); if (!this.view(id).snapshot.items.some(item => item.question?.id === requestId)) throw new Error("问题已结束或不属于此任务");
    await this.request("question.resolve", answers ? { id: requestId, answers: { answers } } : { id: requestId, cancel: true });
  }
  async approve(id: string, requestId: string, decision: "once" | "always" | "reject"): Promise<void> {
    key(id); const approval = this.view(id).snapshot.items.find(item => item.approval?.id === requestId)?.approval;
    if (!approval) throw new Error("审批已结束或不属于此任务"); if (decision === "always" && !approval.canAlways) throw new Error("此操作不支持始终允许");
    await this.request("approval.resolve", { id: requestId, kind: approval.kind, decision: decision === "reject" ? "deny" : decision === "always" ? "allow-always" : "allow-once" });
  }
  private assertNotControlled(): void { if (this.hold) throw new Error("正在接管远端桌面，请先交还智能体"); }
  async send(id: string, prompt: string, files: RemoteUploadedFile[] = []): Promise<void> {
    key(id); this.assertNotControlled(); if (!prompt.trim() && !files.length) throw new Error("请输入消息或上传文件");
    const message = prompt + (files.length ? "\n\n上传文件（远端路径）：\n" + files.map(file => file.absolutePath).join("\n") : "");
    const view = this.views.get(id);
    // Steer targets an existing reply operation, including one still retiring
    // after cancellation. An idle/paused task must start a normal native turn.
    const active = view?.snapshot.task.status === "running" || view?.snapshot.task.status === "waiting";
    await this.request("chat.send", { sessionKey: id, message, ...(active ? { queueMode: "steer" } : {}), idempotencyKey: randomUUID() });
    if (view) { view.snapshot.error = undefined; view.snapshot.task.status = "running"; this.publish(view); }
    this.schedule(id);
    if (view?.snapshot.task.title === "新任务") {
      const title = prompt.trim().slice(0, 36) || files[0]?.name || "文件任务";
      // Native autoLabel is presentation metadata and permits duplicate task
      // titles; label is a unique custom alias, not an automatically made title.
      void this.request("sessions.patch", { key: id, autoLabel: title }).then(() => { view.snapshot.task.title = title; this.publish(view); }).catch(() => {});
    }
  }
  async control(id: string, action: "stop" | "resume"): Promise<void> { key(id); if (action === "stop") await this.request("chat.abort", { sessionKey: id }); else await this.send(id, "继续当前任务；先核对已有进度与产物，不要重复已完成的操作。"); this.schedule(id); }
  async delete(id: string): Promise<void> { key(id); await this.control(id, "stop"); await this.request("sessions.delete", { key: id, deleteTranscript: true }); await this.close(id); }
  async desktop(id: string, control: boolean): Promise<RemoteDesktopGrant> {
    key(id); if (control && !this.hold) {
      const lease = record(await this.request("selfme.control.acquire", { task: remoteTaskId(id) }));
      const leaseId = text(lease.id);
      this.hold = { task: id, id: leaseId, heartbeat: setInterval(() => void this.request("selfme.control.renew", { id: leaseId }).catch(() => this.disconnected()), 15_000) };
      try {
        for (const task of await this.list()) if (task.status === "running" || task.status === "waiting") await this.control(task.id, "stop");
        const deadline = Date.now() + 25_000;
        while ((await this.list()).some(task => task.status === "running" || task.status === "waiting")) {
          if (Date.now() > deadline) throw new Error("智能体仍有操作未停止，未开放桌面控制"); await new Promise(resolve => setTimeout(resolve, 350));
        }
      } catch (error) { await this.release(); throw error; }
    }
    try {
      const result = record(await this.request("desktop.observe", { source: { kind: "host" }, control }));
      const base = new URL(await this.http.base()); base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      const view = this.views.get(id); if (view) this.publish(view);
      return { url: new URL(text(result.wsPath), base).toString(), password: text(result.vncPassword) || undefined, control: result.control === true, expiresAt: Number(result.expiresAtMs) };
    } catch (error) { if (control) await this.release(); throw error; }
  }
  async release(): Promise<void> {
    const hold = this.hold; if (!hold) return; this.hold = undefined; clearInterval(hold.heartbeat);
    try { await this.request("selfme.control.release", { id: hold.id }); }
    finally { const view = this.views.get(hold.task); if (view) this.publish(view); }
  }
  async browser(id: string): Promise<RemoteBrowserGrant> {
    key(id);
    const listing = record(await this.request("browser.request", { method: "GET", path: "/tabs", tabScope: { sessionKey: id } }));
    const tabs = Array.isArray(listing.tabs) ? listing.tabs.map(record) : [];
    const targetId = text(tabs[0]?.targetId); if (!targetId) throw new Error("此任务还没有打开浏览器页面");
    const result = record(await this.request("browser.request", { method: "POST", path: "/screencast", body: { targetId, maxWidth: 1600, maxHeight: 1000, quality: 85 }, tabScope: { sessionKey: id } }));
    const base = new URL(await this.http.base()); base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    return { url: new URL(text(result.wsPath), base).toString(), pageUrl: text(result.url), expiresAt: Number(result.expiresAtMs) };
  }
  async terminal(id: string): Promise<RemoteTerminal> {
    key(id); const result = record(await this.request("terminal.open", { sessionKey: id, cols: 100, rows: 30 }));
    const terminalId = text(result.sessionId); this.terminals.set(terminalId, id);
    const attached = record(await this.request("terminal.attach", { sessionId: terminalId }));
    if (typeof attached.seq === "number") this.terminalSeq.set(terminalId, attached.seq);
    return { id: terminalId, cwd: text(result.cwd), confined: result.confined === true, buffer: text(attached.buffer) };
  }
  private assertTerminal(id: string, terminalId: string): void { key(id); if (this.terminals.get(terminalId) !== id) throw new Error("终端不属于此任务"); }
  async terminalInput(id: string, terminalId: string, data: string): Promise<void> { this.assertTerminal(id, terminalId); await this.request("terminal.input", { sessionId: terminalId, data }); }
  async terminalResize(id: string, terminalId: string, cols: number, rows: number): Promise<void> { this.assertTerminal(id, terminalId); await this.request("terminal.resize", { sessionId: terminalId, cols, rows }); }
  async terminalClose(id: string, terminalId: string): Promise<void> { this.assertTerminal(id, terminalId); await this.request("terminal.close", { sessionId: terminalId }); this.terminals.delete(terminalId); this.terminalSeq.delete(terminalId); }
  async close(id: string): Promise<void> { this.opening.delete(id); await this.detach(id); }
  private async detach(id: string): Promise<void> {
    key(id); const view = this.views.get(id); if (!view) return; clearTimeout(view.timer); this.views.delete(id);
    if (this.hold?.task === id) await this.release();
    for (const [terminalId, task] of this.terminals) if (task === id) await this.terminalClose(id, terminalId).catch(() => {});
    await this.connection?.request("sessions.messages.unsubscribe", { key: id }).catch(() => {});
  }
  private disconnected(): void {
    ++this.epoch; this.connecting = undefined;
    if (this.hold) { clearInterval(this.hold.heartbeat); this.hold = undefined; }
    this.connection?.close(); this.connection = undefined;
    for (const [terminalId, taskId] of this.terminals) this.terminalEvent({ engine: "openclaw", taskId, terminalId, exited: true, detail: "连接已断开，请重新打开终端" }); this.terminals.clear(); this.terminalSeq.clear();
    for (const view of this.views.values()) { view.snapshot.connection = "reconnecting"; this.publish(view); }
    clearTimeout(this.retry); if (this.views.size) this.retry = setTimeout(() => void this.reconnect(), 2000);
  }
  private async reconnect(): Promise<void> {
    try { for (const id of this.views.keys()) { await this.request("sessions.messages.subscribe", { key: id, includeApprovals: true }); await this.refresh(id); await this.questions(id); } }
    catch { clearTimeout(this.retry); if (this.views.size) this.retry = setTimeout(() => void this.reconnect(), 3000); }
  }
  shutdown(): void { ++this.epoch; this.connecting = undefined; this.opening.clear(); clearTimeout(this.retry); if (this.hold) clearInterval(this.hold.heartbeat); this.hold = undefined; for (const view of this.views.values()) clearTimeout(view.timer); this.views.clear(); this.connection?.close(); this.connection = undefined; this.terminals.clear(); this.terminalSeq.clear(); this.http.reset(); }
}
