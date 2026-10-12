import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readLock, validateLock } from "./source.mjs";
import { buildArguments, deploymentArguments } from "./build.mjs";
import { useBuiltLauncher } from "../../services/remote-agent/openclaw/tests/bootstrap-native-proof.mjs";

test("both engines have pinned, distinct official sources", async () => {
  const openhands = await readLock("openhands");
  const openclaw = await readLock("openclaw");
  assert.deepEqual(openhands.sources.map(source => source.id), ["app", "sdk"]);
  assert.equal(openclaw.sources[0].repository, "https://github.com/openclaw/openclaw.git");
});

test("native desktop proof changes only the test launcher and refuses source drift", () => {
  const before = 'assert(nativeClick); spawn(process.execPath, ["scripts/run-node.mjs", "gateway", "run"], { env }); assert(staleGenerationRejected);';
  assert.equal(useBuiltLauncher(before), before.replace("scripts/run-node.mjs", "openclaw.mjs"));
  assert.throws(() => useBuiltLauncher("unexpected native fixture"));
  assert.throws(() => useBuiltLauncher(before + before));
});

test("rejects unknown engines, source traversal, floating revisions and duplicates", async () => {
  await assert.rejects(readLock("../../other"));
  const lock = await readLock("openhands");
  for (const change of [{ id: "../sdk" }, { commit: "main" }, { repository: "https://example.com/untrusted.git" }]) {
    assert.throws(() => validateLock({ ...lock, sources: [{ ...lock.sources[0], ...change }] }, "openhands"));
  }
  assert.throws(() => validateLock({ ...lock, sources: [lock.sources[0], lock.sources[0]] }, "openhands"));
});

test("source builds keep argument boundaries and never resolve outside the source", async () => {
  const source = (await readLock("openhands")).sources[1];
  const definition = { schemaVersion: 1, id: "openhands", build: { source: "sdk", dockerfile: "docker/Dockerfile", image: "selfme-lab/openhands:test", target: "source", args: { INSTALL_ACP_PROVIDERS: "" } } };
  const args = buildArguments(definition, source, "/workspace/source");
  assert.ok(args.includes("INSTALL_ACP_PROVIDERS="));
  assert.ok(args.includes(`ai.selfme.lab.source.commit=${source.commit}`));
  assert.equal(args.at(-1), "/workspace/source");
  assert.throws(() => buildArguments({ ...definition, build: { ...definition.build, dockerfile: "../../outside/Dockerfile" } }, source, "/workspace/source"));
});

test("deployment layers are explicit, source-derived and ownership-labelled", async () => {
  const source = (await readLock("openclaw")).sources[0];
  const definition = { id: "openclaw", build: { image: "selfme-lab/openclaw:source" }, deployment: { image: "selfme-lab/openclaw:lab1", dockerfile: "deployment.Dockerfile" } };
  const args = deploymentArguments(definition, source, "/workspace/service");
  assert.ok(args.includes("SOURCE_IMAGE=selfme-lab/openclaw:source"));
  assert.ok(args.includes(`ai.selfme.lab.source.commit=${source.commit}`));
  assert.ok(args.includes("ai.selfme.lab.integration=1"));
  assert.equal(args.at(-1), "/workspace/service");
  assert.equal(deploymentArguments({ build: definition.build }, source, "/workspace/service"), undefined);
  assert.throws(() => deploymentArguments({ ...definition, deployment: { ...definition.deployment, dockerfile: "../Dockerfile" } }, source, "/workspace/service"));
});

test("OpenClaw adds the curated Xfce desktop and shared terminal in the deployment layer", async () => {
  const definition = JSON.parse(await readFile(new URL("../../services/remote-agent/openclaw/service.json", import.meta.url), "utf8"));
  const dockerfile = await readFile(new URL("../../services/remote-agent/openclaw/deployment.Dockerfile", import.meta.url), "utf8");
  assert.ok(definition.deployment.image.endsWith("-lab27"));
  assert.doesNotMatch(dockerfile, /terminal-build|terminal-focus/);
  assert.match(dockerfile, /COPY --from=panel-build \/panel-root\/usr\/bin\/xfce4-panel/);
  assert.match(dockerfile, /install -y --no-install-recommends xfdesktop4 thunar desktop-base librsvg2-common xfce4-terminal tmux wmctrl xdotool/);
  assert.match(dockerfile, /COPY desktop \/opt\/selfme\/desktop/);
  assert.match(dockerfile, /COPY bootstrap \/opt\/selfme\/bootstrap/);
  assert.match(dockerfile, /COPY --from=model-discovery \/terminal-response\.ts \/opt\/selfme\/plugin\/terminal-response\.ts/);
  assert.match(dockerfile, /gvfs libglib2\.0-bin xdg-user-dirs/);
  assert.match(dockerfile, /XDG_DATA_HOME=\/home\/node\/\.openclaw\/\.selfme-desktop\/data/);
});

test("both native browser deployment layers include color emoji by default", async () => {
  for (const engine of ["openhands", "openclaw"]) {
    const dockerfile = await readFile(new URL(`../../services/remote-agent/${engine}/deployment.Dockerfile`, import.meta.url), "utf8");
    assert.match(dockerfile, /install -y --no-install-recommends[^\n]*fonts-noto-color-emoji/);
  }
});

test("OH observation grants select the task's own display, not a global VNC port", async () => {
  const app = await readFile(new URL("../../services/remote-agent/openhands/extension/app.py", import.meta.url), "utf8");
  assert.match(app, /task_browser\(task\)/);
  assert.match(app, /tickets\[token\] = \(now \+ 60, browser, port\)/);
  assert.match(app, /open_connection\("127\.0\.0\.1", grant\[2\]\)/);
  assert.doesNotMatch(app, /DISPLAY.*:88|rfbport.*5900/);
});
