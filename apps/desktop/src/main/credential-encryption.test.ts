import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ safeStorage: {} }));
import { encryptCredential } from "./credential-encryption";

function storage(backend: "basic_text" | "gnome_libsecret" | "kwallet6" | "unknown" = "gnome_libsecret", available = true) {
  return { isAsyncEncryptionAvailable: vi.fn(async () => true), encryptStringAsync: vi.fn(async () => Buffer.from("encrypted")),
    isEncryptionAvailable: vi.fn(() => available), getSelectedStorageBackend: vi.fn(() => backend) };
}
describe("credential encryption platform guard", () => {
  it("retains existing Mac/Windows async encryption and availability failures", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const native = storage(); await encryptCredential("fixture", "unavailable", native, platform);
      expect(native.encryptStringAsync).toHaveBeenCalledWith("fixture"); expect(native.getSelectedStorageBackend).not.toHaveBeenCalled();
      native.isAsyncEncryptionAvailable.mockResolvedValue(false);
      await expect(encryptCredential("fixture", "unavailable", native, platform)).rejects.toThrow("unavailable");
      expect(native.encryptStringAsync).toHaveBeenCalledTimes(1);
    }
  });
  it("refuses Linux weak, unknown or unavailable backends even when async initialization succeeds", async () => {
    for (const native of [storage("basic_text"), storage("unknown"), storage("gnome_libsecret", false)]) {
      await expect(encryptCredential("fixture", undefined, native, "linux")).rejects.toThrow("系统密钥环不可用");
      expect(native.encryptStringAsync).not.toHaveBeenCalled();
    }
    for (const backend of ["gnome_libsecret", "kwallet6"] as const) {
      const native = storage(backend); await encryptCredential("fixture", undefined, native, "linux");
      expect(native.encryptStringAsync).toHaveBeenCalledOnce();
    }
  });
});
