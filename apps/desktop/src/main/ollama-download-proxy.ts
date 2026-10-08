/** Reuses an existing proxy for the child only; never changes OS or Electron proxy settings. */
export function ollamaDownloadProxy(env: NodeJS.ProcessEnv, systemRule = "DIRECT"): NodeJS.ProcessEnv {
  const first = systemRule.split(";")[0]?.trim() ?? "DIRECT";
  const match = /^(PROXY|HTTPS|SOCKS5?|SOCKS)\s+([^\s]+)$/u.exec(first);
  const systemProxy = match ? `${match[1] === "HTTPS" ? "https" : match[1].startsWith("SOCKS") ? "socks5" : "http"}://${match[2]}` : null;
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || systemProxy;
  if (!proxy) return {};
  return { HTTPS_PROXY: proxy, HTTP_PROXY: env.HTTP_PROXY || env.http_proxy || proxy,
    NO_PROXY: [env.NO_PROXY || env.no_proxy, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",") };
}
