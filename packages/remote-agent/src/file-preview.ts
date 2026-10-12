/** One allow-list for both engines. Other formats remain download-only. */
export const officeExtensions = [".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"] as const;
export type RemotePreviewKind = "text" | "image" | "pdf" | "html" | "office" | "binary";
export function fileExtension(path: string): string { return /\.[^./\\]+$/.exec(path)?.[0].toLowerCase() ?? ""; }
export function remotePreviewKind(path: string): RemotePreviewKind {
  const ext = fileExtension(path);
  if ((officeExtensions as readonly string[]).includes(ext)) return "office";
  if ([".html", ".htm"].includes(ext)) return "html";
  if ([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  return [".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".toml", ".js", ".ts", ".tsx", ".jsx", ".py", ".sh", ".css", ".log", ".xml", ".sql", ".rs"].includes(ext) ? "text" : "binary";
}
