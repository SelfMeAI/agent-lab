import type { JSX, ReactNode } from "react";
import type { LabId } from "../../../../../packages/contracts/src/index";
import { LabIcon } from "./LabIcon";

export function LabIndexHeader({ title, subtitle, labId, actions }: {
  title: string; subtitle?: string; labId?: LabId; actions?: ReactNode;
}): JSX.Element {
  return <header className="lab-index-heading">
    {labId && <LabIcon labId={labId} className="lab-index-heading__icon" />}
    <div className="lab-index-heading__copy"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
    {actions && <div className="lab-index-heading__actions">{actions}</div>}
  </header>;
}
