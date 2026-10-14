import { lstatSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export const applicationName = "Agent Lab";
// These identifiers are exclusively for adopting an existing installation.
// Keep its absolute paths, OS encryption identity and remote volume ownership;
// never rename histories or silently initialize replacement credentials.
export const legacyApplicationName = "SelfMe Lab";
export const legacyResourceNamespace = "selfme-lab";
export const legacyOwnerLabel = "ai.selfme.lab.owner";
export const legacyDesktopHome = ".selfme-desktop/home";
export const ownerLabel = "ai.agent-lab.desktop.owner";

export function ownedResource(labels: Record<string, string> | null | undefined, owner: string): boolean {
  const current = labels?.[ownerLabel];
  const previous = labels?.[legacyOwnerLabel];
  return (current !== undefined || previous !== undefined)
    && (current === undefined || current === owner) && (previous === undefined || previous === owner);
}

export function legacyApplicationRoot(root: string): boolean {
  return basename(root) === legacyApplicationName;
}

export function applicationIdentity(appData: string, testAppData?: string): { root: string; encryptionName: string } {
  const directory = (path: string) => {
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("应用数据目录必须是真实目录");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  // Release smoke tests must never discover or modify an existing user profile.
  // This explicit opt-in is process-local, not a saved application preference.
  if (testAppData !== undefined && (!isAbsolute(testAppData) || !directory(testAppData))) throw new Error("测试数据根目录必须是已创建的真实绝对目录");
  const base = testAppData ?? appData;
  const current = join(base, applicationName);
  const legacy = join(base, legacyApplicationName);
  if (!directory(current) && directory(legacy)) return { root: legacy, encryptionName: legacyApplicationName };
  return { root: current, encryptionName: applicationName };
}
