/** Keep the bottom anchored through viewport changes, without moving history readers. */
export function observeTranscriptLayout(
  output: HTMLElement,
  following: { current: boolean },
  onPosition: (nearLatest: boolean) => void,
): () => void {
  let frame: number | null = null;
  const sync = (): void => {
    frame = null;
    if (following.current) output.scrollTop = output.scrollHeight;
    onPosition(output.scrollHeight - output.scrollTop - output.clientHeight < 72);
  };
  const schedule = (): void => {
    if (frame === null) frame = window.requestAnimationFrame(sync);
  };
  // Queue expansion, growing drafts and native window resizing all change this viewport.
  const observer = new ResizeObserver(schedule);
  observer.observe(output);
  // Tool details change content height rather than viewport height; toggle does not bubble.
  output.addEventListener("toggle", schedule, true);
  return () => {
    observer.disconnect();
    output.removeEventListener("toggle", schedule, true);
    if (frame !== null) window.cancelAnimationFrame(frame);
  };
}
