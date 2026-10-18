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
    DECRYPTED_BADGE: "🔒 Encrypted message",
    DECRYPT_FAILED: "🔒 Encrypted message (decryption failed - invalid key)",
    UNCONFIGURED_CHAT_WARN: "🔒 Encrypted message (this chat is not in your encrypted list)",
    PREFIX_COLLISION_WARN: "Your text starts with the reserved prefix BALEENC1:. The message was not sent to prevent conflicts."
  }
};