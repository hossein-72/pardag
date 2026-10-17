export class LockButtonUI {
  static SETTINGS_BUTTON_ID = "bale-enc-chat-settings-btn";

  /**
   * رندر تنها یک دکمه تمیز «تنظیم رمزنگاری» در نوار ارسال پیام (کامپوزر چت)
   */
  static render(composerEl, currentChatId, chatConfig) {
    // در صورت عدم شناسایی چت یا عدم حضور کامپوزر، دکمه را حذف کن
    if (!currentChatId || !composerEl) {
      const existing = document.getElementById(this.SETTINGS_BUTTON_ID);
      if (existing) existing.remove();
      return;
    }

    let btn = document.getElementById(this.SETTINGS_BUTTON_ID);
    if (!btn) {
      btn = document.createElement("button");
      btn.id = this.SETTINGS_BUTTON_ID;
      btn.type = "button";
      // قرار دادن دکمه در ابتدای نوار چت تا مزاحم تایپ یا دکمه ارسال نشود
      composerEl.insertBefore(btn, composerEl.firstChild);
    }

    this.updateButtonState(btn, currentChatId, chatConfig);
  }

  static updateButtonState(btn, currentChatId, chatConfig) {
    if (!btn) return;

    if (chatConfig && chatConfig.enabled) {
      btn.className = "active";
      btn.innerHTML = `<span>🔒 تنظیم رمزنگاری</span> <small>(${chatConfig.fingerprint || ""})</small>`;
      btn.title = "رمزنگاری فعال است. کلیک کنید تا تنظیمات این چت در افزونه باز شود.";
    } else if (chatConfig && !chatConfig.enabled) {
      btn.className = "inactive";
      btn.innerHTML = `<span>🔓 تنظیم رمزنگاری</span>`;
      btn.title = "رمزنگاری موقتاً خاموش است. کلیک کنید تا در افزونه فعال شود.";
    } else {
      btn.className = "unconfigured";
      btn.innerHTML = `<span>🔒 تنظیم رمزنگاری</span> <small>(ID: ${currentChatId})</small>`;
      btn.title = `شناسه این چت: ${currentChatId} — کلیک کنید تا صفحه افزونه باز شده و تنظیم شود.`;
    }

    // با کلیک روی دکمه، صفحه اکستنشن باز شده و اطلاعات چت لود می‌شود
    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        chrome.runtime.sendMessage({
          action: "open_popup",
          uid: currentChatId
        });
      } catch (err) {
        console.error("[Bale E2EE] Error opening popup:", err);
      }
    };
  }

  static removeAllButtons() {
    const el = document.getElementById(this.SETTINGS_BUTTON_ID);
    if (el) el.remove();
  }
}
