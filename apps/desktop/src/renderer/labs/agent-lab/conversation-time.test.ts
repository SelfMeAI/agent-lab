import { describe, expect, it } from "vitest";
import { calendarDayKey, clockTime, dateDividerLabel, durationMsBetween, elapsedTime, exactTime, sessionTimeLabel, toolDuration, turnDuration } from "./conversation-time";

function localTime(year: number, month: number, day: number, hour: number, minute: number, second = 0): string {
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

describe("agent conversation time", () => {
  it("shows local calendar dates and precise message times", () => {
    const at = localTime(2026, 9, 26, 14, 32, 7);
    expect(calendarDayKey(at)).toBe("2026-09-26");
    expect(clockTime(at)).toBe("14:32");
    expect(exactTime(at)).toBe("2026-09-26 14:32:07");
    expect(dateDividerLabel(at, new Date(2026, 8, 26, 18))).toBe("今天 · 9月26日");
    expect(dateDividerLabel(at, new Date(2026, 8, 27, 9))).toBe("昨天 · 9月26日");
    expect(sessionTimeLabel(at, new Date(2026, 8, 27, 9))).toBe("昨天 14:32");
  });

  it("uses compact older dates and handles year boundaries", () => {
    const at = localTime(2025, 12, 31, 23, 59);
    expect(dateDividerLabel(at, new Date(2026, 0, 1, 9))).toBe("昨天 · 12月31日");
    expect(sessionTimeLabel(at, new Date(2026, 0, 2, 9))).toBe("2025/12/31");
  });

  it("formats elapsed work and tool duration without inventing invalid times", () => {
    const start = localTime(2026, 9, 26, 14, 32, 0);
    const finish = localTime(2026, 9, 26, 14, 32, 7);
    expect(elapsedTime(start, new Date(finish).getTime())).toBe("00:07");
    expect(elapsedTime(start, new Date(start).getTime() + 3_726_000)).toBe("1:02:06");
    expect(durationMsBetween(start, finish)).toBe(7000);
    expect(durationMsBetween(finish, start)).toBeNull();
    expect(turnDuration(start, finish)).toBe("00:07");
    expect(turnDuration(start, start)).toBe("<1 秒");
    expect(toolDuration(0)).toBe("<1ms");
    expect(toolDuration(0.5)).toBe("<1ms");
    expect(toolDuration(42)).toBe("42ms");
    expect(toolDuration(999)).toBe("999ms");
    expect(toolDuration(1000)).toBe("1.0s");
    expect(toolDuration(1900)).toBe("1.9s");
    expect(toolDuration(90_000)).toBe("1m 30s");
    expect(toolDuration(3_726_000)).toBe("1h 2m 6s");
    expect(toolDuration(-1)).toBeNull();
    expect(toolDuration(Number.NaN)).toBeNull();
    expect(exactTime("not-a-timestamp")).toBeNull();
    expect(dateDividerLabel("not-a-timestamp")).toBeNull();
  });
});
