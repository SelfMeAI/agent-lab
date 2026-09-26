interface QuitLifecycle {
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): unknown;
  once(event: "will-quit", listener: () => void): unknown;
  quit(): void;
}

/** Stop children before closing windows; keep SQLite readable until they are gone. */
export function installAppShutdown(
  app: QuitLifecycle,
  stopSessions: () => Promise<void>,
  closeDatabase: () => void,
  reportError: (error: unknown) => void,
): { isQuitting(): boolean } {
  let stopping: Promise<void> | null = null;
  let stopped = false;

  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    // Repeated Quit requests share the same cleanup. They must not stop sessions
    // twice or let a faster duplicate shutdown close storage under the renderer.
    stopping ??= Promise.resolve().then(stopSessions).catch(reportError).then(() => {
      stopped = true;
      // Leave Electron's current native Quit callback before resuming Quit.
      // An already-resolved cleanup must not re-enter it in a microtask.
      setImmediate(() => app.quit());
    });
  });
  // Electron emits will-quit after all windows have closed, unlike before-quit.
  app.once("will-quit", closeDatabase);
  return { isQuitting: () => stopping !== null };
}
