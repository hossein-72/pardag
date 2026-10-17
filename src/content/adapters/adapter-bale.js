import { MessengerAdapter } from './adapter-base.js';

export class BaleAdapter extends MessengerAdapter {
  getName() {
    return "bale";
  }

  /**
   * استخراج شناسه چت از URL یا پارامترهای مختلف بله
   * پشتیبانی از:
   * https://web.bale.ai/chat?uid=4312346492
   * https://web.bale.ai/#/chat?uid=4312346492
   * https://web.bale.ai/chat/4312346492
   */
  getActiveChatId() {
    try {
      const href = window.location.href;

      // ۱. بررسی Regex روی کل URL (Query string, Hash و غیره)
      const queryMatch = href.match(/[?&#](?:uid|id|peer_id)=([0-9a-zA-Z_-]+)/i);
      if (queryMatch && queryMatch[1]) {
        return queryMatch[1];
      }

      // ۲. بررسی searchParams استاندارد
      const url = new URL(href);
      const uidFromSearch = url.searchParams.get("uid") || url.searchParams.get("id");
      if (uidFromSearch) return uidFromSearch;

      // ۳. بررسی در صورت وجود هش با کوئری
      if (url.hash && url.hash.includes("?")) {
        const hashQuery = url.hash.substring(url.hash.indexOf("?"));
        const hashParams = new URLSearchParams(hashQuery);
        const uidFromHash = hashParams.get("uid") || hashParams.get("id");
        if (uidFromHash) return uidFromHash;
      }

      // ۴. بررسی مسیر به شکل /chat/{id}
      const pathMatch = url.pathname.match(/\/chat\/([0-9a-zA-Z_-]+)/i);
      if (pathMatch && pathMatch[1] && pathMatch[1] !== "chat") {
        return pathMatch[1];
      }

      // ۵. پشتیبانی از ویژگیهای DOM در صورت عدم وجود در URL
      const domPeer = document.querySelector('[data-peer-id], [data-chat-id]');
      if (domPeer) {
        return domPeer.getAttribute('data-peer-id') || domPeer.getAttribute('data-chat-id');
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * پیدا کردن هدر چت برای تزریق دکمه قفل
   */
  getHeaderElement() {
    return document.querySelector(
      'header, [class*="ChatHeader" i], [class*="chat-header" i], [class*="TopBar" i], [class*="top-bar" i], [class*="topbar" i], [class*="middle-header" i], [class*="chat-info" i], [class*="ChatInfo" i], [data-testid*="header" i], .chat-top, div[class*="header" i], [class*="conversation-header" i]'
    );
  }

  /**
   * پیدا کردن نوار چت / کامپوزر ورودی پیام
   */
  getComposerElement() {
    const inputEl = this.getInputElement();
    if (inputEl) {
      const composerParent = inputEl.closest(
        '[class*="composer" i], [class*="chat-input" i], [class*="input-box" i], [class*="message-input" i], [class*="sendMessage" i], [class*="bottom-bar" i], [class*="footer" i], form, [class*="chat-bottom" i]'
      );
      if (composerParent) return composerParent;
    }

    return document.querySelector(
      '[class*="composer" i], [class*="chat-input" i], [class*="input-box" i], [class*="message-input" i], [class*="sendMessage" i], [class*="bottom-bar" i], [class*="footer" i], form[class*="message" i], [class*="chat-bottom" i]'
    );
  }

  /**
   * پیدا کردن فیلد ورودی پیام (پشتیبانی از contenteditable و textarea)
   */
  getInputElement() {
    return document.querySelector(
      '[contenteditable="true"][role="textbox"], [id*="editable-message-text"], [class*="composer"] [contenteditable="true"], [class*="input"] [contenteditable="true"], textarea[placeholder], textarea, div[contenteditable="true"]'
    );
  }

  /**
   * پیدا کردن دکمه ارسال
   */
  getSendButtonElement() {
    return document.querySelector(
      'button[aria-label*="Send" i], button[aria-label*="ارسال" i], button[class*="send" i], [data-testid*="send" i], button[type="submit"], [class*="send-btn" i], [class*="send-button" i]'
    );
  }

  /**
   * پیدا کردن عناصر متنی پیامها در صفحه
   */
  getMessageElements() {
    const elements = new Set();
    const candidates = document.querySelectorAll(
      '[class*="message-text" i], [class*="text-content" i], [class*="message-body" i], [dir="auto"]'
    );
    
    candidates.forEach(el => {
      // اطمینان از اینکه خود فیلد ورودی پیام یا المانهای کمکی انتخاب نشوند
      if (!el.isContentEditable && !el.closest('[contenteditable="true"]') && !el.closest('header') && !el.closest('.bale-enc-lock-btn')) {
        elements.add(el);
      }
    });

    return Array.from(elements);
  }

  /**
   * خواندن متن ورودی با حفظ خطوط جدید (Newlines)
   */
  getInputValue(inputEl) {
    if (!inputEl) return "";
    if (inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT") {
      return inputEl.value;
    }
    // برای عناصر contenteditable، innerText خطوط جدید را حفظ میکند
    return inputEl.innerText ? inputEl.innerText.replace(/\u00A0/g, " ").trim() : "";
  }

  /**
   * جایگزینی متن در فیلد ورودی بهگونهای که State داخلی React/SPA بله متوجه تغییر شود
   */
  setInputValue(inputEl, text) {
    if (!inputEl) return;
    inputEl.focus();

    if (inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT") {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(inputEl, text);
      } else {
        inputEl.value = text;
      }
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // برای عناصر contenteditable در React
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    selection.removeAllRanges();
    selection.addRange(range);

    // execCommand سازگارترین روش برای تحریک رویدادهای داخلی React در contenteditable است
    const success = document.execCommand("insertText", false, text);
    if (!success) {
      inputEl.textContent = text;
      inputEl.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text
      }));
    }
  }
}
