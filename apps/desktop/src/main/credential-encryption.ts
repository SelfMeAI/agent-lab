import { safeStorage } from "electron";

type Storage = Pick<typeof safeStorage, "isAsyncEncryptionAvailable" | "encryptStringAsync" | "isEncryptionAvailable" | "getSelectedStorageBackend">;

/** Never opt into Electron's weak Linux basic-text fallback. Async readiness
 * alone confirms initialization, not the strength of a Linux key provider. */
export async function encryptCredential(plaintext: string, unavailable = "系统凭据加密暂不可用，未保存 API Key", storage: Storage = safeStorage, platform = process.platform): Promise<Buffer> {
  if (!(await storage.isAsyncEncryptionAvailable())) throw new Error(unavailable);
  if (platform === "linux") {
    const backend = storage.getSelectedStorageBackend();
    if (!["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(backend) || !storage.isEncryptionAvailable()) {
      throw new Error("系统密钥环不可用，未保存凭据。请启用 Secret Service 或 KWallet 后重试；不会回退为明文存储。");
    }
  }
  return storage.encryptStringAsync(plaintext);
}
