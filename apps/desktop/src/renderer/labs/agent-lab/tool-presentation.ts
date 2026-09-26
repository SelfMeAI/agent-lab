import { diffLines } from "diff";
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
  durationMs?: number;
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
  const all = lines(diff).filter((text) => !/^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode )/u.test(text)).map((text): DiffLine => ({
    kind: text.startsWith("@@") ? "header"
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

export function visibleTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const runsWithTurnDiff = new Set(entries.filter((entry) =>
    entry.kind === "tool" && record(entry.raw).type === "turnDiff" && string(record(entry.raw).diff),
  ).map((entry) => entry.runId));
  return entries.filter((entry) => !(entry.kind === "tool" && runsWithTurnDiff.has(entry.runId) && record(entry.raw).type === "fileChange"));
}

function turnDiff(diff: string): FileChangeView[] {
  const sections = diff.split(/(?=^diff --git )/m).filter((section) => section.startsWith("diff --git "));
  if (sections.length === 0) return diff.trim() ? [unifiedDiff("本轮改动", "变更", diff)] : [];
  return sections.map((section) => {
    const sectionLines = lines(section);
    const oldPath = sectionLines.find((line) => line.startsWith("--- a/"))?.slice(6);
    const newPath = sectionLines.find((line) => line.startsWith("+++ b/"))?.slice(6);
    const headerPath = sectionLines[0]?.match(/^diff --git a\/(.*?) b\/(.*)$/)?.[2];
    const path = newPath ?? oldPath ?? headerPath ?? "未知文件";
    const action = sectionLines.some((line) => line.startsWith("new file mode ")) ? "新增"
      : sectionLines.some((line) => line.startsWith("deleted file mode ")) ? "删除" : "修改";
    return unifiedDiff(path, action, section);
  });
}

function acpDiff(path: string, oldText: string | undefined, newText: string): FileChangeView {
  const changes = diffLines(oldText ?? "", newText);
  const all: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const [index, change] of changes.entries()) {
    const chunk = lines(change.value);
    if (change.added || change.removed) {
      const kind = change.added ? "add" : "remove";
      const sign = change.added ? "+" : "-";
      if (change.added) added += chunk.length;
      else removed += chunk.length;
      all.push(...chunk.map((text): DiffLine => ({ kind, text: `${sign}${text}` })));
      continue;
    }
    const visible = chunk.length <= 4 ? chunk
      : index === 0 ? chunk.slice(-2)
        : index === changes.length - 1 ? chunk.slice(0, 2)
          : [...chunk.slice(0, 2), `… ${chunk.length - 4} 行未改动 …`, ...chunk.slice(-2)];
    all.push(...visible.map((text): DiffLine => text.startsWith("… ")
      ? { kind: "header", text }
      : { kind: "context", text: ` ${text}` }));
  }
  const shown = preview(all);
  return { path, action: oldText === undefined ? "新增" : "修改", added, removed, ...shown };
}

const kindLabels: Record<string, string> = {
  read: "读取文件", edit: "编辑文件", write: "写入文件", bash: "执行命令", delete: "删除文件", move: "移动文件",
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
  const rawInput = record(raw.rawInput);
  const action = entry.title?.match(/^(read|edit|write|bash|delete|move|search|execute|fetch)\b/i)?.[1]?.toLowerCase();
  const titlePath = string(rawInput.file_path) ?? entry.title?.match(/<path>([^<]+)<\/path>/)?.[1] ?? entry.text.match(/<path>([^<]+)<\/path>/)?.[1];
  const cleanTitle = entry.title?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const label = type === "turnDiff" ? "本轮文件变更" : type === "fileChange" ? "文件修改" : type === "commandExecution" ? "执行命令"
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

  if (type === "turnDiff" && typeof raw.diff === "string") files.push(...turnDiff(raw.diff));
  if (type === "turnDiff" && files.length === 0) notes.push("本轮没有保留文件改动");

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

  const command = string(raw.command) ?? string(rawInput.command);
  const cwd = string(raw.cwd);
  const nativeOutput = record(raw.rawOutput);
  const exitCode = typeof raw.exitCode === "number" ? raw.exitCode
    : typeof nativeOutput.exitCode === "number" ? nativeOutput.exitCode : undefined;
  const measured = raw.durationMs ?? record(raw._meta).durationMs;
  const durationMs = typeof measured === "number" && Number.isFinite(measured) && measured >= 0 ? measured : undefined;
  if (!output && raw.rawOutput !== undefined) {
    output = string(raw.rawOutput) ?? string(record(raw.rawOutput).text);
  }
  if (!output && entry.text) output = entry.text;
  if (files.length > 0 && output && /^The file .+ has been updated successfully\.?$/i.test(output.trim())) output = undefined;
  if (output?.includes("<content>")) {
    const content = output.match(/<content>\s*\n?([\s\S]*?)(?:<\/content>|$)/)?.[1];
    if (content !== undefined) output = content.trimEnd();
  }
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const summary = files.length ? `${files.length} 个文件 · +${added} −${removed}`
    : command ? string(rawInput.description) ?? command
      : locations.length ? locations.slice(0, 2).join(" · ")
        : cleanTitle && cleanTitle !== label ? cleanTitle
          : entry.text?.trim().split("\n")[0] ?? "";
  return {
    label, status: statusLabels[entry.toolStatus ?? ""] ?? (entry.kind === "status" ? "更新" : "进行中"),
    summary, command, cwd, output, exitCode, durationMs, files, plan, locations, notes,
  };
}
