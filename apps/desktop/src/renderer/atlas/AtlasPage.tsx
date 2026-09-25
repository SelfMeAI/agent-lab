import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import {
  atlasCapabilities,
  atlasDomains,
  atlasFamilies,
  capabilityById,
  domainById,
} from "./catalog";
import { atlasModules, coverageRecords, surfaceTitle } from "./coverage";
import {
  areaOptions,
  capabilityState,
  coverageOrder,
  coverageTitles,
  domainCounts,
  matchesDimension,
  moduleSummary,
  relevantRecords,
  scopedCapabilities,
  surfaceOptions,
} from "./model";
import { experiencePatterns, experiencePhases } from "./patterns";
import { atlasSources, sourceById } from "./sources";
import type {
  AtlasArea,
  AtlasCapability,
  AtlasFamily,
  AtlasSurface,
  CoverageState,
  ExperiencePattern,
  ExperiencePhase,
} from "./types";
import "./atlas.css";

type AtlasView =
  | "overview"
  | "capabilities"
  | "experience"
  | "coverage"
  | "sources";

const views: readonly { id: AtlasView; title: string; english: string }[] = [
  { id: "overview", title: "总览", english: "OVERVIEW" },
  { id: "capabilities", title: "能力地图", english: "CAPABILITY MAP" },
  { id: "experience", title: "体验图谱", english: "EXPERIENCE" },
  { id: "coverage", title: "实现覆盖", english: "COVERAGE" },
  { id: "sources", title: "市场参照", english: "SOURCES" },
];
const baselineDate =
  [...coverageRecords.map((record) => record.checkedAt)]
    .sort()
    .at(-1)
    ?.replaceAll("-", ".") ?? "待核对";

const familyStyle = (family: AtlasFamily): CSSProperties =>
  ({ "--atlas-accent": family.accent }) as CSSProperties;

function familyOf(domainId: string): AtlasFamily {
  const domain = domainById.get(domainId);
  return (
    atlasFamilies.find((family) => family.id === domain?.familyId) ??
    atlasFamilies[0]!
  );
}

function SourceLink({ sourceId }: { sourceId: string }): JSX.Element | null {
  const source = sourceById.get(sourceId);
  if (!source) return null;
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!window.selfmeLab) return;
        event.preventDefault();
        void window.selfmeLab.openExternal(source.url).catch(() => undefined);
      }}
    >
      {source.product}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function CheckList({
  checks,
  passed = [],
}: {
  checks: readonly string[];
  passed?: readonly number[];
}): JSX.Element {
  return (
    <ul className="atlas-checks">
      {checks.map((check, index) => (
        <li key={check} className={passed.includes(index) ? "is-observed" : ""}>
          <span aria-hidden="true">{passed.includes(index) ? "✓" : "○"}</span>
          {check}
        </li>
      ))}
    </ul>
  );
}

function CapabilityDetail({
  capability,
  onGoCoverage,
}: {
  capability: AtlasCapability;
  onGoCoverage(moduleId: string, capabilityId: string): void;
}): JSX.Element {
  const domain = domainById.get(capability.domainId)!;
  const family = familyOf(domain.id);
  const records = relevantRecords(capability.id);
  return (
    <aside className="atlas-detail" style={familyStyle(family)}>
      <span className="atlas-overline">
        {family.english} / {domain.title}
      </span>
      <h3>{capability.title}</h3>
      <p>{capability.description}</p>
      <div className="atlas-detail__section">
        <h4>
          验收要点 <span>{capability.checks.length}</span>
        </h4>
        <CheckList checks={capability.checks} />
      </div>
      <div className="atlas-detail__section">
        <h4>适用形态</h4>
        <div className="atlas-tags">
          {capability.surfaces.map((surface) => (
            <span key={surface}>{surfaceTitle(surface)}</span>
          ))}
        </div>
      </div>
      <div className="atlas-detail__section">
        <h4>适用场景</h4>
        <div className="atlas-tags">
          {capability.areas.map((area) => (
            <span key={area}>
              {area === "cross"
                ? "跨场景"
                : (areaOptions.find((option) => option.id === area)?.title ??
                  area)}
            </span>
          ))}
        </div>
      </div>
      <div className="atlas-detail__section">
        <h4>SelfMe 记录</h4>
        {records.length ? (
          <div className="atlas-detail__records">
            {records.map((record) => (
              <button
                type="button"
                key={record.moduleId + (record.harnessId ?? "")}
                onClick={() => onGoCoverage(record.moduleId, capability.id)}
              >
                {atlasModules.find((module) => module.id === record.moduleId)
                  ?.title ?? record.moduleId}
                <b data-state={record.state}>{coverageTitles[record.state]}</b>
              </button>
            ))}
          </div>
        ) : (
          <p className="atlas-muted">
            尚无本项目实现证据。知识图谱中的存在，不等于当前产品已接入。
          </p>
        )}
      </div>
      <div className="atlas-detail__section">
        <h4>代表性一手资料</h4>
        <div className="atlas-links">
          {domain.sourceIds.map((sourceId) => (
            <SourceLink sourceId={sourceId} key={sourceId} />
          ))}
        </div>
        <small>资料用于定义能力边界，不宣称其覆盖本条全部要点。</small>
      </div>
    </aside>
  );
}

function ExperienceDetail({
  pattern,
  onSelectCapability,
}: {
  pattern: ExperiencePattern;
  onSelectCapability(id: string): void;
}): JSX.Element {
  const phase = experiencePhases.find((entry) => entry.id === pattern.phase)!;
  return (
    <aside className="atlas-detail atlas-detail--experience">
      <span className="atlas-overline">{phase.english} / 体验准则</span>
      <h3>{pattern.title}</h3>
      <div className="atlas-detail__section">
        <h4>用户真正想要</h4>
        <p>{pattern.intent}</p>
      </div>
      <div className="atlas-detail__section">
        <h4>产品应怎样呈现</h4>
        <p>{pattern.expected}</p>
      </div>
      <div className="atlas-detail__section">
        <h4>体验验收</h4>
        <CheckList checks={pattern.checks} />
      </div>
      <div className="atlas-detail__section">
        <h4>关联底层能力</h4>
        <div className="atlas-detail__records">
          {pattern.capabilityIds.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelectCapability(id)}
            >
              {capabilityById.get(id)?.title ?? id}
              <span>→</span>
            </button>
          ))}
        </div>
      </div>
      <div className="atlas-detail__section">
        <h4>参照资料</h4>
        <div className="atlas-links">
          {pattern.sourceIds.map((id) => (
            <SourceLink sourceId={id} key={id} />
          ))}
        </div>
      </div>
    </aside>
  );
}

export function AtlasPage(): JSX.Element {
  const [view, setView] = useState<AtlasView>("overview");
  const [familyId, setFamilyId] = useState<string>("all");
  const [domainId, setDomainId] = useState<string>("all");
  const [capabilityId, setCapabilityId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [surface, setSurface] = useState<AtlasSurface | "all">("all");
  const [area, setArea] = useState<AtlasArea | "all">("all");
  const [phase, setPhase] = useState<ExperiencePhase | "all">("all");
  const [patternId, setPatternId] = useState<string>(
    experiencePatterns[0]?.id ?? "",
  );
  const [moduleId, setModuleId] = useState<string>("agent-lab");
  const [coverageFilter, setCoverageFilter] = useState<CoverageState | "all">(
    "all",
  );
  const [coverageQuery, setCoverageQuery] = useState("");
  const resultsRef = useRef<HTMLDivElement>(null);
  const patternsRef = useRef<HTMLDivElement>(null);
  const coverageControlsRef = useRef<HTMLDivElement>(null);
  const counts = useMemo(domainCounts, []);

  useEffect(() => {
    document.querySelector(".app-viewport")?.scrollTo({ top: 0 });
  }, [view]);

  useEffect(() => {
    resultsRef.current?.scrollTo({ top: 0 });
  }, [familyId, domainId, query, surface, area]);

  useEffect(() => {
    patternsRef.current?.scrollTo({ top: 0 });
  }, [phase, surface]);

  useEffect(() => {
    const viewport = document.querySelector<HTMLElement>(".app-viewport");
    const controls = coverageControlsRef.current;
    if (!viewport || !controls) return;
    const controlsTop = controls.getBoundingClientRect().top
      - viewport.getBoundingClientRect().top + viewport.scrollTop;
    const tabsHeight = document.querySelector(".atlas-tabs")?.getBoundingClientRect().height ?? 55;
    const resultStart = Math.max(0, controlsTop - tabsHeight);
    const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const target = maxScroll < resultStart ? 0 : resultStart;
    if (viewport.scrollTop > target + 4) {
      viewport.scrollTo({ top: target });
    }
  }, [moduleId, coverageFilter, coverageQuery]);

  const filteredCapabilities = useMemo(
    () =>
      atlasCapabilities.filter((capability) => {
        const domain = domainById.get(capability.domainId)!;
        const family = atlasFamilies.find(
          (item) => item.id === domain.familyId,
        )!;
        const term = query.trim().toLocaleLowerCase();
        return (
          (familyId === "all" || domain.familyId === familyId) &&
          (domainId === "all" || domain.id === domainId) &&
          matchesDimension(capability.surfaces, surface) &&
          matchesDimension(capability.areas, area) &&
          (!term ||
            [
              capability.title,
              capability.description,
              capability.id,
              domain.title,
              family.title,
            ].some((value) => value.toLocaleLowerCase().includes(term)))
        );
      }),
    [familyId, domainId, query, surface, area],
  );
  const currentCapability =
    filteredCapabilities.find((entry) => entry.id === capabilityId) ??
    filteredCapabilities[0];
  const filteredPatterns = useMemo(
    () =>
      experiencePatterns.filter(
        (pattern) =>
          (phase === "all" || pattern.phase === phase) &&
          matchesDimension(pattern.surfaces, surface),
      ),
    [phase, surface],
  );
  const currentPattern =
    filteredPatterns.find((pattern) => pattern.id === patternId) ??
    filteredPatterns[0];
  const currentModule =
    atlasModules.find((module) => module.id === moduleId) ?? atlasModules[0]!;
  const summary = moduleSummary(currentModule.id);
  const moduleCapabilities = useMemo(
    () =>
      scopedCapabilities(currentModule.id).filter((capability) => {
        const term = coverageQuery.trim().toLocaleLowerCase();
        return (
          (coverageFilter === "all" ||
            capabilityState(capability.id, currentModule.id) ===
              coverageFilter) &&
          (!term ||
            [
              capability.title,
              capability.description,
              capability.id,
              domainById.get(capability.domainId)?.title ?? "",
            ].some((value) => value.toLocaleLowerCase().includes(term)))
        );
      }),
    [currentModule.id, coverageFilter, coverageQuery],
  );

  const selectFamily = (id: string): void => {
    setFamilyId(id);
    setDomainId("all");
    setQuery("");
    setView("capabilities");
  };
  const selectCapability = (id: string): void => {
    const capability = capabilityById.get(id);
    if (!capability) return;
    setFamilyId("all");
    setDomainId(capability.domainId);
    setQuery("");
    setSurface("all");
    setArea("all");
    setCapabilityId(id);
    setView("capabilities");
  };
  const selectModule = (id: string): void => {
    setModuleId(id);
    setCoverageFilter("all");
    setCoverageQuery("");
    setView("coverage");
  };
  const selectCoverageCapability = (
    id: string,
    targetCapabilityId: string,
  ): void => {
    selectModule(id);
    setCoverageQuery(
      capabilityById.get(targetCapabilityId)?.title ?? targetCapabilityId,
    );
  };

  return (
    <main className={`atlas-page${view === "capabilities" || view === "experience" ? " atlas-page--explorer" : ""}${view === "coverage" ? " atlas-page--coverage" : ""}`}>
      <header className="atlas-heading">
        <div>
          <span className="atlas-overline">
            SELFME LAB / SYSTEM INTELLIGENCE
          </span>
          <h1>
            AGENT ATLAS<span className="atlas-heading__star">✳</span>
          </h1>
          <p>
            把 Agent
            的技术能力、交互体验和真实实现状态放在同一张可检索的地图上。
          </p>
        </div>
        <div className="atlas-heading__edition">
          <strong>ATLAS / 01</strong>
          <span>
            持续更新的研究地图
            <br />
            不是开发完成清单
          </span>
        </div>
      </header>
      <nav className="atlas-tabs" aria-label="Agent Atlas 视图">
        {views.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={view === entry.id ? "is-active" : ""}
            onClick={() => setView(entry.id)}
          >
            <small>{entry.english}</small>
            <span>{entry.title}</span>
          </button>
        ))}
      </nav>

      {view === "overview" && (
        <div className="atlas-overview">
          <section className="atlas-intro">
            <div>
              <span className="atlas-overline">
                A LIVING MAP OF AGENT SYSTEMS
              </span>
              <h2>
                看见全貌。
                <br />
                <em>然后清楚地知道自己走到哪。</em>
              </h2>
              <p>
                从模型与 Harness
                到工具、审批、交付、移动端与具身系统；从首次打开到长任务接续。每项能力都有可检查的条件，SelfMe
                的进展必须有代码或运行证据。
              </p>
              <button type="button" onClick={() => setView("capabilities")}>
                探索完整能力地图 <span>↗</span>
              </button>
            </div>
            <div className="atlas-intro__signal" aria-hidden="true">
              <span className="atlas-intro__orbit atlas-intro__orbit--one" />
              <span className="atlas-intro__orbit atlas-intro__orbit--two" />
              <span className="atlas-intro__orbit atlas-intro__orbit--three" />
              <span className="atlas-intro__orbit atlas-intro__orbit--four" />
              <b>∗</b>
            </div>
          </section>
          <section className="atlas-statline" aria-label="图谱规模">
            <div>
              <strong>
                {atlasFamilies.length.toString().padStart(2, "0")}
              </strong>
              <span>能力大类</span>
            </div>
            <div>
              <strong>{atlasDomains.length.toString().padStart(2, "0")}</strong>
              <span>能力领域</span>
            </div>
            <div>
              <strong>{atlasCapabilities.length}</strong>
              <span>具体能力</span>
            </div>
            <div>
              <strong>{experiencePatterns.length}</strong>
              <span>交互体验准则</span>
            </div>
            <div>
              <strong>{atlasSources.length}</strong>
              <span>一手资料入口</span>
            </div>
          </section>
          <div className="atlas-section-title">
            <div>
              <span>01 / CAPABILITY FIELD</span>
              <h2>Agent 的能力版图</h2>
            </div>
            <p>
              按内核、行动、扩展、治理、体验与前沿组织，不按某一款产品的菜单组织。
            </p>
          </div>
          <section className="atlas-family-grid">
            {atlasFamilies.map((family, index) => (
              <button
                type="button"
                key={family.id}
                className="atlas-family-card"
                style={familyStyle(family)}
                onClick={() => selectFamily(family.id)}
              >
                <span className="atlas-family-card__index">
                  0{index + 1} / {family.english}
                </span>
                <span className="atlas-family-card__mark" aria-hidden="true">
                  ✳
                </span>
                <strong>{family.title}</strong>
                <p>{family.description}</p>
                <span className="atlas-family-card__foot">
                  {
                    atlasDomains.filter(
                      (domain) => domain.familyId === family.id,
                    ).length
                  }{" "}
                  领域 ·{" "}
                  {
                    atlasCapabilities.filter(
                      (capability) =>
                        domainById.get(capability.domainId)?.familyId ===
                        family.id,
                    ).length
                  }{" "}
                  能力 <b>↗</b>
                </span>
              </button>
            ))}
          </section>
          <div className="atlas-overview__lower">
            <button
              type="button"
              className="atlas-feature-card"
              onClick={() => setView("experience")}
            >
              <span>02 / EXPERIENCE SYSTEM</span>
              <strong>
                不只是能执行。
                <br />
                还要让人始终看得懂、管得住、拿得到。
              </strong>
              <p>从进入、表达、运行、介入、审查到接续，以及视觉与交互工艺。</p>
              <b>打开体验图谱 ↗</b>
            </button>
            <div className="atlas-module-snapshot">
              <span>03 / SELFME COVERAGE</span>
              <h3>项目当前处于哪里</h3>
              <p>按模块观察范围统计，不拿行业全景当作当前开发承诺。</p>
              {atlasModules.map((module) => {
                const item = moduleSummary(module.id);
                const observed = item.total - item.counts.unstarted;
                return (
                  <button
                    type="button"
                    key={module.id}
                    onClick={() => selectModule(module.id)}
                  >
                    <span>{module.title}</span>
                    <small>
                      {observed} 条有接入记录 / {item.total} 条观察能力
                    </small>
                    <span aria-hidden="true">↗</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {view === "capabilities" && (
        <section className="atlas-workspace" aria-label="能力地图">
          <div className="atlas-workspace__heading">
            <div>
              <span className="atlas-overline">
                THE EXPANDING CAPABILITY MAP
              </span>
              <h2>能力地图</h2>
              <p>
                技术原语与产品能力分开审视。每条都附有验收要点，不以“支持”二字代替验证。
              </p>
            </div>
            <strong>
              {filteredCapabilities.length} / {atlasCapabilities.length}
            </strong>
          </div>
          <div className="atlas-filterbar">
            <label className="atlas-search">
              <span aria-hidden="true">⌕</span>
              <input
                aria-label="搜索能力"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索能力、领域或关键词"
              />
            </label>
            <select
              aria-label="形态筛选"
              value={surface}
              onChange={(event) =>
                setSurface(event.target.value as AtlasSurface | "all")
              }
            >
              {surfaceOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
            <select
              aria-label="场景筛选"
              value={area}
              onChange={(event) =>
                setArea(event.target.value as AtlasArea | "all")
              }
            >
              {areaOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setFamilyId("all");
                setDomainId("all");
                setQuery("");
                setSurface("all");
                setArea("all");
              }}
            >
              重置
            </button>
          </div>
          <div className="atlas-explorer">
            <aside className="atlas-rail">
              <button
                type="button"
                className={
                  familyId === "all" && domainId === "all" ? "is-active" : ""
                }
                onClick={() => {
                  setFamilyId("all");
                  setDomainId("all");
                }}
              >
                全部领域 <span>{atlasDomains.length}</span>
              </button>
              {atlasFamilies.map((family) => (
                <div
                  className="atlas-rail__group"
                  key={family.id}
                  style={familyStyle(family)}
                >
                  <button
                    type="button"
                    className={
                      familyId === family.id && domainId === "all"
                        ? "is-active"
                        : ""
                    }
                    onClick={() => {
                      setFamilyId(family.id);
                      setDomainId("all");
                    }}
                  >
                    {family.title}
                    <span>
                      {
                        atlasDomains.filter(
                          (domain) => domain.familyId === family.id,
                        ).length
                      }
                    </span>
                  </button>
                  {atlasDomains
                    .filter((domain) => domain.familyId === family.id)
                    .map((domain) => (
                      <button
                        type="button"
                        className={
                          domainId === domain.id
                            ? "is-active is-domain"
                            : "is-domain"
                        }
                        key={domain.id}
                        onClick={() => {
                          setFamilyId(family.id);
                          setDomainId(domain.id);
                        }}
                      >
                        {domain.title}
                        <span>{counts.get(domain.id)}</span>
                      </button>
                    ))}
                </div>
              ))}
            </aside>
            <div className="atlas-result-list" ref={resultsRef}>
              <div className="atlas-list-caption">
                <span>CAPABILITIES</span>
                <span>{filteredCapabilities.length} ITEMS</span>
              </div>
              {filteredCapabilities.length ? (
                filteredCapabilities.map((capability) => {
                  const domain = domainById.get(capability.domainId)!;
                  return (
                    <button
                      type="button"
                      className={
                        currentCapability?.id === capability.id
                          ? "atlas-result is-active"
                          : "atlas-result"
                      }
                      key={capability.id}
                      onClick={() => setCapabilityId(capability.id)}
                    >
                      <span>
                        {domain.title} / {capability.id}
                      </span>
                      <strong>{capability.title}</strong>
                      <p>{capability.description}</p>
                      <small>
                        {capability.checks.length} 项验收 <b>↗</b>
                      </small>
                    </button>
                  );
                })
              ) : (
                <div className="atlas-empty">
                  没有匹配的能力。试着放宽形态、场景或关键词。
                </div>
              )}
            </div>
            {currentCapability ? (
              <CapabilityDetail
                capability={currentCapability}
                onGoCoverage={selectCoverageCapability}
              />
            ) : (
              <aside className="atlas-detail atlas-detail--empty">
                调整筛选后查看能力详情。
              </aside>
            )}
          </div>
        </section>
      )}

      {view === "experience" && (
        <section className="atlas-workspace">
          <div className="atlas-workspace__heading">
            <div>
              <span className="atlas-overline">
                HUMAN EXPERIENCE IS THE PRODUCT
              </span>
              <h2>体验图谱</h2>
              <p>
                不是一份“界面美化清单”，而是用户如何发起、理解、干预和验收 Agent
                工作。
              </p>
            </div>
            <strong>{experiencePatterns.length} PATTERNS</strong>
          </div>
          <div className="atlas-phasebar">
            <button
              type="button"
              className={phase === "all" ? "is-active" : ""}
              onClick={() => setPhase("all")}
            >
              全链路
            </button>
            {experiencePhases.map((entry, index) => (
              <button
                type="button"
                key={entry.id}
                className={phase === entry.id ? "is-active" : ""}
                onClick={() => setPhase(entry.id)}
              >
                <small>0{index + 1}</small>
                {entry.title}
              </button>
            ))}
            <select
              aria-label="体验形态筛选"
              value={surface}
              onChange={(event) =>
                setSurface(event.target.value as AtlasSurface | "all")
              }
            >
              {surfaceOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
          </div>
          <div className="atlas-experience-grid">
            <div className="atlas-pattern-list" ref={patternsRef}>
              {filteredPatterns.length ? (
                filteredPatterns.map((pattern) => {
                  const entry = experiencePhases.find(
                    (item) => item.id === pattern.phase,
                  )!;
                  return (
                    <button
                      type="button"
                      key={pattern.id}
                      className={
                        currentPattern?.id === pattern.id
                          ? "atlas-pattern is-active"
                          : "atlas-pattern"
                      }
                      onClick={() => setPatternId(pattern.id)}
                    >
                      <small>
                        {entry.english} / {entry.title}
                      </small>
                      <strong>{pattern.title}</strong>
                      <p>{pattern.intent}</p>
                      <span>查看准则 ↗</span>
                    </button>
                  );
                })
              ) : (
                <div className="atlas-empty">当前形态没有匹配的体验准则。</div>
              )}
            </div>
            {currentPattern ? (
              <ExperienceDetail
                pattern={currentPattern}
                onSelectCapability={selectCapability}
              />
            ) : (
              <aside className="atlas-detail atlas-detail--empty">
                切换形态查看体验准则。
              </aside>
            )}
          </div>
        </section>
      )}

      {view === "coverage" && (
        <section className="atlas-workspace">
          <div className="atlas-workspace__heading">
            <div>
              <span className="atlas-overline">EVIDENCE, NOT ASSUMPTION</span>
              <h2>实现覆盖</h2>
            </div>
            <strong>BASELINE / {baselineDate}</strong>
          </div>
          <div className="atlas-coverage-layout">
            <aside className="atlas-module-rail">
              <span>PROJECT MODULES</span>
              {atlasModules.map((module) => {
                const item = moduleSummary(module.id);
                return (
                  <button
                    type="button"
                    key={module.id}
                    className={
                      module.id === currentModule.id ? "is-active" : ""
                    }
                    onClick={() => selectModule(module.id)}
                  >
                    <strong>{module.title}</strong>
                    <small>
                      {item.total - item.counts.unstarted} / {item.total}{" "}
                      有接入记录
                    </small>
                  </button>
                );
              })}
              <p>模块范围只用于观察，不表示路线图承诺。</p>
            </aside>
            <div className="atlas-coverage-main">
              <div className="atlas-coverage-hero">
                <div className="atlas-coverage-hero__identity">
                  <h3>{currentModule.title}</h3>
                  <p>{currentModule.description}</p>
                </div>
                <div className="atlas-coverage-hero__meta">
                  <div className="atlas-coverage-hero__count">
                    <strong>
                      {summary.total - summary.counts.unstarted}
                      <small> / {summary.total}</small>
                    </strong>
                    <span>有接入记录 / 观察能力</span>
                  </div>
                  <details className="atlas-coverage-guide">
                    <summary>怎么读 <span aria-hidden="true">⌄</span></summary>
                    <div>
                      <p>{currentModule.note}</p>
                      <p>“已接入”表示代码通路存在；“可使用”表示有用户可触达界面；“已验证”需要对应验收证据；“已打磨”还需真实体验检查。绿色勾只代表当前代码审查观察到的要点，不等于完整端到端验收。记录不是实时遥测。</p>
                    </div>
                  </details>
                </div>
              </div>
              <div className="atlas-coverage-controls" ref={coverageControlsRef}>
                <div className="atlas-state-strip">
                  {coverageOrder.map((state) => (
                    <button
                      type="button"
                      className={coverageFilter === state ? "is-active" : ""}
                      key={state}
                      data-state={state}
                      onClick={() =>
                        setCoverageFilter(
                          coverageFilter === state ? "all" : state,
                        )
                      }
                    >
                      <strong>{summary.counts[state]}</strong>
                      <span>{coverageTitles[state]}</span>
                    </button>
                  ))}
                </div>
                <label className="atlas-search atlas-search--coverage">
                  <span aria-hidden="true">⌕</span>
                  <input
                    aria-label="搜索观察能力"
                    placeholder="在当前模块的观察范围内搜索"
                    value={coverageQuery}
                    onChange={(event) => setCoverageQuery(event.target.value)}
                  />
                </label>
              </div>
              <div className="atlas-coverage-list">
                <div className="atlas-list-caption">
                  <span>OBSERVATION SCOPE</span>
                  <span>{moduleCapabilities.length} ITEMS</span>
                </div>
                {moduleCapabilities.map((capability) => {
                  const records = relevantRecords(
                    capability.id,
                    currentModule.id,
                  );
                  const state = capabilityState(
                    capability.id,
                    currentModule.id,
                  );
                  const domain = domainById.get(capability.domainId)!;
                  const observed = Array.from(
                    new Set(records.flatMap((record) => record.passedChecks)),
                  );
                  return (
                    <details key={capability.id} className="atlas-coverage-row">
                      <summary>
                        <span className="atlas-coverage-row__domain">
                          {domain.title}
                        </span>
                        <strong>{capability.title}</strong>
                        <small data-state={state}>
                          {coverageTitles[state]}
                        </small>
                        <span aria-hidden="true">⌄</span>
                      </summary>
                      <div className="atlas-coverage-row__body">
                        <p>{capability.description}</p>
                        <CheckList
                          checks={capability.checks}
                          passed={observed}
                        />
                        {records.length ? (
                          records.map((record) => (
                            <div
                              className="atlas-evidence"
                              key={record.harnessId ?? record.moduleId}
                            >
                              <div>
                                <strong>
                                  {record.harnessId ?? currentModule.title}
                                  {record.platform
                                    ? " · " + surfaceTitle(record.platform)
                                    : ""}
                                </strong>
                                <span>
                                  上游：
                                  {record.upstream === "tested"
                                    ? "当前版本已实测"
                                    : record.upstream === "documented"
                                      ? "有文档，当前版本待核对"
                                      : "未单独核对"}{" "}
                                  · 代码核对于 {record.checkedAt}
                                </span>
                              </div>
                              <p>{record.note}</p>
                              <ul>
                                {record.evidence.map((item) => (
                                  <li key={item}>
                                    {item.startsWith("https://") ? (
                                      <a
                                        href={item}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(event) => {
                                          if (!window.selfmeLab) return;
                                          event.preventDefault();
                                          void window.selfmeLab
                                            .openExternal(item)
                                            .catch(() => undefined);
                                        }}
                                      >
                                        {item} ↗
                                      </a>
                                    ) : (
                                      <code>{item}</code>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))
                        ) : (
                          <p className="atlas-muted">
                            本项目尚无此能力的实现证据；不据此推断上游 Harness
                            是否支持。
                          </p>
                        )}
                      </div>
                    </details>
                  );
                })}
                {moduleCapabilities.length === 0 && (
                  <div className="atlas-empty">没有匹配的观察能力。</div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {view === "sources" && (
        <section className="atlas-workspace">
          <div className="atlas-workspace__heading">
            <div>
              <span className="atlas-overline">
                PRIMARY MATERIAL / RESEARCH LINKS
              </span>
              <h2>市场参照</h2>
              <p>
                以官方文档、官方项目仓库和协议原文作为起点。它们是代表性资料，不是对所有产品的穷尽名单。
              </p>
            </div>
            <strong>{atlasSources.length} SOURCES</strong>
          </div>
          <div className="atlas-source-intro">
            <span>研究原则</span>
            <p>
              资料描述“能参考什么”；具体产品是否支持某项能力、当前版本是否稳定，必须逐条验证。SelfMe
              实现状态只在“实现覆盖”中按本项目证据记录。
            </p>
          </div>
          <div className="atlas-source-grid">
            {atlasSources.map((source, index) => (
              <article className="atlas-source-card" key={source.id}>
                <span>REF / {String(index + 1).padStart(2, "0")}</span>
                <small>{source.form}</small>
                <h3>{source.product}</h3>
                <p>{source.note}</p>
                <div>
                  <span>核对 {source.reviewedAt}</span>
                  <SourceLink sourceId={source.id} />
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      <footer className="atlas-footer">
        <span>SELFME LAB / AGENT ATLAS</span>
        <span>能力定义持续扩展 · 实现状态以证据为准</span>
      </footer>
    </main>
  );
}
