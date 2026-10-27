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
    this.currentChatConfig = null;
    this.pendingPeer = null;
    this.isEncryptingAndSending = false;
    this.isSendingControl = false;
    this.handshakeInFlight = false;
    this.retryInFlight = false;
    this.lastUrl = window.location.href;
    this.lastHandshakeAttempt = 0;
    this.pendingNotified = new Set();
  }

  async init() {
    await this.syncChatState();
    this.setupNavigationObservers();
    this.setupMessageObserver();
    this.setupSendInterceptors();
    this.setupStorageListener();
    this.setupMessageListener();
  }

  getMessenger() {
    return this.adapter.getName();
  }

  getMode(config) {
    if (!config) return null;
    return config.mode || (config.password ? "password" : "rsa");
  }

  // ---------------------------------------------------------------------------
  // همگام‌سازی وضعیت چت
  // ---------------------------------------------------------------------------

  async syncChatState() {
    const uid = this.adapter.getActiveChatId();
    this.currentChatId = uid;

    if (uid) {
      this.currentChatConfig = await StorageManager.getChatConfig(
        this.getMessenger(),
        uid
      );
      this.pendingPeer = await StorageManager.getPendingPeer(
        this.getMessenger(),
        uid
      );
    } else {
      this.currentChatConfig = null;
      this.pendingPeer = null;
    }

    this.renderLockUI();
    this.notifyPendingPeer();
    this.scanAllMessages();

    if (
      this.currentChatConfig &&
      this.getMode(this.currentChatConfig) === "rsa" &&
      this.currentChatConfig.enabled !== false
    ) {
      this.ensureRsaHandshake().catch((err) =>
        console.warn("[Bale E2EE] handshake error:", err)
      );
    }
  }

  renderLockUI() {
    const composerEl = this.adapter.getComposerElement();

    LockButtonUI.render(
      composerEl,
      this.currentChatId,
      this.currentChatConfig,
      this.pendingPeer,
      this.adapter,
      {
        onToggle: (newState) => {
          if (!this.currentChatConfig) return;
          this.currentChatConfig.enabled = newState;
          this.renderLockUI();

          if (
            newState &&
            this.getMode(this.currentChatConfig) === "rsa"
          ) {
            this.ensureRsaHandshake().catch((err) =>
              console.warn("[Bale E2EE] handshake error:", err)
            );
          }
        },
        onEnableRsa: () => {
          this.enableRsaForCurrentChat().catch((err) => {
            console.warn("[Bale E2EE] enable RSA failed:", err);
            ToastUI.show("فعال‌سازی رمزنگاری خودکار ناموفق بود.", "error");
          });
        },
        onOpenPopup: (tab) => this.openPopupForCurrentChat(tab),
        onRetryHandshake: () => {
          this.ensureRsaHandshake(true).catch((err) =>
            console.warn("[Bale E2EE] retry handshake failed:", err)
          );
        }
      }
    );
  }

  openPopupForCurrentChat(tab = "add-chat") {
    if (!this.currentChatId) return;

    try {
      chrome.runtime.sendMessage({
        action: "open_popup",
        uid: this.currentChatId,
        displayName: this.adapter.getActiveChatDisplayName(),
        tab
      });
    } catch (err) {
      console.warn("[Bale E2EE] open popup failed:", err);
    }
  }

  notifyPendingPeer() {
    if (!this.pendingPeer) return;

    const key = `${this.currentChatId}:${this.pendingPeer.peerFingerprint || ""}`;
    if (this.pendingNotified.has(key)) return;
    this.pendingNotified.add(key);

    const mode = this.getMode(this.currentChatConfig);
    if (mode === "rsa") return;

    ToastUI.show(
      "مخاطب رمزنگاری خودکار را فعال کرده است. برای فعال‌سازی روی نشانگر گوشه صفحه کلیک کنید.",
      "info",
      7000
    );
  }

  // ---------------------------------------------------------------------------
  // تبادل خودکار کلید
  // ---------------------------------------------------------------------------

  async enableRsaForCurrentChat() {
    if (!this.currentChatId) return;

    const pending =
      this.pendingPeer ||
      (await StorageManager.getPendingPeer(this.getMessenger(), this.currentChatId));

    if (!pending) return;

    const displayName =
      pending.displayName ||
      this.adapter.getActiveChatDisplayName() ||
      this.currentChatId;

    const config = await StorageManager.saveChatConfig(
      this.getMessenger(),
      this.currentChatId,
      displayName,
      undefined,
      pending.peerFingerprint || "",
      true,
      {
        mode: "rsa",
        peerPublicKey: pending.peerPublicKey,
        peerSigningPublicKey: pending.peerSigningPublicKey,
        peerFingerprint: pending.peerFingerprint,
        peerKeyReceivedAt: Date.now(),
        verified: false,
        keyChanged: false,
        announcedFor: null
      }
    );

    await StorageManager.removePendingPeer(this.getMessenger(), this.currentChatId);
    this.pendingPeer = null;
    this.currentChatConfig = config;

    ToastUI.show(CONSTANTS.MESSAGES.ENABLED_RSA, "success");
    await this.syncChatState();
  }

  async ensureRsaHandshake(force = false) {
    if (this.handshakeInFlight) return false;
    if (!this.currentChatId) return false;
    if (!this.currentChatConfig) return false;
    if (this.getMode(this.currentChatConfig) !== "rsa") return false;
    if (this.currentChatConfig.enabled === false && !force) return false;

    const now = Date.now();
    if (!force && now - this.lastHandshakeAttempt < 5000) return false;
    this.lastHandshakeAttempt = now;
    this.handshakeInFlight = true;

    try {
      const identity = await IdentityManager.getIdentity();

      if (
        !force &&
        this.currentChatConfig.announcedFor === identity.fingerprint
      ) {
        return false;
      }

      const sent = await this.sendControlMessage(
        CryptoEngine.formatKeyExchange(identity)
      );

      if (!sent) return false;

      const updated = await StorageManager.updateChatConfig(
        this.getMessenger(),
        this.currentChatId,
        {
          announcedFor: identity.fingerprint,
          lastAnnouncedAt: Date.now()
        }
      );

      if (updated) this.currentChatConfig = updated;
      return true;
    } finally {
      this.handshakeInFlight = false;
    }
  }

  /**
   * ارسال یک پیام کنترلی (تبادل کلید) از طریق همان مسیر رابط کاربری بله.
   * این کار باعث می‌شود احراز هویت كوكی و WebSocket توسط خود اپلیکیشن بله انجام شود.
   */
  async sendControlMessage(text) {
    const inputEl = this.adapter.getInputElement();
    if (!inputEl) return false;

    const draft = this.adapter.getInputValue(inputEl) || "";
    this.isSendingControl = true;

    try {
      this.adapter.setInputValue(inputEl, text);
      await new Promise((resolve) => setTimeout(resolve, 80));

      const sendBtn = this.adapter.getSendButtonElement();
      if (sendBtn) {
        this.adapter.triggerClick(sendBtn);
      } else {
        this.adapter.triggerEnter(inputEl);
      }

      // رویداد ارسال به‌صورت همگام پردازش می‌شود؛ از این لحظه اجازه می‌دهیم
      // پیام‌های بعدی کاربر دوباره از مسیر رمزنگاری عبور کنند.
      this.isSendingControl = false;

      await new Promise((resolve) => setTimeout(resolve, 350));

      const current = this.adapter.getInputValue(inputEl) || "";
      const stillContainsControl =
        current.includes(CONSTANTS.PREFIXES.KEY_EXCHANGE);

      if (stillContainsControl) {
        // ارسال انجام نشده؛ متن قبلی کاربر را برمی‌گردانیم.
        if (draft) this.adapter.setInputValue(inputEl, draft);
        return false;
      }

      // اگر اپلیکیشن فیلد را پاک کرده و کاربر متن جدیدی ننوشته، پیش‌نویس قبلی را بازمی‌گردانیم.
      if (draft && !current) {
        this.adapter.setInputValue(inputEl, draft);
      }

      return true;
    } catch (err) {
      console.warn("[Bale E2EE] sendControlMessage failed:", err);
      if (draft) {
        try {
          this.adapter.setInputValue(inputEl, draft);
        } catch {}
      }
      return false;
    } finally {
      this.isSendingControl = false;
    }
  }

  async handleKeyExchange(text, el) {
    const bundle = CryptoEngine.parseKeyExchange(text);

    if (!bundle) {
      this.renderKeyExchangeNotice(el, CONSTANTS.MESSAGES.KEY_EXCHANGE_INVALID);
      return;
    }

    let fingerprint;
    try {
      // اطمینان از اینکه کلیدهای اعلام‌شده واقعاً از نوع RSA-OAEP و ECDSA هستند.
      await CryptoEngine.importRsaPublicKey(bundle.encryptionPublicKeySpki);
      await CryptoEngine.importEcdsaPublicKey(bundle.signingPublicKeySpki);
      fingerprint = await CryptoEngine.getIdentityFingerprint(
        bundle.encryptionPublicKeySpki,
        bundle.signingPublicKeySpki
      );
    } catch {
      this.renderKeyExchangeNotice(el, CONSTANTS.MESSAGES.KEY_EXCHANGE_INVALID);
      return;
    }

    const identity = await IdentityManager.getIdentity();
    const isOwn = fingerprint === identity.fingerprint;

    this.renderKeyExchangeNotice(
      el,
      isOwn
        ? CONSTANTS.MESSAGES.KEY_EXCHANGE_SENT
        : CONSTANTS.MESSAGES.KEY_EXCHANGE_RECEIVED
    );

    if (isOwn || !this.currentChatId) return;

    const messenger = this.getMessenger();
    const uid = this.currentChatId;
    const existing = await StorageManager.getChatConfig(messenger, uid);

    // چت در حالت تبادل خودکار کلید است: کلید مخاطب را ذخیره/بروزرسانی می‌کنیم.
    if (existing && this.getMode(existing) === "rsa") {
      const keyMaterialChanged =
        (existing.peerPublicKey &&
          existing.peerPublicKey !== bundle.encryptionPublicKeySpki) ||
        (existing.peerSigningPublicKey &&
          existing.peerSigningPublicKey !== bundle.signingPublicKeySpki);

      const keyChanged = Boolean(
        existing.peerFingerprint &&
          (existing.peerFingerprint !== fingerprint || keyMaterialChanged)
      );
      const isFirstKey =
        !existing.peerFingerprint ||
        !existing.peerPublicKey ||
        !existing.peerSigningPublicKey;

      const patch = {
        peerPublicKey: bundle.encryptionPublicKeySpki,
        peerSigningPublicKey: bundle.signingPublicKeySpki,
        peerFingerprint: fingerprint,
        fingerprint,
        peerKeyReceivedAt: Date.now()
      };

      if (keyChanged) {
        // کلید قبلی را نگه می‌داریم تا پیام‌های قدیمی همچنان قابل اعتبارسنجی باشند.
        const history = Array.isArray(existing.peerKeyHistory)
          ? existing.peerKeyHistory.slice()
          : [];
        if (existing.peerFingerprint && existing.peerSigningPublicKey) {
          history.push({
            fingerprint: existing.peerFingerprint,
            signingPublicKeySpki: existing.peerSigningPublicKey,
            encryptionPublicKeySpki: existing.peerPublicKey || null,
            retiredAt: Date.now()
          });
        }
        patch.peerKeyHistory = history.slice(-10);

        patch.verified = false;
        patch.keyChanged = true;
        patch.announcedFor = null;
        ToastUI.show(CONSTANTS.MESSAGES.KEY_CHANGED, "warning", 8000);
      } else if (isFirstKey) {
        patch.verified = false;
        patch.keyChanged = false;
        ToastUI.show(CONSTANTS.MESSAGES.KEY_RECEIVED, "success");
      }

      this.currentChatConfig = await StorageManager.updateChatConfig(
        messenger,
        uid,
        patch
      );

      this.renderLockUI();
      await this.retryFailedMessages();

      // در صورت تغییر کلید، برای اطمینان از دریافت کلید جدید توسط مخاطب دوباره اعلام می‌کنیم.
      await this.ensureRsaHandshake(keyChanged);
      return;
    }

    // چت هنوز ثبت نشده یا در حالت پسورد است: درخواست را نگه می‌داریم.
    const displayName =
      this.adapter.getActiveChatDisplayName() ||
      (existing && existing.displayName) ||
      "";

    this.pendingPeer = await StorageManager.savePendingPeer(messenger, uid, {
      displayName,
      peerPublicKey: bundle.encryptionPublicKeySpki,
      peerSigningPublicKey: bundle.signingPublicKeySpki,
      peerFingerprint: fingerprint
    });

    this.renderLockUI();
    this.notifyPendingPeer();
    await this.retryFailedMessages();
  }

  renderKeyExchangeNotice(el, text) {
    el.innerHTML = "";
    const notice = document.createElement("span");
    notice.className = "bale-enc-key-exchange";
    notice.textContent = text;
    el.appendChild(notice);
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
        if (!ciphertext) continue;

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
    const currentUid = this.adapter.isNonChatView?.()
      ? null
      : this.adapter.getActiveChatId();

    if (
      window.location.href !== this.lastUrl ||
      currentUid !== this.currentChatId
    ) {
      this.lastUrl = window.location.href;
      this.syncChatState().catch((err) =>
        console.warn("[Bale E2EE] sync failed:", err)
      );
    }
  }

  setupNavigationObservers() {
    window.addEventListener("popstate", () => this.checkUrlChange());
    window.addEventListener("hashchange", () => this.checkUrlChange());

    setInterval(() => {
      this.checkUrlChange();

      // اطمینان از حضور نشانگر وضعیت و دکمه تنظیم در صفحه چت
      const hasCornerBadge = document.getElementById(
        LockButtonUI.FLOATING_BUTTON_ID
      );
      const hasSettingsBtn = document.getElementById(
        LockButtonUI.SETTINGS_BUTTON_ID
      );

      if (this.currentChatId && (!hasCornerBadge || !hasSettingsBtn)) {
        this.renderLockUI();
      }

      // تلاش مجدد خودکار برای اعلام کلید در صورت آماده نبودن چت
      const config = this.currentChatConfig;
      if (
        config &&
        this.getMode(config) === "rsa" &&
        config.enabled !== false &&
        !this.handshakeInFlight &&
        Date.now() - this.lastHandshakeAttempt > 10000
      ) {
        IdentityManager.getIdentity()
          .then((identity) => {
            if (
              this.currentChatConfig &&
              this.currentChatConfig.announcedFor !== identity.fingerprint
            ) {
              this.ensureRsaHandshake().catch(() => {});
            }
          })
          .catch(() => {});
      }
    }, 600);
  }

  setupMessageObserver() {
    const observer = new MutationObserver((mutations) => {
      // تغییر مسیر بله (مثلاً باز شدن جستجو) معمولاً با تغییر DOM همراه است؛
      // بنابراین بدون صبر کردن تا تیک بعدی، وضعیت نشانگر را همگام می‌کنیم.
      if (window.location.href !== this.lastUrl) {
        this.checkUrlChange();
      }

      let shouldScan = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
        if (m.type === "characterData") {
          const parent = m.target.parentElement;
          // تایپ در کادر پیام نباید باعث اسکن کل پیام‌ها شود
          if (parent && parent.closest('[contenteditable="true"]')) continue;
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) {
        this.scanAllMessages();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  scanAllMessages() {
    // در صفحه جستجو/تنظیمات، متن نتایج جستجو یا پیش‌نمایش‌ها پیام چت نیستند.
    if (this.adapter.isNonChatView?.()) return;

    const elements = this.adapter.getMessageElements();

    for (const el of elements) {
      const text = el.textContent || "";

      if (text.includes(CONSTANTS.PREFIXES.KEY_EXCHANGE)) {
        if (el.dataset.baleEncKeyProcessed !== text) {
          el.dataset.baleEncKeyProcessed = text;
          this.handleKeyExchange(text, el).catch((err) =>
            console.warn("[Bale E2EE] key exchange error:", err)
          );
        }
        continue;
      }

      MessageDecorator.processElement(el, this.currentChatConfig).catch((err) =>
        console.warn("[Bale E2EE] message decorate error:", err)
      );
    }
  }

  // ---------------------------------------------------------------------------
  // رهگیری ارسال
  // ---------------------------------------------------------------------------

  setupSendInterceptors() {
    document.addEventListener(
      "keydown",
      async (e) => {
        if (this.isSendingControl || this.isEncryptingAndSending) return;

        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          const inputEl = this.adapter.getInputElement();
          if (!inputEl || !inputEl.contains(e.target)) return;

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

    const mouseEvents = ["pointerdown", "mousedown", "click"];
    mouseEvents.forEach((evtName) => {
      document.addEventListener(
        evtName,
        async (e) => {
          if (this.isSendingControl || this.isEncryptingAndSending) return;

          if (this.adapter.isSendButton(e.target)) {
            const inputEl = this.adapter.getInputElement();
            if (!inputEl) return;

            if (this.shouldIntercept()) {
              const rawText = this.adapter.getInputValue(inputEl);
              if (!rawText) return;

              e.preventDefault();
              e.stopImmediatePropagation();

              if (evtName === "pointerdown" || evtName === "mousedown") {
                await this.handleSendTrigger(inputEl, rawText, e.target);
              }
            }
          }
        },
        true
      );
    });
  }

  shouldIntercept() {
    const config = this.currentChatConfig;
    if (!config || config.enabled === false) return false;

    const mode = this.getMode(config);
    if (mode === "password") return Boolean(config.password);
    if (mode === "rsa") return true;
    return false;
  }

  async handleSendTrigger(inputEl, rawText, clickedTarget) {
    if (this.isEncryptingAndSending) return;

    if (CONSTANTS.hasReservedPrefix(rawText)) {
      ToastUI.show(CONSTANTS.MESSAGES.PREFIX_COLLISION_WARN, "error", 6000);
      return;
    }

    const mode = this.getMode(this.currentChatConfig);

    if (mode === "rsa" && !this.currentChatConfig.peerPublicKey) {
      ToastUI.show(CONSTANTS.MESSAGES.SEND_BLOCKED_NO_PEER, "warning", 8000);
      return;
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
      this.adapter.setInputValue(inputEl, ciphertext);

      await new Promise((resolve) => setTimeout(resolve, 60));

      const btn =
        (clickedTarget &&
          clickedTarget.closest(
            'button, [role="button"], div[class*="send" i]'
          )) ||
        this.adapter.getSendButtonElement();

      if (btn) {
        this.adapter.triggerClick(btn);
      } else {
        this.adapter.triggerEnter(inputEl);
      }

      // ارسال برنامه‌ای به‌صورت همگام انجام شده است؛ قفل را فوراً آزاد می‌کنیم
      // تا پیام بعدی کاربر در همین فاصله به‌صورت خام ارسال نشود.
      this.isEncryptingAndSending = false;
    } catch (err) {
      console.error("[Bale E2EE] Error in handleSendTrigger:", err);
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

      if (
        changes[CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS] ||
        changes[CONSTANTS.STORAGE_KEYS.PENDING_PEERS]
      ) {
        this.syncChatState().catch((err) =>
          console.warn("[Bale E2EE] storage sync failed:", err)
        );
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
          displayName: this.adapter.getActiveChatDisplayName(),
          mode: this.currentChatConfig
            ? this.getMode(this.currentChatConfig)
            : null,
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
                peerFingerprint: this.pendingPeer.peerFingerprint || null
              }
            : null
        });
        return true;
      }

      if (request.action === "retry_handshake") {
        if (!request.uid || request.uid === this.currentChatId) {
          this.ensureRsaHandshake(true)
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
  console.error("[Bale E2EE] initialization failed:", err);
});
