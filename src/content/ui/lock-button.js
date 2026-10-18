import { StorageManager } from '../../shared/storage.js';

export class LockButtonUI {
  static FLOATING_BUTTON_ID = "bale-enc-floating-lock-btn";
  static SETTINGS_BUTTON_ID = "bale-enc-chat-settings-btn";

  /**
   * رندر نشانگر وضعیت در گوشه صفحه و دکمه تنظیم در نوار چت
   */
  static render(composerEl, currentChatId, chatConfig, adapter, onToggleCallback) {
    if (!currentChatId) {
      this.removeAllButtons();
      return;
    }

    // ۱. رندر نشانگر کوچک وضعیت در گوشه صفحه چت (پایین‌تر از نوار پین)
    let cornerBadge = document.getElementById(this.FLOATING_BUTTON_ID);
    if (!cornerBadge) {
      cornerBadge = document.createElement("button");
      cornerBadge.id = this.FLOATING_BUTTON_ID;
      cornerBadge.type = "button";
      document.body.appendChild(cornerBadge);
    }
    this.updateCornerBadge(cornerBadge, currentChatId, chatConfig, adapter, onToggleCallback);

    // ۲. رندر دکمه تنظیم در کامپوزر
    if (composerEl) {
      let settingsBtn = document.getElementById(this.SETTINGS_BUTTON_ID);
      if (!settingsBtn) {
        settingsBtn = document.createElement("button");
        settingsBtn.id = this.SETTINGS_BUTTON_ID;
        settingsBtn.type = "button";
        composerEl.insertBefore(settingsBtn, composerEl.firstChild);
      }
      this.updateSettingsBtn(settingsBtn, currentChatId, chatConfig, adapter);
    }
  }

  static updateCornerBadge(btn, currentChatId, chatConfig, adapter, onToggleCallback) {
    if (!btn) return;

    if (chatConfig && chatConfig.enabled) {
      btn.className = "bale-enc-lock-btn active";
      btn.innerHTML = `<span>🔒 این صفحه چت رمزنگاری شده است</span> <small>(${chatConfig.fingerprint || ""})</small>`;
      btn.title = "رمزنگاری فعال است. کلیک کنید تا موقتاً غیرفعال شود.";
      btn.onclick = async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const newState = await StorageManager.toggleChatEnabled(chatConfig.messenger, chatConfig.uid);
        chatConfig.enabled = newState;
        if (onToggleCallback) onToggleCallback(newState);
        this.updateCornerBadge(btn, currentChatId, chatConfig, adapter, onToggleCallback);
      };
    } else if (chatConfig && !chatConfig.enabled) {
      btn.className = "bale-enc-lock-btn inactive";
      btn.innerHTML = `<span>🔓 رمزنگاری در این چت غیرفعال است</span>`;
      btn.title = "رمزنگاری موقتاً خاموش است. کلیک کنید تا فعال شود.";
      btn.onclick = async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const newState = await StorageManager.toggleChatEnabled(chatConfig.messenger, chatConfig.uid);
        chatConfig.enabled = newState;
        if (onToggleCallback) onToggleCallback(newState);
        this.updateCornerBadge(btn, currentChatId, chatConfig, adapter, onToggleCallback);
      };
    } else {
      btn.className = "bale-enc-lock-btn unconfigured";
      btn.innerHTML = `<span>🔒 چت رمزنگاری‌نشده</span> <small>(ID: ${currentChatId})</small>`;
      btn.title = `شناسه این چت: ${currentChatId} — کلیک کنید تا در افزونه تنظیم شود.`;
      btn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const displayName = adapter ? adapter.getActiveChatDisplayName() : null;
        chrome.runtime.sendMessage({
          action: "open_popup",
          uid: currentChatId,
          displayName: displayName
        });
      };
    }
  }

  static updateSettingsBtn(btn, currentChatId, chatConfig, adapter) {
    if (!btn) return;

    if (chatConfig && chatConfig.enabled) {
      btn.className = "active";
      btn.innerHTML = `<span>🔒 تنظیم رمزنگاری</span>`;
    } else if (chatConfig && !chatConfig.enabled) {
      btn.className = "inactive";
      btn.innerHTML = `<span>🔓 تنظیم رمزنگاری</span>`;
    } else {
      btn.className = "unconfigured";
      btn.innerHTML = `<span>🔒 تنظیم رمزنگاری</span>`;
    }

    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const displayName = adapter ? adapter.getActiveChatDisplayName() : null;
      chrome.runtime.sendMessage({
        action: "open_popup",
        uid: currentChatId,
        displayName: displayName
      });
    };
  }

  static removeAllButtons() {
    const b1 = document.getElementById(this.FLOATING_BUTTON_ID);
    if (b1) b1.remove();
    const b2 = document.getElementById(this.SETTINGS_BUTTON_ID);
    if (b2) b2.remove();
  }
}
