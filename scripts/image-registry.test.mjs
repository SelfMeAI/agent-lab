import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { architectureTag, root } from "./release/manifest.mjs";
import { aliasTargets, cleanupCandidates, protectedImageDigests } from "./release/registry.mjs";

const digest = letter => `sha256:${letter.repeat(64)}`;
const build = (letter, arch = "arm64") => `build-${letter.repeat(40)}-${arch}`;
const version = (id, letter, tags) => ({id, name:digest(letter), metadata:{package_type:"container", container:{tags}}});
const leaf = {config:{digest:digest("e")}, layers:[]};
const manifest = {tag:"v0.1.0", images:{openclaw:{repository:"ghcr.io/selfmeai/agent-lab-openclaw", digest:digest("a")}}};
const index = {manifests:[{digest:digest("b"),platform:{os:"linux",architecture:"amd64"}},{digest:digest("c"),platform:{os:"linux",architecture:"arm64"}}]};

test("architecture names expose release and CPU, not the source commit", () => {
  assert.equal(architectureTag(manifest,"amd64"),"v0.1.0-amd64");
  assert.equal(architectureTag({tag:"v0.2.0-rc.1"},"arm64"),"v0.2.0-rc.1-arm64");
  for (const tag of ["latest","v0.1.0;command","../release"]) assert.throws(()=>architectureTag({tag},"arm64"));
  assert.throws(()=>architectureTag(manifest,"x64"));
});
test("alias destinations preserve the exact verified single-architecture digests", () => {
  assert.deepEqual(aliasTargets(manifest,"openclaw",index),[
    {tag:"ghcr.io/selfmeai/agent-lab-openclaw:v0.1.0-amd64",digest:digest("b")},
    {tag:"ghcr.io/selfmeai/agent-lab-openclaw:v0.1.0-arm64",digest:digest("c")},
  ]);
  assert.throws(()=>aliasTargets(manifest,"openclaw",{manifests:[index.manifests[0]]}));
  assert.throws(()=>aliasTargets(manifest,"openclaw",{manifests:[index.manifests[0],index.manifests[0]]}));
  assert.throws(()=>aliasTargets(manifest,"openclaw",{manifests:[index.manifests[0],{...index.manifests[1],digest:"latest"}]}));
});
test("release indices protect their build-tagged and untagged children recursively", async () => {
  const versions = [version(1,"a",["v0.1.0"]),version(2,"b",[build("b","amd64")]),version(3,"c",[]),version(4,"d",[build("d")])];
  const reader = async value => value===digest("a") ? index : leaf;
  const protectedSet = await protectedImageDigests(versions,reader);
  assert.deepEqual([...protectedSet].sort(),[digest("a"),digest("b"),digest("c")].sort());
  assert.deepEqual(cleanupCandidates(versions,protectedSet).map(item=>item.id),[4]);
});
test("old formal releases, custom tags and aliases are never cleanup candidates", async () => {
  const versions = [version(1,"a",["v0.0.9"]),version(2,"b",["custom-experiment"]),version(3,"c",[build("c"),"v0.0.9-arm64"]),version(4,"d",[build("d")])];
  const protectedSet = await protectedImageDigests(versions,async()=>leaf);
  assert.deepEqual(cleanupCandidates(versions,protectedSet).map(item=>item.id),[4]);
  const promoted = {...versions[3],metadata:{package_type:"container",container:{tags:[build("d"),"v0.2.0-arm64"]}}};
  assert.deepEqual(cleanupCandidates([promoted],new Set()),[]);
});
test("published digest pins protect images even if their version tag disappeared", async () => {
  const versions = [version(1,"b",[]),version(2,"c",[build("c")]),version(3,"d",[build("d")])];
  const protectedSet = await protectedImageDigests(versions,async value=>value===digest("a")?index:leaf,[digest("a")]);
  assert.deepEqual(cleanupCandidates(versions,protectedSet).map(item=>item.id),[3]);
});
test("nested indices and attestation references are retained; missing children abort cleanup", async () => {
  const versions = [version(1,"a",["v0.1.0"]),version(2,"b",[]),version(3,"c",[])];
  const protectedSet = await protectedImageDigests(versions,async value=>value===digest("a")?{manifests:[{digest:digest("b")}]}:value===digest("b")?{manifests:[{digest:digest("c"),platform:{os:"unknown",architecture:"unknown"}}]}:leaf);
  assert.equal(protectedSet.size,3); assert.deepEqual(cleanupCandidates(versions,protectedSet),[]);
  await assert.rejects(protectedImageDigests(versions,async()=>{throw Error("Registry unavailable");}),/unavailable/);
  await assert.rejects(protectedImageDigests(versions,async()=>({manifests:[{digest:"invalid"}]})),/digest/);
});
test("malformed package IDs, digests and tags cannot reach deletion", () => {
  for (const item of [{...version(1,"a",[]),id:0},{...version(1,"a",[]),id:"1"},{...version(1,"a",[]),name:"../other"},{id:1,name:digest("a"),metadata:{package_type:"container",container:{tags:null}}}])
    assert.throws(()=>cleanupCandidates([item],new Set()));
});
test("release and maintenance share exclusion, and maintenance never rebuilds distributions", async () => {
  const workflow = await readFile(join(root,".github/workflows/image-maintenance.yml"),"utf8");
  const release = await readFile(join(root,".github/workflows/release.yml"),"utf8");
  for(const text of [workflow,release]) assert.match(text,/group: agent-lab-release/);
  assert.match(workflow,/packages: write/); assert.match(workflow,/--retag/); assert.match(workflow,/--cleanup --apply/);
  assert.doesNotMatch(workflow,/images\.mjs --push|package-desktop|release create|release upload/);
  assert.ok(release.indexOf("--cleanup --apply")>release.indexOf("Upload verified release assets"));
  const images = await readFile(join(root,"scripts/release/images.mjs"),"utf8");
  assert.match(images,/architectureTag\(plan, arch\)/); assert.doesNotMatch(images,/build-\$\{plan\.commit\}/);
});
