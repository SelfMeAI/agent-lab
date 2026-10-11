// Public SDK boundary supplied by the pinned source-built Gateway container.
// The desktop does not load this module. This declaration allows its plugin
// to be type-checked by our hook tests without installing another harness.
declare module "openclaw/plugin-sdk/gateway-method-runtime" {
  export function dispatchGatewayMethod(method: string, params?: unknown, options?: { expectFinal?: boolean; timeoutMs?: number }): Promise<{
    ok: boolean; payload?: unknown;
    error?: { code: string; message: string; details?: unknown; retryable?: boolean; retryAfterMs?: number };
    meta?: Record<string, unknown>;
  }>;
}
