/** Official declared capabilities; unknown/proxied IDs need an explicit choice.
 * Source: https://api-docs.deepseek.com/quick_start/pricing/ (2026-10-10).
 */
export function knownRemoteVision(baseUrl: string, model: string): boolean | undefined {
  try {
    if (new URL(baseUrl).hostname !== "api.deepseek.com") return undefined;
    if (["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model)) return true;
    if (model === "deepseek-v4-pro") return false;
  } catch { /* Incomplete address while editing. */ }
  return undefined;
}

/** Keep OpenAI-compatible transport while using native SDK feature metadata. */
export function remoteCanonicalModel(baseUrl: string, model: string): string | null {
  try {
    if (new URL(baseUrl).hostname === "api.deepseek.com") {
      if (["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model)) return "deepseek/deepseek-v4.1-flash";
      if (model.startsWith("deepseek-")) return `deepseek/${model}`;
    }
  } catch { /* Validated by the connection form. */ }
  return null;
}
