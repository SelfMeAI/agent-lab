declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string }; shared?: boolean });
    viewOnly: boolean; showDotCursor: boolean; scaleViewport: boolean; resizeSession: boolean; clipViewport: boolean; qualityLevel: number; compressionLevel: number; background: string;
    disconnect(): void; sendCredentials(credentials: { password: string }): void;
  }
}
