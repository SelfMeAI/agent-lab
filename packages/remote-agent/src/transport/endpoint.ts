/** Server endpoints never contain credentials or a host task workspace. */
export function remoteEndpoint(value: string, allowLoopbackHttp = false): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) throw new Error("远端连接需要 HTTPS；研发服务可使用本机回环地址");
  if (url.username || url.password || url.search || url.hash) throw new Error("服务地址不能包含凭据、查询参数或片段");
  return url.toString().replace(/\/+$/, "");
}
