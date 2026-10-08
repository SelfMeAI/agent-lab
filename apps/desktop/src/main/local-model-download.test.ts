import { describe, expect, it } from "vitest";
import { DownloadProgress } from "./local-model-download";

describe("real-byte download presentation", () => {
  it("never counts resumed cache as transfer speed and waits for a real sample", () => {
    const progress = new DownloadProgress();
    expect(progress.receive({ status: "pulling manifest" }, 0)).toMatchObject({ total: null, bytesPerSecond: null });
    expect(progress.receive({ status: "pulling layer", digest: "one", completed: 800, total: 1000 }, 100)).toMatchObject({ completed: 800, bytesPerSecond: null });
    expect(progress.receive({ status: "pulling layer", digest: "one", completed: 900, total: 1000 }, 1100)).toMatchObject({ completed: 900, bytesPerSecond: 100, remainingSeconds: 1 });
    expect(progress.receive({ status: "verifying sha256 digest" }, 1200)).toMatchObject({ completed: 900, bytesPerSecond: null, remainingSeconds: null });
  });
  it("aggregates layers, preserves omitted progress and clamps malformed counts", () => {
    const progress = new DownloadProgress();
    progress.receive({ digest: "one", total: 100, completed: 90 }, 0);
    expect(progress.receive({ digest: "one", total: 100 }, 100)).toMatchObject({ completed: 90 });
    expect(progress.receive({ digest: "two", total: 20, completed: 50 }, 1000)).toMatchObject({ completed: 110, total: 120, bytesPerSecond: null });
    expect(progress.receive({ digest: "two", total: 20, completed: -1 }, 2000)).toMatchObject({ completed: 90, total: 120 });
    expect(progress.receive({ status: "success" }, 3000)).toMatchObject({ bytesPerSecond: null, remainingSeconds: null });
  });
  it("clears the estimate on a stalled layer instead of decaying to astronomical remaining times", () => {
    const progress = new DownloadProgress();
    progress.receive({ status: "pulling layer", digest: "one", total: 10000, completed: 0 }, 0);
    expect(progress.receive({ status: "pulling layer", digest: "one", total: 10000, completed: 1000 }, 1000)).toMatchObject({ bytesPerSecond: 1000, remainingSeconds: 9 });
    for (let second = 2; second <= 200; second++) expect(progress.receive({ status: "pulling layer", digest: "one", total: 10000, completed: 1000 }, second * 1000)).toMatchObject({ bytesPerSecond: 0, remainingSeconds: null });
    expect(progress.receive({ status: "pulling layer", digest: "one", total: 10000, completed: 2000 }, 201000)).toMatchObject({ bytesPerSecond: 1000, remainingSeconds: 8 });
  });
  it("includes not-yet-started companion files and never counts the first planned cache report as speed", () => {
    const progress = new DownloadProgress();
    progress.plan([{ digest: "weights", total: 219309792 }, { digest: "license", total: 10596 }, { digest: "config", total: 700 }]);
    expect(progress.receive({ status: "pulling manifest" }, 0)).toMatchObject({ completed: 0, total: 219321088 });
    expect(progress.receive({ status: "pulling cached model", digest: "weights", total: 219309792, completed: 219309792 }, 1000)).toMatchObject({ completed: 219309792, total: 219321088, bytesPerSecond: null });
    expect(progress.receive({ status: "pulling metadata license", digest: "license", total: 10596, completed: 0 }, 1100)).toMatchObject({ completed: 219309792 });
    expect(progress.receive({ status: "pulling metadata license", digest: "license", total: 10596, completed: 10596 }, 2000)).toMatchObject({ completed: 219320388, total: 219321088 });
  });
});
