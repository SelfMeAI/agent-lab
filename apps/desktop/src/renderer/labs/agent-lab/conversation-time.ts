function parseTimestamp(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function calendarDayKey(value: string): string | null {
  const date = parseTimestamp(value);
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : null;
}

export function clockTime(value: string, withSeconds = false): string | null {
  const date = parseTimestamp(value);
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}${withSeconds ? `:${pad(date.getSeconds())}` : ""}` : null;
}

export function exactTime(value: string): string | null {
  const date = parseTimestamp(value);
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clockTime(value, true)}` : null;
}

export function dateDividerLabel(value: string, now = new Date()): string | null {
  const date = parseTimestamp(value);
  if (!date) return null;
  const shortDate = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (sameDay(date, now)) return `今天 · ${shortDate}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 · ${shortDate}`;
  return date.getFullYear() === now.getFullYear() ? shortDate : `${date.getFullYear()}年${shortDate}`;
}

export function sessionTimeLabel(value: string, now = new Date()): string | null {
  const date = parseTimestamp(value);
  if (!date) return null;
  const time = clockTime(value)!;
  if (sameDay(date, now)) return time;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${time}`;
  return date.getFullYear() === now.getFullYear()
    ? `${date.getMonth() + 1}/${date.getDate()} ${time}`
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function elapsedTime(startedAt: string, now = Date.now()): string | null {
  const start = parseTimestamp(startedAt)?.getTime();
  if (start === undefined) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}`
    : `${pad(minutes)}:${pad(seconds % 60)}`;
}

export function shortDuration(milliseconds: number): string | null {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return milliseconds < 100 ? "<0.1s" : `${(milliseconds / 1000).toFixed(1)}s`;
}

export function durationBetween(startedAt: string, finishedAt: string): string | null {
  const start = parseTimestamp(startedAt)?.getTime();
  const finish = parseTimestamp(finishedAt)?.getTime();
  if (start === undefined || finish === undefined || finish < start) return null;
  return shortDuration(finish - start);
}
