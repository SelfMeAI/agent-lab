import { labById } from "../labs/registry";
import type { LabModule } from "../labs/types";

export interface LabRoute {
  lab?: LabModule;
  viewId?: string;
  atlas?: boolean;
}

export function parseHash(hash: string): LabRoute {
  const [category, labId, viewId] = hash.replace(/^#\/?/, "").split("/");
  if (category === "atlas") return { atlas: true };
  if (category !== "lab") return {};
  const lab = labById(labId ?? "");
  if (!lab) return {};
  return { lab, viewId: lab.views.some((view) => view.id === viewId) ? viewId : undefined };
}

export function goHome(): void {
  window.location.hash = "#/";
}

export function goToAtlas(): void {
  window.location.hash = "#/atlas";
}

export function goToLab(labId: string, viewId?: string): void {
  window.location.hash = viewId ? `#/lab/${labId}/${viewId}` : `#/lab/${labId}`;
}
