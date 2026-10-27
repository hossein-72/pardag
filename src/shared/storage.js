import { CONSTANTS } from './constants.js';

const CHATS_KEY = CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS;

export class StorageManager {
  /**
   * دریافت لیست تمام چت‌های رمزنگاری‌شده
   * ساختار: { "messenger_uid": { messenger, uid, displayName, mode, password?, fingerprint, enabled, ... } }
   */
  static async getEncryptedChats() {
    const res = await chrome.storage.local.get(CHATS_KEY);
    return res[CHATS_KEY] || {};
  }

  static async getChatConfig(messenger, uid) {
    const chats = await this.getEncryptedChats();
    return chats[`${messenger}_${uid}`] || null;
  }

  /**
   * ذخیره یا بروزرسانی تنظیمات یک چت.
   *
   * @param {string} messenger
   * @param {string} uid
   * @param {string} displayName
   * @param {string|undefined} password - فقط برای حالت پسورد مشترک
   * @param {string} fingerprint
   * @param {boolean} enabled
   * @param {object} extra - فیلدهای اضافی مانند mode، peerPublicKey و ...
   */
  static async saveChatConfig(
    messenger,
    uid,
    displayName,
    password,
    fingerprint,
    enabled = true,
    extra = {}
  ) {
    const chats = await this.getEncryptedChats();
    const key = `${messenger}_${uid}`;
    const existing = chats[key] || {};
    const mode = extra.mode || existing.mode || (password ? "password" : "rsa");

    let fp = fingerprint;
    if (!fp) {
      fp = mode === "rsa" ? existing.peerFingerprint || "" : existing.fingerprint || "";
    }

    const next = {
      ...existing,
      messenger,
      uid: String(uid).trim(),
      displayName: (displayName || existing.displayName || "").trim(),
      fingerprint: fp,
      mode,
      enabled,
      updatedAt: Date.now(),
      ...extra
    };

    // پسورد قدیمی برای خواندن پیام‌های BALEENC1 قبلی حفظ می‌شود،
    // حتی اگر چت به حالت تبادل خودکار کلید (RSA) منتقل شده باشد.
    if (typeof password === "string" && password.length > 0) {
      next.password = password;
    } else if (existing.password) {
      next.password = existing.password;
    }

    chats[key] = next;
    await chrome.storage.local.set({ [CHATS_KEY]: chats });
    return next;
  }

  static async updateChatConfig(messenger, uid, patch) {
    const chats = await this.getEncryptedChats();
    const key = `${messenger}_${uid}`;
    if (!chats[key]) return null;
    chats[key] = { ...chats[key], ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ [CHATS_KEY]: chats });
    return chats[key];
  }

  static async toggleChatEnabled(messenger, uid) {
    const chats = await this.getEncryptedChats();
    const key = `${messenger}_${uid}`;
    if (chats[key]) {
      // مقدار پیش‌فرض enabled برای تنظیمات قدیمی «فعال» است.
      chats[key].enabled = chats[key].enabled === false;
      chats[key].updatedAt = Date.now();
      await chrome.storage.local.set({ [CHATS_KEY]: chats });
      return chats[key].enabled;
    }
    return false;
  }

  static async removeChatConfig(messenger, uid) {
    const chats = await this.getEncryptedChats();
    const key = `${messenger}_${uid}`;
    delete chats[key];
    await chrome.storage.local.set({ [CHATS_KEY]: chats });
  }

  // ---------------------------------------------------------------------------
  // هویت رمزنگاری (کلیدهای RSA-OAEP و ECDSA)
  // ---------------------------------------------------------------------------

  static async getIdentity() {
    const res = await chrome.storage.local.get(CONSTANTS.STORAGE_KEYS.IDENTITY);
    return res[CONSTANTS.STORAGE_KEYS.IDENTITY] || null;
  }

  static async saveIdentity(identity) {
    await chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.IDENTITY]: identity });
  }

  /**
   * قفل کوتاه‌مدت برای جلوگیری از ساخت هم‌زمان هویت در چند تب/پاپ‌آپ.
   */
  static async acquireIdentityLock(owner, ttl = 8000) {
    const lockKey = CONSTANTS.STORAGE_KEYS.IDENTITY_LOCK;
    const res = await chrome.storage.local.get(lockKey);
    const lock = res[lockKey];

    if (lock && lock.expiresAt > Date.now() && lock.owner !== owner) {
      return false;
    }

    await chrome.storage.local.set({
      [lockKey]: { owner, expiresAt: Date.now() + ttl }
    });
    return true;
  }

  static async releaseIdentityLock(owner) {
    const lockKey = CONSTANTS.STORAGE_KEYS.IDENTITY_LOCK;
    const res = await chrome.storage.local.get(lockKey);
    if (res[lockKey] && res[lockKey].owner === owner) {
      await chrome.storage.local.remove(lockKey);
    }
  }

  // ---------------------------------------------------------------------------
  // درخواست‌های در انتظار تبادل کلید (مخاطبی که هنوز رمزنگاری را فعال نکرده)
  // ---------------------------------------------------------------------------

  static async getPendingPeers() {
    const res = await chrome.storage.local.get(CONSTANTS.STORAGE_KEYS.PENDING_PEERS);
    return res[CONSTANTS.STORAGE_KEYS.PENDING_PEERS] || {};
  }

  static async getPendingPeer(messenger, uid) {
    const peers = await this.getPendingPeers();
    return peers[`${messenger}_${uid}`] || null;
  }

  static async savePendingPeer(messenger, uid, data) {
    const peers = await this.getPendingPeers();
    const key = `${messenger}_${uid}`;
    peers[key] = {
      messenger,
      uid: String(uid).trim(),
      ...data,
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({
      [CONSTANTS.STORAGE_KEYS.PENDING_PEERS]: peers
    });
    return peers[key];
  }

  static async removePendingPeer(messenger, uid) {
    const peers = await this.getPendingPeers();
    delete peers[`${messenger}_${uid}`];
    await chrome.storage.local.set({
      [CONSTANTS.STORAGE_KEYS.PENDING_PEERS]: peers
    });
  }
}
