import type { ComponentType } from "react";
import type { LabDefinition } from "../../../../../packages/contracts/src/index";

export interface LabPageProps {
  lab: LabModule;
  viewId?: string;
  onOpenSettings?(): void;
  providerRevision?: number;
}

export interface LabModule extends LabDefinition {
  purpose: string;
  Page?: ComponentType<LabPageProps>;
}
