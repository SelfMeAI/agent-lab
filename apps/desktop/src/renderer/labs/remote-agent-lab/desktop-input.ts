/** Keep noVNC's mouse capture inside the lifetime of its own framebuffer. */
export function desktopInputBoundary(host: HTMLElement): { release(): void; dispose(): void } {
  const document = host.ownerDocument;
  const window = document.defaultView;
  if (!window) return { release() {}, dispose() {} };
  const capture = document as Document & { captureElement?: Element | null };
  let position = { clientX: 0, clientY: 0 };
  let releasing = false;
  const releaseMouse = () => {
    if (releasing || !capture.captureElement || !host.contains(capture.captureElement)) return;
    releasing = true;
    try {
      // Let noVNC's normal mouseup handler release its proxy and the remote
      // button state. Do not edit its private fields or another viewer's capture.
      window.dispatchEvent(new window.MouseEvent("mouseup", { ...position, buttons: 0, bubbles: true }));
    } finally { releasing = false; }
  };
  const release = () => {
    releaseMouse();
    const focused = document.activeElement as HTMLElement | null;
    if (focused && host.contains(focused)) focused.blur();
  };
  const pointer = (event: PointerEvent) => {
    position = { clientX: event.clientX, clientY: event.clientY };
    // A missed mouseup (for example while switching windows) must not leave
    // the full-window capture proxy blocking the client's own controls.
    if (event.buttons === 0) releaseMouse();
  };
  const hidden = () => { if (document.visibilityState === "hidden") release(); };
  window.addEventListener("pointermove", pointer, true);
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", hidden);
  return { release, dispose() {
    release();
    window.removeEventListener("pointermove", pointer, true);
    window.removeEventListener("blur", release);
    document.removeEventListener("visibilitychange", hidden);
  } };
}
