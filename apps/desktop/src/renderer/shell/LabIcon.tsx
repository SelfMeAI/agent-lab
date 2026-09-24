import type { JSX } from "react";
import type { LabId } from "../../../../../packages/contracts/src/index";

interface LabIconProps {
  labId?: LabId;
  runtimeId?: string;
  className?: string;
}

export function LabIcon({ labId, runtimeId, className }: LabIconProps): JSX.Element {
  const icon = runtimeId ?? labId;
  let art: JSX.Element;
  switch (icon) {
    case "agent-lab":
      art = <><path d="M32 8 51 19v26L32 56 13 45V19Z" /><circle cx="32" cy="8" r="4" /><circle cx="51" cy="19" r="4" /><circle cx="51" cy="45" r="4" /><circle cx="32" cy="56" r="4" /><circle cx="13" cy="45" r="4" /><circle cx="13" cy="19" r="4" /></>;
      break;
    case "remote-agent-lab":
      art = <><rect x="9" y="8" width="46" height="15" rx="2" /><rect x="9" y="41" width="46" height="15" rx="2" /><path d="M32 23v18M9 32h46" /><circle cx="32" cy="32" r="5" /><path d="M16 15h2m25 0h2M16 49h2m25 0h2" /></>;
      break;
    case "local-model-lab":
      art = <><path d="M32 6 55 19v27L32 59 9 46V19Z M9 19l23 14 23-14M32 33v26" /><path d="M20 26v13l8 4M44 26v13l-8 4" /></>;
      break;
    case "jev-lab":
      art = <><path d="M32 12v36M32 31 14 22M32 31l18-9" /><circle cx="32" cy="9" r="5" /><circle cx="13" cy="20" r="5" /><circle cx="51" cy="20" r="5" /><circle cx="32" cy="53" r="5" /></>;
      break;
    case "harness-forge":
      art = <><path d="m22 16-16 16 16 16m20-32 16 16-16 16M39 11 25 53" /></>;
      break;
    case "rsi-lab":
      art = <><path d="M53 28a22 22 0 0 0-39-10l-5 7M11 17v10h10M11 36a22 22 0 0 0 39 10l5-7M53 47V37H43" /></>;
      break;
    case "founder-studio":
      art = <><path d="M35 9H10v45h45V29M30 9h25v25M55 9 28 36" /></>;
      break;
    case "dsh":
      art = <><path d="M32 5 54 18v28L32 59 10 46V18Z M32 5v15m22-2-13 8m13 20-13-8M32 59V44M10 46l13-8M10 18l13 8" /><circle cx="32" cy="32" r="11" /><circle cx="32" cy="32" r="3" /></>;
      break;
    case "codex":
      art = <><path d="m32 7 24 13-24 13L8 20 32 7Zm-19 23L8 33l24 13 24-13-5-3M13 43l-5 3 24 13 24-13-5-3" /></>;
      break;
    case "pi":
      art = <><path d="M32 5 54 18v28L32 59 10 46V18Z" /><path d="M19 25h26M25 25v15m12-15v15m-12 0-4 3m16-3 4 3" /></>;
      break;
    case "kimi-code":
      art = <><rect x="13" y="7" width="38" height="50" /><circle cx="32" cy="32" r="6" fill="currentColor" stroke="none" /></>;
      break;
    case "qwen-code":
      art = <><path d="M32 5 54 18v28L32 59 10 46V18Z" /><circle cx="32" cy="24" r="4" /><circle cx="21" cy="42" r="4" /><circle cx="43" cy="42" r="4" /><path d="m30 27-8 12m12-12 8 12" /></>;
      break;
    case "claude-code":
      art = <><path d="M32 5 54 18v28L32 59 10 46V18Z M32 18v28m-12-21 24 14m0-14L20 39" /></>;
      break;
    default:
      art = <><circle cx="32" cy="32" r="23" /><path d="M32 18v28M18 32h28" /></>;
  }
  return <svg className={className} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{art}</svg>;
}
