import type { OllamaChunk } from "../../../../packages/runtime/src/ollama";

/** Rates exclude the first cached progress report, including when a new layer appears. */
export class DownloadProgress {
  private layers = new Map<string, { completed: number; total: number }>();
  private baseline: { time: number; completed: number } | null = null;
  private speed: number | null = null;

  receive(chunk: OllamaChunk, now = performance.now()): { completed: number | null; total: number | null; bytesPerSecond: number | null; remainingSeconds: number | null } {
    let cachedLayer = false;
    if (chunk.digest && Number.isFinite(chunk.total) && chunk.total! > 0) {
      const previous = this.layers.get(chunk.digest);
      const completed = typeof chunk.completed === "number" && Number.isFinite(chunk.completed) ? Math.max(0, Math.min(chunk.total!, chunk.completed)) : previous?.completed ?? 0;
      cachedLayer = !previous && completed > 0;
      this.layers.set(chunk.digest, { completed, total: chunk.total! });
    }
    if (!this.layers.size) return { completed: null, total: null, bytesPerSecond: null, remainingSeconds: null };
    const layers = [...this.layers.values()];
    const completed = layers.reduce((sum, layer) => sum + layer.completed, 0), total = layers.reduce((sum, layer) => sum + layer.total, 0);
    if (!this.baseline || cachedLayer || completed < this.baseline.completed) {
      this.baseline = { time: now, completed }; this.speed = null;
    } else if (now - this.baseline.time >= 500) {
      const rate = (completed - this.baseline.completed) * 1000 / (now - this.baseline.time);
      this.speed = rate <= 0 ? 0 : !this.speed ? rate : this.speed * .5 + rate * .5;
      this.baseline = { time: now, completed };
    }
    const pulling = chunk.status?.startsWith("pulling ") && chunk.status !== "pulling manifest";
    return { completed, total, bytesPerSecond: pulling && completed < total ? this.speed : null,
      remainingSeconds: pulling && this.speed && completed < total ? Math.ceil((total - completed) / this.speed) : null };
  }
}
