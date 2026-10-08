import { net, session } from "electron";
import type { Readable } from "node:stream";
import type { ModelMetadataFetch } from "./hf-model-metadata";

const maxMetadataBytes = 1024 * 1024;

/**
 * Electron net.fetch cancels manual redirects rather than exposing a 3xx
 * Response. Expose each hop ourselves so the metadata downloader can validate
 * its destination before sending another request. Keep the existing session's
 * network route, but never use its cookies or origin credentials.
 */
export const electronModelMetadataFetch: ModelMetadataFetch = async (url, options = {}) => {
  if ((options.method && options.method !== "GET") || options.body || options.redirect !== "manual" || options.credentials !== "omit") {
    throw new Error("模型配套文件只支持无凭据的手动跳转下载");
  }
  const signal = options.signal;
  signal?.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const request = net.request({ url, method: "GET", session: session.defaultSession, redirect: "manual", credentials: "omit", useSessionCookies: false });
    let settled = false;
    const finish = (response: Response): void => {
      if (settled) return;
      settled = true; signal?.removeEventListener("abort", abort);
      resolve(response);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true; signal?.removeEventListener("abort", abort);
      reject(error); request.abort();
    };
    const abort = (): void => fail(signal?.reason ?? new DOMException("下载已停止", "AbortError"));
    request.on("error", fail);
    request.once("abort", () => fail(new Error("模型配套文件下载已停止")));
    // In Electron 44 the outgoing Writable can close as soon as end() finishes,
    // before headers or body arrive. Only the incoming stream ends the response;
    // network errors still arrive on request, and the caller bounds the signal.
    request.once("redirect", (status, _method, location) => {
      if (settled) return;
      try { finish(new Response(null, { status, headers: { location } })); }
      catch (error) { fail(error); }
      // Settle first: abort/close (or Redirect was cancelled) must not turn an
      // intentional handoff into a failed download.
      request.abort();
    });
    request.once("response", (incoming) => {
      const parts: Buffer[] = []; let size = 0;
      // IncomingMessage is a Readable in Electron, although its generated types
      // omit the inherited close event.
      const stream = incoming as unknown as Readable;
      incoming.once("error", fail);
      incoming.once("aborted", () => fail(new Error("模型配套文件下载中断，请重试")));
      stream.once("close", () => fail(new Error("模型配套文件连接提前结束，请重试")));
      incoming.once("end", () => {
        if (settled) return;
        try {
          const headers = new Headers();
          for (const [name, values] of Object.entries(incoming.headers)) for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
          const body = [204, 205, 304].includes(incoming.statusCode) ? null : new Uint8Array(Buffer.concat(parts, size));
          finish(new Response(body, { status: incoming.statusCode, headers }));
        } catch (error) { fail(error); }
      });
      incoming.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.byteLength;
        if (size > maxMetadataBytes) { fail(new Error("模型配套文件超过允许大小")); return; }
        parts.push(chunk);
      });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else {
      try { request.end(); } catch (error) { fail(error); }
    }
  });
};
