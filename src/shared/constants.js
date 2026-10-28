export const CONSTANTS = {
  PREFIXES: {
    PASSWORD: "BALEENC1:",
    HYBRID: "BALEENC2:",
    KEY_EXCHANGE: "BALEENC-KEY:"
  },

  // Backward-compatible alias for the original password-based format.
  PREFIX: "BALEENC1:",

  SALT: "bale-enc-ext-v1",
  PBKDF2_ITERATIONS: 600000,
  IV_LENGTH: 12, // 96 bits for AES-GCM
  KEY_LENGTH: 256,
  AES_KEY_LENGTH: 32,

  RSA_MODULUS_LENGTH: 2048,
  RSA_HASH: "SHA-256",
  ECDSA_CURVE: "P-256",
  KEY_EXCHANGE_VERSION: 1,

  STORAGE_KEYS: {
    ENCRYPTED_CHATS: "encryptedChats",
    IDENTITY: "identityKey",
    IDENTITY_LOCK: "identityKeyLock",
    PENDING_PEERS: "pendingPeerKeys"
  },

  MESSAGES: {
    DECRYPTED_BADGE: "🔒 پیام رمزنگاری‌شده",
    DECRYPT_FAILED: "🔒 پیام رمزنگاری‌شده (رمزگشایی ناموفق - کلید نامعتبر)",
    UNCONFIGURED_CHAT_WARN: "🔒 پیام رمزنگاری‌شده (این چت در لیست رمزنگاری شما نیست)",
    PREFIX_COLLISION_WARN:
      "متن شما با پیشوند رزروشده رمزنگاری شروع می‌شود. برای جلوگیری از تداخل، پیام ارسال نشد.",
    INVALID_SIGNATURE: "🔒 پیام رمزنگاری‌شده (امضای دیجیتال نامعتبر است)",
    UNKNOWN_SENDER: "🔒 پیام رمزنگاری‌شده (کلید فرستنده ناشناخته است)",
    KEY_EXCHANGE_SENT: "🔑 کلید امنیتی شما ارسال شد",
    KEY_EXCHANGE_RECEIVED: "🔑 کلید امنیتی مخاطب دریافت شد",
    KEY_EXCHANGE_PREVIEW: "🔑 پیام تبادل کلید",
    KEY_EXCHANGE_INVALID: "⚠️ پیام تبادل کلید نامعتبر است",
    WAITING_PEER_KEY: "در انتظار کلید امنیتی مخاطب...",
    KEY_CHANGED:
      "کلید امنیتی مخاطب تغییر کرده است. لطفاً کد امنیتی را دوباره با مخاطب مقایسه کنید.",
    SEND_BLOCKED_NO_PEER:
      "کلید امنیتی مخاطب هنوز دریافت نشده است. مطمئن شوید مخاطب افزونه را نصب کرده و این چت را باز کرده است.",
    ENABLED_RSA: "رمزنگاری خودکار فعال شد. کلید امنیتی شما در حال ارسال است.",
    KEY_RECEIVED: "کلید امنیتی مخاطب دریافت شد. رمزنگاری آماده است.",
    IDENTITY_READY: "کلیدهای هویت امنیتی آماده شدند.",
    EDIT_KEY_EXCHANGE_CLEARED:
      "پیام تبادل کلید قابل ویرایش نیست؛ کادر ویرایش پاک شد.",
    EDIT_TEXT_UNAVAILABLE:
      "متن اصلی این پیام قابل بازیابی نبود؛ کادر ویرایش پاک شد.",
    TOAST_TITLE: "رمزنگاری بله"
  },

  CIPHERTEXT_REGEX: /BALEENC[12]:[A-Za-z0-9+/=]+/,
  KEY_EXCHANGE_REGEX: /BALEENC-KEY:1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)/,

  /**
   * حذف کاراکترهای نامرئی و جهت‌دهی متن که ممکن است توسط پیام‌رسان اضافه شوند.
   */
  stripFormatting(text) {
    if (!text) return "";
    return String(text).replace(
      /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u00a0\u202f]/g,
      ""
    );
  },

  hasReservedPrefix(text) {
    if (!text) return false;
    const clean = this.stripFormatting(text).trimStart();
    return Object.values(this.PREFIXES).some((p) => clean.startsWith(p));
  },

  /**
   * استخراج امن ciphertext از یک متن که ممکن است شامل کاراکترهای جهت‌دهی باشد.
   */
  extractCiphertext(text) {
    if (!text) return null;
    const clean = this.stripFormatting(text);
    const match = clean.match(this.CIPHERTEXT_REGEX);
    return match ? match[0] : null;
  }
};
