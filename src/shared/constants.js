export const CONSTANTS = {
  PREFIXES: {
    PASSWORD: "PARDAG1:",
    HYBRID: "PARDAG2:",
    ECDH: "PARDAG3:",
    KEY_EXCHANGE: "PARDAG-KEY:"
  },

  // پیشوندهای نسل قبلی برای شناسایی و پوشاندن پیام‌های قدیمی در لیست چت‌ها و داخل چت
  LEGACY_PREFIXES: {
    PASSWORD: "BALEENC1:",
    HYBRID: "BALEENC2:",
    ECDH: "BALEENC3:",
    KEY_EXCHANGE: "BALEENC-KEY:"
  },

  PREFIX: "PARDAG1:",

  SALT: "bale-enc-ext-v1",
  PBKDF2_ITERATIONS: 600000,
  IV_LENGTH: 12, // 96 bits for AES-GCM
  KEY_LENGTH: 256,
  AES_KEY_LENGTH: 32,

  RSA_MODULUS_LENGTH: 2048,
  RSA_HASH: "SHA-256",
  ECDSA_CURVE: "P-256",
  ECDH_CURVE: "P-256",
  KEY_EXCHANGE_VERSION: 1,
  SIGNED_KEY_EXCHANGE_VERSION: 2,

  // مهلت زمانی اعتبار درخواست تبادل کلید (۱۰ دقیقه)
  KEY_EXCHANGE_TTL_MS: 10 * 60 * 1000,
  MAX_CLOCK_SKEW_MS: 60 * 60 * 1000,

  HANDSHAKE_STATES: {
    UNCONFIGURED: "unconfigured",
    INITIATING_SYN: "initiating_syn",
    AWAITING_ACK: "awaiting_ack",
    PENDING_APPROVAL: "pending_approval",
    ACTIVE: "active",
    KEY_CHANGED: "key_changed",
    EXPIRED: "expired"
  },

  HANDSHAKE_ROLES: {
    SYN: "SYN",
    ACK: "ACK",
    REJECT: "REJECT",
    ROTATE: "ROTATE"
  },

  // پیش‌نویس‌های محلی فقط برای چت‌های رمزنگاری‌شده نگهداری می‌شوند.
  DRAFT_SAVE_DEBOUNCE_MS: 350,
  DRAFT_MAX_BYTES: 2 * 1024 * 1024,
  DRAFT_PRUNE_CHECK_RATIO: 0.9,

  STORAGE_KEYS: {
    ENCRYPTED_CHATS: "encryptedChats",
    IDENTITY: "identityKey",
    IDENTITY_LOCK: "identityKeyLock",
    PENDING_PEERS: "pendingPeerKeys",
    RECOVERED_PEER_KEYS: "recoveredPeerKeys",
    TERMINATED_SESSIONS: "terminatedKeySessions",
    KEY_EXCHANGE_TTL_MINUTES: "keyExchangeTtlMinutes",
    DRAFT_PREFIX: "pardagEncDraft:",
    DRAFT_INDEX: "pardagEncDraftIndex"
  },

  MESSAGES: {
    DECRYPTED_BADGE: "🔒 پیام رمزنگاری‌شده",
    DECRYPT_FAILED: "🔒 پیام رمزنگاری‌شده (رمزگشایی ناموفق؛ کلید یا رمز عبور معتبر نیست)",
    OLD_PRIVATE_KEY_LOST:
      "🔒 پیام رمزنگاری‌شده (کلید خصوصی قبلی با حذف افزونه پاک شده است؛ در صورت داشتن فایل پشتیبان، از بخش «امنیت و پشتیبان‌گیری» بازیابی کنید)",
    UNCONFIGURED_CHAT_WARN: "🔒 پیام رمزنگاری‌شده (این چت در لیست رمزنگاری شما فعال نیست)",
    PREFIX_COLLISION_WARN:
      "متن شما با پیشوند رزروشده رمزنگاری شروع می‌شود. برای جلوگیری از تداخل، پیام ارسال نشد.",
    INVALID_SIGNATURE: "🔒 پیام رمزنگاری‌شده (امضای دیجیتال نامعتبر است)",
    UNKNOWN_SENDER: "🔒 پیام رمزنگاری‌شده (کلید فرستنده شناخته نشده است)",
    KEEP_KEY_MSG_WARN:
      "⚠️ این پیام را به هیچ وجه پاک نکنید تا چت قابل بازیابی باشد",
    KEY_EXCHANGE_SENT:
      "🔑 بسته کلید امنیتی ارسال شد (پاک نشود)",
    KEY_EXCHANGE_SENT_SYN:
      "🔑 درخواست تبادل کلید ارسال شد (حذف نشود)",
    KEY_EXCHANGE_SENT_ACK:
      "✅ کلید به اشتراک گذاشته شد (پاک نشود)",
    KEY_EXCHANGE_SENT_REJECT:
      "❌ درخواست تبادل کلید رد شد و فرایند پایان یافت",
    KEY_EXCHANGE_RECEIVED:
      "🔑 کلید امنیتی مخاطب دریافت شد (پاک نشود)",
    KEY_EXCHANGE_RECEIVED_SYN:
      "🔑 درخواست تبادل کلید دریافت شد (حذف نشود)",
    KEY_EXCHANGE_RECEIVED_ACK:
      "✅ تبادل کلید تکمیل شد (پاک نشود)",
    KEY_EXCHANGE_RECEIVED_REJECT:
      "❌ مخاطب اشتراک‌گذاری کلید را رد کرد — فرایند تبادل کلید پایان یافت",
    KEY_EXCHANGE_EXPIRED:
      "⌛ مهلت درخواست تبادل کلید تمام شد (پاک نشود)",
    KEY_EXCHANGE_HISTORICAL:
      "🕓 کلید قدیمی چت (پاک نشود)",
    KEY_EXCHANGE_PREVIEW: "🔑 پیام تبادل کلید (پاک نشود)",
    KEY_EXCHANGE_INVALID: "⚠️ پیام تبادل کلید نامعتبر است",
    KEY_EXCHANGE_CHAT_MISMATCH: "⚠️ پیام تبادل کلید متعلق به این چت نیست",
    WAITING_PEER_KEY: "درخواست تبادل کلید ارسال شد — منتظر تایید کاربر هدف در بازه زمانی مجاز...",
    PENDING_APPROVAL_PROMPT:
      "این کاربر قصد تبادل کلید با شما را دارد. آیا می‌خواهید کلید خود را به اشتراک بگذارید؟",
    KEY_CHANGED:
      "درخواست تبادل کلید جدیدی از مخاطب دریافت شده است. برای جایگزینی کلید قبلی آن را تایید کنید.",
    SEND_BLOCKED_NO_PEER:
      "فرایند تبادل کلید هنوز تکمیل نشده است (منتظر تایید مخاطب). پیام خام ارسال نشد.",
    SEND_BLOCKED_PENDING_APPROVAL:
      "درخواست تبادل کلید در انتظار تایید شماست. ابتدا در پنجره پاپ‌آپ مشخص کنید آیا مایل به اشتراک‌گذاری کلید هستید یا خیر.",
    SEND_BLOCKED_KEY_CHANGED:
      "مخاطب درخواست تبادل کلید جدیدی فرستاده است. پیش از ارسال پیام، درخواست جدید را تایید یا رد کنید.",
    SEND_BLOCKED_EXPIRED:
      "مهلت زمانی درخواست تبادل کلید به پایان رسیده است. لطفاً یک درخواست تبادل کلید جدید ارسال کنید.",
    ENABLED_RSA: "درخواست تبادل کلید ارسال شد. منتظر تایید کاربر هدف هستیم.",
    ACK_SENT_ACTIVE: "کلید شما به اشتراک گذاشته شد و فرایند تبادل کلید با موفقیت به اتمام رسید.",
    HANDSHAKE_CANCELED_BY_USER: "به درخواست تبادل کلید پایان داده شد.",
    HANDSHAKE_CANCELED_BY_PEER: "کاربر هدف اشتراک‌گذاری کلید را نپذیرفت و فرایند پایان یافت.",
    HANDSHAKE_EXPIRED_TARGET: "مهلت زمانی درخواست تبادل کلید گذشته بود؛ به این درخواست پایان داده شد.",
    HANDSHAKE_EXPIRED_INITIATOR: "در بازه زمانی مقرر پاسخی از کاربر هدف دریافت نشد؛ درخواست تبادل کلید پایان یافت.",
    KEY_RECEIVED: "کاربر هدف اشتراک‌گذاری کلید را تایید کرد. فرایند تبادل کلید به اتمام رسید و رمزنگاری فعال است.",
    IDENTITY_READY: "کلیدهای هویت امنیتی آماده شدند.",
    EDIT_KEY_EXCHANGE_CLEARED:
      "پیام تبادل کلید قابل ویرایش نیست؛ حالت ویرایش لغو شد.",
    EDIT_TEXT_UNAVAILABLE:
      "متن اصلی این پیام قابل بازیابی نبود؛ کادر ویرایش پاک شد.",
    DRAFT_RESTORED: "پیش‌نویس محلی این چت بازیابی شد.",
    DRAFT_TOO_LARGE:
      "پیش‌نویس بسیار بزرگ است و در حافظه محلی ذخیره نشد.",
    TOAST_TITLE: "رمزنگاری پردگ"
  },

  CIPHERTEXT_REGEX: /(?:PARDAG|BALEENC)[123]:[A-Za-z0-9+/=]+/,
  EXACT_CIPHERTEXT_REGEX: /^(?:PARDAG|BALEENC)[123]:[A-Za-z0-9+/=]+$/,

  KEY_EXCHANGE_REGEX:
    /^(?:PARDAG-KEY|BALEENC-KEY):(1|2):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)(?::([0-9a-zA-Z_-]*):(\d+):([A-Za-z0-9+/=]+)(?::([A-Za-z0-9+/=]*)(?::(SYN|ACK|REJECT|ROTATE):([0-9a-zA-Z_-]*):([0-9A-Fa-f]*))?)?)?$/,

  stripFormatting(text) {
    if (!text) return "";
    return String(text).replace(
      /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u00a0\u202f\ufeff]/g,
      ""
    );
  },

  allReservedPrefixes() {
    return [
      ...Object.values(this.PREFIXES),
      ...Object.values(this.LEGACY_PREFIXES)
    ];
  },

  hasReservedPrefix(text) {
    if (!text) return false;
    const clean = this.stripFormatting(text).trimStart();
    return this.allReservedPrefixes().some((p) => clean.startsWith(p));
  },

  containsReservedPrefix(text) {
    if (!text) return false;
    const clean = this.stripFormatting(text);
    return this.allReservedPrefixes().some((p) => clean.includes(p));
  },

  isKeyExchangePreview(text) {
    if (!text) return false;
    const clean = this.stripFormatting(text).trim();
    return (
      clean.startsWith(this.PREFIXES.KEY_EXCHANGE) ||
      clean.startsWith(this.LEGACY_PREFIXES.KEY_EXCHANGE) ||
      /(?:^|[\s:«"'])(?:PARDAG-KEY|BALEENC-KEY):(1|2):[A-Za-z0-9+/=]/.test(clean)
    );
  },

  isCiphertextPreview(text) {
    if (!text) return false;
    const clean = this.stripFormatting(text).trim();
    return /(?:^|[\s:«"'])(?:PARDAG|BALEENC)[123]:[A-Za-z0-9+/=]/.test(clean);
  },

  isKeyExchangeMessage(text) {
    if (!text) return false;
    const clean = this.stripFormatting(text).trim();
    if (
      !clean.startsWith(this.PREFIXES.KEY_EXCHANGE) &&
      !clean.startsWith(this.LEGACY_PREFIXES.KEY_EXCHANGE)
    ) {
      return false;
    }
    return this.KEY_EXCHANGE_REGEX.test(clean);
  },

  isExactCiphertext(text) {
    if (!text) return false;
    const clean = this.stripFormatting(text).trim();
    return this.EXACT_CIPHERTEXT_REGEX.test(clean);
  },

  extractCiphertext(text) {
    if (!text) return null;
    const clean = this.stripFormatting(text).trim();
    const match = clean.match(this.CIPHERTEXT_REGEX);
    return match ? match[0] : null;
  }
};
