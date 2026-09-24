import type { DesktopBridge } from "../../../../packages/contracts/src/index";

declare global {
  interface Window {
    selfmeLab?: DesktopBridge;
  }
}

export {};
