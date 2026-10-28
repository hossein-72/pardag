import { CONSTANTS } from '../../shared/constants.js';
import { StorageManager } from '../../shared/storage.js';
import { IdentityManager } from '../../shared/identity.js';
import { CryptoEngine } from '../crypto/crypto.js';

export class MessageDecorator {
  // کش درون‌حافظه‌ای (Session) برای نمایش فوری پیام‌های ارسالی خود کاربر
  static sessionCache = new Map();

  static cachePlaintext(ciphertext, plaintext) {
    if (!ciphertext || !plaintext) return;
    const key = CONSTANTS.extractCiphertext(ciphertext) || ciphertext.trim();
    this.sessionCache.set(key, plaintext);
  }

  static async processElement(el, chatConfig, ciphertextOverride = null) {
    const rawContent = el.textContent || "";

    // پیام‌های تبادل کلید توسط ContentController مدیریت می‌شوند.
    if (!ciphertextOverride && rawContent.includes(CONSTANTS.PREFIXES.KEY_EXCHANGE)) return;

    const ciphertext =
      ciphertextOverride || CONSTANTS.extractCiphertext(rawContent);
    if (!ciphertext) return;

    // پیش‌نمایش لیست چت‌ها ممکن است متن بریده‌شده باشد؛ رمزگشایی آن در context
    // چت جاری می‌تواند خطای کاذب «کلید نامعتبر» تولید کند.
    if (el.dataset.baleEncPreview === "1") {
      this.renderPreview(el);
      return;
    }

    const isHybrid = ciphertext.startsWith(CONSTANTS.PREFIXES.HYBRID);
    const peerMarker = chatConfig ? chatConfig.peerFingerprint || "none" : "none";
    const marker = `${ciphertext}|${peerMarker}`;

    // جلوگیری از پردازش مجدد المانی که قبلاً رمزگشایی شده
    if (el.dataset.baleEncProcessed === marker) return;
    el.dataset.baleEncProcessed = marker;

    // ۱. پیام‌های ارسال‌شده توسط خود کاربر در همین نشست
    if (this.sessionCache.has(ciphertext)) {
      this.renderSuccess(el, this.sessionCache.get(ciphertext));
      return;
    }

    if (isHybrid) {
      await this.processHybrid(el, ciphertext, chatConfig);
    } else {
      await this.processPassword(el, ciphertext, chatConfig);
    }
  }

  // ---------------------------------------------------------------------------
  // حالت پسورد مشترک (BALEENC1)
  // ---------------------------------------------------------------------------

  static async processPassword(el, ciphertext, chatConfig) {
    let password = chatConfig && chatConfig.password ? chatConfig.password : null;

    // اگر چت جاری تنظیم نشده بود، تمام کلیدهای ذخیره‌شده را امتحان می‌کنیم
    if (!password) {
      const allChats = await StorageManager.getEncryptedChats();
      for (const cfg of Object.values(allChats)) {
        if (cfg.password) {
          try {
            const plaintext = await CryptoEngine.decrypt(ciphertext, cfg.password);
            this.sessionCache.set(ciphertext, plaintext);
            this.renderSuccess(el, plaintext);
            return;
          } catch {
            // کلید بعدی را امتحان می‌کنیم
          }
        }
      }
      this.renderWarning(el, CONSTANTS.MESSAGES.UNCONFIGURED_CHAT_WARN, ciphertext);
      return;
    }

    // تلاش برای رمزگشایی با کلید چت جاری
    try {
      const plaintext = await CryptoEngine.decrypt(ciphertext, password);
      this.sessionCache.set(ciphertext, plaintext);
      this.renderSuccess(el, plaintext);
    } catch {
      // در صورت خطا، چت‌های دیگر را نیز بررسی می‌کنیم
      const allChats = await StorageManager.getEncryptedChats();
      for (const cfg of Object.values(allChats)) {
        if (cfg.password && cfg.password !== password) {
          try {
            const plaintext = await CryptoEngine.decrypt(ciphertext, cfg.password);
            this.sessionCache.set(ciphertext, plaintext);
            this.renderSuccess(el, plaintext);
            return;
          } catch {
            // کلید بعدی را امتحان می‌کنیم
          }
        }
      }
      this.renderWarning(el, CONSTANTS.MESSAGES.DECRYPT_FAILED, ciphertext);
    }
  }

  // ---------------------------------------------------------------------------
  // حالت تبادل خودکار کلید (BALEENC2)
  // ---------------------------------------------------------------------------

  static async processHybrid(el, ciphertext, chatConfig) {
    let identity;
    try {
      identity = await IdentityManager.getIdentity();
    } catch {
      this.renderWarning(el, CONSTANTS.MESSAGES.DECRYPT_FAILED, ciphertext);
      return;
    }

    const kid = CryptoEngine.peekHybridKid(ciphertext);
    let signingPublicKeySpki = null;

    // پیام ارسال‌شده توسط خودمان (مثلاً بعد از رفرش صفحه)
    if (kid && kid === identity.fingerprint) {
      signingPublicKeySpki = identity.signing.publicKeySpki;
    } else {
      signingPublicKeySpki = await this.resolvePeerSigningKey(kid, chatConfig);
    }

    if (!signingPublicKeySpki) {
      this.renderWarning(el, CONSTANTS.MESSAGES.UNKNOWN_SENDER, ciphertext);
      return;
    }

    try {
      const result = await CryptoEngine.decryptHybrid(ciphertext, {
        privateKeyJwk: identity.encryption.privateKeyJwk,
        signingPublicKeySpki
      });

      this.sessionCache.set(ciphertext, result.plaintext);
      this.renderSuccess(el, result.plaintext);
    } catch (err) {
      if (err && err.message === "INVALID_SIGNATURE") {
        this.renderWarning(el, CONSTANTS.MESSAGES.INVALID_SIGNATURE, ciphertext);
      } else {
        this.renderWarning(el, CONSTANTS.MESSAGES.DECRYPT_FAILED, ciphertext);
      }
    }
  }

  /**
   * یافتن کلید عمومی امضای فرستنده بر اساس fingerprint موجود در پیام.
   */
  static async resolvePeerSigningKey(kid, chatConfig) {
    if (!kid) return null;

    const fromConfig = (cfg) => {
      if (!cfg) return null;
      if (cfg.peerFingerprint === kid && cfg.peerSigningPublicKey) {
        return cfg.peerSigningPublicKey;
      }
      if (Array.isArray(cfg.peerKeyHistory)) {
        const old = cfg.peerKeyHistory.find(
          (entry) =>
            entry &&
            entry.fingerprint === kid &&
            entry.signingPublicKeySpki
        );
        if (old) return old.signingPublicKeySpki;
      }
      return null;
    };

    const direct = fromConfig(chatConfig);
    if (direct) return direct;

    const allChats = await StorageManager.getEncryptedChats();
    for (const cfg of Object.values(allChats)) {
      const key = fromConfig(cfg);
      if (key) return key;
    }

    const pendingPeers = await StorageManager.getPendingPeers();
    for (const peer of Object.values(pendingPeers)) {
      if (peer.peerFingerprint === kid && peer.peerSigningPublicKey) {
        return peer.peerSigningPublicKey;
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // نمایش
  // ---------------------------------------------------------------------------

  static renderPreview(el, text = CONSTANTS.MESSAGES.DECRYPTED_BADGE) {
    el.innerHTML = "";
    const badge = document.createElement("span");
    badge.className = "bale-enc-preview";
    badge.textContent = text;
    el.appendChild(badge);

    delete el.dataset.baleEncFailed;
    delete el.dataset.baleEncCiphertext;
  }

  static renderSuccess(el, plaintext) {
    // ایجاد ساختار امن بدون دستکاری زمان یا آیکون تیک خوانده‌شدن پیام
    el.innerHTML = "";

    const container = document.createElement("div");
    container.className = "bale-enc-container";

    const badge = document.createElement("span");
    badge.className = "bale-enc-badge";
    badge.textContent = CONSTANTS.MESSAGES.DECRYPTED_BADGE;

    const textNode = document.createElement("div");
    textNode.className = "bale-enc-plaintext";
    textNode.textContent = plaintext; // textContent برای جلوگیری کامل از XSS

    container.appendChild(badge);
    container.appendChild(textNode);
    el.appendChild(container);

    delete el.dataset.baleEncFailed;
    delete el.dataset.baleEncCiphertext;
  }

  static renderWarning(el, warningText, ciphertext = "") {
    el.innerHTML = "";
    const errSpan = document.createElement("span");
    errSpan.className = "bale-enc-error";
    errSpan.textContent = warningText;
    el.appendChild(errSpan);
    el.dataset.baleEncFailed = "true";
    if (ciphertext) el.dataset.baleEncCiphertext = ciphertext;
  }
}
