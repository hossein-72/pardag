import { CONSTANTS } from '../../shared/constants.js';
import { CryptoEngine } from '../crypto/crypto.js';

export class MessageDecorator {
  // کش درونحافظهای (Session) برای نمایش فوری پیامهای ارسالی خود کاربر و جلوگیری از رمزگشایی تکراری
  static sessionCache = new Map();

  static cachePlaintext(ciphertext, plaintext) {
    this.sessionCache.set(ciphertext.trim(), plaintext);
  }

  static async processElement(el, chatConfig) {
    // جلوگیری از پردازش مجدد المانی که قبلاً رمزگشایی شده (مگر اینکه متن آن توسط ویرایش تغییر کرده باشد)
    const rawText = el.textContent?.trim() || "";
    if (!rawText.startsWith(CONSTANTS.PREFIX)) return;

    if (el.dataset.baleEncProcessed === rawText) return;
    el.dataset.baleEncProcessed = rawText;

    // اگر چت در لیست رمزنگاریشدهها نباشد
    if (!chatConfig || !chatConfig.password) {
      this.renderWarning(el, CONSTANTS.MESSAGES.UNCONFIGURED_CHAT_WARN);
      return;
    }

    // ۱. بررسی کش نشست (Session Cache)
    if (this.sessionCache.has(rawText)) {
      this.renderSuccess(el, this.sessionCache.get(rawText));
      return;
    }

    // ۲. تلاش برای رمزگشایی با Web Crypto API
    try {
      const plaintext = await CryptoEngine.decrypt(rawText, chatConfig.password);
      this.sessionCache.set(rawText, plaintext);
      this.renderSuccess(el, plaintext);
    } catch (err) {
      this.renderWarning(el, CONSTANTS.MESSAGES.DECRYPT_FAILED);
    }
  }

  static renderSuccess(el, plaintext) {
    el.innerHTML = "";
    
    const badge = document.createElement("span");
    badge.className = "bale-enc-badge";
    badge.textContent = CONSTANTS.MESSAGES.DECRYPTED_BADGE;

    const textNode = document.createElement("div");
    textNode.className = "bale-enc-plaintext";
    textNode.textContent = plaintext; // استفاده از textContent برای جلوگیری کامل از XSS

    el.appendChild(badge);
    el.appendChild(textNode);
  }

  static renderWarning(el, warningText) {
    el.innerHTML = "";
    const errSpan = document.createElement("span");
    errSpan.className = "bale-enc-error";
    errSpan.textContent = warningText;
    el.appendChild(errSpan);
  }
}
