export interface RuntimeTarget {
  key: string;
  platform: string;
  arch: string;
  rustTarget: string;
  dockerPlatform: string;
}
export const runtimeTargets: readonly string[];
export function runtimeTarget(platform?: string, arch?: string): RuntimeTarget;
export function executableName(name: string, platform?: string): string;
export function ollamaExecutableRelativePath(platform?: string): string;
export function codexRuntimeFiles(platform?: string): string[];
export function dockerCliCandidates(platform?: string, env?: Record<string, string | undefined>): string[];
export function requireNativeTarget(platform?: string, arch?: string): RuntimeTarget;
