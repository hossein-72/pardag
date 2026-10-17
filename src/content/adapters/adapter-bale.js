import { MessengerAdapter } from './adapter-base.js';
import { CONSTANTS } from '../../shared/constants.js';

export class BaleAdapter extends MessengerAdapter {
  getName() {
    return "bale";
  }

  /**
   * استخراج شناسه چت از URL یا پارامترهای مختلف بله
   */
  getActiveChatId() {
    try {
      const href = window.location.href;

      // ۱. بررسی Regex روی کل URL
      const queryMatch = href.match(/[?&#](?:uid|id|peer_id)=([0-9a-zA-Z_-]+)/i);
      if (queryMatch && queryMatch[1]) {
        return queryMatch[1];
      }

      // ۲. بررسی searchParams استاندارد
      const url = new URL(href);
      const uidFromSearch = url.searchParams.get("uid") || url.searchParams.get("id");
      if (uidFromSearch) return uidFromSearch;

      // ۳. بررسی هش با کوئری
      if (url.hash && url.hash.includes("?")) {
        const hashQuery = url.hash.substring(url.hash.indexOf("?"));
        const hashParams = new URLSearchParams(hashQuery);
        const uidFromHash = hashParams.get("uid") || hashParams.get("id");
        if (uidFromHash) return uidFromHash;
      }

      // ۴. بررسی مسیر /chat/{id}
      const pathMatch = url.pathname.match(/\/chat\/([0-9a-zA-Z_-]+)/i);
      if (pathMatch && pathMatch[1] && pathMatch[1] !== "chat") {
        return pathMatch[1];
      }

      // ۵. ویژگی‌های DOM
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
   * پیدا کردن هدر چت
   */
  getHeaderElement() {
    return document.querySelector(
      'header, [class*="ChatHeader" i], [class*="chat-header" i], [class*="TopBar" i], [class*="top-bar" i], [class*="topbar" i], [class*="middle-header" i], [class*="chat-info" i], [data-testid*="header" i], .chat-top, div[class*="header" i]'
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
   * پیدا کردن دکمه ارسال پیام در کامپوزر
   */
  getSendButtonElement() {
    // ۱. جستجوی صریح با سلکتورهای ارسال
    const candidates = document.querySelectorAll(
      'button[aria-label*="Send" i], button[aria-label*="ارسال" i], button[class*="send" i], [data-testid*="send" i], button[type="submit"], [class*="send-btn" i], [class*="send-button" i], [class*="btn-send" i]'
    );
    for (const btn of candidates) {
      if (btn.offsetParent !== null && !btn.id?.includes("bale-enc")) return btn;
    }

    // ۲. بررسی دکمه‌های داخل کامپوزر جاری
    const inputEl = this.getInputElement();
    const composer = this.getComposerElement() || (inputEl ? inputEl.closest('[class*="composer" i], form, footer, div') : null);
    if (composer) {
      const clickableElements = composer.querySelectorAll('button, [role="button"], div[class*="send" i], span[class*="send" i]');
      for (const el of clickableElements) {
        if (el.id && el.id.includes("bale-enc")) continue;
        if (el.offsetParent === null) continue;

        const html = el.outerHTML.toLowerCase();
        if (html.includes("emoji") || html.includes("attach") || html.includes("پیوست") || html.includes("voice") || html.includes("میکروفون")) {
          continue;
        }

        if (html.includes("send") || html.includes("ارسال") || html.includes("submit") || html.includes("plane") || el.type === "submit") {
          return el;
        }
      }

      // در صورت نبود برچسب، آخرین المان قابل کلیک در کامپوزر که ایموجی یا اتچ نیست
      const validElements = Array.from(clickableElements).filter(b => 
        b.offsetParent !== null && 
        (!b.id || !b.id.includes("bale-enc")) &&
        !b.matches('[aria-label*="emoji" i], [aria-label*="attach" i], [aria-label*="پیوست" i]')
      );
      if (validElements.length > 0) {
        return validElements[validElements.length - 1];
      }
    }

    return null;
  }

  /**
   * بررسی اینکه آیا المان کلیک‌شده دکمه ارسال پیام است یا خیر
   */
  isSendButton(target) {
    if (!target) return false;
    const btn = target.closest('button, [role="button"], div[class*="send" i], [class*="send-btn" i]');
    if (!btn) return false;
    if (btn.id && btn.id.includes("bale-enc")) return false;

    const composer = this.getComposerElement();
    if (composer && !composer.contains(btn)) return false;

    const html = btn.outerHTML.toLowerCase();
    if (html.includes("emoji") || html.includes("attach") || html.includes("پیوست")) {
      return false;
    }

    if (html.includes("send") || html.includes("ارسال") || html.includes("submit") || html.includes("plane") || btn.type === "submit") {
      return true;
    }

    const sendBtn = this.getSendButtonElement();
    return sendBtn === btn || sendBtn?.contains(target);
  }

  /**
   * شبیه‌سازی کامل تمام رویدادهای موس بر روی یک دکمه جهت اجرای قطعی در فریمورک‌های مختلف
   */
  triggerClick(element) {
    if (!element) return;
    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    element.dispatchEvent(new PointerEvent('pointerdown', opts));
    element.dispatchEvent(new MouseEvent('mousedown', opts));
    element.dispatchEvent(new PointerEvent('pointerup', opts));
    element.dispatchEvent(new MouseEvent('mouseup', opts));
    element.click();
  }

  /**
   * شبیه‌سازی رویداد فشردن Enter
   */
  triggerEnter(element) {
    if (!element) return;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new KeyboardEvent('keydown', opts));
    element.dispatchEvent(new KeyboardEvent('keypress', opts));
    element.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /**
   * پیدا کردن تمام عناصر متنی حاوی BALEENC1: به صورت مستقل از کلاس‌ها
   */
  getMessageElements() {
    const elements = new Set();

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeValue && node.nodeValue.includes(CONSTANTS.PREFIX)) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            if (p.isContentEditable || p.closest('[contenteditable="true"]')) {
              return NodeFilter.FILTER_REJECT;
            }
            if (p.tagName === "SCRIPT" || p.tagName === "STYLE" || p.tagName === "TEXTAREA" || p.tagName === "INPUT") {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    let textNode;
    while ((textNode = walker.nextNode())) {
      if (textNode.parentElement) {
        elements.add(textNode.parentElement);
      }
    }

    return Array.from(elements);
  }

  /**
   * خواندن متن ورودی با حفظ خطوط جدید
   */
  getInputValue(inputEl) {
    if (!inputEl) return "";
    if (inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT") {
      return inputEl.value;
    }
    return inputEl.innerText ? inputEl.innerText.replace(/\u00A0/g, " ").trim() : "";
  }

  /**
   * جایگزینی متن در فیلد ورودی به شکلی که React متوجه تغییرات شود
   */
  setInputValue(inputEl, text) {
    if (!inputEl) return;
    inputEl.focus();

    if (inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT") {
      const proto = inputEl.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(inputEl, text);
      } else {
        inputEl.value = text;
      }
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    // برای عناصر contenteditable در React:
    // ۱. فوکوس روی المان
    inputEl.focus();

    // ۲. انتخاب کل متن موجود با دستور بومی مرورگر
    document.execCommand('selectAll', false, null);

    // ۳. درج متن جدید با execCommand (باعث ایجاد native beforeinput و input در مرورگر می‌شود)
    let success = false;
    try {
      success = document.execCommand("insertText", false, text);
    } catch {}

    // ۴. اگر execCommand جواب نداد، از DataTransfer و InputEvent استفاده می‌کنیم
    if (!success || !inputEl.textContent.includes(text)) {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);

      inputEl.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
        dataTransfer: dt
      }));

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
