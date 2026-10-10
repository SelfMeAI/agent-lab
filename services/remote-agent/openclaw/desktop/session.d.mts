type Identity = { task: string; name: string; cwd: string };
export const contextPath: string;
export function terminalIdentity(task: unknown): Identity;
export function checkedTask(task: string): Promise<Identity>;
export function setDesktopTask(task: string): Promise<Identity>;
export function terminalArgv(task: string): string[];
export function prepareTerminal(task: string): Promise<Identity>;
export function showTerminal(task: string): Promise<void>;
export function disposeTerminal(task: string): Promise<void>;
