import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** One open input stream per native session; never close stdin at a turn boundary. */
export class ClaudeInput implements AsyncIterable<SDKUserMessage> {
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private readonly messages: SDKUserMessage[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude 会话已关闭");
    if (this.waiting) {
      const deliver = this.waiting;
      this.waiting = null;
      deliver({ value: message, done: false });
    } else this.messages.push(message);
  }

  close(): void {
    this.closed = true;
    this.messages.length = 0;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.messages.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => { this.waiting = resolve; });
      },
      return: async () => { this.close(); return { value: undefined, done: true }; },
    };
  }
}
