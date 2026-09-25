export type AtlasFamilyId =
  | "intelligence"
  | "orchestration"
  | "execution"
  | "extensions"
  | "trust"
  | "experience"
  | "operations"
  | "frontiers";

export type AtlasSurface =
  | "cross"
  | "cli"
  | "ide"
  | "desktop"
  | "web"
  | "mobile"
  | "messaging"
  | "voice"
  | "api"
  | "embodied";

export type AtlasArea =
  | "cross"
  | "coding"
  | "work"
  | "personal"
  | "creative"
  | "research"
  | "physical";

export interface AtlasFamily {
  id: AtlasFamilyId;
  title: string;
  english: string;
  description: string;
  accent: string;
}

export interface AtlasDomain {
  id: string;
  familyId: AtlasFamilyId;
  title: string;
  description: string;
  surfaces: readonly AtlasSurface[];
  areas: readonly AtlasArea[];
  sourceIds: readonly string[];
}

export interface AtlasCapability {
  id: string;
  domainId: string;
  title: string;
  description: string;
  checks: readonly string[];
  surfaces: readonly AtlasSurface[];
  areas: readonly AtlasArea[];
}

export type ExperiencePhase =
  | "enter"
  | "compose"
  | "run"
  | "intervene"
  | "review"
  | "continue"
  | "craft";

export interface ExperiencePattern {
  id: string;
  phase: ExperiencePhase;
  title: string;
  intent: string;
  expected: string;
  checks: readonly string[];
  capabilityIds: readonly string[];
  surfaces: readonly AtlasSurface[];
  sourceIds: readonly string[];
}

export interface AtlasSource {
  id: string;
  product: string;
  form: string;
  title: string;
  url: string;
  note: string;
  reviewedAt: string;
}

export type CoverageState =
  | "unstarted"
  | "integrated"
  | "usable"
  | "verified"
  | "polished";
export type UpstreamState = "unknown" | "documented" | "tested";

export interface CoverageRecord {
  capabilityId: string;
  moduleId: string;
  harnessId?: string;
  platform?: AtlasSurface;
  state: CoverageState;
  upstream: UpstreamState;
  passedChecks: readonly number[];
  evidence: readonly string[];
  checkedAt: string;
  note: string;
}
