import { CryptoEngine } from '../content/crypto/crypto.js';
import { StorageManager } from './storage.js';

/**
 * مدیریت هویت رمزنگاری دستگاه.
 *
 * هر نصب افزونه یک جفت کلید RSA-OAEP (برای رمزنگاری کلید AES)
 * و یک جفت کلید ECDSA (برای امضای دیجیتال پیام‌ها) دارد.
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

  static async loadOrCreate() {
    let identity = await StorageManager.getIdentity();
    if (this.isValid(identity)) return identity;

    const owner = `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    for (let attempt = 0; attempt < 80; attempt++) {
      const acquired = await StorageManager.acquireIdentityLock(owner);
      if (acquired) {
        try {
          identity = await StorageManager.getIdentity();
          if (!this.isValid(identity)) {
            identity = await CryptoEngine.generateIdentity();
            await StorageManager.saveIdentity(identity);

            // اگر فرایند دیگری هم‌زمان کلید ساخته باشد، از نسخه ذخیره‌شده استفاده می‌کنیم
            // تا همه contextها روی یک هویت یکسان باقی بمانند.
            const stored = await StorageManager.getIdentity();
            if (this.isValid(stored)) identity = stored;
          }
          return identity;
        } finally {
          await StorageManager.releaseIdentityLock(owner);
        }
      }

      // ممکن است تب دیگری در حال ساخت کلید باشد؛ کمی صبر می‌کنیم.
      await new Promise((resolve) => setTimeout(resolve, 100));
      identity = await StorageManager.getIdentity();
      if (this.isValid(identity)) return identity;
    }

    throw new Error("Unable to initialize identity keys");
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
