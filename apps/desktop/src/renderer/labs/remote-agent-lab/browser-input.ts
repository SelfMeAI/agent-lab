/** Map object-fit:contain pixels to the native page's CSS viewport, not its JPEG size. */
export function browserInputPoint(x: number, y: number, box: { left: number; top: number; width: number; height: number }, raster: { width: number; height: number }, viewport: { width: number; height: number }, clamp = false): { x: number; y: number } | undefined {
  if (![box.width, box.height, raster.width, raster.height, viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) return;
  const scale = Math.min(box.width / raster.width, box.height / raster.height);
  const width = raster.width * scale, height = raster.height * scale;
  const localX = x - box.left - (box.width - width) / 2, localY = y - box.top - (box.height - height) / 2;
  if (!clamp && (localX < 0 || localY < 0 || localX >= width || localY >= height)) return;
  return { x: Math.max(0, Math.min(viewport.width - 1, localX / width * viewport.width)), y: Math.max(0, Math.min(viewport.height - 1, localY / height * viewport.height)) };
}
/** The remote desktop is Linux; macOS Command shortcuts use its Control key. */
export function browserInputModifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey || event.metaKey ? 2 : 0) | (event.shiftKey ? 8 : 0);
}
