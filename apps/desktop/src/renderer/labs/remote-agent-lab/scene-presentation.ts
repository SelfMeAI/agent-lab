import type { RemoteBrowserOptions, RemoteBrowserTab, RemoteItem } from "../../../../../../packages/contracts/src/remote-agent";

/** Follow genuinely new pages, not arbitrary reordering of a CDP listing. */
export function followBrowserTab(previousIds: ReadonlySet<string>, tabs: RemoteBrowserTab[], currentId: string): string | undefined {
  const added = tabs.filter(tab => !previousIds.has(tab.targetId));
  const preferred = (values: RemoteBrowserTab[]) => (values.find(tab => tab.url && tab.url !== "about:blank") ?? values[0])?.targetId;
  if (added.length) return preferred(added);
  if (!tabs.some(tab => tab.targetId === currentId)) return preferred(tabs);
  return undefined;
}

/** Shell tools and command-like filesystem queries, not arbitrary file edits. */
export function remoteCommandItems(items: RemoteItem[]): RemoteItem[] {
  return items.filter(item => item.tool && /(?:^|[.:/_-])(?:terminal|exec(?:_command)?|bash|shell|run_command|run_cmd|process|ls|grep|find)(?:$|[.:/_-])/i.test(item.tool.name));
}

export function browserFrame(data: ArrayBuffer): { jpeg: Uint8Array; url?: string } {
  const bytes = new Uint8Array(data);
  if (bytes.length < 4) throw new Error("浏览器画面不完整");
  const length = new DataView(data).getUint32(0);
  if (!length || length > 32_000 || length + 6 >= bytes.length) throw new Error("浏览器画面不完整");
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
  const jpeg = bytes.subarray(4 + length);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("浏览器画面格式异常");
  return { jpeg, url: typeof metadata.url === "string" ? metadata.url : undefined };
}

export function observerLabel(state: "loading" | "connected" | "error", busy: boolean, control: boolean): string {
  if (busy || state === "loading") return "正在连接远端画面…";
  return state === "connected" ? control ? "CONTROL · 人工接管中" : "LIVE · 只读观察" : "观察连接已断开";
}

export function desktopInputEnabled(control: boolean, granted: boolean, state: "loading" | "connected" | "error", busy: boolean, dialog: boolean): boolean {
  return control && granted && state === "connected" && !busy && !dialog;
}

/** A reconnect is a fresh lookup, not a replay of a historical page identity. */
export function browserReconnectOptions(tabs: RemoteBrowserTab[], previousId: string, openIfMissing: boolean): RemoteBrowserOptions | undefined {
  if (!tabs.length && !openIfMissing) return undefined;
  return tabs.some(tab => tab.targetId === previousId) ? { targetId: previousId } : {};
}
