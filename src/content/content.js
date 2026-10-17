import { BaleAdapter } from './adapters/adapter-bale.js';
import { StorageManager } from '../shared/storage.js';
import { CryptoEngine } from './crypto/crypto.js';
import { CONSTANTS } from '../shared/constants.js';
import { LockButtonUI } from './ui/lock-button.js';
import { MessageDecorator } from './ui/message-decorator.js';

class ContentController {
  constructor(adapter) {
    this.adapter = adapter;
    this.currentChatId = null;
    this.currentChatConfig = null;
    this.isEncryptingAndSending = false;
    this.lastUrl = window.location.href;
  }

  async init() {
    await this.syncChatState();
    this.setupNavigationObservers();
    this.setupMessageObserver();
    this.setupSendInterceptors();
    this.setupStorageListener();
  }

  /**
   * همگامسازی وضعیت چت فعال با تنظیمات ذخیرهشده
   */
  async syncChatState() {
    const uid = this.adapter.getActiveChatId();
    this.currentChatId = uid;

    if (uid) {
      this.currentChatConfig = await StorageManager.getChatConfig(this.adapter.getName(), uid);
    } else {
      this.currentChatConfig = null;
    }

    // رندر تنها یک دکمه تنظیم رمزنگاری در نوار چت (کامپوزر)
    const composerEl = this.adapter.getComposerElement();
    LockButtonUI.render(composerEl, this.currentChatId, this.currentChatConfig);

    this.scanAllMessages();
  }

  /**
   * تشخیص تغییر چت در ساختار SPA (با تغییر URL، هش یا تغییر کامپوننت)
   */
  setupNavigationObservers() {
    const checkUrlChange = () => {
      const currentUid = this.adapter.getActiveChatId();
      if (window.location.href !== this.lastUrl || currentUid !== this.currentChatId) {
        this.lastUrl = window.location.href;
        this.syncChatState();
      }
    };

    window.addEventListener("popstate", checkUrlChange);
    window.addEventListener("hashchange", checkUrlChange);

    // بررسی دورهای برای حفظ دکمه تنظیم در صورت Re-render کامپوزر
    setInterval(() => {
      checkUrlChange();

      const hasBtn = document.getElementById(LockButtonUI.SETTINGS_BUTTON_ID);
      if (this.currentChatId && !hasBtn) {
        const composerEl = this.adapter.getComposerElement();
        if (composerEl) {
          LockButtonUI.render(composerEl, this.currentChatId, this.currentChatConfig);
        }
      }
    }, 600);
  }

  /**
   * رصد پیامهای ورودی، خروجی و ویرایششده در DOM
   */
  setupMessageObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0 || m.type === "characterData") {
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
    const elements = this.adapter.getMessageElements();
    for (const el of elements) {
      MessageDecorator.processElement(el, this.currentChatConfig);
    }
  }

  /**
   * رهگیری ارسال پیام (کلید Enter و کلیک موس روی دکمه ارسال) در فاز Capture
   */
  setupSendInterceptors() {
    // ۱. رهگیری کلید Enter روی فیلد ورودی پیام
    document.addEventListener("keydown", async (e) => {
      if (this.isEncryptingAndSending) return;

      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        const inputEl = this.adapter.getInputElement();
        if (!inputEl || !inputEl.contains(e.target)) return;

        if (this.shouldIntercept()) {
          const rawText = this.adapter.getInputValue(inputEl);
          if (!rawText) return;

          e.preventDefault();
          e.stopImmediatePropagation();
          await this.encryptAndTriggerSend(inputEl, rawText, null);
        }
      }
    }, true); // Capture phase

    // ۲. رهگیری کلیک موس روی دکمه ارسال پیام
    document.addEventListener("click", async (e) => {
      if (this.isEncryptingAndSending) return;

      // بررسی اینکه آیا المان کلیک‌شده دکمه ارسال است یا خیر
      const isSendBtn = this.adapter.isSendButton(e.target);
      if (isSendBtn) {
        const inputEl = this.adapter.getInputElement();
        if (!inputEl) return;

        if (this.shouldIntercept()) {
          const rawText = this.adapter.getInputValue(inputEl);
          if (!rawText) return;

          e.preventDefault();
          e.stopImmediatePropagation();

          const clickedBtn = e.target.closest('button, [role="button"]');
          await this.encryptAndTriggerSend(inputEl, rawText, clickedBtn);
        }
      }
    }, true); // Capture phase
  }

  shouldIntercept() {
    return Boolean(this.currentChatConfig && this.currentChatConfig.enabled && this.currentChatConfig.password);
  }

  async encryptAndTriggerSend(inputEl, rawText, sendBtn) {
    // اگر متن تصادفاً قبلاً رمز شده بود
    if (rawText.startsWith(CONSTANTS.PREFIX)) {
      alert(CONSTANTS.MESSAGES.PREFIX_COLLISION_WARN);
      return;
    }

    try {
      this.isEncryptingAndSending = true;
      const ciphertext = await CryptoEngine.encrypt(rawText, this.currentChatConfig.password);

      // ذخیره در کش نشست برای نمایش فوری در صفحه خود فرستنده
      MessageDecorator.cachePlaintext(ciphertext, rawText);

      // جایگزینی متن ورودی با پیام رمزنگاری‌شده
      this.adapter.setInputValue(inputEl, ciphertext);

      // تأخیر ۵۰ میلی‌ثانیه‌ای برای ثبت شدن State در React بله
      await new Promise(r => setTimeout(r, 50));

      const btn = sendBtn || this.adapter.getSendButtonElement();
      if (btn) {
        btn.click();
      } else {
        inputEl.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        }));
      }

      // اطمینان از پاکسازی فیلد ورودی تا متن رمزشده در جعبه پیام باقی نماند
      setTimeout(() => {
        const currentVal = this.adapter.getInputValue(inputEl);
        if (currentVal === ciphertext) {
          this.adapter.setInputValue(inputEl, "");
        }
        this.isEncryptingAndSending = false;
      }, 150);
    } catch (err) {
      console.error("[Bale E2EE] Encryption or send failed:", err);
      this.isEncryptingAndSending = false;
    }
  }

  setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS]) {
        this.syncChatState();
      }
    });
  }
}

const controller = new ContentController(new BaleAdapter());
controller.init();
