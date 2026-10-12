import { describe, expect, it } from "vitest";
import { officeExtensions, remotePreviewKind } from "./file-preview";

describe("shared remote file preview formats", () => {
  it("recognizes all six confirmed office formats regardless of name, case or folder", () => {
    expect(officeExtensions).toEqual([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
    for (const extension of officeExtensions) expect(remotePreviewKind("uploads/办公 文件" + extension.toUpperCase())).toBe("office");
  });
  it("preserves the existing image, PDF, HTML and text formats", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]) expect(remotePreviewKind("file" + ext)).toBe("image");
    expect(remotePreviewKind("file.PDF")).toBe("pdf");
    for (const ext of [".html", ".htm"]) expect(remotePreviewKind("file" + ext)).toBe("html");
    for (const ext of [".txt", ".md", ".csv", ".json", ".ts", ".py", ".sql", ".rs"]) expect(remotePreviewKind("file" + ext)).toBe("text");
  });
  it("does not claim unconfirmed formats or misleading filename suffixes", () => {
    for (const path of ["file.wps", "file.et", "file.dps", "file.docm", "file.zip", "file.docx.exe", "folder.docx/file", "file"]) expect(remotePreviewKind(path)).toBe("binary");
  });
});
