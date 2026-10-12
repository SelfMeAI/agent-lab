import { randomUUID } from "node:crypto";
import type { RemoteInputMode, RemoteInputQueue, RemoteSendOptions, RemoteTask, RemoteTaskSnapshot, RemoteUploadedFile } from "../../../contracts/src/remote-agent";
import { applyOpenHandsEvent, contentText, executionFailure, record, taskStatus, text, timestamp } from "../transcript";
import { RemoteHttp, remoteTaskId } from "../transport/http";
import { mergeRemoteInputQueue, remoteInputQueue, remoteSendOptions } from "../input-queue";
import { knownRemoteVision, remoteCanonicalModel } from "../model-capabilities";
import { latestTaskTime, sortRemoteTasks, unknownTaskTime } from "../task-order";

type View = { snapshot: RemoteTaskSnapshot; socket?: WebSocket; seq: number; retry?: ReturnType<typeof setTimeout>; closed: boolean; slots: Map<string, { attempt: number; order: number; lossy: boolean }> };
export function handsTask(value: unknown): RemoteTask {
  const row = record(value); const id = text(row.id);
  const createdAt = timestamp(row.created_at) ?? timestamp(row.updated_at) ?? unknownTaskTime;
  return { id, title: text(row.title) || "新任务", status: taskStatus(row.execution_status), createdAt, updatedAt: timestamp(row.updated_at) ?? createdAt };
}
export class OpenHandsTasks {
  private views = new Map<string, View>();
  private opening = new Map<string, symbol>();
  constructor(readonly http: RemoteHttp, private readonly token: () => Promise<string>, private readonly emit: (snapshot: RemoteTaskSnapshot) => void) {}
  async list(): Promise<RemoteTask[]> {
    const tasks: RemoteTask[] = []; let page = "";
    do {
      const result = await this.http.json<{ items: unknown[]; next_page_id?: string }>("/api/conversations/search?sort_order=UPDATED_AT_DESC&limit=100" + (page ? "&page_id=" + encodeURIComponent(page) : ""));
      tasks.push(...result.items.map(handsTask)); page = result.next_page_id ?? "";
    } while (page);
    return sortRemoteTasks(tasks);
  }
  async create(): Promise<RemoteTask> {
    const id = randomUUID();
    const workspace = await this.http.json<{ root: string }>("/api/selfme/workspace", "POST", { id });
    // Encrypted round-trip stays in the main process -> same server, not the renderer.
    const settings = await this.http.json<{ agent_settings: Record<string, unknown>; llm_api_key_is_set: boolean }>("/api/settings", "GET", undefined, { "X-Expose-Secrets": "encrypted" });
    if (!settings.llm_api_key_is_set) throw new Error("请先保存 OpenHands 的模型连接");
    const llm = record(settings.agent_settings.llm), model = text(llm.model).replace(/^(?:openai|anthropic)\//, "");
    const canonical = remoteCanonicalModel(text(llm.base_url), model), capabilities = record(llm.capability_overrides);
    const vision = knownRemoteVision(text(llm.base_url), model) ?? (typeof capabilities.supports_vision === "boolean" ? capabilities.supports_vision : undefined);
    const agent = { ...settings.agent_settings, llm: { ...llm, stream: true,
      ...(canonical ? { model_canonical_name: canonical } : {}),
      ...(vision !== undefined ? { capability_overrides: { ...record(llm.capability_overrides), supports_vision: vision } } : {}),
    }, tools: [
      { name: "terminal" }, { name: "file_editor" }, { name: "task_tracker" }, { name: "switch_llm" },
      { name: "browser_tool_set", params: { headless: false, chromium_sandbox: false, window_size: { width: 1280, height: 800 }, viewport: { width: 1280, height: 720 } } },
    ] };
    const result = await this.http.json("/api/conversations", "POST", { conversation_id: id, agent_settings: agent, secrets_encrypted: true,
      workspace: { working_dir: workspace.root }, confirmation_policy: { kind: "AlwaysConfirm" }, title: "新任务", max_iterations: 500 });
    return handsTask(result);
  }
  async open(id: string): Promise<RemoteTaskSnapshot> {
    remoteTaskId(id); this.close(id);
    const ticket = Symbol(id); this.opening.set(id, ticket);
    const task = handsTask(await this.http.json(`/api/conversations/${id}`));
    if (this.opening.get(id) !== ticket) throw new Error("任务视图已关闭");
    const snapshot: RemoteTaskSnapshot = { task, items: [], connection: "reconnecting" };
    const view: View = { snapshot, seq: -1, closed: false, slots: new Map() }; this.views.set(id, view);
    await this.stream(id, view); await this.inputQueue(id); return structuredClone(view.snapshot);
  }
  private async stream(id: string, view: View): Promise<void> {
    if (view.closed) return;
    const url = new URL(await this.http.base()); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/sockets/session/${id}`; url.searchParams.set("after_seq", String(view.seq));
    const token = await this.token(); if (view.closed) return;
    const socket = new WebSocket(url); view.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("OpenHands 会话连接超时")); }, 15_000);
      let ready = false; let synced = false; let through: number | undefined;
      const failed = (): void => { clearTimeout(timer); if (!ready) reject(new Error("OpenHands 会话连接失败")); };
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", session_api_key: token })));
      socket.addEventListener("message", message => {
        if (view.closed) return;
        try {
          const frame = record(JSON.parse(String(message.data)));
          // Native sync describes the replay range *before* its durable rows.
          // Resolve open only after that watermark, not with a blank history.
          if (frame.type === "sync") { synced = true; through = Number.isSafeInteger(frame.through_seq) ? Number(frame.through_seq) : undefined; }
          this.frame(view, frame);
          if (!ready && synced && (through === undefined || view.seq >= through)) { ready = true; clearTimeout(timer); view.snapshot.connection = "connected"; view.snapshot.error = undefined; resolve(); }
          this.emit(structuredClone(view.snapshot));
        } catch (error) { view.snapshot.error = error instanceof Error ? error.message : "会话输出解析失败"; }
      });
      socket.addEventListener("error", failed);
      socket.addEventListener("close", () => {
        failed(); if (view.closed) return;
        view.snapshot.connection = "reconnecting";
        // Drop partial text on a reconnect: the durable log supplies the truth.
        view.snapshot.items = view.snapshot.items.filter(item => !item.streaming); view.slots.clear(); this.emit(structuredClone(view.snapshot));
        view.retry = setTimeout(() => void this.stream(id, view).catch(error => { view.snapshot.error = String(error); this.emit(structuredClone(view.snapshot)); }), 1800);
      });
    });
  }
  private frame(view: View, frame: Record<string, unknown>): void {
    const snapshot = view.snapshot;
    if (frame.type === "durable" || frame.type === "transient") {
      const event = record(frame.event);
      if (text(event.id)) view.slots.delete(text(event.id));
      if (frame.type === "durable" && typeof frame.seq === "number") { if (frame.seq <= view.seq) return; view.seq = frame.seq; }
      if (event.kind === "ConversationStateUpdateEvent") {
        const state = event.key === "full_state" ? record(event.value) : { [text(event.key)]: event.value };
        if (state.execution_status) {
          snapshot.task.status = taskStatus(state.execution_status);
          if (snapshot.task.status !== "error") snapshot.failure = undefined;
        }
        const pending = Array.isArray(state.pending_actions) ? state.pending_actions.map(record) : [];
        if (snapshot.task.status === "waiting") {
          const tool = [...snapshot.items].reverse().find(item => item.tool?.status === "running");
          const actionIds = pending.map(action => text(action.id) || text(action.tool_call_id)).filter(Boolean);
          const approval = { id: "confirmation:" + (actionIds.join(":") || tool?.id || text(event.id)), title: "允许远端执行这些操作？", detail: pending.map(action => text(action.tool_name)).join("、") || tool?.tool?.input || "智能体正在等待你的确认", canAlways: true };
          snapshot.items = [...snapshot.items.filter(item => !item.approval), { id: "confirmation", role: "notice", text: "", approval }];
        } else snapshot.items = snapshot.items.filter(item => !item.approval);
      } else {
        snapshot.items = applyOpenHandsEvent(snapshot.items, event);
        if (event.kind === "ConversationErrorEvent") {
          snapshot.task.status = "error";
          snapshot.failure = executionFailure(text(event.detail) || text(event.error) || text(event.message), timestamp(event.timestamp));
        }
        // Native history is replayed on every view open. Never regress activity,
        // and include assistant/tool work rather than only the last user message.
        snapshot.task.updatedAt = latestTaskTime(snapshot.task.updatedAt, timestamp(event.timestamp));
      }
    } else if (frame.type === "item_started") {
      const id = text(frame.item_id), attempt = Number(frame.attempt ?? 1);
      if ((view.slots.get(id)?.attempt ?? 0) >= attempt || snapshot.items.some(item => item.id === id && !item.streaming)) return;
      view.slots.set(id, { attempt, order: -1, lossy: false });
      snapshot.items = [...snapshot.items.filter(item => item.id !== id), { id, role: "assistant", text: "", streaming: true }];
    } else if (frame.type === "delta") {
      const id = text(frame.item_id);
      const slot = view.slots.get(id), order = Number(frame.order);
      if (!slot || Number(frame.attempt ?? 1) !== slot.attempt || slot.lossy || !Number.isSafeInteger(order) || order <= slot.order) return;
      if ((slot.order >= 0 && order !== slot.order + 1) || (slot.order === -1 && order > 1)) { slot.lossy = true; snapshot.items = snapshot.items.filter(item => item.id !== id || !item.streaming); return; }
      slot.order = order;
      snapshot.items = snapshot.items.map(item => item.id !== id || !item.streaming ? item : frame.kind === "reasoning" ? { ...item, reasoning: (item.reasoning ?? "") + text(frame.content) } : { ...item, text: item.text + text(frame.content) });
    } else if (frame.type === "item_aborted") { if (view.slots.get(text(frame.item_id))?.attempt !== Number(frame.attempt ?? 1)) return; view.slots.delete(text(frame.item_id)); snapshot.items = snapshot.items.filter(item => item.id !== frame.item_id || !item.streaming); }
    else if (frame.type === "error") snapshot.error = text(frame.detail) || "会话连接发生错误";
  }
  private applyQueue(id: string, value: unknown): RemoteInputQueue {
    const next = remoteInputQueue(value), view = this.views.get(id);
    if (view) { view.snapshot.queue = mergeRemoteInputQueue(view.snapshot.queue, next); this.emit(structuredClone(view.snapshot)); }
    return next;
  }
  async inputQueue(id: string): Promise<RemoteInputQueue> {
    remoteTaskId(id); const view = this.views.get(id), revision = view?.snapshot.queue?.revision;
    const next = this.applyQueue(id, await this.http.json(`/api/selfme/inputs?task=${id}`));
    // User events are canonical native history, even when their live callback
    // was omitted. Never invent a submitted row for a still-pending input.
    if (view && revision !== undefined && revision !== next.revision) await this.inputHistory(id, view);
    return next;
  }
  private async inputHistory(id: string, view: View): Promise<void> {
      const page = await this.http.json<{ items: unknown[] }>(`/api/conversations/${id}/events/search?source=user&sort_order=TIMESTAMP_DESC&limit=10`).catch(() => null);
      if (this.views.get(id) === view) {
        for (const event of [...(page?.items ?? [])].reverse()) if (record(event).kind === "MessageEvent") {
          const before = view.snapshot.items;
          view.snapshot.items = applyOpenHandsEvent(before, event);
          const added = view.snapshot.items.find(item => item.id === record(event).id);
          if (added && !before.some(item => item.id === added.id) && added.at) {
            const remaining = view.snapshot.items.filter(item => item !== added);
            const index = remaining.findIndex(item => item.at && Date.parse(item.at) > Date.parse(added.at!));
            if (index >= 0) { remaining.splice(index, 0, added); view.snapshot.items = remaining; }
          }
        }
        this.emit(structuredClone(view.snapshot));
      }
  }
  async inputMode(id: string, mode: RemoteInputMode): Promise<RemoteInputQueue> { remoteTaskId(id); return this.applyQueue(id, await this.http.json("/api/selfme/inputs/mode", "POST", { task: id, mode })); }
  async inputAction(id: string, messageId: string, action: "remove" | "steer"): Promise<RemoteInputQueue> { remoteTaskId(id); return this.applyQueue(id, await this.http.json(`/api/selfme/inputs/${action}`, "POST", { task: id, messageId })); }
  async send(id: string, prompt: string, files: RemoteUploadedFile[] = [], options?: RemoteSendOptions): Promise<void> {
    remoteTaskId(id); if (!prompt.trim() && !files.length) throw new Error("请输入消息或上传文件");
    const view = this.views.get(id);
    const input = remoteSendOptions(options ?? { mode: view?.snapshot.queue?.mode ?? "queue", requestId: randomUUID() });
    this.applyQueue(id, await this.http.json("/api/selfme/inputs/send", "POST", { task: id, text: prompt, files, ...input }));
    if (view && !view.snapshot.queue?.items.some(item => item.id === input.requestId)) await this.inputHistory(id, view);
    if (view) { view.snapshot.error = undefined; this.emit(structuredClone(view.snapshot)); }
    // Naming failure must not turn an accepted message into a duplicate retry.
    void this.http.json(`/api/conversations/${id}`).then(async result => {
      if (handsTask(result).title === "新任务") { const title = prompt.trim().slice(0, 36) || files[0]?.name || "文件任务"; await this.http.json(`/api/conversations/${id}`, "PATCH", { title }); if (view) { view.snapshot.task.title = title; this.emit(structuredClone(view.snapshot)); } }
    }).catch(() => {});
  }
  async control(id: string, action: "stop" | "resume"): Promise<void> { remoteTaskId(id); this.applyQueue(id, await this.http.json("/api/selfme/inputs/control", "POST", { task: id, action })); }
  async approve(id: string, requestId: string, decision: "once" | "always" | "reject"): Promise<void> {
    remoteTaskId(id);
    const view = this.views.get(id);
    if (view?.snapshot.task.status !== "waiting" || !view.snapshot.items.some(item => item.approval?.id === requestId)) throw new Error("审批已结束或已改变，请确认当前操作");
    if (decision === "always") await this.http.json(`/api/conversations/${id}/confirmation_policy`, "POST", { policy: { kind: "NeverConfirm" } });
    await this.http.json(`/api/conversations/${id}/events/respond_to_confirmation`, "POST", { accept: decision !== "reject", reason: "用户拒绝此操作" });
  }
  async delete(id: string): Promise<void> { remoteTaskId(id); await this.control(id, "stop"); await this.http.json("/api/selfme/inputs/clear", "POST", { task: id }); await this.http.json(`/api/conversations/${id}`, "DELETE"); this.close(id); }
  close(id: string): void { this.opening.delete(id); const view = this.views.get(id); if (!view) return; view.closed = true; clearTimeout(view.retry); view.socket?.close(); this.views.delete(id); }
  shutdown(): void { this.opening.clear(); for (const id of this.views.keys()) this.close(id); this.http.reset(); }
}
