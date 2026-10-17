import { CONSTANTS } from '../../shared/constants.js';

// کش کردن کلیدهای مشتقشده در طول نشست برای جلوگیری از اجرای مکرر 600,000 دور PBKDF2
const derivedKeyCache = new Map();

export class CryptoEngine {
  static encoder = new TextEncoder();
  static decoder = new TextDecoder();

  /**
   * تبدیل بافر به Base64 استاندارد
   */
  static bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * تبدیل Base64 به Uint8Array با پاکسازی کاراکترهای نامعتبر
   */
  static base64ToBuffer(base64) {
    // پاکسازی فاصله‌ها، شکستگی‌های خط و کاراکترهای نامرئی یونیکد/BiDi
    const cleanBase64 = base64.replace(/[^A-Za-z0-9+/=]/g, '');
    const binary = atob(cleanBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * تولید کلید تصادفی ۳۲ بایتی (نمایش به صورت Base64)
   */
  static generateRandomKeyBase64() {
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    return this.bufferToBase64(randomBytes);
  }

  /**
   * اشتقاق کلید AES-256-GCM از پسورد با PBKDF2-SHA256
   * به همراه استخراج بایتهای خام برای محاسبه Fingerprint
   */
  static async deriveKeyAndRaw(password) {
    if (derivedKeyCache.has(password)) {
      return derivedKeyCache.get(password);
    }

    const baseKey = await crypto.subtle.importKey(
      "raw",
      this.encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );

    const saltBuffer = this.encoder.encode(CONSTANTS.SALT);

    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBuffer,
        iterations: CONSTANTS.PBKDF2_ITERATIONS,
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: CONSTANTS.KEY_LENGTH },
      true, // extractable برای محاسبه fingerprint
      ["encrypt", "decrypt"]
    );

    const rawKeyBuffer = await crypto.subtle.exportKey("raw", aesKey);
    const result = { aesKey, rawKeyBuffer };
    derivedKeyCache.set(password, result);
    return result;
  }

  /**
   * محاسبه Fingerprint: ۸ کاراکتر اول هگز از SHA-256 کلید مشتقشده
   */
  static async getKeyFingerprint(password) {
    const { rawKeyBuffer } = await this.deriveKeyAndRaw(password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", rawKeyBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.substring(0, 8).toUpperCase();
  }

  /**
   * رمزنگاری متن
   * خروجی: BALEENC1:<base64(IV(12B) || ciphertext || GCM_tag(16B))>
   */
  static async encrypt(plaintext, password) {
    const { aesKey } = await this.deriveKeyAndRaw(password);
    const iv = crypto.getRandomValues(new Uint8Array(CONSTANTS.IV_LENGTH));
    const encodedText = this.encoder.encode(plaintext);

    // در Web Crypto API، خروجی AES-GCM به صورت خودکار شامل Ciphertext + 16B Auth Tag در انتهای بافر است
    const cipherBuffer = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128 // 16 bytes
      },
      aesKey,
      encodedText
    );

    const cipherBytes = new Uint8Array(cipherBuffer);
    const combined = new Uint8Array(iv.byteLength + cipherBytes.byteLength);
    combined.set(iv, 0);
    combined.set(cipherBytes, iv.byteLength);

    return CONSTANTS.PREFIX + this.bufferToBase64(combined);
  }

  /**
   * رمزگشایی متن با پشتیبانی از استخراج هوشمند و پاکسازی کاراکترهای مخرب
   */
  static async decrypt(payload, password) {
    if (!payload || !payload.includes(CONSTANTS.PREFIX)) {
      throw new Error("Invalid prefix");
    }

    // استخراج بخش Base64 با Regex بدون وابستگی به کاراکترهای جهت متن (RTL/LTR)
    const match = payload.match(/BALEENC1:([A-Za-z0-9+/=]+)/);
    if (!match || !match[1]) {
      throw new Error("Invalid payload format");
    }

    const base64Data = match[1];
    const combined = this.base64ToBuffer(base64Data);

    // حداقل طول: 12 بایت IV + 16 بایت تگ = 28 بایت
    if (combined.byteLength < 28) {
      throw new Error("Payload too short");
    }

    const iv = combined.slice(0, CONSTANTS.IV_LENGTH);
    const ciphertextWithTag = combined.slice(CONSTANTS.IV_LENGTH);

    const { aesKey } = await this.deriveKeyAndRaw(password);

    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128
      },
      aesKey,
      ciphertextWithTag
    );

    return this.decoder.decode(decryptedBuffer);
  }
}
