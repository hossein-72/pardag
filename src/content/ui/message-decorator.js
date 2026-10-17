import { CONSTANTS } from '../../shared/constants.js';
import { StorageManager } from '../../shared/storage.js';
import { CryptoEngine } from '../crypto/crypto.js';

export class MessageDecorator {
  // کش درونحافظهای (Session) برای نمایش فوری پیامهای ارسالی خود کاربر و جلوگیری از رمزگشایی تکراری
  static sessionCache = new Map();

  static cachePlaintext(ciphertext, plaintext) {
    if (!ciphertext || !plaintext) return;
    const match = ciphertext.match(/BALEENC1:[A-Za-z0-9+/=]+/);
    const key = match ? match[0] : ciphertext.trim();
    this.sessionCache.set(key, plaintext);
  }

  static async processElement(el, chatConfig) {
    const rawContent = el.textContent || "";
    if (!rawContent.includes(CONSTANTS.PREFIX)) return;

    // استخراج دقیق Ciphertext با Regex
    const match = rawContent.match(/BALEENC1:[A-Za-z0-9+/=]+/);
    if (!match) return;
    const ciphertext = match[0];

    // جلوگیری از پردازش مجدد المانی که قبلاً رمزگشایی شده
    if (el.dataset.baleEncProcessed === ciphertext) return;
    el.dataset.baleEncProcessed = ciphertext;

    // ۱. بررسی کش نشست (Session Cache) برای پیام‌های ارسال‌شده توسط خود کاربر
    if (this.sessionCache.has(ciphertext)) {
      this.renderSuccess(el, this.sessionCache.get(ciphertext));
      return;
    }

    // ۲. شناسایی کلید برای رمزگشایی
    let password = chatConfig ? chatConfig.password : null;

    // اگر چت جاری تنظیم نشده بود، تمام کلیدهای ذخیره شده را امتحان میکنیم
    if (!password) {
      const allChats = await StorageManager.getEncryptedChats();
      for (const cfg of Object.values(allChats)) {
        if (cfg.password) {
          try {
            const pt = await CryptoEngine.decrypt(ciphertext, cfg.password);
            this.sessionCache.set(ciphertext, pt);
            this.renderSuccess(el, pt);
            return;
          } catch {}
        }
      }
      this.renderWarning(el, CONSTANTS.MESSAGES.UNCONFIGURED_CHAT_WARN);
      return;
    }

    // ۳. تلاش برای رمزگشایی با کلید چت جاری
    try {
      const plaintext = await CryptoEngine.decrypt(ciphertext, password);
      this.sessionCache.set(ciphertext, plaintext);
      this.renderSuccess(el, plaintext);
    } catch (err) {
      // در صورت خطا، چت‌های دیگر را نیز بررسی می‌کنیم
      const allChats = await StorageManager.getEncryptedChats();
      for (const cfg of Object.values(allChats)) {
        if (cfg.password && cfg.password !== password) {
          try {
            const pt = await CryptoEngine.decrypt(ciphertext, cfg.password);
            this.sessionCache.set(ciphertext, pt);
            this.renderSuccess(el, pt);
            return;
          } catch {}
        }
      }
      this.renderWarning(el, CONSTANTS.MESSAGES.DECRYPT_FAILED);
    }
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
    textNode.textContent = plaintext; // استفاده از textContent جهت جلوگیری کامل از XSS

    container.appendChild(badge);
    container.appendChild(textNode);
    el.appendChild(container);
  }

  static renderWarning(el, warningText) {
    el.innerHTML = "";
    const errSpan = document.createElement("span");
    errSpan.className = "bale-enc-error";
    errSpan.textContent = warningText;
    el.appendChild(errSpan);
  }
}
