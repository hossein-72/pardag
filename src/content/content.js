import { BaleAdapter } from './adapters/adapter-bale.js';
import { StorageManager } from '../shared/storage.js';
import { IdentityManager } from '../shared/identity.js';
import { CryptoEngine } from './crypto/crypto.js';
import { CONSTANTS } from '../shared/constants.js';
import { LockButtonUI } from './ui/lock-button.js';
import { MessageDecorator } from './ui/message-decorator.js';
import { ToastUI } from './ui/toast.js';

class ContentController {
  constructor(adapter) {
    this.adapter = adapter;
    this.currentChatId = null;
    this.currentChatType = "none";
    this.currentChatConfig = null;
    this.currentChatDisplayName = "";
    this.pendingPeer = null;
    this.isEncryptingAndSending = false;
    this.isSendingControl = false;
    this.handshakeInFlight = false;
    this.retryInFlight = false;
    this.lastUrl = window.location.href;
    this.lastHandshakeAttempt = 0;
    this.pendingNotified = new Set();
    this.rejectedHandshakes = new Set();
    this.terminatedSessions = {};
    this.editRestoreTimer = null;
    this.editRestoreInFlight = false;
    this.lastSendAt = 0;
    this.lastUserTypingAt = 0;
    this.keyExchangeChain = Promise.resolve();
    this.keyExchangeTtlMs = CONSTANTS.KEY_EXCHANGE_TTL_MS;

    // وضعیت پیش‌نویس محلی
    this.draftSaveTimer = null;
    this.pendingDraftSave = null;
    this.draftWriteChain = Promise.resolve();
    this.draftRestoreTimer = null;
    this.draftEscapeRestoreTimer = null;
    this.draftSnapshotPending = false;
    this.draftPendingSnapshot = null;
    this.draftStateInFlight = false;
    this.draftStateChatId = null;
    this.draftStateLoadedFor = null;
    this.draftStateLocal = null;
    this.draftStateObserveAfter = 0;
    this.draftStateRestoreSuppressUntil = 0;
    this.suppressDraftInput = false;
    this.draftInputSuppressedUntil = 0;
    this.draftUserTypedSinceOpen = false;
    this.draftEditModeActive = false;
    this.draftLastKnown = { chatId: null, text: "", displayName: "" };
    this.navIntervalId = null;
    this.messageObserver = null;
    this.contextInvalidated = false;
  }

  isContextInvalidated(err = null) {
    const msg = String(err?.message || err || "");
    if (
      this.contextInvalidated ||
      !chrome?.runtime?.id ||
      msg.includes("Extension context invalidated")
    ) {
      this.contextInvalidated = true;
      if (this.navIntervalId) {
        clearInterval(this.navIntervalId);
        this.navIntervalId = null;
      }
      if (this.messageObserver) {
        this.messageObserver.disconnect();
        this.messageObserver = null;
      }
      return true;
    }
    return false;
  }

  async init() {
    this.draftWriteChain = StorageManager.pruneDrafts().catch((err) =>
      console.warn("[Pardag E2EE] draft prune failed:", err)
    );

    await this.loadTerminatedSessions();
    this.keyExchangeTtlMs = await StorageManager.getKeyExchangeTtlMs();
    this.publishDraftGuardChats();
    await this.syncChatState();
    this.setupNavigationObservers();
    this.setupMessageObserver();
    this.setupSendInterceptors();
    this.setupEditModeRestorer();
    this.setupDraftGuard();
    this.setupStorageListener();
    this.setupMessageListener();
  }

  async loadTerminatedSessions() {
    try {
      this.terminatedSessions = (await StorageManager.getTerminatedSessions()) || {};
      for (const key of Object.keys(this.terminatedSessions)) {
        this.rejectedHandshakes.add(key);
      }
    } catch {
      this.terminatedSessions = {};
    }
  }

  isSessionTerminated(uid, fingerprint, sessionId) {
    const specificKey = `${uid}:${fingerprint || ""}:${sessionId || ""}`;
    if (this.rejectedHandshakes.has(specificKey) || this.terminatedSessions[specificKey]) {
      return true;
    }
    if (sessionId) {
      const sessionOnlyKey = `${uid}:SESSION:${sessionId}`;
      if (this.rejectedHandshakes.has(sessionOnlyKey) || this.terminatedSessions[sessionOnlyKey]) {
        return true;
      }
    }
    return false;
  }

  async recordSessionTerminated(uid, fingerprint, sessionId, reason = "expired") {
    const specificKey = `${uid}:${fingerprint || ""}:${sessionId || ""}`;
    this.rejectedHandshakes.add(specificKey);
    this.terminatedSessions[specificKey] = { reason, terminatedAt: Date.now() };
    await StorageManager.markSessionTerminated(specificKey, reason);

    if (sessionId) {
      const sessionOnlyKey = `${uid}:SESSION:${sessionId}`;
      this.rejectedHandshakes.add(sessionOnlyKey);
      this.terminatedSessions[sessionOnlyKey] = { reason, terminatedAt: Date.now() };
      await StorageManager.markSessionTerminated(sessionOnlyKey, reason);
    }
  }

  getMessenger() {
    return this.adapter.getName();
  }

  async publishDraftGuardChats() {
    try {
      const chats = await StorageManager.getEncryptedChats();
      const prefix = `${this.getMessenger()}_`;
      const uids = [];

      for (const [key, config] of Object.entries(chats || {})) {
        if (!key.startsWith(prefix)) continue;
        if (config && config.enabled === false) continue;

        const uid = String(config?.uid || key.slice(prefix.length)).trim();
        if (uid) uids.push(uid);
      }

      window.postMessage(
        { type: "BALE_ENC_DRAFT_UIDS", uids },
        window.location.origin
      );
    } catch (err) {
      console.warn("[Pardag E2EE] draft guard UID publish failed:", err);
    }
  }

  getMode(config) {
    if (!config) return null;
    return config.mode || (config.password ? "password" : "rsa");
  }

  // ---------------------------------------------------------------------------
  // همگام‌سازی وضعیت چت و بررسی انقضای زمانی درخواست‌های تبادل کلید
  // ---------------------------------------------------------------------------

  async syncChatState() {
    const previousUid = this.currentChatId;
    const uid = this.adapter.getActiveChatId();
    this.currentChatId = uid;
    this.currentChatType = uid ? (this.adapter.getChatType?.() || "private") : "none";
    const isChatSwitch = previousUid !== uid;

    await this.loadTerminatedSessions();
    this.keyExchangeTtlMs = await StorageManager.getKeyExchangeTtlMs();

    if (uid) {
      this.currentChatConfig = await StorageManager.getChatConfig(
        this.getMessenger(),
        uid
      );
      this.pendingPeer = await StorageManager.getPendingPeer(
        this.getMessenger(),
        uid
      );
      await this.checkPendingHandshakeExpiration();
    } else {
      this.currentChatConfig = null;
      this.pendingPeer = null;
    }

    this.currentChatDisplayName = uid
      ? (this.currentChatConfig && this.currentChatConfig.displayName) ||
        this.adapter.getActiveChatDisplayName() ||
        ""
      : "";

    this.handleDraftChatChange(previousUid, uid);

    this.renderLockUI();
    this.notifyPendingPeer();
    this.scanAllMessages({ isInitialHistoryScan: isChatSwitch });

    if (uid) {
      this.scheduleDraftRestore(uid);
    }
  }

  async checkPendingHandshakeExpiration() {
    if (!this.currentChatId || this.currentChatType !== "private") return;
    const messenger = this.getMessenger();
    const uid = this.currentChatId;
    const now = Date.now();

    const candidate =
      (this.currentChatConfig && this.currentChatConfig.pendingCandidate) ||
      this.pendingPeer;

    if (candidate) {
      const ts = Number(candidate.peerKeyTimestamp) || 0;
      if (!ts || now - ts > this.keyExchangeTtlMs) {
        await this.expireTargetPendingRequest(candidate, false);
      }
    }

    if (
      this.currentChatConfig &&
      this.getMode(this.currentChatConfig) === "rsa" &&
      this.currentChatConfig.handshakeState === CONSTANTS.HANDSHAKE_STATES.AWAITING_ACK
    ) {
      const announcedAt = Number(this.currentChatConfig.lastAnnouncedAt) || 0;
      if (announcedAt > 0 && now - announcedAt > this.keyExchangeTtlMs) {
        await this.recordSessionTerminated(
          uid,
          this.currentChatConfig.fingerprint || "",
          this.currentChatConfig.sessionId || "",
          "initiator_timeout"
        );
        this.currentChatConfig = await StorageManager.updateChatConfig(
          messenger,
          uid,
          {
            handshakeState: CONSTANTS.HANDSHAKE_STATES.EXPIRED,
            pendingCandidate: null
          }
        );
        this.renderLockUI();
        ToastUI.show(CONSTANTS.MESSAGES.HANDSHAKE_EXPIRED_INITIATOR, "warning", 6500);
      }
    }
  }

  async expireTargetPendingRequest(candidate = null, showToast = true) {
    if (!this.currentChatId || this.currentChatType !== "private") return;
    const messenger = this.getMessenger();
    const uid = this.currentChatId;
    const targetCandidate =
      candidate ||
      (this.currentChatConfig && this.currentChatConfig.pendingCandidate) ||
      this.pendingPeer;

    if (targetCandidate) {
      await this.recordSessionTerminated(
        uid,
        targetCandidate.peerFingerprint || "",
        targetCandidate.sessionId || "",
        "target_expired"
      );
    }

    await StorageManager.removePendingPeer(messenger, uid);
    this.pendingPeer = null;

    if (this.currentChatConfig) {
      if (this.currentChatConfig.peerPublicKey) {
        this.currentChatConfig = await StorageManager.updateChatConfig(
          messenger,
          uid,
          {
            handshakeState: CONSTANTS.HANDSHAKE_STATES.ACTIVE,
            pendingCandidate: null,
            keyChanged: false
          }
        );
      } else {
        this.currentChatConfig = await StorageManager.updateChatConfig(
          messenger,
          uid,
          {
            handshakeState: CONSTANTS.HANDSHAKE_STATES.EXPIRED,
            pendingCandidate: null,
            keyChanged: false
          }
        );
      }
    }

    LockButtonUI.closeKeyExchangeModal();
    this.renderLockUI();
    if (showToast) {
      ToastUI.show(CONSTANTS.MESSAGES.HANDSHAKE_EXPIRED_TARGET, "warning", 6000);
    }
  }

  getUiCallbacks() {
    return {
      ttlMs: this.keyExchangeTtlMs,
      chatType: this.currentChatType,
      onToggle: (newState) => {
        if (!this.currentChatConfig) return;
        this.currentChatConfig.enabled = newState;
        this.renderLockUI();
      },
      onStartHandshake: () => {
        this.startKeyExchangeProcess().catch((err) => {
          console.warn("[Pardag E2EE] start handshake failed:", err);
          ToastUI.show("آغاز فرایند تبادل کلید ناموفق بود.", "error");
        });
      },
      onEnableRsa: () => {
        this.enableRsaForCurrentChat().catch((err) => {
          console.warn("[Pardag E2EE] enable RSA failed:", err);
          ToastUI.show("تایید تبادل کلید ناموفق بود.", "error");
        });
      },
      onApprovePeerKey: () => {
        this.approvePeerKeyAndSendAck().catch((err) => {
          console.warn("[Pardag E2EE] approve peer key failed:", err);
          ToastUI.show("تایید کلید مخاطب و ارسال پاسخ ناموفق بود.", "error");
        });
      },
      onRejectPeerKey: () => {
        this.rejectPeerKeyAndCancel().catch((err) => {
          console.warn("[Pardag E2EE] reject peer key failed:", err);
          ToastUI.show("رد درخواست تبادل کلید با خطا مواجه شد.", "error");
        });
      },
      onCancelHandshake: () => {
        this.cancelOwnHandshake().catch((err) => {
          console.warn("[Pardag E2EE] cancel handshake failed:", err);
          ToastUI.show("لغو درخواست تبادل کلید با خطا مواجه شد.", "error");
        });
      },
      onExpireHandshake: (expiredCandidate) => {
        this.expireTargetPendingRequest(expiredCandidate, true).catch((err) =>
          console.warn("[Pardag E2EE] expire handshake failed:", err)
        );
      },
      onOpenPopup: (tab) => this.openPopupForCurrentChat(tab),
      onRetryHandshake: () => {
        this.startKeyExchangeProcess(true).catch((err) =>
          console.warn("[Pardag E2EE] retry handshake failed:", err)
        );
      }
    };
  }

  renderLockUI() {
    const composerEl = this.adapter.getComposerElement();

    LockButtonUI.render(
      composerEl,
      this.currentChatId,
      this.currentChatConfig,
      this.pendingPeer,
      this.adapter,
      this.getUiCallbacks()
    );
  }

  openPopupForCurrentChat(tab = "add-chat") {
    if (
      !this.currentChatId ||
      (this.currentChatType !== "private" && this.currentChatType !== "group")
    ) {
      return;
    }

    try {
      chrome.runtime.sendMessage({
        action: "open_popup",
        uid: this.currentChatId,
        displayName: this.adapter.getActiveChatDisplayName(),
        tab
      });
    } catch (err) {
      console.warn("[Pardag E2EE] open popup failed:", err);
    }
  }

  notifyPendingPeer() {
    if (this.currentChatType !== "private") return;
    const candidate =
      (this.currentChatConfig && this.currentChatConfig.pendingCandidate) ||
      this.pendingPeer;
    if (!candidate) return;

    if (CryptoEngine.isKeyExchangeExpired({ timestamp: candidate.peerKeyTimestamp }, this.keyExchangeTtlMs)) {
      this.expireTargetPendingRequest(candidate, false).catch(() => {});
      return;
    }

    // تضمین نمایش فوری پنجره پاپ‌آپ روی صفحه
    LockButtonUI.renderKeyExchangeModal(
      this.currentChatId,
      this.currentChatConfig,
      this.pendingPeer,
      this.adapter,
      this.getUiCallbacks()
    );

    const key = `${this.currentChatId}:${candidate.peerFingerprint || ""}:${candidate.sessionId || ""}`;
    if (this.pendingNotified.has(key)) return;
    this.pendingNotified.add(key);

    const requesterName =
      candidate.displayName ||
      this.currentChatDisplayName ||
      this.adapter.getActiveChatDisplayName() ||
      this.currentChatId;

    ToastUI.show(
      `🔐 کاربر «${requesterName}» قصد تبادل کلید با شما را دارد.`,
      "info",
      6500
    );
  }

  // ---------------------------------------------------------------------------
  // فرایند تبادل کلید RSA
  // ---------------------------------------------------------------------------

  async startKeyExchangeProcess(isRetry = false) {
    if (!this.currentChatId) return false;
    if (this.currentChatType !== "private") {
      ToastUI.show("تبادل کلید RSA فقط در چت‌های خصوصی ۱:۱ پشتیبانی می‌شود. در گروه‌ها از کلید مشترک استفاده کنید.", "warning", 5500);
      return false;
    }
    if (this.handshakeInFlight || this.isSendingControl || this.isEncryptingAndSending) {
      return false;
    }

    const existingPending =
      this.pendingPeer ||
      (await StorageManager.getPendingPeer(this.getMessenger(), this.currentChatId));
    if (
      !isRetry &&
      existingPending &&
      existingPending.peerPublicKey &&
      !CryptoEngine.isKeyExchangeExpired({ timestamp: existingPending.peerKeyTimestamp }, this.keyExchangeTtlMs)
    ) {
      return this.approvePeerKeyAndSendAck(existingPending);
    }

    const messenger = this.getMessenger();
    const uid = this.currentChatId;
    const displayName =
      this.adapter.getActiveChatDisplayName() ||
      this.currentChatDisplayName ||
      uid;
    const identity = await IdentityManager.getIdentity();
    const sessionId = CryptoEngine.generateSessionId();
    const now = Date.now();

    await StorageManager.removePendingPeer(messenger, uid);
    this.pendingPeer = null;

    const config = await StorageManager.saveChatConfig(
      messenger,
      uid,
      displayName,
      undefined,
      identity.fingerprint,
      true,
      {
        mode: "rsa",
        handshakeState: CONSTANTS.HANDSHAKE_STATES.AWAITING_ACK,
        sessionId,
        peerPublicKey: null,
        peerSigningPublicKey: null,
        peerEcdhPublicKey: null,
        peerFingerprint: null,
        pendingCandidate: null,
        verified: false,
        keyChanged: false,
        announcedFor: null,
        lastAnnouncedAt: now
      }
    );

    this.currentChatConfig = config;
    this.renderLockUI();
    this.publishDraftGuardChats();

    const sent = await this.ensureRsaHandshake(true, sessionId, now);
    if (sent) {
      ToastUI.show(
        "🔑 درخواست تبادل کلید ارسال شد. منتظر پاسخ کاربر هدف در پنجره پاپ‌آپ هستیم...",
        "info",
        6000
      );
    }
    return sent;
  }

  async enableRsaForCurrentChat() {
    if (!this.currentChatId || this.currentChatType !== "private") return;

    const pending =
      (this.currentChatConfig && this.currentChatConfig.pendingCandidate) ||
      this.pendingPeer ||
      (await StorageManager.getPendingPeer(this.getMessenger(), this.currentChatId));

    if (!pending) return;

    await this.approvePeerKeyAndSendAck(pending);
  }

  async rejectPeerKeyAndCancel() {
    if (!this.currentChatId) return false;
    if (this.handshakeInFlight || this.isSendingControl || this.isEncryptingAndSending) {
      return false;
    }

    const messenger = this.getMessenger();
    const uid = this.currentChatId;
    const existing =
      this.currentChatConfig || (await StorageManager.getChatConfig(messenger, uid));
    const pending =
      existing?.pendingCandidate ||
      this.pendingPeer ||
      (await StorageManager.getPendingPeer(messenger, uid));

    const peerFp = pending?.peerFingerprint || existing?.peerFingerprint || "";
    const sessionId =
      pending?.sessionId ||
      existing?.sessionId ||
      CryptoEngine.generateSessionId();

    await this.recordSessionTerminated(uid, peerFp, sessionId, "rejected_by_target");

    this.handshakeInFlight = true;
    try {
      const identity = await IdentityManager.getIdentity();
      const rejectPayload = await CryptoEngine.formatSignedKeyExchange(
        identity,
        uid,
        {
          timestamp: Date.now(),
          role: CONSTANTS.HANDSHAKE_ROLES.REJECT,
          sessionId,
          ackForFingerprint: peerFp
        }
      );

      await this.sendControlMessage(rejectPayload, {
        role: CONSTANTS.HANDSHAKE_ROLES.REJECT,
        stepLabel: "ارسال پیام رد درخواست تبادل کلید (REJECT)"
      });

      await StorageManager.removePendingPeer(messenger, uid);
      this.pendingPeer = null;

      if (existing) {
        if (existing.peerPublicKey) {
          this.currentChatConfig = await StorageManager.updateChatConfig(messenger, uid, {
            handshakeState: CONSTANTS.HANDSHAKE_STATES.ACTIVE,
            pendingCandidate: null,
            keyChanged: false
          });
        } else {
          await StorageManager.removeChatConfig(messenger, uid);
          this.currentChatConfig = null;
        }
      }

      LockButtonUI.closeKeyExchangeModal();
      this.publishDraftGuardChats();
      this.renderLockUI();
      ToastUI.show(CONSTANTS.MESSAGES.HANDSHAKE_CANCELED_BY_USER, "warning", 6000);
      return true;
    } finally {
      this.handshakeInFlight = false;
    }
  }

  async cancelOwnHandshake() {
    if (!this.currentChatId) return false;
    if (this.handshakeInFlight || this.isSendingControl || this.isEncryptingAndSending) {
      return false;
    }

    const messenger = this.getMessenger();
    const uid = this.currentChatId;
    const existing =
      this.currentChatConfig || (await StorageManager.getChatConfig(messenger, uid));

    this.handshakeInFlight = true;
    try {
      const identity = await IdentityManager.getIdentity();
      const sessionId = existing?.sessionId || CryptoEngine.generateSessionId();

      await this.recordSessionTerminated(
        uid,
        identity.fingerprint,
        sessionId,
        "canceled_by_initiator"
      );

      const rejectPayload = await CryptoEngine.formatSignedKeyExchange(
        identity,
        uid,
        {
          timestamp: Date.now(),
          role: CONSTANTS.HANDSHAKE_ROLES.REJECT,
          sessionId,
          ackForFingerprint: existing?.peerFingerprint || ""
        }
      );

      await this.sendControlMessage(rejectPayload, {
        role: CONSTANTS.HANDSHAKE_ROLES.REJECT,
        stepLabel: "پایان دادن به درخواست تبادل کلید..."
      });

      await StorageManager.removePendingPeer(messenger, uid);
      await StorageManager.removeChatConfig(messenger, uid);
      this.pendingPeer = null;
      this.currentChatConfig = null;

      this.publishDraftGuardChats();
      this.renderLockUI();
      ToastUI.show(CONSTANTS.MESSAGES.HANDSHAKE_CANCELED_BY_USER, "info", 5500);
      return true;
    } finally {
      this.handshakeInFlight = false;
    }
  }

  async approvePeerKeyAndSendAck(explicitCandidate = null) {
    if (!this.currentChatId) return false;
    if (this.handshakeInFlight || this.isSendingControl || this.isEncryptingAndSending) {
      return false;
    }

    const messenger = this.getMessenger();
    const uid = this.currentChatId;
    const existing =
      this.currentChatConfig || (await StorageManager.getChatConfig(messenger, uid));
    const pending =
      explicitCandidate ||
      existing?.pendingCandidate ||
      this.pendingPeer ||
      (await StorageManager.getPendingPeer(messenger, uid));

    if (!pending || !pending.peerPublicKey || !pending.peerSigningPublicKey) {
      return false;
    }

    if (CryptoEngine.isKeyExchangeExpired({ timestamp: pending.peerKeyTimestamp }, this.keyExchangeTtlMs)) {
      await this.expireTargetPendingRequest(pending, true);
      return false;
    }

    this.handshakeInFlight = true;
    try {
      const identity = await IdentityManager.getIdentity();
      const sessionId =
        pending.sessionId ||
        existing?.sessionId ||
        CryptoEngine.generateSessionId();
      const now = Date.now();

      const ackPayload = await CryptoEngine.formatSignedKeyExchange(
        identity,
        uid,
        {
          timestamp: now,
          role: CONSTANTS.HANDSHAKE_ROLES.ACK,
          sessionId,
          ackForFingerprint: pending.peerFingerprint
        }
      );

      const sent = await this.sendControlMessage(ackPayload, {
        role: CONSTANTS.HANDSHAKE_ROLES.ACK,
        stepLabel: "ارسال کلید و تکمیل تبادل کلید (ACK)"
      });

      if (!sent) {
        ToastUI.show("ارسال بسته تایید (ACK) در چت انجام نشد. دوباره تلاش کنید.", "warning");
        return false;
      }

      const displayName =
        pending.displayName ||
        existing?.displayName ||
        this.adapter.getActiveChatDisplayName() ||
        uid;

      await this.recordSessionTerminated(
        uid,
        pending.peerFingerprint || "",
        sessionId,
        "completed"
      );

      const config = await StorageManager.saveChatConfig(
        messenger,
        uid,
        displayName,
        undefined,
        pending.peerFingerprint || "",
        true,
        {
          mode: "rsa",
          handshakeState: CONSTANTS.HANDSHAKE_STATES.ACTIVE,
          sessionId,
          peerPublicKey: pending.peerPublicKey,
          peerSigningPublicKey: pending.peerSigningPublicKey,
          peerEcdhPublicKey: pending.peerEcdhPublicKey || null,
          peerFingerprint: pending.peerFingerprint,
          peerKeyTimestamp: pending.peerKeyTimestamp || now,
          peerKeyReceivedAt: now,
          pendingCandidate: null,
          verified: false,
          keyChanged: false,
          announcedFor: identity.fingerprint,
          lastAnnouncedAt: now
        }
      );

      await StorageManager.removePendingPeer(messenger, uid);
      this.pendingPeer = null;
      this.currentChatConfig = config;

      LockButtonUI.closeKeyExchangeModal();
      this.publishDraftGuardChats();
      ToastUI.show(CONSTANTS.MESSAGES.ACK_SENT_ACTIVE, "success");
      this.renderLockUI();
      await this.retryFailedMessages();
      return true;
    } finally {
      this.handshakeInFlight = false;
    }
  }

  async ensureRsaHandshake(force = false, customSessionId = null, customTimestamp = null) {
    if (!force) return false;
    if (this.handshakeInFlight) return false;
    if (this.isSendingControl || this.isEncryptingAndSending) return false;
    if (!this.currentChatId) return false;
    if (!this.currentChatConfig) return false;
    if (this.getMode(this.currentChatConfig) !== "rsa") return false;

    const now = customTimestamp || Date.now();
    this.lastHandshakeAttempt = now;
    this.handshakeInFlight = true;

    try {
      const identity = await IdentityManager.getIdentity();
      const sessionId =
        customSessionId ||
        this.currentChatConfig.sessionId ||
        CryptoEngine.generateSessionId();

      const keyExchangePayload = await CryptoEngine.formatSignedKeyExchange(
        identity,
        this.currentChatId,
        {
          timestamp: now,
          role: CONSTANTS.HANDSHAKE_ROLES.SYN,
          sessionId,
          ackForFingerprint: ""
        }
      );

      const sent = await this.sendControlMessage(keyExchangePayload, {
        role: CONSTANTS.HANDSHAKE_ROLES.SYN,
        stepLabel: "ارسال درخواست تبادل کلید (SYN)"
      });

      if (!sent) return false;

      const updated = await StorageManager.updateChatConfig(
        this.getMessenger(),
        this.currentChatId,
        {
          handshakeState: CONSTANTS.HANDSHAKE_STATES.AWAITING_ACK,
          sessionId,
          announcedFor: identity.fingerprint,
          lastAnnouncedAt: now
        }
      );

      if (updated) this.currentChatConfig = updated;
      this.renderLockUI();
      return true;
    } finally {
      this.handshakeInFlight = false;
    }
  }

  async sendControlMessage(text, meta = {}) {
    if (this.isSendingControl || this.isEncryptingAndSending) return false;

    const inputEl = this.adapter.getInputElement();
    if (!inputEl) return false;

    const composerEl = this.adapter.getComposerElement();
    const draft = this.adapter.getInputValue(inputEl) || "";
    this.isSendingControl = true;

    const blockUserInput = (e) => {
      if (e.isTrusted) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    const blockedEvents = ["keydown", "keypress", "beforeinput", "paste", "drop"];
    for (const evt of blockedEvents) {
      inputEl.addEventListener(evt, blockUserInput, true);
    }

    inputEl.dataset.baleEncLocked = "1";

    try {
      LockButtonUI.renderComposerLock(composerEl, {
        active: true,
        step: 1,
        total: 3,
        label: "قفل ایمن کادر پیام و حفظ پیش‌نویس..."
      });

      this.setDraftInputValue(inputEl, text);
      await new Promise((resolve) => setTimeout(resolve, 80));

      LockButtonUI.renderComposerLock(composerEl, {
        active: true,
        step: 2,
        total: 3,
        label: meta.stepLabel || "در حال ارسال بسته امضاشده تبادل کلید..."
      });

      const preSendValue = (this.adapter.getInputValue(inputEl) || "").trim();
      if (CONSTANTS.stripFormatting(preSendValue).trim() !== text.trim()) {
        this.setDraftInputValue(inputEl, text);
      }

      const sendBtn = this.adapter.getSendButtonElement();
      if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute("aria-disabled") !== "true") {
        this.adapter.triggerClick(sendBtn);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const activeInput = inputEl.isConnected ? inputEl : this.adapter.getInputElement();
        if (activeInput) {
          const stillInBox = (this.adapter.getInputValue(activeInput) || "").trim();
          if (CONSTANTS.stripFormatting(stillInBox).trim() === text.trim()) {
            activeInput.focus();
            this.adapter.triggerEnter(activeInput);
          }
        }
      } else {
        inputEl.focus();
        this.adapter.triggerEnter(inputEl);
      }
      this.lastSendAt = Date.now();

      await new Promise((resolve) => setTimeout(resolve, 350));

      LockButtonUI.renderComposerLock(composerEl, {
        active: true,
        step: 3,
        total: 3,
        label: "تأیید ارسال و بازیابی کادر پیام..."
      });

      const current = this.adapter.getInputValue(inputEl) || "";
      const stillContainsControl =
        current.includes(CONSTANTS.PREFIXES.KEY_EXCHANGE);

      if (stillContainsControl) {
        this.setDraftInputValue(inputEl, draft);
        return false;
      }

      if (draft && !current) {
        this.setDraftInputValue(inputEl, draft);
      }

      return true;
    } catch (err) {
      console.warn("[Pardag E2EE] sendControlMessage failed:", err);
      try {
        this.setDraftInputValue(inputEl, draft);
      } catch {}
      return false;
    } finally {
      delete inputEl.dataset.baleEncLocked;
      LockButtonUI.renderComposerLock(composerEl, null);
      for (const evt of blockedEvents) {
        inputEl.removeEventListener(evt, blockUserInput, true);
      }
      this.isSendingControl = false;
    }
  }

  queueKeyExchange(task) {
    const next = this.keyExchangeChain
      .catch(() => {})
      .then(task);
    this.keyExchangeChain = next.catch(() => {});
    return next;
  }

  /**
   * پردازش پیام‌های تبادل کلید در صفحه چت:
   * - در چت‌های ۱:۱ بله، uid هر طرف شناسه طرف مقابل است؛ بنابراین خطای کاذب KEY_EXCHANGE_CHAT_MISMATCH رخ نمی‌دهد.
   * - تشخیص خودی یا مخاطب بودن بسته صرفاً از روی اثرانگشت رمزنگاری (fingerprint === identity.fingerprint) انجام می‌شود.
   */
  async handleKeyExchange(text, el, options = {}) {
    if (el.dataset.baleEncPreview === "1") {
      MessageDecorator.renderPreview(
        el,
        CONSTANTS.MESSAGES.KEY_EXCHANGE_PREVIEW,
        text
      );
      return;
    }

    const bundle = CryptoEngine.parseKeyExchange(text);

    if (!bundle) {
      this.renderKeyExchangeNotice(el, CONSTANTS.MESSAGES.KEY_EXCHANGE_INVALID, text);
      return;
    }

    let verifiedBundle;
    try {
      verifiedBundle = await CryptoEngine.verifyKeyExchange(bundle);
    } catch {
      this.renderKeyExchangeNotice(el, CONSTANTS.MESSAGES.KEY_EXCHANGE_INVALID, text);
      return;
    }

    const fingerprint = verifiedBundle.fingerprint;
    const identity = await IdentityManager.getIdentity();

    // تشخیص قطعی و بدون خطای خودی بودن کلید صرفاً از طریق اثرانگشت کلید هویت
    const isOwn =
      fingerprint === identity.fingerprint ||
      (Array.isArray(identity.history) &&
        identity.history.some((h) => h && h.fingerprint === fingerprint));

    const isExpiredByTime = CryptoEngine.isKeyExchangeExpired(verifiedBundle, this.keyExchangeTtlMs);

    if (isOwn) {
      if (isExpiredByTime && verifiedBundle.role === CONSTANTS.HANDSHAKE_ROLES.SYN) {
        this.renderKeyExchangeNotice(el, CONSTANTS.MESSAGES.KEY_EXCHANGE_EXPIRED, text);
        await this.checkPendingHandshakeExpiration();
        return;
      }

      const ownNotice =
        verifiedBundle.role === CONSTANTS.HANDSHAKE_ROLES.REJECT
          ? CONSTANTS.MESSAGES.KEY_EXCHANGE_SENT_REJECT
          : verifiedBundle.role === CONSTANTS.HANDSHAKE_ROLES.ACK
          ? CONSTANTS.MESSAGES.KEY_EXCHANGE_SENT_ACK
          : verifiedBundle.role === CONSTANTS.HANDSHAKE_ROLES.SYN
          ? CONSTANTS.MESSAGES.KEY_EXCHANGE_SENT_SYN
          : CONSTANTS.MESSAGES.KEY_EXCHANGE_SENT;
      this.renderKeyExchangeNotice(el, ownNotice, text);
      return;
    }

    if (!this.currentChatId || this.currentChatType !== "private") {
      this.renderKeyExchangeNotice(el, CONSTANTS.MESSAGES.KEY_EXCHANGE_PREVIEW, text);
      return;
    }

    const messenger = this.getMessenger();
    const uid = this.currentChatId;
    const existing = await StorageManager.getChatConfig(messenger, uid);
    const sessionId = verifiedBundle.sessionId || "";

    // ذخیره کلید عمومی تاییدشده از تاریخچه چت در مخزن فقط-خواندنی (برای بازیابی پیام‌های قدیمی پس از نصب مجدد)
    // بدون اینکه این کلید قدیمی به عنوان کلید فعال فعلی برای ارسال پیام جدید اعمال شود.
    if (verifiedBundle.role !== CONSTANTS.HANDSHAKE_ROLES.REJECT) {
      await StorageManager.saveRecoveredPeerKey(messenger, uid, {
        fingerprint,
        signingPublicKeySpki: verifiedBundle.signingPublicKeySpki,
        encryptionPublicKeySpki: verifiedBundle.encryptionPublicKeySpki,
        ecdhPublicKeySpki: verifiedBundle.ecdhPublicKeySpki || null,
        timestamp: verifiedBundle.timestamp || 0
      });
      this.retryFailedMessages().catch(() => {});
    }

    const isOlderThanCurrentActiveKey = Boolean(
      verifiedBundle.timestamp &&
        existing &&
        existing.peerKeyTimestamp &&
        verifiedBundle.timestamp <= existing.peerKeyTimestamp &&
        existing.handshakeState === CONSTANTS.HANDSHAKE_STATES.ACTIVE &&
        existing.peerFingerprint === fingerprint
    );

    if (options.isSupersededInScan || isOlderThanCurrentActiveKey) {
      this.renderKeyExchangeNotice(
        el,
        CONSTANTS.MESSAGES.KEY_EXCHANGE_HISTORICAL,
        text
      );
      return;
    }

    // اگر ساعت مدنظر (KEY_EXCHANGE_TTL_MS) از زمان ارسال پیام گذشته باشد، به درخواست پایان می‌دهیم
    if (isExpiredByTime) {
      this.renderKeyExchangeNotice(
        el,
        CONSTANTS.MESSAGES.KEY_EXCHANGE_EXPIRED,
        text
      );
      await this.recordSessionTerminated(uid, fingerprint, sessionId, "expired_on_view");

      const currentPending =
        (existing && existing.pendingCandidate) ||
        this.pendingPeer ||
        (await StorageManager.getPendingPeer(messenger, uid));

      if (
        currentPending &&
        (currentPending.sessionId === sessionId ||
          currentPending.peerFingerprint === fingerprint)
      ) {
        await this.expireTargetPendingRequest(currentPending, false);
      }
      return;
    }

    if (this.isSessionTerminated(uid, fingerprint, sessionId)) {
      const termRecord =
        this.terminatedSessions[`${uid}:${fingerprint}:${sessionId}`] ||
        this.terminatedSessions[`${uid}:SESSION:${sessionId}`];
      const notice =
        verifiedBundle.role === CONSTANTS.HANDSHAKE_ROLES.ACK
          ? CONSTANTS.MESSAGES.KEY_EXCHANGE_RECEIVED_ACK
          : verifiedBundle.role === CONSTANTS.HANDSHAKE_ROLES.REJECT
          ? CONSTANTS.MESSAGES.KEY_EXCHANGE_RECEIVED_REJECT
          : termRecord?.reason === "completed"
          ? CONSTANTS.MESSAGES.KEY_EXCHANGE_RECEIVED_SYN
          : termRecord?.reason?.includes("expired")
          ? CONSTANTS.MESSAGES.KEY_EXCHANGE_EXPIRED
          : CONSTANTS.MESSAGES.KEY_EXCHANGE_SENT_REJECT;
      this.renderKeyExchangeNotice(el, notice, text);
      return;
    }

    if (verifiedBundle.role === CONSTANTS.HANDSHAKE_ROLES.REJECT) {
      this.renderKeyExchangeNotice(
        el,
        CONSTANTS.MESSAGES.KEY_EXCHANGE_RECEIVED_REJECT,
        text
      );

      const isRejectForUs =
        !verifiedBundle.ackForFingerprint ||
        verifiedBundle.ackForFingerprint === identity.fingerprint;

      if (isRejectForUs) {
        await this.recordSessionTerminated(uid, fingerprint, sessionId, "rejected_by_peer");
        await StorageManager.removePendingPeer(messenger, uid);
        this.pendingPeer = null;

        if (
          existing &&
          this.getMode(existing) === "rsa" &&
          existing.handshakeState !== CONSTANTS.HANDSHAKE_STATES.ACTIVE
        ) {
          await StorageManager.removeChatConfig(messenger, uid);
          this.currentChatConfig = null;
        }

        LockButtonUI.closeKeyExchangeModal();
        this.publishDraftGuardChats();
        this.renderLockUI();
        ToastUI.show(CONSTANTS.MESSAGES.HANDSHAKE_CANCELED_BY_PEER, "error", 7000);
      }
      return;
    }

    const isAckForUs =
      verifiedBundle.role === CONSTANTS.HANDSHAKE_ROLES.ACK &&
      (!verifiedBundle.ackForFingerprint ||
        verifiedBundle.ackForFingerprint === identity.fingerprint);

    if (isAckForUs) {
      this.renderKeyExchangeNotice(
        el,
        CONSTANTS.MESSAGES.KEY_EXCHANGE_RECEIVED_ACK,
        text
      );

      await this.recordSessionTerminated(uid, fingerprint, sessionId, "completed");

      const displayName =
        (existing && existing.displayName) ||
        this.adapter.getActiveChatDisplayName() ||
        uid;

      this.currentChatConfig = await StorageManager.saveChatConfig(
        messenger,
        uid,
        displayName,
        undefined,
        fingerprint,
        true,
        {
          mode: "rsa",
          handshakeState: CONSTANTS.HANDSHAKE_STATES.ACTIVE,
          sessionId: sessionId || (existing && existing.sessionId) || null,
          peerPublicKey: verifiedBundle.encryptionPublicKeySpki,
          peerSigningPublicKey: verifiedBundle.signingPublicKeySpki,
          peerEcdhPublicKey: verifiedBundle.ecdhPublicKeySpki || null,
          peerFingerprint: fingerprint,
          peerKeyTimestamp: verifiedBundle.timestamp || Date.now(),
          peerKeyReceivedAt: Date.now(),
          pendingCandidate: null,
          keyChanged: false,
          announcedFor: identity.fingerprint
        }
      );
      await StorageManager.removePendingPeer(messenger, uid);
      this.pendingPeer = null;
      this.publishDraftGuardChats();
      ToastUI.show(CONSTANTS.MESSAGES.KEY_RECEIVED, "success");
      this.renderLockUI();
      await this.retryFailedMessages();
      return;
    }

    // بسته دریافتی یک درخواست تبادل کلید معتبر (SYN) است -> نمایش پنجره پاپ‌آپ به کاربر هدف
    this.renderKeyExchangeNotice(
      el,
      CONSTANTS.MESSAGES.KEY_EXCHANGE_RECEIVED_SYN,
      text
    );

    const candidate = {
      displayName:
        this.adapter.getActiveChatDisplayName() ||
        (existing && existing.displayName) ||
        "",
      peerPublicKey: verifiedBundle.encryptionPublicKeySpki,
      peerSigningPublicKey: verifiedBundle.signingPublicKeySpki,
      peerEcdhPublicKey: verifiedBundle.ecdhPublicKeySpki || null,
      peerFingerprint: fingerprint,
      peerKeyTimestamp: verifiedBundle.timestamp || Date.now(),
      receivedAt: Date.now(),
      sessionId: sessionId || null,
      role: verifiedBundle.role || CONSTANTS.HANDSHAKE_ROLES.SYN,
      ackForFingerprint: verifiedBundle.ackForFingerprint || null
    };

    if (existing && this.getMode(existing) === "rsa") {
      const sameActiveSession =
        existing.peerPublicKey === verifiedBundle.encryptionPublicKeySpki &&
        existing.peerSigningPublicKey === verifiedBundle.signingPublicKeySpki &&
        existing.peerFingerprint === fingerprint &&
        existing.sessionId === sessionId &&
        existing.handshakeState === CONSTANTS.HANDSHAKE_STATES.ACTIVE;

      if (sameActiveSession) {
        return;
      }

      const isReplacingOldKey = Boolean(existing.peerPublicKey);

      this.currentChatConfig = await StorageManager.updateChatConfig(
        messenger,
        uid,
        {
          handshakeState: isReplacingOldKey
            ? CONSTANTS.HANDSHAKE_STATES.KEY_CHANGED
            : CONSTANTS.HANDSHAKE_STATES.PENDING_APPROVAL,
          keyChanged: isReplacingOldKey,
          verified: false,
          pendingCandidate: candidate
        }
      );
      this.pendingPeer = await StorageManager.savePendingPeer(
        messenger,
        uid,
        candidate
      );
      this.renderLockUI();
      this.notifyPendingPeer();
      return;
    }

    this.pendingPeer = await StorageManager.savePendingPeer(
      messenger,
      uid,
      candidate
    );
    this.renderLockUI();
    this.notifyPendingPeer();
  }

  renderKeyExchangeNotice(el, text, rawPayload = "") {
    MessageDecorator.renderKeyExchange(el, text, rawPayload);
  }

  async retryFailedMessages() {
    if (this.retryInFlight) return;
    this.retryInFlight = true;

    try {
      const failed = Array.from(
        document.querySelectorAll('[data-bale-enc-failed="true"]')
      );

      for (const el of failed) {
        const ciphertext = el.dataset.baleEncCiphertext;
        if (!ciphertext || CONSTANTS.isKeyExchangeMessage(ciphertext)) continue;

        delete el.dataset.baleEncProcessed;
        await MessageDecorator.processElement(
          el,
          this.currentChatConfig,
          ciphertext
        );
      }
    } finally {
      this.retryInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // رصد ناوبری و پیام‌ها
  // ---------------------------------------------------------------------------

  checkUrlChange() {
    if (this.isContextInvalidated()) return;
    const currentUid = this.adapter.isNonChatView?.()
      ? null
      : this.adapter.getActiveChatId();

    if (
      window.location.href !== this.lastUrl ||
      currentUid !== this.currentChatId
    ) {
      this.lastUrl = window.location.href;
      this.syncChatState().catch((err) => {
        if (this.isContextInvalidated(err)) return;
        console.warn("[Pardag E2EE] sync failed:", err);
      });
    }
  }

  setupNavigationObservers() {
    window.addEventListener("popstate", () => this.checkUrlChange());
    window.addEventListener("hashchange", () => this.checkUrlChange());
    window.addEventListener("message", (event) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.type !== "BALE_ENC_PEER_TYPE") return;
      if (this.currentChatId && String(data.uid) === String(this.currentChatId)) {
        if (data.chatType && data.chatType !== this.currentChatType) {
          this.currentChatType = data.chatType;
          this.renderLockUI();
        }
      }
    });

    this.navIntervalId = setInterval(() => {
      if (this.isContextInvalidated()) return;
      this.checkUrlChange();
      this.restoreEditInput().catch(() => {});
      this.ensureDraftState().catch(() => {});
      this.checkPendingHandshakeExpiration().catch(() => {});

      const hasCornerBadge = document.getElementById(
        LockButtonUI.FLOATING_BUTTON_ID
      );
      const hasSettingsBtn = document.getElementById(
        LockButtonUI.SETTINGS_BUTTON_ID
      );

      const refreshedType = this.adapter.getChatType?.() || "private";
      if (refreshedType !== this.currentChatType) {
        this.currentChatType = refreshedType;
        this.renderLockUI();
      }
      if (this.currentChatId && (this.currentChatType === "private" || this.currentChatType === "group") && (!hasCornerBadge || !hasSettingsBtn)) {
        this.renderLockUI();
      }
    }, 600);
  }

  setupMessageObserver() {
    const observer = new MutationObserver((mutations) => {
      if (this.isContextInvalidated()) return;
      this.scheduleEditRestore();

      if (window.location.href !== this.lastUrl) {
        this.checkUrlChange();
      }

      let shouldScan = false;
      for (const m of mutations) {
        const targetEl =
          m.target.nodeType === Node.ELEMENT_NODE
            ? m.target
            : m.target.parentElement;
        if (
          targetEl &&
          targetEl.closest?.('.bale-enc-ui-root, [data-bale-enc-ui="1"], #bale-enc-toast-container')
        ) {
          continue;
        }

        if (m.addedNodes.length > 0) {
          let onlyOurUi = true;
          for (const added of m.addedNodes) {
            if (
              added.nodeType === Node.ELEMENT_NODE &&
              (added.classList?.contains("bale-enc-ui-root") ||
                added.dataset?.baleEncUi === "1")
            ) {
              continue;
            }
            onlyOurUi = false;
            break;
          }
          if (!onlyOurUi) {
            shouldScan = true;
            break;
          }
        }
        if (m.type === "characterData") {
          const parent = m.target.parentElement;
          if (parent && parent.closest('[contenteditable="true"]')) continue;
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) {
        this.scanAllMessages();
      }
    });

    this.messageObserver = observer;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  setupEditModeRestorer() {
    document.addEventListener(
      "input",
      (e) => {
        const inputEl = this.adapter.getInputElement();
        if (inputEl && (inputEl === e.target || inputEl.contains(e.target))) {
          if (e.isTrusted && !this.suppressDraftInput) {
            this.lastUserTypingAt = Date.now();
          }
          this.scheduleEditRestore();
        }
      },
      true
    );

    document.addEventListener(
      "keydown",
      (e) => {
        if (!e.isTrusted) return;
        const inputEl = this.adapter.getInputElement();
        if (inputEl && (inputEl === e.target || inputEl.contains(e.target))) {
          this.lastUserTypingAt = Date.now();
        }
      },
      true
    );
  }

  // ---------------------------------------------------------------------------
  // پیش‌نویس محلی و جلوگیری از ذخیره پیش‌نویس خام در سرور بله
  // ---------------------------------------------------------------------------

  setupDraftGuard() {
    document.addEventListener(
      "input",
      (e) => {
        if (!e.isTrusted) return;
        if (this.suppressDraftInput) return;
        if (Date.now() < this.draftInputSuppressedUntil) return;
        if (this.isSendingControl || this.isEncryptingAndSending) return;

        const inputEl = this.adapter.getInputElement();
        if (
          !inputEl ||
          (inputEl !== e.target && !inputEl.contains(e.target))
        ) {
          return;
        }

        this.lastUserTypingAt = Date.now();
        this.draftUserTypedSinceOpen = true;
        this.draftEditModeActive = false;
        this.scheduleDraftSave();
      },
      true
    );

    const navigate = (e) => {
      if (this.isSendingControl || this.isEncryptingAndSending) return;
      if (e.type === "pointerdown" && e.button !== 0) return;

      const target = e.target;

      if (this.isComposerInteraction(target)) {
        this.restorePendingDraftSnapshot();
        return;
      }

      const isNavigation = Boolean(
        this.adapter.isChatNavigationTarget?.(target)
      );
      const isPotentialExit =
        isNavigation || this.isPotentialChatExitTarget(target);

      if (!isPotentialExit) {
        this.restorePendingDraftSnapshot();
        return;
      }

      this.prepareDraftExit(
        isNavigation ? "navigation" : "outside",
        700
      );
    };

    document.addEventListener(
      "keydown",
      (e) => {
        if (this.isSendingControl || this.isEncryptingAndSending) return;
        if (e.key !== "Escape") return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.isComposing) return;
        this.prepareDraftEscape();
      },
      true
    );

    document.addEventListener("pointerdown", navigate, true);
    document.addEventListener("touchstart", navigate, {
      capture: true,
      passive: true
    });
    document.addEventListener("click", navigate, true);

    window.addEventListener(
      "popstate",
      () => {
        this.prepareDraftExit("popstate", 500);
        this.checkUrlChange();
      },
      true
    );

    window.addEventListener(
      "hashchange",
      () => {
        this.prepareDraftExit("hashchange", 500);
        this.checkUrlChange();
      },
      true
    );

    window.addEventListener(
      "pagehide",
      () => this.handleDraftLeave("pagehide"),
      true
    );

    window.addEventListener(
      "beforeunload",
      () => this.handleDraftLeave("beforeunload"),
      true
    );

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "hidden") {
          this.handleDraftLeave("hidden");
          this.cancelPendingDraftSnapshot();
          this.draftStateLoadedFor = null;
          this.draftStateLocal = null;
          this.draftUserTypedSinceOpen = false;
        } else {
          this.cancelPendingDraftSnapshot();
          this.draftStateObserveAfter = Date.now() + 150;
          this.draftStateRestoreSuppressUntil = 0;
          this.draftUserTypedSinceOpen = false;
          this.ensureDraftState().catch(() => {});
        }
      },
      true
    );
  }

  setDraftInputValue(inputEl, text) {
    if (!inputEl) return;

    this.suppressDraftInput = true;
    this.draftInputSuppressedUntil = Date.now() + 120;
    try {
      this.adapter.setInputValue(inputEl, text);
    } finally {
      this.suppressDraftInput = false;
    }
  }

  queueDraftWrite(operation) {
    const run = this.draftWriteChain.catch(() => {}).then(operation);
    this.draftWriteChain = run.catch(() => {});
    return run;
  }

  isComposerInteraction(target) {
    if (!target || !target.closest) return false;

    if (
      target.closest(
        '[data-bale-enc-ui="1"], #bale-enc-floating-lock-btn, #bale-enc-chat-settings-btn, ' +
          '#bale-enc-start-handshake-btn, #bale-enc-consent-prompt, #bale-enc-composer-lock-overlay, ' +
          '#bale-enc-key-request-modal-backdrop, #bale-enc-key-request-modal, ' +
          '#bale-enc-toast-container, .bale-enc-toast'
      )
    ) {
      return true;
    }

    if (
      target.closest(
        '[class*="emoji" i], [class*="attach" i], [class*="voice" i], ' +
          '[class*="record" i], [class*="micro" i], ' +
          '[aria-label*="emoji" i], [aria-label*="attach" i], ' +
          '[aria-label*="voice" i], [aria-label*="record" i], ' +
          '[aria-label*="میکروفون"], [aria-label*="پیوست"]'
      )
    ) {
      return true;
    }

    const inputEl = this.adapter.getInputElement();
    if (inputEl && (target === inputEl || inputEl.contains(target))) {
      return true;
    }

    const composer = this.adapter.getComposerElement();
    if (composer && composer.contains(target)) return true;

    const sendBtn = this.adapter.getSendButtonElement();
    if (sendBtn && (sendBtn === target || sendBtn.contains(target))) {
      return true;
    }

    if (this.adapter.isSendButton?.(target)) {
      return true;
    }

    return false;
  }

  isInChatMessageAction(target) {
    if (!target || !target.closest) return false;
    const actionEl = target.closest(
      'button, [role="button"], [role="menuitem"], li, a, div, span'
    );
    const label = [
      actionEl?.getAttribute?.("aria-label") || "",
      actionEl?.getAttribute?.("title") || "",
      (actionEl?.innerText || "").slice(0, 40)
    ].join(" ").toLowerCase();

    if (
      /(ویرایش|پاسخ|ریپلای|کپی|فوروارد|بازارسال|پین|سنجاق|edit|reply|copy|forward|pin)/i.test(
        label
      )
    ) {
      return true;
    }

    if (target.closest('[role="menu"], [class*="contextMenu" i], [class*="context-menu" i]')) {
      return true;
    }

    return false;
  }

  isPotentialChatExitTarget(target) {
    if (!target || !target.closest) return false;
    if (this.isComposerInteraction(target)) return false;
    if (this.isInChatMessageAction(target)) return false;

    if (
      target.closest(
        'a[href], button, [role="button"], [role="tab"], ' +
          '[role="menuitem"], [role="option"]'
      )
    ) {
      return true;
    }

    if (
      target.closest(
        'header, [class*="header" i], [class*="sidebar" i], ' +
          '[class*="side-bar" i], [class*="drawer" i], ' +
          '[class*="dialog" i], [class*="conversation" i], ' +
          '[class*="chat-list" i], [class*="chatList" i]'
      )
    ) {
      return true;
    }

    let node = target;
    for (
      let depth = 0;
      depth < 5 && node && node !== document.body;
      depth++, node = node.parentElement
    ) {
      if (window.getComputedStyle(node).cursor === "pointer") return true;
    }

    return false;
  }

  prepareDraftEscape() {
    this.prepareDraftExit("escape", 1000);
  }

  prepareDraftExit(reason, restoreDelayMs = 700) {
    if (!this.currentChatId || !this.shouldIntercept()) return false;
    if (this.isSendingControl || this.isEncryptingAndSending) return false;

    const inputEl = this.adapter.getInputElement();
    if (!inputEl) return false;

    const text = this.adapter.getInputValue(inputEl) || "";
    if (!text.trim()) return false;

    if (this.draftEditModeActive || this.isEncryptedPayload(text)) {
      // هنگام کلیک‌های غیرناوبری داخل چت (مثل باز کردن حالت ویرایش)، متن رمزشده بارگذاری‌شده را پاک نکنیم
      if (reason === "outside") {
        return false;
      }
      this.handleDraftLeave(reason);
      return false;
    }

    const snapshot = {
      uid: this.currentChatId,
      messenger: this.getMessenger(),
      displayName: this.getDraftDisplayName(),
      text
    };

    if (!this.handleDraftLeave(reason)) return false;

    const navigationLeave =
      reason === "navigation" ||
      reason === "outside" ||
      reason === "popstate" ||
      reason === "hashchange";

    this.draftSnapshotPending = true;
    this.draftPendingSnapshot = snapshot;
    this.draftStateRestoreSuppressUntil =
      Date.now() + (navigationLeave ? 2000 : restoreDelayMs + 200);

    if (this.draftEscapeRestoreTimer) {
      clearTimeout(this.draftEscapeRestoreTimer);
    }
    this.draftEscapeRestoreTimer = setTimeout(() => {
      this.draftEscapeRestoreTimer = null;
      if (
        !this.draftSnapshotPending ||
        this.draftPendingSnapshot !== snapshot ||
        this.currentChatId !== snapshot.uid
      ) {
        return;
      }
      this.restorePendingDraftSnapshot();
    }, restoreDelayMs);

    return true;
  }

  cancelPendingDraftSnapshot() {
    this.draftSnapshotPending = false;
    this.draftPendingSnapshot = null;
    if (this.draftEscapeRestoreTimer) {
      clearTimeout(this.draftEscapeRestoreTimer);
      this.draftEscapeRestoreTimer = null;
    }
  }

  restorePendingDraftSnapshot() {
    if (!this.draftSnapshotPending) return;

    if (this.draftEscapeRestoreTimer) {
      clearTimeout(this.draftEscapeRestoreTimer);
      this.draftEscapeRestoreTimer = null;
    }

    this.draftSnapshotPending = false;
    this.draftStateRestoreSuppressUntil = 0;
    this.draftStateObserveAfter = 0;

    const snapshot = this.draftPendingSnapshot;
    this.draftPendingSnapshot = null;

    const inputEl = this.adapter.getInputElement();
    const current = inputEl ? this.adapter.getInputValue(inputEl) || "" : "";

    if (
      inputEl &&
      snapshot &&
      snapshot.uid === this.currentChatId &&
      !current.trim() &&
      !this.draftUserTypedSinceOpen &&
      !this.draftEditModeActive &&
      !this.isSendingControl &&
      !this.isEncryptingAndSending
    ) {
      this.setDraftInputValue(inputEl, snapshot.text);
      this.draftLastKnown = {
        chatId: snapshot.uid,
        text: snapshot.text,
        displayName: snapshot.displayName
      };
      this.draftStateLocal = {
        messenger: snapshot.messenger,
        uid: snapshot.uid,
        displayName: snapshot.displayName,
        text: snapshot.text,
        updatedAt: Date.now()
      };
      this.draftStateLoadedFor = snapshot.uid;
      return;
    }

    this.ensureDraftState().catch(() => {});
  }

  getDraftDisplayName() {
    return (
      (this.currentChatConfig && this.currentChatConfig.displayName) ||
      this.currentChatDisplayName ||
      this.currentChatId ||
      ""
    );
  }

  isEncryptedPayload(text) {
    const clean = CONSTANTS.stripFormatting(text || "").trim();
    if (!clean) return false;
    if (
      clean.startsWith(CONSTANTS.PREFIXES.KEY_EXCHANGE) ||
      clean.startsWith(CONSTANTS.LEGACY_PREFIXES.KEY_EXCHANGE)
    ) {
      return true;
    }

    const ciphertext = CONSTANTS.extractCiphertext(clean);
    return Boolean(ciphertext && ciphertext === clean);
  }

  handleDraftChatChange(previousUid, uid) {
    if (previousUid === uid) return;

    this.cancelPendingDraftSnapshot();
    this.flushPendingDraftSave();

    if (this.draftRestoreTimer) {
      clearTimeout(this.draftRestoreTimer);
      this.draftRestoreTimer = null;
    }

    if (previousUid) {
      this.clearDraftFromPreviousChat(previousUid);
    }

    this.draftStateChatId = uid;
    this.draftStateLoadedFor = null;
    this.draftStateLocal = null;
    this.draftStateInFlight = false;
    this.draftStateObserveAfter = uid ? Date.now() + 350 : 0;
    if (this.draftStateRestoreSuppressUntil <= Date.now()) {
      this.draftStateRestoreSuppressUntil = 0;
    } else if (this.draftStateRestoreSuppressUntil > Date.now() + 2500) {
      this.draftStateRestoreSuppressUntil = Date.now() + 2000;
    }
    this.draftUserTypedSinceOpen = false;
    this.draftEditModeActive = false;
    this.draftLastKnown = {
      chatId: uid,
      text: "",
      displayName: uid ? this.getDraftDisplayName() : ""
    };
  }

  clearDraftFromPreviousChat(previousUid) {
    if (!previousUid) return;
    if (this.draftLastKnown.chatId !== previousUid) return;
    if (!this.draftLastKnown.text) return;
    if (this.isSendingControl || this.isEncryptingAndSending) return;

    const inputEl = this.adapter.getInputElement();
    if (!inputEl) return;

    const current = this.adapter.getInputValue(inputEl) || "";
    if (current !== this.draftLastKnown.text) return;

    this.setDraftInputValue(inputEl, "");
  }

  scheduleDraftRestore(uid) {
    if (!uid) return;

    if (this.draftRestoreTimer) {
      clearTimeout(this.draftRestoreTimer);
    }

    this.draftRestoreTimer = setTimeout(() => {
      this.draftRestoreTimer = null;
      if (this.currentChatId !== uid) return;
      this.ensureDraftState().catch((err) =>
        console.warn("[Pardag E2EE] draft restore error:", err)
      );
    }, 400);
  }

  async ensureDraftState() {
    if (this.draftStateInFlight) return;

    const uid = this.currentChatId;
    if (!uid || !this.currentChatConfig) return;
    if (this.currentChatConfig.enabled === false) return;
    if (!this.shouldIntercept()) return;
    if (this.adapter.isNonChatView?.()) return;
    if (this.isSendingControl || this.isEncryptingAndSending) return;
    if (Date.now() - this.lastSendAt < 1500) return;
    if (Date.now() < this.draftStateRestoreSuppressUntil) return;
    if (!this.draftStateObserveAfter || Date.now() < this.draftStateObserveAfter) {
      return;
    }

    this.draftStateInFlight = true;
    try {
      const inputEl = this.adapter.getInputElement();
      if (!inputEl) return;

      if (this.draftStateLoadedFor !== uid) {
        this.draftStateLocal = await StorageManager.getDraft(
          this.getMessenger(),
          uid
        );
        this.draftStateLoadedFor = uid;
      }

      if (this.currentChatId !== uid) return;

      const current = this.adapter.getInputValue(inputEl) || "";

      if (this.draftEditModeActive && !current.trim()) {
        this.draftEditModeActive = false;
      }
      if (this.draftEditModeActive) return;
      if (this.draftUserTypedSinceOpen) return;

      if (this.isEncryptedPayload(current)) {
        return;
      }

      const localText = this.draftStateLocal ? this.draftStateLocal.text : "";

      if (localText) {
        if (current === localText) {
          this.draftLastKnown = {
            chatId: uid,
            text: current,
            displayName: this.draftStateLocal.displayName || ""
          };
          return;
        }

        this.setDraftInputValue(inputEl, localText);
        this.draftLastKnown = {
          chatId: uid,
          text: localText,
          displayName: this.draftStateLocal.displayName || ""
        };
        return;
      }

      if (current.trim()) {
        const record = await this.queueDraftWrite(() =>
          StorageManager.saveDraft(
            this.getMessenger(),
            uid,
            this.getDraftDisplayName(),
            current
          )
        );
        if (record && this.currentChatId === uid) {
          this.draftStateLocal = record;
          this.draftStateLoadedFor = uid;
          this.draftLastKnown = {
            chatId: uid,
            text: current,
            displayName: record.displayName || ""
          };
        }
      }
    } finally {
      this.draftStateInFlight = false;
    }
  }

  scheduleDraftSave() {
    if (!this.currentChatId || !this.shouldIntercept()) return;
    if (this.isSendingControl || this.isEncryptingAndSending) return;

    const inputEl = this.adapter.getInputElement();
    if (!inputEl) return;

    const text = this.adapter.getInputValue(inputEl) || "";
    if (this.isEncryptedPayload(text)) return;

    const snapshot = {
      messenger: this.getMessenger(),
      uid: this.currentChatId,
      displayName: this.getDraftDisplayName(),
      text
    };

    this.pendingDraftSave = snapshot;
    this.draftLastKnown = {
      chatId: snapshot.uid,
      text,
      displayName: snapshot.displayName
    };

    if (this.draftSaveTimer) clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = setTimeout(() => {
      this.draftSaveTimer = null;
      this.flushPendingDraftSave();
    }, CONSTANTS.DRAFT_SAVE_DEBOUNCE_MS);
  }

  flushPendingDraftSave() {
    if (this.draftSaveTimer) {
      clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }

    const snapshot = this.pendingDraftSave;
    this.pendingDraftSave = null;
    if (!snapshot || !snapshot.uid) return;

    const messenger = snapshot.messenger || this.getMessenger();

    if (!snapshot.text || !snapshot.text.trim()) {
      this.queueDraftWrite(() =>
        StorageManager.removeDraft(messenger, snapshot.uid)
      ).catch((err) =>
        console.warn("[Pardag E2EE] draft remove failed:", err)
      );
      if (this.draftStateLoadedFor === snapshot.uid) {
        this.draftStateLocal = null;
      }
      return;
    }

    this.queueDraftWrite(() =>
      StorageManager.saveDraft(
        messenger,
        snapshot.uid,
        snapshot.displayName,
        snapshot.text
      )
    )
      .then((record) => {
        if (record && this.currentChatId === snapshot.uid) {
          this.draftStateLocal = record;
          this.draftStateLoadedFor = snapshot.uid;
        }
      })
      .catch((err) =>
        console.warn("[Pardag E2EE] draft save failed:", err)
      );
  }

  handleDraftLeave(reason) {
    if (!this.currentChatId || !this.shouldIntercept()) return false;
    if (this.isSendingControl || this.isEncryptingAndSending) return false;

    const inputEl = this.adapter.getInputElement();
    if (!inputEl) return false;

    const text = this.adapter.getInputValue(inputEl) || "";
    if (!text.trim()) {
      this.flushPendingDraftSave();
      return false;
    }

    if (this.draftSaveTimer) {
      clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    this.pendingDraftSave = null;

    const uid = this.currentChatId;
    const displayName = this.getDraftDisplayName();
    const isEditDraft = this.draftEditModeActive;

    if (!isEditDraft && !this.isEncryptedPayload(text)) {
      this.queueDraftWrite(() =>
        StorageManager.saveDraft(
          this.getMessenger(),
          uid,
          displayName,
          text
        )
      ).catch((err) => console.warn("[Pardag E2EE] draft save failed:", err));
    }

    this.setDraftInputValue(inputEl, "");

    const navigationLeave =
      reason === "navigation" ||
      reason === "outside" ||
      reason === "popstate" ||
      reason === "hashchange";

    this.draftLastKnown = { chatId: uid, text: "", displayName };
    this.draftStateLocal = null;
    this.draftStateLoadedFor = null;
    this.draftUserTypedSinceOpen = false;
    this.draftEditModeActive = false;
    this.draftStateObserveAfter = Date.now() + 300;

    this.draftStateRestoreSuppressUntil = navigationLeave
      ? Date.now() + 2000
      : 0;
    return true;
  }

  scheduleEditRestore() {
    if (this.editRestoreTimer) return;
    this.editRestoreTimer = setTimeout(() => {
      this.editRestoreTimer = null;
      this.restoreEditInput().catch((err) =>
        console.warn("[Pardag E2EE] edit restore error:", err)
      );
    }, 120);
  }

  async restoreEditInput() {
    if (this.isEncryptingAndSending || this.isSendingControl) return;
    if (Date.now() - this.lastSendAt < 1500) return;
    if (this.editRestoreInFlight) return;

    const inputEl = this.adapter.getInputElement();
    if (!inputEl) return;

    const raw = (this.adapter.getInputValue(inputEl) || "").trim();
    const cleanRaw = CONSTANTS.stripFormatting(raw).trim();
    if (!cleanRaw) return;

    if (
      CONSTANTS.isKeyExchangeMessage(cleanRaw) &&
      CryptoEngine.parseKeyExchange(cleanRaw)
    ) {
      this.draftEditModeActive = false;
      this.setDraftInputValue(inputEl, "");
      this.adapter.cancelEditMode?.(inputEl);
      ToastUI.show(
        CONSTANTS.MESSAGES.EDIT_KEY_EXCHANGE_CLEARED,
        "info",
        5000
      );
      return;
    }

    if (!CONSTANTS.isExactCiphertext(cleanRaw)) return;

    const ciphertext = CONSTANTS.extractCiphertext(cleanRaw);
    if (!ciphertext) return;

    this.draftEditModeActive = true;

    this.editRestoreInFlight = true;
    try {
      const plaintext = await MessageDecorator.decryptForEdit(
        ciphertext,
        this.currentChatConfig
      );

      const currentInput = this.adapter.getInputElement();
      const currentValue = currentInput
        ? (this.adapter.getInputValue(currentInput) || "").trim()
        : "";
      if (
        currentInput !== inputEl ||
        CONSTANTS.stripFormatting(currentValue).trim() !== ciphertext
      ) {
        return;
      }

      if (plaintext !== null) {
        this.setDraftInputValue(inputEl, plaintext);
      } else {
        this.setDraftInputValue(inputEl, "");
        ToastUI.show(
          CONSTANTS.MESSAGES.EDIT_TEXT_UNAVAILABLE,
          "warning",
          5000
        );
      }
    } finally {
      this.editRestoreInFlight = false;
    }
  }

  /**
   * اسکن پیام‌ها هم در داخل چت و هم در صفحه خارج از چت (برای پوشاندن پیش‌نمایش لیست چت‌ها).
   */
  scanAllMessages(scanOptions = {}) {
    if (this.isContextInvalidated()) return;
    const isOutsideChat =
      Boolean(this.adapter.isNonChatView?.()) || !this.currentChatId;

    const elements = this.adapter.getMessageElements();

    const chatKeyExchangeItems = [];
    const regularMessageElements = [];

    for (const el of elements) {
      const rawText = MessageDecorator.getRawText(el);

      if (isOutsideChat || el.dataset.baleEncPreview === "1") {
        el.dataset.baleEncPreview = "1";
        if (CONSTANTS.isKeyExchangePreview(rawText)) {
          MessageDecorator.renderPreview(
            el,
            CONSTANTS.MESSAGES.KEY_EXCHANGE_PREVIEW,
            rawText
          );
        } else {
          MessageDecorator.processElement(el, this.currentChatConfig).catch(() => {});
        }
        continue;
      }

      if (CONSTANTS.isKeyExchangeMessage(rawText)) {
        chatKeyExchangeItems.push({ el, rawText });
        continue;
      }

      regularMessageElements.push(el);
    }

    if (chatKeyExchangeItems.length > 0) {
      const latestIndex = chatKeyExchangeItems.length - 1;

      for (let i = 0; i < chatKeyExchangeItems.length; i += 1) {
        const { el, rawText } = chatKeyExchangeItems[i];
        const isSupersededInScan = i < latestIndex;

        if (el.dataset.baleEncKeyProcessed !== rawText || el.dataset.baleEncDecorated !== "1") {
          el.dataset.baleEncKeyProcessed = rawText;
          this.queueKeyExchange(() =>
            this.handleKeyExchange(rawText, el, {
              isSupersededInScan,
              isInitialHistoryScan: Boolean(scanOptions.isInitialHistoryScan)
            })
          ).catch((err) => {
            if (this.isContextInvalidated(err)) return;
            console.warn("[Pardag E2EE] key exchange error:", err);
          });
        }
      }
    }

    for (const el of regularMessageElements) {
      MessageDecorator.processElement(el, this.currentChatConfig).catch((err) => {
        if (this.isContextInvalidated(err)) return;
        console.warn("[Pardag E2EE] message decorate error:", err);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // رهگیری ارسال
  // ---------------------------------------------------------------------------

  setupSendInterceptors() {
    document.addEventListener(
      "keydown",
      async (e) => {
        if (!e.isTrusted) return;

        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          const inputEl = this.adapter.getInputElement();
          if (!inputEl || (inputEl !== e.target && !inputEl.contains(e.target))) {
            return;
          }

          if (this.isSendingControl || this.isEncryptingAndSending) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }

          if (this.shouldIntercept()) {
            const rawText = this.adapter.getInputValue(inputEl);
            if (!rawText) return;

            e.preventDefault();
            e.stopImmediatePropagation();
            await this.handleSendTrigger(inputEl, rawText, null);
          }
        }
      },
      true
    );

    const mousePreEvents = ["pointerdown", "mousedown", "pointerup", "mouseup"];
    mousePreEvents.forEach((evtName) => {
      document.addEventListener(
        evtName,
        (e) => {
          if (!e.isTrusted) return;
          const target = e.target?.nodeType === Node.TEXT_NODE ? e.target.parentElement : e.target;
          if (!this.adapter.isSendButton(target)) return;

          if (this.isSendingControl || this.isEncryptingAndSending) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }

          if (this.shouldIntercept()) {
            const inputEl = this.adapter.getInputElement();
            const rawText = inputEl ? this.adapter.getInputValue(inputEl) : "";
            if (!rawText) return;
            // در mousedown از تغییر فوکوس جلوگیری می‌کنیم تا کادر متن blur نشود و click به‌درستی ثبت شود
            if (evtName === "mousedown") {
              e.preventDefault();
            }
            // فقط جلوی رسیدن رویداد به بله را می‌گیریم تا رویداد click به‌طور طبیعی تولید و رهگیری شود
            e.stopImmediatePropagation();
          }
        },
        true
      );
    });

    document.addEventListener(
      "click",
      async (e) => {
        if (!e.isTrusted) return;
        const target = e.target?.nodeType === Node.TEXT_NODE ? e.target.parentElement : e.target;
        if (!this.adapter.isSendButton(target)) return;

        if (this.isSendingControl || this.isEncryptingAndSending) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }

        const inputEl = this.adapter.getInputElement();
        if (!inputEl) return;

        if (this.shouldIntercept()) {
          const rawText = this.adapter.getInputValue(inputEl);
          if (!rawText) return;

          e.preventDefault();
          e.stopImmediatePropagation();
          await this.handleSendTrigger(inputEl, rawText, target);
        }
      },
      true
    );

    document.addEventListener(
      "submit",
      async (e) => {
        if (!e.isTrusted) return;
        const inputEl = this.adapter.getInputElement();
        if (!inputEl) return;
        if (e.target && e.target.contains && !e.target.contains(inputEl)) return;

        if (this.isSendingControl || this.isEncryptingAndSending) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }

        if (this.shouldIntercept()) {
          const rawText = this.adapter.getInputValue(inputEl);
          if (!rawText) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          await this.handleSendTrigger(inputEl, rawText, null);
        }
      },
      true
    );
  }

  shouldIntercept() {
    if (this.currentChatType === "channel" || this.currentChatType === "bot" || this.currentChatType === "none") {
      return false;
    }
    const config = this.currentChatConfig;
    if (!config || config.enabled === false) return false;

    const mode = this.getMode(config);
    if (mode === "password") return Boolean(config.password);
    if (mode === "rsa") return this.currentChatType === "private";
    return false;
  }

  async handleSendTrigger(inputEl, rawText, clickedTarget) {
    if (this.isEncryptingAndSending || this.isSendingControl) return;

    if (CONSTANTS.hasReservedPrefix(rawText)) {
      ToastUI.show(CONSTANTS.MESSAGES.PREFIX_COLLISION_WARN, "error", 6000);
      return;
    }

    const sendUid = this.currentChatId;
    const sendMessenger = this.getMessenger();
    const sendDisplayName = this.getDraftDisplayName();

    const mode = this.getMode(this.currentChatConfig);

    if (mode === "rsa") {
      await this.checkPendingHandshakeExpiration();
      const hsState = this.currentChatConfig?.handshakeState;

      if (hsState === CONSTANTS.HANDSHAKE_STATES.EXPIRED) {
        ToastUI.show(CONSTANTS.MESSAGES.SEND_BLOCKED_EXPIRED, "warning", 7000);
        return;
      }
      if (
        hsState === CONSTANTS.HANDSHAKE_STATES.KEY_CHANGED ||
        this.currentChatConfig?.keyChanged
      ) {
        ToastUI.show(CONSTANTS.MESSAGES.SEND_BLOCKED_KEY_CHANGED, "warning", 7000);
        return;
      }
      if (hsState === CONSTANTS.HANDSHAKE_STATES.PENDING_APPROVAL) {
        ToastUI.show(
          CONSTANTS.MESSAGES.SEND_BLOCKED_PENDING_APPROVAL,
          "warning",
          7000
        );
        return;
      }
      if (
        !this.currentChatConfig?.peerPublicKey ||
        (hsState && hsState !== CONSTANTS.HANDSHAKE_STATES.ACTIVE)
      ) {
        ToastUI.show(CONSTANTS.MESSAGES.SEND_BLOCKED_NO_PEER, "warning", 7000);
        return;
      }
    }

    try {
      this.isEncryptingAndSending = true;

      let ciphertext;

      if (mode === "rsa") {
        const identity = await IdentityManager.getIdentity();
        ciphertext = await CryptoEngine.encryptHybrid(rawText, {
          peerEncryptionPublicKeySpki: this.currentChatConfig.peerPublicKey,
          ownEncryptionPublicKeySpki: identity.encryption.publicKeySpki,
          ownSigningPrivateKeyJwk: identity.signing.privateKeyJwk,
          senderFingerprint: identity.fingerprint
        });
      } else {
        ciphertext = await CryptoEngine.encrypt(
          rawText,
          this.currentChatConfig.password
        );
      }

      MessageDecorator.cachePlaintext(ciphertext, rawText);
      this.setDraftInputValue(inputEl, ciphertext);

      await new Promise((resolve) => setTimeout(resolve, 90));

      let btn =
        clickedTarget && clickedTarget.isConnected
          ? (this.adapter.findClickableAncestor?.(clickedTarget) ||
            clickedTarget.closest?.(
              'button, [role="button"], div[class*="send" i], span[class*="send" i], [class*="send-btn" i], [data-testid*="send" i]'
            ))
          : null;
      if (!btn || !btn.isConnected) {
        btn = this.adapter.getSendButtonElement();
      }

      if (btn && btn.isConnected && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        this.adapter.triggerClick(btn);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const activeInput = inputEl.isConnected ? inputEl : this.adapter.getInputElement();
        if (activeInput) {
          const stillInBox = (this.adapter.getInputValue(activeInput) || "").trim();
          if (stillInBox === ciphertext.trim()) {
            activeInput.focus();
            this.adapter.triggerEnter(activeInput);
          }
        }
      } else {
        const activeInput = inputEl.isConnected ? inputEl : this.adapter.getInputElement();
        if (activeInput) {
          activeInput.focus();
          this.adapter.triggerEnter(activeInput);
        }
      }
      this.lastSendAt = Date.now();

      if (sendUid) {
        if (this.draftSaveTimer) {
          clearTimeout(this.draftSaveTimer);
          this.draftSaveTimer = null;
        }
        this.pendingDraftSave = null;
        this.draftStateLocal = null;
        this.draftStateLoadedFor = null;
        this.draftEditModeActive = false;
        if (this.draftPendingSnapshot?.uid === sendUid) {
          this.cancelPendingDraftSnapshot();
        }
        this.draftLastKnown = {
          chatId: sendUid,
          text: "",
          displayName: sendDisplayName
        };
        this.queueDraftWrite(() =>
          StorageManager.removeDraft(sendMessenger, sendUid)
        ).catch((err) =>
          console.warn("[Pardag E2EE] draft remove after send failed:", err)
        );
      }

      this.isEncryptingAndSending = false;
    } catch (err) {
      console.error("[Pardag E2EE] Error in handleSendTrigger:", err);
      ToastUI.show("خطا در رمزنگاری پیام. لطفاً دوباره تلاش کنید.", "error");
      this.isEncryptingAndSending = false;
    }
  }

  // ---------------------------------------------------------------------------
  // همگام‌سازی بین تب‌ها و پاپ‌آپ
  // ---------------------------------------------------------------------------

  setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      if (changes[CONSTANTS.STORAGE_KEYS.IDENTITY]) {
        IdentityManager.clearCache();
      }

      if (changes[CONSTANTS.STORAGE_KEYS.RECOVERED_PEER_KEYS]) {
        this.retryFailedMessages().catch(() => {});
      }

      if (
        changes[CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS] ||
        changes[CONSTANTS.STORAGE_KEYS.PENDING_PEERS] ||
        changes[CONSTANTS.STORAGE_KEYS.TERMINATED_SESSIONS]
      ) {
        this.syncChatState().catch((err) =>
          console.warn("[Pardag E2EE] storage sync failed:", err)
        );
      }

      if (changes[CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS]) {
        this.publishDraftGuardChats();
      }

      if (this.currentChatId) {
        const draftKey = StorageManager.getDraftKey(
          this.getMessenger(),
          this.currentChatId
        );
        if (Object.prototype.hasOwnProperty.call(changes, draftKey)) {
          const newDraft = changes[draftKey].newValue || null;
          this.draftStateLocal = newDraft;
          this.draftStateLoadedFor = this.currentChatId;
          if (!newDraft && this.draftPendingSnapshot?.uid === this.currentChatId) {
            this.cancelPendingDraftSnapshot();
          }
        }
      }
    });
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "get_chat_info") {
        const activeUid = this.adapter.isNonChatView?.()
          ? null
          : this.currentChatId || this.adapter.getActiveChatId();

        sendResponse({
          uid: activeUid,
          chatType: this.currentChatType,
          displayName: this.adapter.getActiveChatDisplayName(),
          mode: this.currentChatConfig
            ? this.getMode(this.currentChatConfig)
            : null,
          handshakeState:
            (this.currentChatConfig && this.currentChatConfig.handshakeState) ||
            null,
          hasConfig: Boolean(this.currentChatConfig),
          hasPeerKey: Boolean(
            this.currentChatConfig && this.currentChatConfig.peerPublicKey
          ),
          peerFingerprint:
            (this.currentChatConfig && this.currentChatConfig.peerFingerprint) ||
            null,
          verified: Boolean(
            this.currentChatConfig && this.currentChatConfig.verified
          ),
          keyChanged: Boolean(
            this.currentChatConfig && this.currentChatConfig.keyChanged
          ),
          pendingPeer: this.pendingPeer
            ? {
                displayName: this.pendingPeer.displayName || null,
                peerFingerprint: this.pendingPeer.peerFingerprint || null,
                peerKeyTimestamp: this.pendingPeer.peerKeyTimestamp || null
              }
            : null
        });
        return true;
      }

      if (request.action === "start_handshake" || request.action === "retry_handshake") {
        if (!request.uid || request.uid === this.currentChatId) {
          this.startKeyExchangeProcess(true)
            .then((ok) => sendResponse({ ok }))
            .catch((err) =>
              sendResponse({ ok: false, error: err.message || "unknown" })
            );
          return true;
        }
        sendResponse({ ok: false, error: "chat_not_active" });
        return true;
      }

      if (request.action === "approve_peer_key") {
        if (!request.uid || request.uid === this.currentChatId) {
          this.approvePeerKeyAndSendAck()
            .then((ok) => sendResponse({ ok }))
            .catch((err) =>
              sendResponse({ ok: false, error: err.message || "unknown" })
            );
          return true;
        }
        sendResponse({ ok: false, error: "chat_not_active" });
        return true;
      }

      if (request.action === "sync_after_backup") {
        IdentityManager.clearCache();
        MessageDecorator.clearCache();
        StorageManager.getKeyExchangeTtlMs()
          .then(async (ms) => {
            this.keyExchangeTtlMs = ms;
            await this.loadTerminatedSessions();
            await this.syncChatState();
            await this.retryFailedMessages();
            sendResponse({ ok: true });
          })
          .catch((err) =>
            sendResponse({ ok: false, error: err.message || "unknown" })
          );
        return true;
      }

      if (request.action === "cancel_handshake") {
        if (!request.uid || request.uid === this.currentChatId) {
          this.cancelOwnHandshake()
            .then((ok) => sendResponse({ ok }))
            .catch((err) =>
              sendResponse({ ok: false, error: err.message || "unknown" })
            );
          return true;
        }
        sendResponse({ ok: false, error: "chat_not_active" });
        return true;
      }

      if (request.action === "reject_peer_key") {
        if (!request.uid || request.uid === this.currentChatId) {
          this.rejectPeerKeyAndCancel()
            .then((ok) => sendResponse({ ok }))
            .catch((err) =>
              sendResponse({ ok: false, error: err.message || "unknown" })
            );
          return true;
        }
        sendResponse({ ok: false, error: "chat_not_active" });
        return true;
      }

      return false;
    });
  }
}

const controller = new ContentController(new BaleAdapter());
controller.init().catch((err) => {
  console.error("[Pardag E2EE] initialization failed:", err);
});
