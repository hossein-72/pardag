import { MessengerAdapter } from './adapter-base.js';
import { CONSTANTS } from '../../shared/constants.js';

// مسیرهای داخلی بله که چت نیستند و نباید به‌عنوان UID چت تفسیر شوند.
const NON_CHAT_ROUTES = new Set([
  "search",
  "new",
  "settings",
  "profile",
  "archived",
  "archive",
  "calls",
  "contacts",
  "requests",
  "saved",
  "folders",
  "invite",
  "login",
  "logout"
]);

export class BaleAdapter extends MessengerAdapter {
  getName() {
    return "bale";
  }

  /**
   * UID چتی که صریحاً در query یا hash آمده است.
   * در حالت جستجو، بله آدرس را به /chat/search?uid=... تغییر می‌دهد
   * اگر همان لحظه یک چت هم باز باشد.
   */
  getUidFromUrlParams() {
    try {
      const url = new URL(window.location.href);
      const fromSearch =
        url.searchParams.get("uid") ||
        url.searchParams.get("id") ||
        url.searchParams.get("peer_id");
      if (fromSearch) return fromSearch;

      if (url.hash && url.hash.includes("?")) {
        const hashQuery = url.hash.substring(url.hash.indexOf("?"));
        const hashParams = new URLSearchParams(hashQuery);
        return (
          hashParams.get("uid") ||
          hashParams.get("id") ||
          hashParams.get("peer_id") ||
          null
        );
      }
    } catch {}

    return null;
  }

  /**
   * صفحه جستجو، تنظیمات و سایر مسیرهای داخلی، چت نیستند.
   * اما اگر همان لحظه چت مشخصی باز باشد (uid در URL)، وضعیت آن چت نمایش داده می‌شود.
   */
  isNonChatView() {
    try {
      if (this.getUidFromUrlParams()) return false;

      const url = new URL(window.location.href);
      const segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.toLowerCase());

      if (segments[0] === "search") return true;

      // پشتیبانی از مسیرهایی مانند /chat/search و /fa/chat/search
      const chatIndex = segments.indexOf("chat");
      return (
        chatIndex !== -1 &&
        NON_CHAT_ROUTES.has(segments[chatIndex + 1] || "")
      );
    } catch {
      return false;
    }
  }

  /**
   * استخراج شناسه چت از URL یا پارامترهای مختلف بله
   */
  getActiveChatId() {
    try {
      if (this.isNonChatView()) return null;

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
   * خواندن نام نمایشی مخاطب/چت جاری از هدر یا صفحه گفتگو
   */
  getActiveChatDisplayName() {
    try {
      // ۱. استخراج از هدر گفتگو
      const header = this.getHeaderElement();
      if (header) {
        const titleCandidates = header.querySelectorAll(
          '[class*="title" i], [class*="name" i], [class*="user-name" i], [class*="peer-name" i], h1, h2, h3, [role="heading"], strong, b'
        );

        for (const el of titleCandidates) {
          const text = el.textContent?.trim();
          if (text && text.length >= 2 &&
              !text.includes("آنلاین") &&
              !text.includes("بازدید") &&
              !text.includes("تایپ") &&
              !text.includes("عضو") &&
              !text.includes("رمزنگاری")) {
            return text;
          }
        }
      }

      // ۲. استخراج از تایتل صفحه (مانند "علی محمدی - بله" یا "بله | علی محمدی")
      if (document.title && document.title.includes("بله")) {
        const parts = document.title.split(/[-|–]/).map(s => s.trim());
        for (const p of parts) {
          if (p && p !== "بله" && p !== "پیام‌رسان بله" && !p.toLowerCase().includes("bale")) {
            return p;
          }
        }
      }

      // ۳. استخراج از آیتم فعال در لیست چت‌های کناری
      const activeDialogTitle = document.querySelector(
        '[class*="active" i] [class*="title" i], [class*="active" i] [class*="name" i], [aria-selected="true"] [class*="title" i]'
      );
      if (activeDialogTitle && activeDialogTitle.textContent) {
        const text = activeDialogTitle.textContent.trim();
        if (text && text.length >= 2) return text;
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
    const candidates = document.querySelectorAll(
      'button[aria-label*="Send" i], button[aria-label*="ارسال" i], button[class*="send" i], [data-testid*="send" i], button[type="submit"], [class*="send-btn" i], [class*="send-button" i], [class*="btn-send" i]'
    );
    for (const btn of candidates) {
      if (btn.offsetParent !== null && !btn.id?.includes("bale-enc")) return btn;
    }

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
   * شبیه‌سازی کامل تمام رویدادهای موس بر روی یک دکمه
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
   * پیدا کردن تمام عناصر متنی حاوی پیشوندهای رمزنگاری (BALEENC1/BALEENC2/BALEENC-KEY)
   * به صورت مستقل از کلاس‌ها
   */
  getMessageElements() {
    const elements = new Set();

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeValue && CONSTANTS.hasReservedPrefix(node.nodeValue)) {
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
    inputEl.focus();
    document.execCommand('selectAll', false, null);

    let success = false;
    try {
      success = document.execCommand("insertText", false, text);
    } catch {}

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
