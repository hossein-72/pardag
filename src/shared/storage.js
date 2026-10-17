import { CONSTANTS } from './constants.js';

export class StorageManager {
  /**
   * دریافت لیست تمام چتهای رمزنگاریشده
   * ساختار: { "messenger_uid": { messenger, uid, displayName, password, fingerprint, enabled } }
   */
  static async getEncryptedChats() {
    const res = await chrome.storage.local.get(CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS);
    return res[CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS] || {};
  }

  static async getChatConfig(messenger, uid) {
    const chats = await this.getEncryptedChats();
    return chats[`${messenger}_${uid}`] || null;
  }

  static async saveChatConfig(messenger, uid, displayName, password, fingerprint, enabled = true) {
    const chats = await this.getEncryptedChats();
    const key = `${messenger}_${uid}`;
    chats[key] = {
      messenger,
      uid: String(uid).trim(),
      displayName: displayName.trim(),
      password,
      fingerprint,
      enabled,
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS]: chats });
  }

  static async toggleChatEnabled(messenger, uid) {
    const chats = await this.getEncryptedChats();
    const key = `${messenger}_${uid}`;
    if (chats[key]) {
      chats[key].enabled = !chats[key].enabled;
      await chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS]: chats });
      return chats[key].enabled;
    }
    return false;
  }

  static async removeChatConfig(messenger, uid) {
    const chats = await this.getEncryptedChats();
    const key = `${messenger}_${uid}`;
    delete chats[key];
    await chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS]: chats });
  }
}
