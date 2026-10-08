import type { LocalModelDownload } from "../../../../../../packages/contracts/src/local-model";

export function downloadInProgress(download?: LocalModelDownload | null): boolean {
  return Boolean(download && ["downloading", "pausing", "cancelling"].includes(download.status));
}

export function downloadPercent(download: LocalModelDownload): number | null {
  return download.total && download.completed !== null ? Math.max(0, Math.min(100, download.completed / download.total * 100)) : null;
}

export function formatDownloadRate(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "计算速度中…";
  if (bytes <= 0) return "等待下载数据…";
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB/s`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} KB/s`;
  return bytes < 1 ? "<1 B/s" : `${Math.round(bytes)} B/s`;
}

export function formatDownloadRemaining(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟`;
  return `约 ${(seconds / 3600).toFixed(1)} 小时`;
}

export const downloadStatus = { downloading: "下载中", pausing: "暂停中", paused: "已暂停", cancelling: "取消中", cancelled: "已取消", complete: "已下载", error: "下载失败" } as const;

export function downloadStatusLabel(download: LocalModelDownload): string {
  if (download.status === "downloading") {
    if (download.message === "校验文件") return "校验中";
    if (download.message === "安装模型" || download.message === "模型验证完成") return "安装中";
  }
  return downloadStatus[download.status];
}
