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
    this.setupMessageListener();
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

    const composerEl = this.adapter.getComposerElement();
    LockButtonUI.render(composerEl, this.currentChatId, this.currentChatConfig, this.adapter, (newState) => {
      if (this.currentChatConfig) {
        this.currentChatConfig.enabled = newState;
      }
    });

    this.scanAllMessages();
  }

  /**
   * تشخیص تغییر چت در ساختار SPA
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

    setInterval(() => {
      checkUrlChange();

      // اطمینان از حضور نشانگر وضعیت در گوشه صفحه چت (زیر نوار پین)
      const hasCornerBadge = document.getElementById(LockButtonUI.FLOATING_BUTTON_ID);
      if (this.currentChatId && !hasCornerBadge) {
        const composerEl = this.adapter.getComposerElement();
        LockButtonUI.render(composerEl, this.currentChatId, this.currentChatConfig, this.adapter, (newState) => {
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
          await this.handleSendTrigger(inputEl, rawText, null);
        }
      }
    }, true); // Capture phase

    // ۲. رهگیری رویدادهای موس (pointerdown, mousedown, click) روی دکمه ارسال پیام
    const mouseEvents = ['pointerdown', 'mousedown', 'click'];
    mouseEvents.forEach(evtName => {
      document.addEventListener(evtName, async (e) => {
        if (this.isEncryptingAndSending) return;

        if (this.adapter.isSendButton(e.target)) {
          const inputEl = this.adapter.getInputElement();
          if (!inputEl) return;

          if (this.shouldIntercept()) {
            const rawText = this.adapter.getInputValue(inputEl);
            if (!rawText) return;

            e.preventDefault();
            e.stopImmediatePropagation();

            // شروع رمزنگاری فقط در اولین رویداد فشرده‌شدن موس (pointerdown یا mousedown)
            if (evtName === 'pointerdown' || evtName === 'mousedown') {
              await this.handleSendTrigger(inputEl, rawText, e.target);
            }
          }
        }
      }, true); // Capture phase
    });
  }

  shouldIntercept() {
    return Boolean(this.currentChatConfig && this.currentChatConfig.enabled && this.currentChatConfig.password);
  }

  async handleSendTrigger(inputEl, rawText, clickedTarget) {
    if (this.isEncryptingAndSending) return;

    if (rawText.startsWith(CONSTANTS.PREFIX)) {
      alert(CONSTANTS.MESSAGES.PREFIX_COLLISION_WARN);
      return;
    }

    try {
      this.isEncryptingAndSending = true;

      // ۱. رمزنگاری متن پیام با کلید چت
      const ciphertext = await CryptoEngine.encrypt(rawText, this.currentChatConfig.password);

      // ۲. ذخیره در کش نشست برای نمایش آنی متن اصلی در صفحه فرستنده
      MessageDecorator.cachePlaintext(ciphertext, rawText);

      // ۳. جایگزینی متن در فیلد ورودی به شکل سازگار با React
      this.adapter.setInputValue(inputEl, ciphertext);

      // ۴. مهلت کوتاه برای پذیرش State در React
      await new Promise(r => setTimeout(r, 60));

      // ۵. اجرای ارسال پیام با تحریک رویدادهای واقعی
      const btn = (clickedTarget && clickedTarget.closest('button, [role="button"], div[class*="send" i]')) ||
                  this.adapter.getSendButtonElement();

      if (btn) {
        this.adapter.triggerClick(btn);
      } else {
        this.adapter.triggerEnter(inputEl);
      }

      // ۶. آزادسازی قفل رهگیری پس از ارسال
      setTimeout(() => {
        this.isEncryptingAndSending = false;
      }, 250);

    } catch (err) {
      console.error("[Bale E2EE] Error in handleSendTrigger:", err);
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

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === "get_chat_info") {
        sendResponse({
          uid: this.currentChatId || this.adapter.getActiveChatId(),
          displayName: this.adapter.getActiveChatDisplayName()
        });
        return true;
      }
    });
  }
}

const controller = new ContentController(new BaleAdapter());
controller.init();
