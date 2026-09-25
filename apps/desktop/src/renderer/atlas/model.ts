import { atlasCapabilities, atlasDomains } from "./catalog";
import { atlasModules, coverageRecords } from "./coverage";
import type {
  AtlasArea,
  AtlasCapability,
  AtlasSurface,
  CoverageRecord,
  CoverageState,
} from "./types";

export const surfaceOptions: readonly {
  id: AtlasSurface | "all";
  title: string;
}[] = [
  { id: "all", title: "全部形态" },
  { id: "cli", title: "CLI" },
  { id: "ide", title: "IDE" },
  { id: "desktop", title: "桌面" },
  { id: "web", title: "Web" },
  { id: "mobile", title: "移动" },
  { id: "messaging", title: "IM" },
  { id: "voice", title: "语音" },
  { id: "api", title: "API" },
  { id: "embodied", title: "具身" },
];

export const areaOptions: readonly { id: AtlasArea | "all"; title: string }[] =
  [
    { id: "all", title: "全部场景" },
    { id: "coding", title: "编程" },
    { id: "work", title: "工作" },
    { id: "personal", title: "个人" },
    { id: "creative", title: "创作" },
    { id: "research", title: "研究" },
    { id: "physical", title: "物理世界" },
  ];

export const coverageTitles: Record<CoverageState, string> = {
  unstarted: "未接入",
  integrated: "已接入",
  usable: "可使用",
  verified: "已验证",
  polished: "已打磨",
};

export const coverageOrder: readonly CoverageState[] = [
  "unstarted",
  "integrated",
  "usable",
  "verified",
  "polished",
];

export function matchesDimension(
  values: readonly string[],
  selected: string,
): boolean {
  return (
    selected === "all" || values.includes("cross") || values.includes(selected)
  );
}

export function scopedCapabilities(moduleId: string): AtlasCapability[] {
  const scope = atlasModules.find((entry) => entry.id === moduleId);
  if (!scope) return [];
  const domains = new Set(scope.domainIds);
  return atlasCapabilities.filter((capability) =>
    domains.has(capability.domainId),
  );
}

export function relevantRecords(
  capabilityId: string,
  moduleId?: string,
): CoverageRecord[] {
  return coverageRecords.filter(
    (record) =>
      record.capabilityId === capabilityId &&
      (!moduleId || record.moduleId === moduleId),
  );
}

export function capabilityState(
  capabilityId: string,
  moduleId: string,
): CoverageState {
  const records = relevantRecords(capabilityId, moduleId);
  return records.reduce<CoverageState>(
    (best, record) =>
      coverageOrder.indexOf(record.state) > coverageOrder.indexOf(best)
        ? record.state
        : best,
    "unstarted",
  );
}

export function moduleSummary(moduleId: string): {
  total: number;
  counts: Record<CoverageState, number>;
} {
  const capabilities = scopedCapabilities(moduleId);
  const counts: Record<CoverageState, number> = {
    unstarted: 0,
    integrated: 0,
    usable: 0,
    verified: 0,
    polished: 0,
  };
  for (const capability of capabilities)
    counts[capabilityState(capability.id, moduleId)] += 1;
  return { total: capabilities.length, counts };
}

export function domainCounts(): Map<string, number> {
  return new Map(
    atlasDomains.map((domain) => [
      domain.id,
      atlasCapabilities.filter(
        (capability) => capability.domainId === domain.id,
      ).length,
    ]),
  );
}
