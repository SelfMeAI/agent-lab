import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  atlasCapabilities,
  atlasDomains,
  atlasFamilies,
  capabilityById,
  domainById,
} from "./catalog";
import { atlasModules, coverageRecords, moduleById } from "./coverage";
import { capabilityState, moduleSummary } from "./model";
import { experiencePatterns, experiencePhases } from "./patterns";
import { atlasSources, sourceById } from "./sources";

const root = new URL("../../../../../", import.meta.url);

describe("Agent Atlas knowledge base", () => {
  it("keeps taxonomy identifiers unique and checklists actionable", () => {
    expect(atlasFamilies).toHaveLength(8);
    expect(atlasDomains.length).toBeGreaterThan(30);
    expect(atlasCapabilities.length).toBeGreaterThan(250);
    expect(new Set(atlasFamilies.map((item) => item.id)).size).toBe(
      atlasFamilies.length,
    );
    expect(new Set(atlasDomains.map((item) => item.id)).size).toBe(
      atlasDomains.length,
    );
    expect(new Set(atlasCapabilities.map((item) => item.id)).size).toBe(
      atlasCapabilities.length,
    );
    for (const domain of atlasDomains) {
      expect(
        atlasFamilies.some((family) => family.id === domain.familyId),
        domain.id,
      ).toBe(true);
      expect(domain.sourceIds.length, domain.id).toBeGreaterThan(0);
      for (const id of domain.sourceIds)
        expect(sourceById.has(id), domain.id + ":" + id).toBe(true);
    }
    for (const capability of atlasCapabilities) {
      expect(domainById.has(capability.domainId), capability.id).toBe(true);
      expect(capability.checks.length, capability.id).toBeGreaterThanOrEqual(3);
      expect(
        capability.checks.every((check) => check.trim().length > 2),
        capability.id,
      ).toBe(true);
      expect(capability.surfaces.length, capability.id).toBeGreaterThan(0);
      expect(capability.areas.length, capability.id).toBeGreaterThan(0);
    }
  });

  it("connects every experience pattern to a real capability and a source", () => {
    expect(new Set(experiencePatterns.map((item) => item.id)).size).toBe(
      experiencePatterns.length,
    );
    for (const pattern of experiencePatterns) {
      expect(
        experiencePhases.some((phase) => phase.id === pattern.phase),
        pattern.id,
      ).toBe(true);
      expect(pattern.checks.length, pattern.id).toBeGreaterThanOrEqual(3);
      expect(pattern.capabilityIds.length, pattern.id).toBeGreaterThan(0);
      for (const id of pattern.capabilityIds)
        expect(capabilityById.has(id), pattern.id + ":" + id).toBe(true);
      for (const id of pattern.sourceIds)
        expect(sourceById.has(id), pattern.id + ":" + id).toBe(true);
    }
  });

  it("keeps sources primary, explicit and safe to open", () => {
    expect(new Set(atlasSources.map((item) => item.id)).size).toBe(
      atlasSources.length,
    );
    const hosts = new Set([
      "developers.openai.com",
      "modelcontextprotocol.io",
      "github.com",
      "code.claude.com",
      "learn.microsoft.com",
      "support.google.com",
      "deepmind.google",
      "docs.langchain.com",
    ]);
    for (const source of atlasSources) {
      const url = new URL(source.url);
      expect(url.protocol, source.id).toBe("https:");
      expect(hosts.has(url.hostname), source.id).toBe(true);
      expect(source.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("does not count upstream features as SelfMe implementation", () => {
    expect(atlasModules.some((module) => module.id === "founder-studio")).toBe(false);
    expect(coverageRecords.some((record) => record.moduleId === "founder-studio")).toBe(false);
    expect(new Set(atlasModules.map((item) => item.id)).size).toBe(
      atlasModules.length,
    );
    for (const module of atlasModules)
      for (const id of module.domainIds)
        expect(domainById.has(id), module.id + ":" + id).toBe(true);
    expect(
      new Set(
        coverageRecords.map((record) =>
          [record.moduleId, record.capabilityId, record.harnessId ?? ""].join(
            ":",
          ),
        ),
      ).size,
    ).toBe(coverageRecords.length);
    for (const record of coverageRecords) {
      const capability = capabilityById.get(record.capabilityId);
      const module = moduleById.get(record.moduleId);
      expect(capability, record.capabilityId).toBeDefined();
      expect(module, record.moduleId).toBeDefined();
      expect(
        module!.domainIds.includes(capability!.domainId),
        record.capabilityId,
      ).toBe(true);
      expect(record.evidence.length, record.capabilityId).toBeGreaterThan(0);
      for (const index of record.passedChecks)
        expect(index, record.capabilityId).toBeGreaterThanOrEqual(0);
      for (const index of record.passedChecks)
        expect(index, record.capabilityId).toBeLessThan(
          capability!.checks.length,
        );
      for (const evidence of record.evidence)
        if (!evidence.startsWith("https://"))
          expect(existsSync(new URL(evidence, root)), evidence).toBe(true);
      if (record.state === "verified" || record.state === "polished")
        expect(record.passedChecks.length, record.capabilityId).toBe(
          capability!.checks.length,
        );
    }
    expect(capabilityState("jobs.job-start", "agent-lab")).toBe("unstarted");
    expect(moduleSummary("remote-agent-lab").counts.unstarted).toBe(
      moduleSummary("remote-agent-lab").total,
    );
  });
});
