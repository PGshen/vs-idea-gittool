export interface StartupDeps<R> {
  /** Resolves once the repositories are discovered. */
  ready(): Promise<unknown>;
  /** The repository to show; undefined when the workspace has none. */
  repo(): R | undefined;
  /** `ideagittool.log.openOnStartup` (off by default). */
  enabled(): boolean;
  /** True when the main log is already open, e.g. restored by the panel serializer. */
  alreadyOpen(): boolean;
  show(repo: R): Promise<unknown>;
  /** Time given to a restored panel to come back before opening a new one. */
  delayMs?: number;
}

/** Shows the main log on startup when the user opted in with `ideagittool.log.openOnStartup`. */
export async function showLogOnStartup<R>(d: StartupDeps<R>): Promise<boolean> {
  await d.ready();
  const repo = d.repo();
  if (!repo || !d.enabled()) return false;
  await new Promise(r => setTimeout(r, d.delayMs ?? 1500));
  if (d.alreadyOpen()) return false;
  await d.show(repo);
  return true;
}
