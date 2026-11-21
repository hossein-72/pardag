import { StorageManager } from '../../shared/storage.js';
import { CONSTANTS } from '../../shared/constants.js';

export class LockButtonUI {
  static FLOATING_BUTTON_ID = "bale-enc-floating-lock-btn";
  static SETTINGS_BUTTON_ID = "bale-enc-chat-settings-btn";
  static START_HANDSHAKE_BUTTON_ID = "bale-enc-start-handshake-btn";
  static CONSENT_PROMPT_ID = "bale-enc-consent-prompt";
  static COMPOSER_LOCK_ID = "bale-enc-composer-lock-overlay";
  static MODAL_BACKDROP_ID = "bale-enc-key-request-modal-backdrop";
  static MODAL_ID = "bale-enc-key-request-modal";
  static _modalTimer = null;

  /**
   * رندر نشانگر کوچک کنج صفحه (در چت‌های خصوصی و گروه، و نه در کانال و ربات)،
   * چیپ وضعیت در کامپوزر و پنجره پاپ‌آپ تایید تبادل کلید.
   */
  static render(composerEl, currentChatId, chatConfig, pendingPeer, adapter, callbacks = {}) {
    const chatType = callbacks.chatType || adapter?.getChatType?.() || "private";
    if (!currentChatId || !document.body || chatType === "channel" || chatType === "bot" || chatType === "none") {
      this.removeAllButtons();
      return;
    }

    const oldStart = document.getElementById(this.START_HANDSHAKE_BUTTON_ID);
    if (oldStart) oldStart.remove();

    const isGroup = chatType === "group";
    const enrichedCallbacks = { ...callbacks, isGroup, chatType };

    // بازگردانی نشانگر کوچک کنج صفحه برای پیشنهاد/مدیریت یک‌کلیکی رمزنگاری در چت‌های غیرکانال
    const cornerBadge = this.ensureCornerBadge();
    this.updateCornerBadge(
      cornerBadge,
      currentChatId,
      chatConfig,
      pendingPeer,
      adapter,
      enrichedCallbacks
    );

    if (isGroup) {
      this.closeKeyExchangeModal();
    } else {
      this.renderKeyExchangeModal(
        currentChatId,
        chatConfig,
        pendingPeer,
        adapter,
        enrichedCallbacks
      );
    }

    if (composerEl) {
      const settingsBtn = this.ensureSettingsBtn(composerEl);
      this.updateSettingsBtn(
        settingsBtn,
        currentChatId,
        chatConfig,
        pendingPeer,
        adapter,
        enrichedCallbacks
      );

      if (isGroup) {
        const consentEl = document.getElementById(this.CONSENT_PROMPT_ID);
        if (consentEl) consentEl.remove();
      } else {
        this.renderConsentPrompt(
          composerEl,
          currentChatId,
          chatConfig,
          pendingPeer,
          adapter,
          enrichedCallbacks
        );
      }
    }
  }

  static ensureCornerBadge() {
    let badge = document.getElementById(this.FLOATING_BUTTON_ID);
    if (!badge) {
      badge = document.createElement("button");
      badge.id = this.FLOATING_BUTTON_ID;
      badge.type = "button";
      badge.dataset.baleEncUi = "1";
      document.body.appendChild(badge);
    }
    return badge;
  }

  static updateCornerBadge(btn, chatId, chatConfig, pendingPeer, adapter, callbacks = {}) {
    if (!btn) return;

    const isGroup = Boolean(callbacks.isGroup);
    const mode = this.getMode(chatConfig);
    const isRsa = mode === "rsa";
    const hasConfig = Boolean(chatConfig);
    const enabled = Boolean(chatConfig && chatConfig.enabled !== false);
    const pending = Boolean(pendingPeer || (chatConfig && chatConfig.pendingCandidate));
    const hsState = this.getHandshakeState(chatConfig, pendingPeer);

    if (!hasConfig) {
      if (!isGroup && pendingPeer) {
        const fp = this.safeHex(pendingPeer.peerFingerprint);
        btn.className = "bale-enc-lock-btn pending";
        btn.innerHTML = `<span>🔐 درخواست تبادل کلید (${fp})</span> <small>پاسخ</small>`;
        btn.title = "کاربر مقابل قصد تبادل کلید دارد. کلیک کنید تا پنجره تایید باز شود.";
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.renderKeyExchangeModal(chatId, chatConfig, pendingPeer, adapter, callbacks);
        };
      } else if (isGroup) {
        btn.className = "bale-enc-lock-btn unconfigured";
        btn.innerHTML = `<span>🔑 رمزنگاری گروه با کلید مشترک</span>`;
        btn.title = "برای فعال‌سازی رمزنگاری گروه با کلید مشترک کلیک کنید.";
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          callbacks.onOpenPopup?.("add-chat");
        };
      } else {
        btn.className = "bale-enc-lock-btn unconfigured";
        btn.innerHTML = `<span>🔑 رمزنگاری این چت را فعال کنید</span>`;
        btn.title = "کلیک کنید تا فرایند تبادل کلید با یک کلیک آغاز شود.";
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (callbacks.onStartHandshake) {
            callbacks.onStartHandshake();
          } else {
            callbacks.onOpenPopup?.("add-chat");
          }
        };
      }
      return;
    }

    if (!isRsa) {
      if (enabled) {
        btn.className = "bale-enc-lock-btn active";
        btn.innerHTML = `<span>🔒 رمزنگاری با کلید مشترک فعال است</span>`;
        btn.title = "کلیک کنید تا موقتاً غیرفعال شود.";
      } else {
        btn.className = "bale-enc-lock-btn inactive";
        btn.innerHTML = `<span>🔓 رمزنگاری غیرفعال است</span>`;
        btn.title = "کلیک کنید تا فعال شود.";
      }
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggle(btn, chatConfig, chatId, pendingPeer, adapter, callbacks);
      };
      return;
    }

    if (!enabled) {
      btn.className = "bale-enc-lock-btn inactive";
      btn.innerHTML = `<span>🔓 رمزنگاری غیرفعال است</span>`;
      btn.title = "کلیک کنید تا دوباره فعال شود.";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggle(btn, chatConfig, chatId, pendingPeer, adapter, callbacks);
      };
      return;
    }

    if (hsState === CONSTANTS.HANDSHAKE_STATES.EXPIRED) {
      btn.className = "bale-enc-lock-btn inactive";
      btn.innerHTML = `<span>⌛ درخواست کلید منقضی شد</span> <small>تلاش مجدد</small>`;
      btn.title = "کلیک کنید تا درخواست تبادل کلید جدید ارسال شود.";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        callbacks.onStartHandshake?.();
      };
      return;
    }

    if (
      hsState === CONSTANTS.HANDSHAKE_STATES.PENDING_APPROVAL ||
      hsState === CONSTANTS.HANDSHAKE_STATES.KEY_CHANGED ||
      chatConfig.keyChanged
    ) {
      btn.className = "bale-enc-lock-btn pending";
      btn.innerHTML = `<span>🔐 درخواست تبادل کلید دریافت شد</span> <small>مشاهده</small>`;
      btn.title = "کلیک کنید تا پنجره پاپ‌آپ تایید باز شود.";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.renderKeyExchangeModal(chatId, chatConfig, pendingPeer, adapter, callbacks);
      };
      return;
    }

    if (hsState === CONSTANTS.HANDSHAKE_STATES.AWAITING_ACK || !chatConfig.peerPublicKey) {
      btn.className = "bale-enc-lock-btn waiting";
      btn.innerHTML = `<span>⏳ منتظر تایید مخاطب...</span> <small>لغو</small>`;
      btn.title = "کلیک کنید تا درخواست تبادل کلید لغو (باطل) شود و بتوانید پیام ارسال کنید.";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        callbacks.onCancelHandshake?.();
      };
      return;
    }

    btn.className = chatConfig.verified ? "bale-enc-lock-btn verified" : "bale-enc-lock-btn active";
    btn.innerHTML = chatConfig.verified
      ? `<span>🔒 چت رمزنگاری و تأیید شده است</span>`
      : `<span>🔒 چت رمزنگاری شده است</span>`;
    btn.title = "برای مدیریت تنظیمات و کد امنیتی کلیک کنید.";
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      callbacks.onOpenPopup?.("chats-list");
    };
  }

  static formatRemainingTime(remainingMs) {
    const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  static renderKeyExchangeModal(currentChatId, chatConfig, pendingPeer, adapter, callbacks = {}) {
    const existingBackdrop = document.getElementById(this.MODAL_BACKDROP_ID);
    const mode = this.getMode(chatConfig);
    const isRsa = !chatConfig || mode === "rsa";

    if (!currentChatId || (chatConfig && chatConfig.enabled === false)) {
      this.closeKeyExchangeModal();
      return;
    }

    const hsState = this.getHandshakeState(chatConfig, pendingPeer);
    const candidate = (chatConfig && chatConfig.pendingCandidate) || pendingPeer;

    const isPendingConsent =
      Boolean(candidate && candidate.peerPublicKey) &&
      (!isRsa ||
        hsState === CONSTANTS.HANDSHAKE_STATES.PENDING_APPROVAL ||
        hsState === CONSTANTS.HANDSHAKE_STATES.KEY_CHANGED ||
        Boolean(chatConfig && chatConfig.keyChanged) ||
        Boolean(!chatConfig && pendingPeer));

    if (!isPendingConsent) {
      this.closeKeyExchangeModal();
      return;
    }

    const now = Date.now();
    const rawTs = Number(candidate.peerKeyTimestamp) || now;
    const effectiveStartTs = rawTs > now ? (Number(candidate.receivedAt) || now) : rawTs;
    const ttlMs = Number(callbacks.ttlMs) > 0 ? Number(callbacks.ttlMs) : CONSTANTS.KEY_EXCHANGE_TTL_MS;
    const expiresAt = effectiveStartTs + ttlMs;
    const remainingMs = expiresAt - now;

    if (remainingMs <= 0) {
      this.closeKeyExchangeModal();
      callbacks.onExpireHandshake?.(candidate);
      return;
    }

    const requesterName =
      (candidate.displayName && candidate.displayName.trim()) ||
      (chatConfig && chatConfig.displayName && chatConfig.displayName.trim()) ||
      adapter?.getActiveChatDisplayName?.() ||
      `شناسه ${this.safeId(currentChatId)}`;

    const fp = this.safeHex(candidate.peerFingerprint || chatConfig?.peerFingerprint);
    const sessionKey = `${currentChatId}:${fp}:${candidate.sessionId || ""}`;

    if (existingBackdrop && existingBackdrop.dataset.sessionKey === sessionKey) {
      const timerEl = existingBackdrop.querySelector(".bale-enc-modal-timer-val");
      if (timerEl) {
        timerEl.textContent = this.formatRemainingTime(remainingMs);
      }
      return;
    }

    this.closeKeyExchangeModal();

    const backdrop = document.createElement("div");
    backdrop.id = this.MODAL_BACKDROP_ID;
    backdrop.dataset.baleEncUi = "1";
    backdrop.dataset.sessionKey = sessionKey;
    backdrop.style.cssText =
      "position:fixed !important; inset:0 !important; background:rgba(15,23,42,0.62) !important; " +
      "backdrop-filter:blur(3px) !important; display:flex !important; align-items:center !important; " +
      "justify-content:center !important; z-index:2147483647 !important; padding:16px !important; direction:rtl !important;";

    const modal = document.createElement("div");
    modal.id = this.MODAL_ID;
    modal.dataset.baleEncUi = "1";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.style.cssText =
      "width:min(440px,100%) !important; background:#ffffff !important; border-radius:16px !important; " +
      "border:1px solid #cbd5e1 !important; box-shadow:0 20px 50px rgba(15,23,42,0.35) !important; " +
      "padding:20px !important; font-family:'Vazirmatn','Vazir',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif !important; " +
      "color:#0f172a !important; text-align:right !important; direction:rtl !important;";

    const header = document.createElement("div");
    header.className = "bale-enc-modal-header";
    header.style.cssText =
      "display:flex; align-items:center; gap:10px; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #e2e8f0;";

    const iconSpan = document.createElement("span");
    iconSpan.className = "bale-enc-modal-icon";
    iconSpan.textContent = "🔐";
    iconSpan.style.fontSize = "24px";

    const titleEl = document.createElement("h3");
    titleEl.className = "bale-enc-modal-title";
    titleEl.textContent = "درخواست تبادل کلید امنیتی";
    titleEl.style.cssText = "font-size:15px; font-weight:800; color:#1e3a8a; margin:0;";

    header.appendChild(iconSpan);
    header.appendChild(titleEl);

    const body = document.createElement("div");
    body.className = "bale-enc-modal-body";
    body.style.cssText = "display:flex; flex-direction:column; gap:12px; margin-bottom:16px;";

    const promptParagraph = document.createElement("p");
    promptParagraph.className = "bale-enc-modal-question";
    promptParagraph.textContent = `کاربر «${requesterName}» قصد تبادل کلید دارد. آیا می‌خواهید کلید خود را با این کاربر به اشتراک بگذارید؟`;
    promptParagraph.style.cssText =
      "font-size:13.5px; font-weight:700; line-height:1.7; color:#0f172a; margin:0;";

    const metaBox = document.createElement("div");
    metaBox.className = "bale-enc-modal-meta";
    metaBox.style.cssText =
      "background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:6px; font-size:12px;";

    const userRow = document.createElement("div");
    userRow.className = "bale-enc-modal-meta-row";
    userRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:8px; color:#475569;";
    userRow.innerHTML = `<span>کاربر درخواست‌دهنده:</span> <strong style="color:#0f172a;"></strong>`;
    userRow.querySelector("strong").textContent = requesterName;

    const fpRow = document.createElement("div");
    fpRow.className = "bale-enc-modal-meta-row";
    fpRow.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:8px; color:#475569;";
    fpRow.innerHTML = `<span>اثرانگشت کلید:</span> <code style="background:#eff6ff; color:#1d4ed8; padding:2px 6px; border-radius:5px; font-family:monospace; font-weight:700;">${fp || "---"}</code>`;

    const timerRow = document.createElement("div");
    timerRow.className = "bale-enc-modal-meta-row timer";
    timerRow.style.cssText =
      "display:flex; align-items:center; justify-content:space-between; gap:8px; padding-top:6px; border-top:1px dashed #cbd5e1; color:#b45309;";
    timerRow.innerHTML = `<span>مهلت پاسخ‌گویی تا پایان خودکار درخواست:</span> <strong class="bale-enc-modal-timer-val" style="color:#d97706; font-family:monospace; font-size:13px;">${this.formatRemainingTime(remainingMs)}</strong>`;

    metaBox.appendChild(userRow);
    metaBox.appendChild(fpRow);
    metaBox.appendChild(timerRow);

    const noteEl = document.createElement("p");
    noteEl.className = "bale-enc-modal-note";
    noteEl.textContent =
      "با تایید شما، کلید عمومی‌تان به اشتراک گذاشته شده و فرایند تبادل کلید به اتمام می‌رسد.";
    noteEl.style.cssText = "font-size:11.5px; line-height:1.6; color:#64748b; margin:0;";

    body.appendChild(promptParagraph);
    body.appendChild(metaBox);
    body.appendChild(noteEl);

    const footer = document.createElement("div");
    footer.className = "bale-enc-modal-actions";
    footer.style.cssText = "display:flex; align-items:center; gap:10px;";

    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.className = "bale-enc-modal-btn accept";
    acceptBtn.textContent = "✅ بله، اشتراک‌گذاری کلید";
    acceptBtn.style.cssText =
      "flex:1; padding:10px 14px; border-radius:10px; font-size:12.5px; font-weight:700; cursor:pointer; background:#10b981; color:#ffffff; border:1px solid #059669;";
    acceptBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.closeKeyExchangeModal();
      if (callbacks.onApprovePeerKey) {
        callbacks.onApprovePeerKey();
      } else {
        callbacks.onEnableRsa?.();
      }
    };

    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "bale-enc-modal-btn reject";
    rejectBtn.textContent = "❌ خیر، رد درخواست";
    rejectBtn.style.cssText =
      "flex:1; padding:10px 14px; border-radius:10px; font-size:12.5px; font-weight:700; cursor:pointer; background:#fef2f2; color:#dc2626; border:1px solid #fca5a5;";
    rejectBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.closeKeyExchangeModal();
      callbacks.onRejectPeerKey?.();
    };

    footer.appendChild(acceptBtn);
    footer.appendChild(rejectBtn);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    this._modalTimer = setInterval(() => {
      const rem = expiresAt - Date.now();
      const valEl = backdrop.querySelector(".bale-enc-modal-timer-val");
      if (rem <= 0) {
        this.closeKeyExchangeModal();
        callbacks.onExpireHandshake?.(candidate);
        return;
      }
      if (valEl) {
        valEl.textContent = this.formatRemainingTime(rem);
      }
    }, 1000);
  }

  static closeKeyExchangeModal() {
    if (this._modalTimer) {
      clearInterval(this._modalTimer);
      this._modalTimer = null;
    }
    const existing = document.getElementById(this.MODAL_BACKDROP_ID);
    if (existing) existing.remove();
  }

  static renderConsentPrompt(composerEl, currentChatId, chatConfig, pendingPeer, adapter, callbacks = {}) {
    const existing = document.getElementById(this.CONSENT_PROMPT_ID);
    if (!composerEl || !currentChatId) {
      if (existing) existing.remove();
      return;
    }

    const mode = this.getMode(chatConfig);
    const isRsa = !chatConfig || mode === "rsa";
    if (!isRsa || (chatConfig && chatConfig.enabled === false)) {
      if (existing) existing.remove();
      return;
    }

    const hsState = this.getHandshakeState(chatConfig, pendingPeer);
    const isWaitingForPeer =
      Boolean(chatConfig) &&
      hsState === CONSTANTS.HANDSHAKE_STATES.AWAITING_ACK &&
      !chatConfig.peerPublicKey;

    if (!isWaitingForPeer) {
      if (existing) existing.remove();
      return;
    }

    let banner = existing;
    if (!banner) {
      banner = document.createElement("div");
      banner.id = this.CONSENT_PROMPT_ID;
      banner.dataset.baleEncUi = "1";
      composerEl.insertBefore(banner, composerEl.firstChild);
    } else if (!composerEl.contains(banner)) {
      composerEl.insertBefore(banner, composerEl.firstChild);
    }

    banner.innerHTML = "";
    banner.className = "waiting";

    const textWrap = document.createElement("div");
    textWrap.className = "bale-enc-consent-text";

    const titleEl = document.createElement("div");
    titleEl.className = "bale-enc-consent-title";
    titleEl.textContent = "⏳ درخواست تبادل کلید ارسال شد؛ منتظر تایید کاربر هدف...";

    const ttlMins = Math.max(1, Math.round((Number(callbacks.ttlMs) || CONSTANTS.KEY_EXCHANGE_TTL_MS) / 60000));
    const subEl = document.createElement("div");
    subEl.className = "bale-enc-consent-subtitle";
    subEl.textContent = `در صورت عدم پاسخ تا ${ttlMins} دقیقه، درخواست پایان می‌یابد. برای ارسال پیام عادی می‌توانید درخواست را لغو کنید.`;

    textWrap.appendChild(titleEl);
    textWrap.appendChild(subEl);

    const actionsWrap = document.createElement("div");
    actionsWrap.className = "bale-enc-consent-actions";

    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "bale-enc-consent-btn secondary";
    retryBtn.textContent = "🔄 ارسال مجدد";
    retryBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      callbacks.onRetryHandshake?.();
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "bale-enc-consent-btn reject";
    cancelBtn.textContent = "❌ لغو تبادل کلید";
    cancelBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      callbacks.onCancelHandshake?.();
    };

    actionsWrap.appendChild(retryBtn);
    actionsWrap.appendChild(cancelBtn);

    banner.appendChild(textWrap);
    banner.appendChild(actionsWrap);
  }

  static renderComposerLock(composerEl, lockInfo = null) {
    const existing = document.getElementById(this.COMPOSER_LOCK_ID);
    if (!lockInfo || !lockInfo.active || !composerEl) {
      if (existing) existing.remove();
      return;
    }

    let overlay = existing;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = this.COMPOSER_LOCK_ID;
      overlay.dataset.baleEncUi = "1";
      composerEl.insertBefore(overlay, composerEl.firstChild);
    } else if (!composerEl.contains(overlay)) {
      composerEl.insertBefore(overlay, composerEl.firstChild);
    }

    const step = Number(lockInfo.step) || 1;
    const total = Number(lockInfo.total) || 3;
    const label = String(lockInfo.label || "در حال ارسال بسته امنیتی تبادل کلید...");

    overlay.innerHTML = "";
    const textSpan = document.createElement("span");
    textSpan.textContent = `🔒 کادر پیام قفل است: ${label}`;
    const pillSpan = document.createElement("span");
    pillSpan.className = "bale-enc-step-pill";
    pillSpan.textContent = `مرحله ${step} از ${total}`;
    overlay.appendChild(textSpan);
    overlay.appendChild(pillSpan);
  }

  static ensureSettingsBtn(composerEl) {
    let btn = document.getElementById(this.SETTINGS_BUTTON_ID);
    if (!btn) {
      btn = document.createElement("button");
      btn.id = this.SETTINGS_BUTTON_ID;
      btn.type = "button";
      btn.dataset.baleEncUi = "1";
      composerEl.insertBefore(btn, composerEl.firstChild);
    } else if (!composerEl.contains(btn)) {
      composerEl.insertBefore(btn, composerEl.firstChild);
    }
    return btn;
  }

  static getMode(config) {
    if (!config) return null;
    return config.mode || (config.password ? "password" : "rsa");
  }

  static getHandshakeState(chatConfig, pendingPeer) {
    if (!chatConfig) {
      return pendingPeer
        ? CONSTANTS.HANDSHAKE_STATES.PENDING_APPROVAL
        : CONSTANTS.HANDSHAKE_STATES.UNCONFIGURED;
    }
    if (chatConfig.handshakeState) {
      return chatConfig.handshakeState;
    }
    if (chatConfig.keyChanged) {
      return CONSTANTS.HANDSHAKE_STATES.KEY_CHANGED;
    }
    if (chatConfig.pendingCandidate && !chatConfig.peerPublicKey) {
      return CONSTANTS.HANDSHAKE_STATES.PENDING_APPROVAL;
    }
    if (chatConfig.peerPublicKey) {
      return CONSTANTS.HANDSHAKE_STATES.ACTIVE;
    }
    if (pendingPeer) {
      return CONSTANTS.HANDSHAKE_STATES.PENDING_APPROVAL;
    }
    return CONSTANTS.HANDSHAKE_STATES.AWAITING_ACK;
  }

  static safeId(value) {
    return String(value || "").replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 48);
  }

  static safeHex(value) {
    return String(value || "")
      .replace(/[^0-9A-Fa-f]/g, "")
      .slice(0, 16)
      .toUpperCase();
  }

  static updateSettingsBtn(btn, chatId, chatConfig, pendingPeer, adapter, callbacks = {}) {
    if (!btn) return;

    const isGroup = Boolean(callbacks.isGroup);
    const mode = this.getMode(chatConfig);
    const isRsa = mode === "rsa";
    const enabled = Boolean(chatConfig && chatConfig.enabled !== false);
    const pending = Boolean(pendingPeer || (chatConfig && chatConfig.pendingCandidate));
    const hsState = this.getHandshakeState(chatConfig, pendingPeer);

    let className = "unconfigured";
    let label = isGroup ? "🔑 کلید مشترک گروه" : "⚙️ تنظیمات رمزنگاری";
    let title = isGroup
      ? "تنظیم کلید مشترک برای رمزنگاری پیام‌های این گروه"
      : "باز کردن تنظیمات رمزنگاری چت";
    let popupTab = "add-chat";

    if (!chatConfig) {
      if (!isGroup && pendingPeer) {
        const fp = this.safeHex(pendingPeer.peerFingerprint);
        className = "pending";
        label = `🔐 درخواست کلید (${fp})`;
        title = "کلیک کنید تا پنجره تایید تبادل کلید باز شود";
      }
    } else if (!isRsa) {
      className = !isGroup && pending ? "pending" : enabled ? "active" : "inactive";
      label =
        !isGroup && pending
          ? "🔐 درخواست کلید"
          : enabled
          ? "🔒 رمزنگاری فعال"
          : "🔓 رمزنگاری خاموش";
      title = enabled
        ? "رمزنگاری با کلید مشترک فعال است"
        : "رمزنگاری موقتاً خاموش است";
    } else {
      popupTab = "chats-list";
      if (!enabled) {
        className = "inactive";
        label = "🔓 رمزنگاری غیرفعال";
      } else if (hsState === CONSTANTS.HANDSHAKE_STATES.EXPIRED) {
        className = "inactive";
        label = "⌛ منقضی شد";
      } else if (
        hsState === CONSTANTS.HANDSHAKE_STATES.KEY_CHANGED ||
        hsState === CONSTANTS.HANDSHAKE_STATES.PENDING_APPROVAL ||
        chatConfig.keyChanged
      ) {
        className = "pending";
        label = "🔐 پاسخ به درخواست کلید";
      } else if (
        hsState === CONSTANTS.HANDSHAKE_STATES.AWAITING_ACK ||
        !chatConfig.peerPublicKey
      ) {
        className = "waiting";
        label = "⏳ منتظر تایید مقصد";
      } else if (chatConfig.verified) {
        className = "active";
        label = "🔒 امن (تأیید‌شده ✅)";
      } else {
        className = "active";
        label = "🔒 رمزنگاری فعال";
      }
    }

    btn.className = className;
    btn.title = title;
    btn.innerHTML = `<span>${label}</span>`;

    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!chatConfig && !isGroup && pendingPeer) {
        this.renderKeyExchangeModal(chatId, chatConfig, pendingPeer, adapter, callbacks);
        return;
      }

      if (
        isRsa &&
        (hsState === CONSTANTS.HANDSHAKE_STATES.PENDING_APPROVAL ||
          hsState === CONSTANTS.HANDSHAKE_STATES.KEY_CHANGED ||
          chatConfig?.keyChanged)
      ) {
        this.renderKeyExchangeModal(chatId, chatConfig, pendingPeer, adapter, callbacks);
        return;
      }

      callbacks.onOpenPopup?.(popupTab);
    };
  }

  static async toggle(btn, chatConfig, chatId, pendingPeer, adapter, callbacks = {}) {
    if (!chatConfig) return;

    const newState = await StorageManager.toggleChatEnabled(
      chatConfig.messenger,
      chatConfig.uid
    );
    chatConfig.enabled = newState;

    if (callbacks.onToggle) {
      callbacks.onToggle(newState);
    } else {
      this.updateCornerBadge(btn, chatId, chatConfig, pendingPeer, adapter, callbacks);
    }
  }

  static removeAllButtons() {
    this.closeKeyExchangeModal();
    const badge = document.getElementById(this.FLOATING_BUTTON_ID);
    if (badge) badge.remove();
    const settingsBtn = document.getElementById(this.SETTINGS_BUTTON_ID);
    if (settingsBtn) settingsBtn.remove();
    const startBtn = document.getElementById(this.START_HANDSHAKE_BUTTON_ID);
    if (startBtn) startBtn.remove();
    const consentPrompt = document.getElementById(this.CONSENT_PROMPT_ID);
    if (consentPrompt) consentPrompt.remove();
    const lockOverlay = document.getElementById(this.COMPOSER_LOCK_ID);
    if (lockOverlay) lockOverlay.remove();
  }
}
