import { describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RemoteServiceCredentials } from "./credentials";
import { RemoteAgentContainer } from "./service-manager";
import { RemoteTaskController } from "./task-controller";
import { RemoteModelClient } from "../../../../../packages/remote-agent/src/model-connection";
import { documentPreviewDefinition } from "./document-preview-service";

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const fixtures = resolve(projectRoot, ".work/remote-agent/document-preview-fixtures");

describe.skipIf(process.env.SELFME_DOCUMENT_PREVIEW_INTEGRATION !== "1")("real Office rendering in both native services", () => {
  it("renders six formats, Chinese, multiple sheets/pages, and leaves encrypted, invalid and original files untouched", async () => {
    await mkdir(fixtures, { recursive: true });
    await exec("docker", ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--mount", `type=bind,src=${resolve(projectRoot, "services/remote-agent/document-preview/tests")},dst=/fixtures-script,readonly`,
      "--mount", `type=bind,src=${fixtures},dst=/fixtures`, "--entrypoint", "python3", documentPreviewDefinition.image, "/fixtures-script/fixtures.py", "/fixtures"], { timeout: 30_000 });
    const rendered = join(fixtures, "rendered"); await mkdir(rendered, { recursive: true });
    for (const engine of ["openhands", "openclaw"] as const) {
      const root = resolve(projectRoot, ".work/remote-agent/office-native-" + engine + "-" + randomUUID());
      const credentials = new RemoteServiceCredentials(root, { encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() }, engine);
      const container = new RemoteAgentContainer(root, () => credentials.get(), engine);
      const connection = { endpoint: () => container.requireEndpoint(), credentials: () => credentials.get(), ensureDocumentPreview: () => container.ensureDocumentPreview() };
      const controller = new RemoteTaskController({ openhands: connection, openclaw: connection }, { choose: async () => [], save: async name => join(root, name) }, () => {}, () => {});
      const client = controller.client(engine);
      let taskId: string | undefined;
      try {
        expect((await container.start()).phase).toBe("ready");
        const models = new RemoteModelClient(engine, connection.endpoint, connection.credentials);
        await models.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "offline-fixture-key" });
        await expect.poll(async () => (await container.state()).phase, { timeout: 20_000 }).toBe("ready");
        const task = await client.create(); taskId = task.id;
        for (const extension of ["doc", "docx", "xls", "xlsx", "ppt", "pptx"]) {
          const original = await readFile(join(fixtures, "office-proof." + extension)), path = "uploads/办公验收." + extension;
          await client.http.upload(task.id, path, original);
          const preview = await controller.preview(engine, task.id, path);
          expect(preview).toMatchObject({ kind: "pdf", mime: "application/pdf", sourceFormat: "." + extension });
          const response = await fetch(preview.url!);
          expect(response.headers.get("content-type")).toBe("application/pdf"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
          const pdf = Buffer.from(await response.arrayBuffer()); expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
          const pdfPath = join(rendered, engine + "-" + extension + ".pdf"); await writeFile(pdfPath, pdf);
          const text = (await exec("pdftotext", [pdfPath, "-"])).stdout;
          expect(text).toContain("Office Preview Proof");
          if (extension === "xls" || extension === "xlsx") { expect(text).toContain("1337"); expect(text).toContain("Multi Sheet Proof"); }
          else expect(text).toContain(extension.startsWith("ppt") ? "演示文稿预览验收" : "办公文档预览验收");
          const info = (await exec("pdfinfo", [pdfPath])).stdout;
          if (extension.startsWith("ppt")) expect(info).toMatch(/Pages:\s+2/);
          if (extension === "doc" || extension === "docx") expect(Number(/Pages:\s+(\d+)/.exec(info)?.[1])).toBeGreaterThan(1);
          const downloaded = Buffer.from(await (await client.http.download(task.id, path)).arrayBuffer());
          expect(createHash("sha256").update(downloaded).digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
        }
        const encrypted = await readFile(join(fixtures, "encrypted.docx"));
        await client.http.upload(task.id, "uploads/encrypted.docx", encrypted);
        await expect(controller.preview(engine, task.id, "uploads/encrypted.docx")).rejects.toThrow("加密");
        expect(Buffer.from(await (await client.http.download(task.id, "uploads/encrypted.docx")).arrayBuffer())).toEqual(encrypted);
        await client.http.upload(task.id, "uploads/broken.xlsx", Buffer.from("not an Excel file"));
        await expect(controller.preview(engine, task.id, "uploads/broken.xlsx")).rejects.toThrow("格式不匹配");
        await client.http.upload(task.id, "uploads/text.txt", Buffer.from("TEXT_PREVIEW_OK"));
        expect((await controller.preview(engine, task.id, "uploads/text.txt")).text).toBe("TEXT_PREVIEW_OK");
        expect((await client.http.listFiles(task.id, "uploads")).files.some(file => file.name.endsWith(".pdf"))).toBe(false);
        expect((await client.list()).some(row => row.id === task.id)).toBe(true);
        const keys = await credentials.get(), log = await container.logs();
        expect(log).not.toContain(keys.sessionApiKey); expect(log).not.toContain(keys.persistenceKey);
        await controller.download(engine, task.id, "uploads/办公验收.docx");
        expect(await readFile(join(root, "办公验收.docx"))).toEqual(await readFile(join(fixtures, "office-proof.docx")));
        expect((await readdir(root)).some(name => name.endsWith(".pdf"))).toBe(false);
      } catch (error) {
        console.error(await container.logs()); throw error;
      } finally {
        if (taskId) await client.delete(taskId).catch(() => {});
        controller.shutdown(); await container.stop();
        await exec("docker", ["rm", container.name]).catch(error => { if (!/No such container/i.test(String(error.stderr))) throw error; });
        await exec("docker", ["volume", "rm", container.volume]).catch(error => { if (!/no such volume/i.test(String(error.stderr))) throw error; });
        await exec("docker", ["rm", `selfme-lab-document-preview-${container.owner}`]).catch(error => { if (!/No such container/i.test(String(error.stderr))) throw error; });
        await exec("docker", ["network", "rm", `selfme-lab-document-preview-${container.owner}-network`]).catch(error => { if (!/not found|no such network/i.test(String(error.stderr))) throw error; });
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 240_000);
});
