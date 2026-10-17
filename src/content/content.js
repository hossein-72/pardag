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

    const headerEl = this.adapter.getHeaderElement();
    const composerEl = this.adapter.getComposerElement();

    LockButtonUI.render(headerEl, composerEl, this.currentChatId, this.currentChatConfig, (newState) => {
      if (this.currentChatConfig) {
        this.currentChatConfig.enabled = newState;
      }
    });

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

    // بررسی دورهای و MutationObserver برای تغییرات PushState در React Router
    setInterval(() => {
      checkUrlChange();

      // اطمینان از حضور دکمه قفل در صورت Re-render شدن نوار چت یا هدر توسط بله
      const hasComposerBtn = document.getElementById(LockButtonUI.COMPOSER_BUTTON_ID);
      const hasHeaderBtn = document.getElementById(LockButtonUI.HEADER_BUTTON_ID);
      const hasFloatingBtn = document.getElementById(LockButtonUI.FLOATING_BUTTON_ID);

      if (this.currentChatId && !hasComposerBtn && !hasHeaderBtn && !hasFloatingBtn) {
        const headerEl = this.adapter.getHeaderElement();
        const composerEl = this.adapter.getComposerElement();
        LockButtonUI.render(headerEl, composerEl, this.currentChatId, this.currentChatConfig, (newState) => {
          if (this.currentChatConfig) {
            this.currentChatConfig.enabled = newState;
          }
        });
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
      if (el.textContent && el.textContent.includes(CONSTANTS.PREFIX)) {
        MessageDecorator.processElement(el, this.currentChatConfig);
      }
    }
  }

  /**
   * رهگیری ارسال پیام (کلید Enter و کلیک روی دکمه ارسال/ویرایش) در فاز Capture
   */
  setupSendInterceptors() {
    // ۱. رهگیری کلید Enter روی فیلد ورودی
    document.addEventListener("keydown", async (e) => {
      if (this.isEncryptingAndSending) return;

      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        const inputEl = this.adapter.getInputElement();
        if (!inputEl || !inputEl.contains(e.target)) return;

        if (this.shouldIntercept()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          await this.encryptAndTriggerSend(inputEl, "enter");
        }
      }
    }, true); // Capture phase

    // ۲. رهگیری کلیک روی دکمه Send
    document.addEventListener("click", async (e) => {
      if (this.isEncryptingAndSending) return;

      const sendBtn = this.adapter.getSendButtonElement();
      if (sendBtn && (sendBtn === e.target || sendBtn.contains(e.target))) {
        const inputEl = this.adapter.getInputElement();
        if (inputEl && this.shouldIntercept()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          await this.encryptAndTriggerSend(inputEl, "click", sendBtn);
        }
      }
    }, true); // Capture phase
  }

  shouldIntercept() {
    return Boolean(this.currentChatConfig && this.currentChatConfig.enabled && this.currentChatConfig.password);
  }

  async encryptAndTriggerSend(inputEl, triggerType, sendBtn = null) {
    const rawText = this.adapter.getInputValue(inputEl);
    if (!rawText) return;

    // بررسی برخورد پیشوند (اگر کاربر خودش متنی با BALEENC1: وارد کرده باشد)
    if (rawText.startsWith(CONSTANTS.PREFIX)) {
      alert(CONSTANTS.MESSAGES.PREFIX_COLLISION_WARN);
      return;
    }

    try {
      this.isEncryptingAndSending = true;
      const ciphertext = await CryptoEngine.encrypt(rawText, this.currentChatConfig.password);

      // ذخیره در کش نشست برای نمایش فوری در صفحه خود کاربر
      MessageDecorator.cachePlaintext(ciphertext, rawText);

      // جایگزینی متن در فیلد ورودی
      this.adapter.setInputValue(inputEl, ciphertext);

      // تاخیر کوتاه برای ثبت شدن State در React و سپس ارسال واقعی
      setTimeout(() => {
        if (triggerType === "click" && sendBtn) {
          sendBtn.click();
        } else {
          const btn = this.adapter.getSendButtonElement();
          if (btn) {
            btn.click();
          } else {
            inputEl.dispatchEvent(new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true
            }));
          }
        }
        setTimeout(() => {
          this.isEncryptingAndSending = false;
        }, 50);
      }, 30);
    } catch (err) {
      console.error("[Bale E2EE] Encryption failed:", err);
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
