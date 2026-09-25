import type { TranscriptEntry } from "./agent-store";

type RecordValue = Record<string, unknown>;

export interface DiffLine {
  kind: "add" | "remove" | "context" | "header";
  text: string;
}

export interface FileChangeView {
  path: string;
  action: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  hiddenLines: number;
}

export interface PlanStepView {
  text: string;
  status: string;
}

export interface EntryPresentation {
  label: string;
  status: string;
  summary: string;
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  duration?: string;
  files: FileChangeView[];
  plan: PlanStepView[];
  locations: string[];
  notes: string[];
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function lines(value: string): string[] {
  const result = value.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function preview(all: DiffLine[]): Pick<FileChangeView, "lines" | "hiddenLines"> {
  const limit = 160;
  return { lines: all.slice(0, limit), hiddenLines: Math.max(0, all.length - limit) };
}

function unifiedDiff(path: string, action: string, diff: string): FileChangeView {
  const all = lines(diff).map((text): DiffLine => ({
    kind: text.startsWith("+++") || text.startsWith("---") || text.startsWith("@@") || text.startsWith("diff ") || text.startsWith("index ") ? "header"
      : text.startsWith("+") ? "add"
        : text.startsWith("-") ? "remove" : "context",
    text,
  }));
  const { lines: shown, hiddenLines } = preview(all);
  return {
    path, action,
    added: all.filter((line) => line.kind === "add").length,
    removed: all.filter((line) => line.kind === "remove").length,
    lines: shown, hiddenLines,
  };
}

function acpDiff(path: string, oldText: string | undefined, newText: string): FileChangeView {
  const oldLines = oldText === undefined ? [] : lines(oldText);
  const newLines = lines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)) suffix++;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const all: DiffLine[] = [
    ...oldLines.slice(Math.max(0, prefix - 2), prefix).map((text): DiffLine => ({ kind: "context", text: ` ${text}` })),
    ...removed.map((text): DiffLine => ({ kind: "remove", text: `-${text}` })),
    ...added.map((text): DiffLine => ({ kind: "add", text: `+${text}` })),
    ...oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + 2).map((text): DiffLine => ({ kind: "context", text: ` ${text}` })),
  ];
  const shown = preview(all);
  return { path, action: oldText === undefined ? "新增" : "修改", added: added.length, removed: removed.length, ...shown };
}

const kindLabels: Record<string, string> = {
  read: "读取文件", edit: "编辑文件", delete: "删除文件", move: "移动文件",
  search: "搜索", execute: "执行命令", think: "分析", fetch: "获取内容", switch_mode: "切换模式",
};

const statusLabels: Record<string, string> = {
  pending: "等待中", in_progress: "进行中", inProgress: "进行中", running: "进行中",
  completed: "已完成", finished: "已完成", failed: "失败", interrupted: "已中断",
};

export function presentEntry(entry: TranscriptEntry): EntryPresentation {
  const raw = record(entry.raw);
  const type = string(raw.type);
  const kind = string(raw.kind);
  const action = entry.title?.match(/^(read|edit|delete|move|search|execute|fetch)\b/i)?.[1]?.toLowerCase();
  const titlePath = entry.title?.match(/<path>([^<]+)<\/path>/)?.[1] ?? entry.text.match(/<path>([^<]+)<\/path>/)?.[1];
  const cleanTitle = entry.title?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const label = type === "fileChange" ? "文件修改" : type === "commandExecution" ? "执行命令"
    : type === "webSearch" ? "网页搜索" : action ? kindLabels[action] ?? cleanTitle ?? "工具调用"
      : kind ? kindLabels[kind] ?? cleanTitle ?? "工具调用"
        : cleanTitle ?? (entry.kind === "status" ? "运行状态" : "工具调用");
  const files: FileChangeView[] = [];
  const notes: string[] = [];
  let output = string(raw.aggregatedOutput) ?? string(entry.text);

  if (type === "fileChange" && Array.isArray(raw.changes)) {
    for (const value of raw.changes) {
      const change = record(value);
      const path = string(change.path);
      if (!path) continue;
      const changeKind = string(record(change.kind).type);
      const action = changeKind === "add" ? "新增" : changeKind === "delete" ? "删除" : changeKind === "update" ? "修改" : "变更";
      files.push(unifiedDiff(path, action, string(change.diff) ?? ""));
    }
  }

  if (Array.isArray(raw.content)) {
    for (const value of raw.content) {
      const content = record(value);
      if (content.type === "diff") {
        const path = string(content.path);
        const newText = typeof content.newText === "string" ? content.newText : undefined;
        if (path && newText !== undefined) files.push(acpDiff(path, typeof content.oldText === "string" ? content.oldText : undefined, newText));
      } else if (content.type === "content") {
        const text = string(record(content.content).text);
        if (text && !output?.includes(text)) notes.push(text);
      }
    }
  }

  const locations = Array.isArray(raw.locations) ? raw.locations.map((value) => {
    const location = record(value);
    const path = string(location.path);
    return path ? `${path}${typeof location.line === "number" ? `:${location.line}` : ""}` : "";
  }).filter(Boolean) : [];
  if (titlePath && !locations.includes(titlePath)) locations.unshift(titlePath);

  const planValue = Array.isArray(raw.plan) ? raw.plan : Array.isArray(raw.entries) ? raw.entries : [];
  const plan = planValue.map((value): PlanStepView | null => {
    const step = record(value);
    const text = string(step.step) ?? string(step.content);
    return text ? { text, status: string(step.status) ?? "pending" } : null;
  }).filter((value): value is PlanStepView => value !== null);

  const command = string(raw.command) ?? (kind === "execute" ? string(record(raw.rawInput).command) : undefined);
  const cwd = string(raw.cwd);
  const exitCode = typeof raw.exitCode === "number" ? raw.exitCode : undefined;
  const duration = typeof raw.durationMs === "number" ? `${(raw.durationMs / 1000).toFixed(1)}s` : undefined;
  if (!output && raw.rawOutput !== undefined) {
    output = string(raw.rawOutput) ?? string(record(raw.rawOutput).text);
  }
  if (!output && entry.text) output = entry.text;
  if (output?.includes("<content>")) {
    const content = output.match(/<content>\s*\n?([\s\S]*?)(?:<\/content>|$)/)?.[1];
    if (content !== undefined) output = content.trimEnd();
  }
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const summary = files.length ? `${files.length} 个文件 · +${added} −${removed}`
    : command ? command
      : locations.length ? locations.slice(0, 2).join(" · ")
        : cleanTitle && cleanTitle !== label ? cleanTitle
          : entry.text?.trim().split("\n")[0] ?? "";
  return {
    label, status: statusLabels[entry.toolStatus ?? ""] ?? (entry.kind === "status" ? "更新" : "进行中"),
    summary, command, cwd, output, exitCode, duration, files, plan, locations, notes,
  };
}
