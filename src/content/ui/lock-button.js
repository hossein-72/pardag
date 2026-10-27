import { StorageManager } from '../../shared/storage.js';

export class LockButtonUI {
  static FLOATING_BUTTON_ID = "bale-enc-floating-lock-btn";
  static SETTINGS_BUTTON_ID = "bale-enc-chat-settings-btn";

  /**
   * رندر نشانگر وضعیت در گوشه صفحه و دکمه تنظیم در نوار چت.
   *
   * @param {Element|null} composerEl
   * @param {string|null} currentChatId
   * @param {object|null} chatConfig
   * @param {object|null} pendingPeer
   * @param {object} adapter
   * @param {object} callbacks - { onToggle, onEnableRsa, onOpenPopup, onRetryHandshake }
   */
  static render(composerEl, currentChatId, chatConfig, pendingPeer, adapter, callbacks = {}) {
    if (!currentChatId || !document.body) {
      this.removeAllButtons();
      return;
    }

    const cornerBadge = this.ensureCornerBadge();
    this.updateCornerBadge(
      cornerBadge,
      currentChatId,
      chatConfig,
      pendingPeer,
      adapter,
      callbacks
    );

    if (composerEl) {
      const settingsBtn = this.ensureSettingsBtn(composerEl);
      this.updateSettingsBtn(
        settingsBtn,
        currentChatId,
        chatConfig,
        pendingPeer,
        adapter,
        callbacks
      );
    }
  }

  static ensureCornerBadge() {
    let badge = document.getElementById(this.FLOATING_BUTTON_ID);
    if (!badge) {
      badge = document.createElement("button");
      badge.id = this.FLOATING_BUTTON_ID;
      badge.type = "button";
      document.body.appendChild(badge);
    }
    return badge;
  }

  static ensureSettingsBtn(composerEl) {
    let btn = document.getElementById(this.SETTINGS_BUTTON_ID);
    if (!btn) {
      btn = document.createElement("button");
      btn.id = this.SETTINGS_BUTTON_ID;
      btn.type = "button";
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

  static safeId(value) {
    return String(value || "").replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 48);
  }

  static safeHex(value) {
    return String(value || "")
      .replace(/[^0-9A-Fa-f]/g, "")
      .slice(0, 16)
      .toUpperCase();
  }

  static updateCornerBadge(btn, chatId, chatConfig, pendingPeer, adapter, callbacks = {}) {
    if (!btn) return;

    const mode = this.getMode(chatConfig);
    const isRsa = mode === "rsa";
    const hasConfig = Boolean(chatConfig);
    const hasPeerKey = Boolean(chatConfig && chatConfig.peerPublicKey);
    const enabled = Boolean(chatConfig && chatConfig.enabled !== false);
    const pending = Boolean(pendingPeer);
    const safeChatId = this.safeId(chatId);

    // ۱. چت هنوز در افزونه ثبت نشده
    if (!hasConfig) {
      if (pending) {
        btn.className = "bale-enc-lock-btn pending";
        btn.innerHTML = `<span>🔐 درخواست رمزنگاری خودکار</span> <small>کلیک کنید</small>`;
        btn.title =
          "مخاطب شما رمزنگاری خودکار را فعال کرده است. برای فعال‌سازی روی این نشانگر کلیک کنید.";
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          callbacks.onEnableRsa?.();
        };
      } else {
        btn.className = "bale-enc-lock-btn unconfigured";
        btn.innerHTML = `<span>🔒 چت رمزنگاری‌نشده</span> <small>(ID: ${safeChatId})</small>`;
        btn.title = `شناسه این چت: ${safeChatId} — کلیک کنید تا در افزونه تنظیم شود.`;
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          callbacks.onOpenPopup?.("add-chat");
        };
      }
      return;
    }

    // ۲. چت با پسورد مشترک ثبت شده ولی مخاطب درخواست حالت خودکار داده است
    if (!isRsa && pending) {
      btn.className = "bale-enc-lock-btn pending";
      btn.innerHTML = `<span>🔐 مخاطب رمزنگاری خودکار را فعال کرده</span> <small>تغییر روش</small>`;
      btn.title =
        "برای ادامه گفتگو، روش رمزنگاری این چت را به «تبادل خودکار کلید» تغییر دهید.";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        callbacks.onOpenPopup?.("add-chat");
      };
      return;
    }

    // ۳. حالت پسورد مشترک (رفتار قبلی)
    if (!isRsa) {
      if (enabled) {
        btn.className = "bale-enc-lock-btn active";
        btn.innerHTML = `<span>🔒 این صفحه چت رمزنگاری شده است</span> <small>(${this.safeHex(
          chatConfig.fingerprint
        )})</small>`;
        btn.title = "رمزنگاری با پسورد مشترک فعال است. کلیک کنید تا موقتاً غیرفعال شود.";
      } else {
        btn.className = "bale-enc-lock-btn inactive";
        btn.innerHTML = `<span>🔓 رمزنگاری در این چت غیرفعال است</span>`;
        btn.title = "رمزنگاری موقتاً خاموش است. کلیک کنید تا فعال شود.";
      }
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggle(btn, chatConfig, chatId, pendingPeer, adapter, callbacks);
      };
      return;
    }

    // ۴. حالت تبادل خودکار کلید
    if (!enabled) {
      btn.className = "bale-enc-lock-btn inactive";
      btn.innerHTML = `<span>🔓 رمزنگاری خودکار غیرفعال است</span>`;
      btn.title = "برای فعال‌سازی مجدد رمزنگاری خودکار کلیک کنید.";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggle(btn, chatConfig, chatId, pendingPeer, adapter, callbacks);
      };
      return;
    }

    if (!hasPeerKey) {
      btn.className = "bale-enc-lock-btn waiting";
      btn.innerHTML = `<span>⏳ در حال تبادل کلید امنیتی...</span>`;
      btn.title =
        "کلید مخاطب هنوز دریافت نشده است. مطمئن شوید مخاطب افزونه را نصب کرده و این چت را باز کرده است. برای تلاش مجدد کلیک کنید.";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        callbacks.onRetryHandshake?.();
      };
      return;
    }

    if (chatConfig.keyChanged) {
      btn.className = "bale-enc-lock-btn key-change";
      btn.innerHTML = `<span>⚠️ کلید مخاطب تغییر کرده</span> <small>بررسی کنید</small>`;
      btn.title =
        "کلید امنیتی مخاطب تغییر کرده است. برای بررسی و تأیید کد امنیتی جدید کلیک کنید.";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        callbacks.onOpenPopup?.("chats-list");
      };
      return;
    }

    if (chatConfig.verified) {
      btn.className = "bale-enc-lock-btn verified";
      btn.innerHTML = `<span>🔒 رمزنگاری خودکار فعال</span> <small>✅ تأیید شده</small>`;
      btn.title =
        "رمزنگاری خودکار فعال است و کد امنیتی تأیید شده است. برای مدیریت کلیک کنید.";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        callbacks.onOpenPopup?.("chats-list");
      };
      return;
    }

    btn.className = "bale-enc-lock-btn active";
    btn.innerHTML = `<span>🔒 رمزنگاری خودکار فعال</span> <small>(${this.safeHex(
      chatConfig.peerFingerprint || chatConfig.fingerprint
    )})</small>`;
    btn.title =
      "رمزنگاری خودکار فعال است. برای مشاهده و تأیید کد امنیتی کلیک کنید.";
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      callbacks.onOpenPopup?.("chats-list");
    };
  }

  static updateSettingsBtn(btn, chatId, chatConfig, pendingPeer, adapter, callbacks = {}) {
    if (!btn) return;

    const mode = this.getMode(chatConfig);
    const isRsa = mode === "rsa";
    const hasPeerKey = Boolean(chatConfig && chatConfig.peerPublicKey);
    const enabled = Boolean(chatConfig && chatConfig.enabled !== false);
    const pending = Boolean(pendingPeer);

    let className = "unconfigured";
    let label = "🔒 تنظیم رمزنگاری";
    let popupTab = "add-chat";

    if (!chatConfig) {
      className = pending ? "pending" : "unconfigured";
      label = pending ? "🔐 فعال‌سازی رمزنگاری" : "🔒 تنظیم رمزنگاری";
    } else if (!isRsa) {
      className = pending ? "pending" : enabled ? "active" : "inactive";
      label = pending
        ? "🔐 تغییر به رمزنگاری خودکار"
        : enabled
        ? "🔒 تنظیم رمزنگاری"
        : "🔓 تنظیم رمزنگاری";
    } else {
      popupTab = "chats-list";
      if (!enabled) {
        className = "inactive";
        label = "🔓 رمزنگاری خودکار";
      } else if (!hasPeerKey) {
        className = "waiting";
        label = "⏳ در انتظار کلید";
      } else if (chatConfig.keyChanged) {
        className = "key-change";
        label = "⚠️ بررسی کلید";
      } else if (chatConfig.verified) {
        className = "active";
        label = "🔐 رمزنگاری تأیید‌شده";
      } else {
        className = "active";
        label = "🔐 رمزنگاری خودکار";
      }
    }

    btn.className = className;
    btn.innerHTML = `<span>${label}</span>`;

    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!chatConfig && pending) {
        callbacks.onEnableRsa?.();
      } else {
        callbacks.onOpenPopup?.(popupTab);
      }
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
    const badge = document.getElementById(this.FLOATING_BUTTON_ID);
    if (badge) badge.remove();
    const settingsBtn = document.getElementById(this.SETTINGS_BUTTON_ID);
    if (settingsBtn) settingsBtn.remove();
  }
}
