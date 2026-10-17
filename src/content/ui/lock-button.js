import { StorageManager } from '../../shared/storage.js';

export class LockButtonUI {
  static HEADER_BUTTON_ID = "bale-enc-header-lock-btn";
  static COMPOSER_BUTTON_ID = "bale-enc-composer-lock-btn";
  static FLOATING_BUTTON_ID = "bale-enc-floating-lock-btn";

  /**
   * رندر نماد قفل در هدر و نوار چت (کامپوزر)
   */
  static render(headerEl, composerEl, currentChatId, chatConfig, onToggleCallback) {
    // اگر هیچ چتی فعال نیست، تمام دکمهها را پاک کن
    if (!currentChatId) {
      this.removeAllButtons();
      return;
    }

    let renderedAny = false;

    // ۱. رندر در نوار ارسال پیام / کامپوزر چت
    if (composerEl) {
      let composerBtn = document.getElementById(this.COMPOSER_BUTTON_ID);
      if (!composerBtn) {
        composerBtn = document.createElement("button");
        composerBtn.id = this.COMPOSER_BUTTON_ID;
        composerBtn.type = "button";
        // تلاش برای قرار دادن قبل از دکمه ارسال یا به عنوان اولین/آخرین فرزند کامپوزر
        composerEl.insertBefore(composerBtn, composerEl.firstChild);
      }
      this.updateButtonState(composerBtn, currentChatId, chatConfig, onToggleCallback);
      renderedAny = true;
    } else {
      const existing = document.getElementById(this.COMPOSER_BUTTON_ID);
      if (existing) existing.remove();
    }

    // ۲. رندر در هدر چت
    if (headerEl) {
      let headerBtn = document.getElementById(this.HEADER_BUTTON_ID);
      if (!headerBtn) {
        headerBtn = document.createElement("button");
        headerBtn.id = this.HEADER_BUTTON_ID;
        headerBtn.type = "button";
        headerEl.appendChild(headerBtn);
      }
      this.updateButtonState(headerBtn, currentChatId, chatConfig, onToggleCallback);
      renderedAny = true;
    } else {
      const existing = document.getElementById(this.HEADER_BUTTON_ID);
      if (existing) existing.remove();
    }

    // ۳. در صورتی که ساختار DOM المان هدر یا کامپوزر را نداد، دکمه شناور در صفحه قرار میدهیم
    let floatingBtn = document.getElementById(this.FLOATING_BUTTON_ID);
    if (!renderedAny) {
      if (!floatingBtn) {
        floatingBtn = document.createElement("button");
        floatingBtn.id = this.FLOATING_BUTTON_ID;
        floatingBtn.type = "button";
        document.body.appendChild(floatingBtn);
      }
      this.updateButtonState(floatingBtn, currentChatId, chatConfig, onToggleCallback);
    } else if (floatingBtn) {
      floatingBtn.remove();
    }
  }

  static updateButtonState(btn, currentChatId, chatConfig, onToggleCallback) {
    if (!btn) return;

    // حالت ۱: چت پیکربندی شده و رمزنگاری فعال است
    if (chatConfig && chatConfig.enabled) {
      btn.className = "bale-enc-lock-btn active";
      btn.innerHTML = `<span>🔒 رمزنگاری فعال</span> <small>(${chatConfig.fingerprint || ""})</small>`;
      btn.title = "رمزنگاری فعال است. کلیک کنید تا موقتاً غیرفعال شود.";
      btn.onclick = async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const newState = await StorageManager.toggleChatEnabled(chatConfig.messenger, chatConfig.uid);
        chatConfig.enabled = newState;
        this.syncAllButtons(currentChatId, chatConfig, onToggleCallback);
        if (onToggleCallback) onToggleCallback(newState);
      };
      return;
    }

    // حالت ۲: چت پیکربندی شده ولی رمزنگاری موقتاً خاموش است
    if (chatConfig && !chatConfig.enabled) {
      btn.className = "bale-enc-lock-btn inactive";
      btn.innerHTML = `<span>🔓 رمزنگاری غیرفعال</span>`;
      btn.title = "رمزنگاری موقتاً غیرفعال است. کلیک کنید تا مجدداً فعال شود.";
      btn.onclick = async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const newState = await StorageManager.toggleChatEnabled(chatConfig.messenger, chatConfig.uid);
        chatConfig.enabled = newState;
        this.syncAllButtons(currentChatId, chatConfig, onToggleCallback);
        if (onToggleCallback) onToggleCallback(newState);
      };
      return;
    }

    // حالت ۳: چت در لیست افزونه ثبت نشده است
    btn.className = "bale-enc-lock-btn unconfigured";
    btn.innerHTML = `<span>🔒 تنظیم رمزنگاری</span> <small>(ID: ${currentChatId})</small>`;
    btn.title = `شناسه این چت: ${currentChatId} — کلیک برای کپی شناسه و راهنمای ثبت`;
    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        navigator.clipboard.writeText(String(currentChatId));
        alert(
          `شناسه چت (${currentChatId}) در کلیپبورد کپی شد.\n\nاکنون روی آیکون افزونه در بالای مرورگر کلیک کرده و در تب «افزودن چت»، پسورد یا کلید مشترک را ثبت نمایید.`
        );
      } catch {
        alert(
          `شناسه چت جاری: ${currentChatId}\nلطفاً این شناسه را در افزونه ثبت کنید.`
        );
      }
    };
  }

  static syncAllButtons(currentChatId, chatConfig, onToggleCallback) {
    [this.HEADER_BUTTON_ID, this.COMPOSER_BUTTON_ID, this.FLOATING_BUTTON_ID].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        this.updateButtonState(el, currentChatId, chatConfig, onToggleCallback);
      }
    });
  }

  static removeAllButtons() {
    [this.HEADER_BUTTON_ID, this.COMPOSER_BUTTON_ID, this.FLOATING_BUTTON_ID].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }
}
