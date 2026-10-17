export const CONSTANTS = {
  PREFIX: "BALEENC1:",
  SALT: "bale-enc-ext-v1",
  PBKDF2_ITERATIONS: 600000,
  IV_LENGTH: 12, // 96 bits for AES-GCM
  KEY_LENGTH: 256,
  STORAGE_KEYS: {
    ENCRYPTED_CHATS: "encryptedChats"
  },
  MESSAGES: {
    DECRYPTED_BADGE: "🔒 پیام رمزنگاریشده",
    DECRYPT_FAILED: "🔒 پیام رمزنگاریشده (رمزگشایی ناموفق - کلید نامعتبر)",
    UNCONFIGURED_CHAT_WARN: "🔒 پیام رمزنگاریشده (این چت در لیست رمزنگاری شما نیست)",
    PREFIX_COLLISION_WARN: "متن شما با پیشوند رزرو شده BALEENC1: شروع میشود. جهت جلوگیری از اختلال، پیام ارسال نشد."
  }
};
