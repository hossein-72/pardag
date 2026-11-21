import { CryptoEngine } from '../content/crypto/crypto.js';
import { StorageManager } from './storage.js';

/**
 * مدیریت هویت رمزنگاری دستگاه.
 *
 * هر نصب افزونه یک جفت کلید RSA-OAEP (برای بسته‌بندی کلید AES در PARDAG2)،
 * یک جفت کلید ECDH P-256 (برای توافق کلید سبک در PARDAG3)
 * و یک جفت کلید ECDSA P-256 (برای امضای دیجیتال پیام‌ها و بسته تبادل کلید) دارد.
 * کلید خصوصی فقط در chrome.storage.local همین افزونه نگهداری می‌شود
 * و هیچ‌گاه در پیام‌ها ارسال نمی‌شود.
 */
export class IdentityManager {
  static cache = null;
  static inFlight = null;

  static async getIdentity() {
    if (this.cache) return this.cache;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.loadOrCreate()
      .then((identity) => {
        this.cache = identity;
        return identity;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /**
   * تولید مجدد کلید هویت (برای زمانی که کاربر می‌خواهد کلید خود را تغییر دهد).
   */
  static async regenerateIdentity() {
    const generated = await CryptoEngine.generateIdentity();
    const saved = await StorageManager.saveIdentity(generated);
    this.cache = saved;
    return saved;
  }

  static async loadOrCreate() {
    const runInit = async () => {
      let identity = await StorageManager.getIdentity();
      if (this.isValid(identity)) {
        return this.ensureEcdhSubkey(identity);
      }

      const owner = `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      for (let attempt = 0; attempt < 80; attempt++) {
        const acquired = await StorageManager.acquireIdentityLock(owner);
        if (acquired) {
          try {
            identity = await StorageManager.getIdentity();
            if (this.isValid(identity)) {
              return await this.ensureEcdhSubkey(identity);
            }

            const generated = await CryptoEngine.generateIdentity();

            const concurrentStored = await StorageManager.getIdentity();
            if (this.isValid(concurrentStored)) {
              return await this.ensureEcdhSubkey(concurrentStored);
            }

            await StorageManager.saveIdentity(generated);

            const stored = await StorageManager.getIdentity();
            if (this.isValid(stored)) {
              return stored;
            }
            return generated;
          } finally {
            await StorageManager.releaseIdentityLock(owner);
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
        identity = await StorageManager.getIdentity();
        if (this.isValid(identity)) {
          return await this.ensureEcdhSubkey(identity);
        }
      }

      throw new Error("Unable to initialize identity keys");
    };

    if (
      typeof navigator !== "undefined" &&
      navigator.locks &&
      typeof navigator.locks.request === "function"
    ) {
      return navigator.locks.request("bale_e2ee_identity_init", { mode: "exclusive" }, runInit);
    }

    return runInit();
  }

  static async ensureEcdhSubkey(identity) {
    if (
      identity &&
      identity.ecdh &&
      identity.ecdh.publicKeySpki &&
      identity.ecdh.privateKeyJwk
    ) {
      return identity;
    }

    try {
      const ecdh = await CryptoEngine.generateEcdhKeyPair();
      const upgraded = { ...identity, ecdh };
      await StorageManager.saveIdentity(upgraded);
      return upgraded;
    } catch {
      return identity;
    }
  }

  static isValid(identity) {
    return Boolean(
      identity &&
        identity.encryption &&
        identity.encryption.publicKeySpki &&
        identity.encryption.privateKeyJwk &&
        identity.signing &&
        identity.signing.publicKeySpki &&
        identity.signing.privateKeyJwk &&
        identity.fingerprint
    );
  }

  static clearCache() {
    this.cache = null;
  }
}
