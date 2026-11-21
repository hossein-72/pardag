import { CONSTANTS } from './constants.js';

const CHATS_KEY = CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS;
const TERMINATED_SESSIONS_KEY = CONSTANTS.STORAGE_KEYS.TERMINATED_SESSIONS;
const RECOVERED_KEYS_KEY = CONSTANTS.STORAGE_KEYS.RECOVERED_PEER_KEYS;

export class StorageManager {
  static _mutex = Promise.resolve();

  static async _withLock(lockName, fn) {
    const runInProcessQueue = () => {
      const next = this._mutex.catch(() => {}).then(fn);
      this._mutex = next.catch(() => {});
      return next;
    };

    if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
      return navigator.locks.request(lockName, { mode: "exclusive" }, () => runInProcessQueue());
    }

    return runInProcessQueue();
  }

  static async getEncryptedChats() {
    const res = await chrome.storage.local.get(CHATS_KEY);
    return res[CHATS_KEY] || {};
  }

  static async getChatConfig(messenger, uid) {
    const chats = await this.getEncryptedChats();
    return chats[`${messenger}_${uid}`] || null;
  }

  static buildUpdatedPeerKeyHistory(existing, incomingHistory = null) {
    const baseList = Array.isArray(incomingHistory)
      ? incomingHistory.slice()
      : Array.isArray(existing?.peerKeyHistory)
      ? existing.peerKeyHistory.slice()
      : [];

    if (
      existing &&
      existing.peerFingerprint &&
      existing.peerSigningPublicKey &&
      !baseList.some((h) => h && h.fingerprint === existing.peerFingerprint)
    ) {
      baseList.push({
        fingerprint: existing.peerFingerprint,
        signingPublicKeySpki: existing.peerSigningPublicKey,
        encryptionPublicKeySpki: existing.peerPublicKey || null,
        ecdhPublicKeySpki: existing.peerEcdhPublicKey || null,
        retiredAt: Date.now()
      });
    }

    return baseList.slice(-20);
  }

  static buildUpdatedPasswordHistory(existing, newPassword) {
    const history = Array.isArray(existing?.passwordHistory)
      ? existing.passwordHistory.filter((p) => typeof p === "string" && p.length > 0)
      : [];

    if (
      existing &&
      typeof existing.password === "string" &&
      existing.password.length > 0 &&
      existing.password !== newPassword &&
      !history.includes(existing.password)
    ) {
      history.push(existing.password);
    }

    if (typeof newPassword === "string" && newPassword.length > 0) {
      return history.filter((p) => p !== newPassword).slice(-20);
    }

    return history.slice(-20);
  }

  static async saveChatConfig(
    messenger,
    uid,
    displayName,
    password,
    fingerprint,
    enabled = true,
    extra = {}
  ) {
    return this._withLock("bale_e2ee_chats_lock", async () => {
      const chats = await this.getEncryptedChats();
      const key = `${messenger}_${uid}`;
      const existing = chats[key] || {};
      const mode = extra.mode || existing.mode || (password ? "password" : "rsa");

      let fp = fingerprint;
      if (fp === undefined || fp === null) {
        fp = mode === "rsa" ? existing.peerFingerprint || "" : existing.fingerprint || "";
      }

      const peerKeyHistory = this.buildUpdatedPeerKeyHistory(
        existing,
        extra.peerKeyHistory
      );
      const passwordHistory = this.buildUpdatedPasswordHistory(existing, password);

      const next = {
        ...existing,
        messenger,
        uid: String(uid).trim(),
        displayName: (displayName || existing.displayName || "").trim(),
        fingerprint: fp,
        mode,
        enabled,
        updatedAt: Date.now(),
        ...extra,
        peerKeyHistory,
        passwordHistory
      };

      if (typeof password === "string" && password.length > 0) {
        next.password = password;
      } else if (existing.password) {
        next.password = existing.password;
      }

      chats[key] = next;
      await chrome.storage.local.set({ [CHATS_KEY]: chats });
      return next;
    });
  }

  static async updateChatConfig(messenger, uid, patch) {
    return this._withLock("bale_e2ee_chats_lock", async () => {
      const chats = await this.getEncryptedChats();
      const key = `${messenger}_${uid}`;
      if (!chats[key]) return null;

      const existing = chats[key];
      const patchData = typeof patch === "function" ? patch(existing) : patch;
      if (!patchData) return existing;

      const peerKeyHistory = this.buildUpdatedPeerKeyHistory(
        existing,
        patchData.peerKeyHistory
      );
      const passwordHistory = this.buildUpdatedPasswordHistory(
        existing,
        patchData.password
      );

      chats[key] = {
        ...existing,
        ...patchData,
        peerKeyHistory,
        passwordHistory,
        updatedAt: Date.now()
      };
      await chrome.storage.local.set({ [CHATS_KEY]: chats });
      return chats[key];
    });
  }

  static async toggleChatEnabled(messenger, uid) {
    return this._withLock("bale_e2ee_chats_lock", async () => {
      const chats = await this.getEncryptedChats();
      const key = `${messenger}_${uid}`;
      if (chats[key]) {
        chats[key].enabled = chats[key].enabled === false;
        chats[key].updatedAt = Date.now();
        await chrome.storage.local.set({ [CHATS_KEY]: chats });
        return chats[key].enabled;
      }
      return false;
    });
  }

  static async removeChatConfig(messenger, uid) {
    return this._withLock("bale_e2ee_chats_lock", async () => {
      const chats = await this.getEncryptedChats();
      const key = `${messenger}_${uid}`;
      delete chats[key];
      await chrome.storage.local.set({ [CHATS_KEY]: chats });
    });
  }

  static async resetRsaChatsForIdentityRotation() {
    return this._withLock("bale_e2ee_chats_lock", async () => {
      const chats = await this.getEncryptedChats();
      let resetCount = 0;

      for (const [key, existing] of Object.entries(chats)) {
        if (!existing) continue;
        const mode = existing.mode || (existing.password ? "password" : "rsa");
        if (mode !== "rsa") continue;

        const peerKeyHistory = this.buildUpdatedPeerKeyHistory(existing);
        chats[key] = {
          ...existing,
          handshakeState: CONSTANTS.HANDSHAKE_STATES.EXPIRED,
          sessionId: null,
          peerPublicKey: null,
          peerSigningPublicKey: null,
          peerEcdhPublicKey: null,
          peerFingerprint: null,
          pendingCandidate: null,
          verified: false,
          keyChanged: false,
          announcedFor: null,
          peerKeyHistory,
          updatedAt: Date.now()
        };
        resetCount += 1;
      }

      if (resetCount > 0) {
        await chrome.storage.local.set({ [CHATS_KEY]: chats });
      }
      return resetCount;
    });
  }

  // ---------------------------------------------------------------------------
  // کلیدهای تاریخی بازیابی‌شده از پیام‌های تبادل کلید چت (فقط خواندنی برای پیام‌های قدیم)
  // این کلیدها هرگز به عنوان کلید فعال فعلی برای ارسال پیام جدید اعمال نمی‌شوند.
  // ---------------------------------------------------------------------------

  static async getAllRecoveredPeerKeys() {
    const res = await chrome.storage.local.get(RECOVERED_KEYS_KEY);
    return res[RECOVERED_KEYS_KEY] || {};
  }

  static async getRecoveredPeerKeys(messenger, uid) {
    const all = await this.getAllRecoveredPeerKeys();
    const list = all[`${messenger}_${uid}`];
    return Array.isArray(list) ? list : [];
  }

  static async saveRecoveredPeerKey(messenger, uid, entry) {
    if (!uid || !entry || !entry.fingerprint || !entry.signingPublicKeySpki) return null;
    return this._withLock("bale_e2ee_recovered_keys_lock", async () => {
      const all = await this.getAllRecoveredPeerKeys();
      const key = `${messenger}_${uid}`;
      const list = Array.isArray(all[key]) ? all[key].slice() : [];

      if (!list.some((item) => item && item.fingerprint === entry.fingerprint)) {
        list.push({
          fingerprint: entry.fingerprint,
          signingPublicKeySpki: entry.signingPublicKeySpki,
          encryptionPublicKeySpki: entry.encryptionPublicKeySpki || null,
          ecdhPublicKeySpki: entry.ecdhPublicKeySpki || null,
          recoveredAt: Date.now(),
          timestamp: entry.timestamp || 0
        });
        all[key] = list.slice(-25);
        await chrome.storage.local.set({ [RECOVERED_KEYS_KEY]: all });
      }
      return all[key];
    });
  }

  // ---------------------------------------------------------------------------
  // مدیریت نشست‌های تبادل کلید پایان‌یافته / منقضی‌شده / ردشده
  // ---------------------------------------------------------------------------

  static async getTerminatedSessions() {
    const res = await chrome.storage.local.get(TERMINATED_SESSIONS_KEY);
    return res[TERMINATED_SESSIONS_KEY] || {};
  }

  static async markSessionTerminated(sessionKey, reason = "expired") {
    if (!sessionKey) return;
    return this._withLock("bale_e2ee_terminated_sessions_lock", async () => {
      const sessions = await this.getTerminatedSessions();
      sessions[sessionKey] = {
        reason,
        terminatedAt: Date.now()
      };

      const entries = Object.entries(sessions);
      if (entries.length > 500) {
        entries.sort((a, b) => (a[1]?.terminatedAt || 0) - (b[1]?.terminatedAt || 0));
        const trimmed = Object.fromEntries(entries.slice(-500));
        await chrome.storage.local.set({ [TERMINATED_SESSIONS_KEY]: trimmed });
        return trimmed;
      }

      await chrome.storage.local.set({ [TERMINATED_SESSIONS_KEY]: sessions });
      return sessions;
    });
  }

  // ---------------------------------------------------------------------------
  // پیش‌نویس‌های محلی (خارج از سرور بله)
  // ---------------------------------------------------------------------------

  static getDraftKey(messenger, uid) {
    return `${CONSTANTS.STORAGE_KEYS.DRAFT_PREFIX}${encodeURIComponent(
      messenger
    )}:${encodeURIComponent(String(uid))}`;
  }

  static estimateDraftBytes(key, record) {
    const json = JSON.stringify(record);
    try {
      return new TextEncoder().encode(`${key}${json}`).length;
    } catch {
      return (String(key).length + json.length) * 2;
    }
  }

  static async getDraftIndex() {
    const res = await chrome.storage.local.get(
      CONSTANTS.STORAGE_KEYS.DRAFT_INDEX
    );
    return res[CONSTANTS.STORAGE_KEYS.DRAFT_INDEX] || {};
  }

  static async getDraft(messenger, uid) {
    const key = this.getDraftKey(messenger, uid);
    const res = await chrome.storage.local.get(key);
    return res[key] || null;
  }

  static async saveDraft(messenger, uid, displayName, text) {
    const value = String(text ?? "");
    if (!value.trim()) {
      await this.removeDraft(messenger, uid);
      return null;
    }

    return this._withLock("bale_e2ee_drafts_lock", async () => {
      const key = this.getDraftKey(messenger, uid);
      const record = {
        messenger,
        uid: String(uid).trim(),
        displayName: String(displayName || "").trim(),
        text: value,
        updatedAt: Date.now()
      };

      const bytes = this.estimateDraftBytes(key, record) + 48;
      if (bytes > CONSTANTS.DRAFT_MAX_BYTES) {
        console.warn("[Pardag E2EE] draft is larger than local limit; not saved");
        return null;
      }
      record.bytes = bytes;

      await chrome.storage.local.set({ [key]: record });

      const index = await this.getDraftIndex();
      index[key] = {
        messenger: record.messenger,
        uid: record.uid,
        displayName: record.displayName,
        updatedAt: record.updatedAt,
        bytes: record.bytes
      };

      const total = Object.values(index).reduce(
        (sum, entry) => sum + (Number(entry.bytes) || 0),
        0
      );
      await chrome.storage.local.set({
        [CONSTANTS.STORAGE_KEYS.DRAFT_INDEX]: index
      });

      if (total > CONSTANTS.DRAFT_MAX_BYTES * CONSTANTS.DRAFT_PRUNE_CHECK_RATIO) {
        await this._pruneDraftsUnlocked(key);
      }

      return record;
    });
  }

  static async removeDraft(messenger, uid) {
    return this._withLock("bale_e2ee_drafts_lock", async () => {
      const key = this.getDraftKey(messenger, uid);
      await chrome.storage.local.remove(key);

      const index = await this.getDraftIndex();
      if (index[key]) {
        delete index[key];
        await chrome.storage.local.set({
          [CONSTANTS.STORAGE_KEYS.DRAFT_INDEX]: index
        });
      }
    });
  }

  static async pruneDrafts(protectedKey = null) {
    return this._withLock("bale_e2ee_drafts_lock", () =>
      this._pruneDraftsUnlocked(protectedKey)
    );
  }

  static async _pruneDraftsUnlocked(protectedKey = null) {
    const prefix = CONSTANTS.STORAGE_KEYS.DRAFT_PREFIX;
    const all = await chrome.storage.local.get(null);
    const drafts = {};
    let total = 0;

    for (const [key, record] of Object.entries(all)) {
      if (!key.startsWith(prefix)) continue;
      if (!record || typeof record.text !== "string") continue;

      const bytes = this.estimateDraftBytes(key, record) + 48;
      drafts[key] = { ...record, bytes };
      total += bytes;
    }

    const keysToRemove = [];
    if (total > CONSTANTS.DRAFT_MAX_BYTES) {
      const oldestFirst = Object.entries(drafts).sort(
        (a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0)
      );

      for (const [key, record] of oldestFirst) {
        if (total <= CONSTANTS.DRAFT_MAX_BYTES) break;
        if (key === protectedKey) continue;

        keysToRemove.push(key);
        total -= record.bytes;
        delete drafts[key];
      }
    }

    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }

    const index = {};
    for (const [key, record] of Object.entries(drafts)) {
      index[key] = {
        messenger: record.messenger || "",
        uid: record.uid || "",
        displayName: record.displayName || "",
        updatedAt: record.updatedAt || 0,
        bytes: record.bytes
      };
    }
    await chrome.storage.local.set({
      [CONSTANTS.STORAGE_KEYS.DRAFT_INDEX]: index
    });

    return { total, removed: keysToRemove.length };
  }

  // ---------------------------------------------------------------------------
  // هویت رمزنگاری (کلیدهای RSA-OAEP / ECDH و ECDSA) همراه با تاریخچه کلیدهای قبلی
  // ---------------------------------------------------------------------------

  static async getIdentity() {
    const res = await chrome.storage.local.get(CONSTANTS.STORAGE_KEYS.IDENTITY);
    return res[CONSTANTS.STORAGE_KEYS.IDENTITY] || null;
  }

  static async saveIdentity(identity) {
    return this._withLock("bale_e2ee_identity_storage_lock", async () => {
      const existing = await this.getIdentity();
      if (
        existing &&
        existing.fingerprint &&
        existing.fingerprint !== identity.fingerprint &&
        existing.encryption?.privateKeyJwk
      ) {
        const prevHistory = Array.isArray(existing.history) ? existing.history : [];
        const nextHistory = [
          ...prevHistory.filter((h) => h && h.fingerprint !== existing.fingerprint),
          {
            fingerprint: existing.fingerprint,
            encryption: existing.encryption,
            ecdh: existing.ecdh || null,
            signing: existing.signing,
            retiredAt: Date.now()
          }
        ].slice(-20);
        identity = { ...identity, history: nextHistory };
      } else if (existing && Array.isArray(existing.history) && !Array.isArray(identity.history)) {
        identity = { ...identity, history: existing.history };
      }
      await chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.IDENTITY]: identity });
      return identity;
    });
  }

  static async acquireIdentityLock(owner, ttl = 8000) {
    const lockKey = CONSTANTS.STORAGE_KEYS.IDENTITY_LOCK;
    const now = Date.now();
    const res = await chrome.storage.local.get(lockKey);
    const lock = res[lockKey];

    if (lock && lock.expiresAt > now && lock.owner !== owner) {
      return false;
    }

    const candidate = { owner, acquiredAt: now, expiresAt: now + ttl };
    await chrome.storage.local.set({ [lockKey]: candidate });

    await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 20)));
    const verifyRes = await chrome.storage.local.get(lockKey);
    const activeLock = verifyRes[lockKey];

    return Boolean(activeLock && activeLock.owner === owner);
  }

  static async releaseIdentityLock(owner) {
    const lockKey = CONSTANTS.STORAGE_KEYS.IDENTITY_LOCK;
    const res = await chrome.storage.local.get(lockKey);
    if (res[lockKey] && res[lockKey].owner === owner) {
      await chrome.storage.local.remove(lockKey);
    }
  }

  // ---------------------------------------------------------------------------
  // درخواست‌های در انتظار تبادل کلید
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
    return this._withLock("bale_e2ee_pending_peers_lock", async () => {
      const peers = await this.getPendingPeers();
      const key = `${messenger}_${uid}`;
      peers[key] = {
        ...(peers[key] || {}),
        messenger,
        uid: String(uid).trim(),
        ...data,
        updatedAt: Date.now()
      };
      await chrome.storage.local.set({
        [CONSTANTS.STORAGE_KEYS.PENDING_PEERS]: peers
      });
      return peers[key];
    });
  }

  static async removePendingPeer(messenger, uid) {
    return this._withLock("bale_e2ee_pending_peers_lock", async () => {
      const peers = await this.getPendingPeers();
      delete peers[`${messenger}_${uid}`];
      await chrome.storage.local.set({
        [CONSTANTS.STORAGE_KEYS.PENDING_PEERS]: peers
      });
    });
  }

  // ---------------------------------------------------------------------------
  // تنظیمات مهلت زمانی تبادل کلید و پشتیبان‌گیری رمزنگاری‌شده هویت (Export / Import)
  // ---------------------------------------------------------------------------

  static async getKeyExchangeTtlMinutes() {
    return Math.round(CONSTANTS.KEY_EXCHANGE_TTL_MS / 60000);
  }

  static async getKeyExchangeTtlMs() {
    return CONSTANTS.KEY_EXCHANGE_TTL_MS;
  }
}
