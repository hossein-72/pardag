import { MessengerAdapter } from './adapter-base.js';
import { CONSTANTS } from '../../shared/constants.js';
import { MessageDecorator } from '../ui/message-decorator.js';

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
  constructor() {
    super();
    // کش نوع گفتگوهای غیرکانال (شخصی، گروه، ربات) از لایه WebSocket؛
    // کانال‌ها عمداً کش نمی‌شوند تا با مشاهده کانال‌های متعدد حافظه اشغال نشود.
    this.wsPeerTypes = new Map();
    this.activeChannelUid = null;

    if (typeof window !== "undefined") {
      window.addEventListener("message", (event) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data;
        if (!data || data.type !== "BALE_ENC_PEER_TYPE") return;
        const uid = data.uid ? String(data.uid).trim() : "";
        const chatType = data.chatType;
        if (!uid) return;

        if (chatType === "channel") {
          this.activeChannelUid = uid;
          return;
        }

        if (chatType === "private" || chatType === "group" || chatType === "bot") {
          if (this.activeChannelUid === uid) {
            this.activeChannelUid = null;
          }
          if (this.wsPeerTypes.size >= 500 && !this.wsPeerTypes.has(uid)) {
            const firstKey = this.wsPeerTypes.keys().next().value;
            if (firstKey !== undefined) this.wsPeerTypes.delete(firstKey);
          }
          this.wsPeerTypes.set(uid, chatType);
        }
      });
    }
  }

  getName() {
    return "bale";
  }

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

  isNonChatView() {
    try {
      if (this.getUidFromUrlParams()) return false;

      const url = new URL(window.location.href);
      const segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.toLowerCase());

      if (segments[0] === "search") return true;

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
   * استخراج شناسه چت فعال از URL یا هدر گفتگوی باز (بدون برداشتن اشتباهی آیتم‌های سایدبار زمانی که چتی باز نیست).
   */
  getActiveChatId() {
    try {
      if (this.isNonChatView()) return null;

      const href = window.location.href;

      const queryMatch = href.match(/[?&#](?:uid|id|peer_id)=([0-9a-zA-Z_-]+)/i);
      if (queryMatch && queryMatch[1]) {
        return queryMatch[1];
      }

      const url = new URL(href);
      const uidFromSearch = url.searchParams.get("uid") || url.searchParams.get("id");
      if (uidFromSearch) return uidFromSearch;

      if (url.hash && url.hash.includes("?")) {
        const hashQuery = url.hash.substring(url.hash.indexOf("?"));
        const hashParams = new URLSearchParams(hashQuery);
        const uidFromHash = hashParams.get("uid") || hashParams.get("id");
        if (uidFromHash) return uidFromHash;
      }

      const pathMatch = url.pathname.match(/\/chat\/([0-9a-zA-Z_-]+)/i);
      if (
        pathMatch &&
        pathMatch[1] &&
        pathMatch[1] !== "chat" &&
        !NON_CHAT_ROUTES.has(pathMatch[1].toLowerCase())
      ) {
        return pathMatch[1];
      }

      // فقط اگر کادر پیام چت واقعاً در صفحه باز باشد، هدر چت را برای data-peer-id بررسی می‌کنیم
      const inputEl = this.getInputElement();
      if (inputEl) {
        const header = this.getHeaderElement();
        const domPeer = header?.querySelector?.('[data-peer-id], [data-chat-id]');
        if (domPeer) {
          return domPeer.getAttribute('data-peer-id') || domPeer.getAttribute('data-chat-id');
        }
      }

      return null;
    } catch {
      return null;
    }
  }


  /**
   * تشخیص نوع گفتگوی فعال در بله: "private" | "group" | "channel" | "bot" | "none"
   */
  getChatType() {
    try {
      if (this.isNonChatView()) return "none";
      const chatId = this.getActiveChatId();
      if (!chatId) return "none";

      const href = window.location.href.toLowerCase();
      if (/[?&#/](?:type|peer_type)=channel/.test(href) || /\/channel\//i.test(href)) {
        return "channel";
      }
      if (/[?&#/](?:type|peer_type)=bot/.test(href) || /\/bot\//i.test(href)) {
        return "bot";
      }
      if (/[?&#/](?:type|peer_type)=group/.test(href) || /\/group\//i.test(href)) {
        return "group";
      }

      const peerAttrEl = document.querySelector("[data-peer-type], [data-chat-type]");
      const attrType = (
        peerAttrEl?.getAttribute("data-peer-type") ||
        peerAttrEl?.getAttribute("data-chat-type") ||
        ""
      ).toLowerCase();
      if (attrType.includes("channel")) return "channel";
      if (attrType.includes("bot")) return "bot";
      if (attrType.includes("group")) return "group";
      if (attrType.includes("private") || attrType.includes("user")) return "private";

      const uidStr = String(chatId);
      if (this.activeChannelUid === uidStr) return "channel";
      if (this.wsPeerTypes.has(uidStr)) return this.wsPeerTypes.get(uidStr);

      const header = this.getHeaderElement();
      const headerText = (header?.innerText || header?.textContent || "").trim();

      // ۱. تشخیص کانال (وجود واژه دنبال‌کننده/مشترک/کانال یا نبود کادر ورودی پیام در گفتگوی باز)
      if (
        /(\d[\d\s,٬۰-۹]*\s*(?:دنبال[\s\u200c]?کننده|مشترک|subscriber)s?)|(?:^|\s)(?:کانال|channel)(?:\s|$)/i.test(
          headerText
        )
      ) {
        return "channel";
      }

      // ۲. تشخیص ربات
      if (
        /(?:^|\s)(?:ربات|bot)(?:\s|$)/i.test(headerText) ||
        /@[a-z0-9_]+bot\b/i.test(headerText)
      ) {
        return "bot";
      }

      // ۳. تشخیص گروه (تعداد عضو/اعضا/نفر در هدر)
      if (
        /(\d[\d\s,٬۰-۹]*\s*(?:عضو|اعضا|نفر|member)s?)|(?:^|\s)(?:گروه|group)(?:\s|$)/i.test(
          headerText
        )
      ) {
        return "group";
      }

      // اگر چت باز است ولی کادر ورودی پیام وجود ندارد و دکمه عضویت/بی‌صدا/شروع دیده می‌شود، کانال یا ربات است
      const inputEl = this.getInputElement();
      if (!inputEl) {
        return "channel";
      }

      // اگر هدر چت هنوز رندر نشده باشد و نوع گفتگو از وب‌سوکت نرسیده باشد، منتظر می‌مانیم
      if (!headerText) {
        return "none";
      }

      return "private";
    } catch {
      return "none";
    }
  }

  getActiveChatDisplayName() {
    try {
      const header = this.getHeaderElement();
      if (header) {
        const titleCandidates = header.querySelectorAll(
          '[class*="title" i], [class*="name" i], [class*="user-name" i], [class*="peer-name" i], h1, h2, h3, [role="heading"], strong, b'
        );

        for (const el of titleCandidates) {
          const text = el.textContent?.trim();
          if (
            text &&
            text.length >= 2 &&
            !text.includes("آنلاین") &&
            !text.includes("بازدید") &&
            !text.includes("تایپ") &&
            !text.includes("عضو") &&
            !text.includes("رمزنگاری")
          ) {
            return text;
          }
        }
      }

      if (document.title && document.title.includes("بله")) {
        const parts = document.title.split(/[-|–]/).map((s) => s.trim());
        for (const p of parts) {
          if (
            p &&
            p !== "بله" &&
            p !== "پیام‌رسان بله" &&
            !p.toLowerCase().includes("bale")
          ) {
            return p;
          }
        }
      }

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

  getHeaderElement() {
    const inputEl = this.getInputElement();
    const inputRect = inputEl?.getBoundingClientRect?.();

    const candidates = document.querySelectorAll(
      'header, [class*="ChatHeader" i], [class*="chat-header" i], [class*="TopBar" i], [class*="top-bar" i], [class*="topbar" i], [class*="middle-header" i], [class*="chat-info" i], [data-testid*="header" i], .chat-top, div[class*="header" i]'
    );
    for (const el of candidates) {
      if (!this.isElementVisible(el)) continue;
      if (el.closest('aside, nav, [class*="sidebar" i], [class*="side-bar" i], [class*="chat-list" i], [class*="chatList" i], [class*="dialog-list" i]')) {
        continue;
      }
      if (inputRect && inputRect.width > 0) {
        const r = el.getBoundingClientRect();
        const overlapsHorizontally = r.right > inputRect.left + 20 && r.left < inputRect.right - 20;
        if (!overlapsHorizontally) continue;
      }
      return el;
    }

    if (inputRect && inputRect.width > 0) {
      const topEls = document.querySelectorAll("header, div, section");
      for (const el of topEls) {
        if (!this.isElementVisible(el)) continue;
        if (el.closest('aside, nav, [class*="sidebar" i], [class*="chat-list" i], [data-bale-enc-ui="1"]')) continue;
        const r = el.getBoundingClientRect();
        if (
          r.top >= 0 &&
          r.top <= 110 &&
          r.height >= 36 &&
          r.height <= 120 &&
          r.width >= Math.min(260, inputRect.width * 0.7) &&
          r.right > inputRect.left + 20 &&
          r.left < inputRect.right - 20 &&
          (el.innerText || "").trim().length >= 2
        ) {
          return el;
        }
      }
    }

    return null;
  }

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

  getInputElement() {
    return document.querySelector(
      '[contenteditable="true"][role="textbox"], [id*="editable-message-text"], [class*="composer"] [contenteditable="true"], [class*="input"] [contenteditable="true"], textarea[placeholder], textarea, div[contenteditable="true"]'
    );
  }

  isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return el.offsetParent !== null;
    }
  }

  isExcludedComposerButton(el) {
    if (!el) return true;
    if ((el.id && el.id.includes("bale-enc")) || el.dataset?.baleEncUi || el.closest?.('[data-bale-enc-ui="1"]')) {
      return true;
    }
    const label = [
      el.getAttribute?.("aria-label") || "",
      el.getAttribute?.("title") || "",
      el.getAttribute?.("data-testid") || "",
      typeof el.className === "string" ? el.className : ""
    ].join(" ").toLowerCase();
    const html = (el.outerHTML || "").toLowerCase();
    const combined = `${label} ${html}`;
    return (
      combined.includes("emoji") ||
      combined.includes("sticker") ||
      combined.includes("attach") ||
      combined.includes("پیوست") ||
      combined.includes("voice") ||
      combined.includes("record") ||
      combined.includes("micro") ||
      combined.includes("میکروفون") ||
      combined.includes("ضبط") ||
      combined.includes("ایموجی") ||
      combined.includes("استیکر")
    );
  }

  findClickableAncestor(target) {
    if (!target) return null;
    const el = target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
    if (!el || !el.closest) return null;

    const direct = el.closest(
      'button, [role="button"], div[class*="send" i], span[class*="send" i], [class*="send-btn" i], [data-testid*="send" i]'
    );
    if (direct) return direct;

    const inputEl = this.getInputElement();
    let node = el;
    for (let depth = 0; depth < 6 && node && node !== document.body; depth++, node = node.parentElement) {
      if (inputEl && (node === inputEl || node.contains(inputEl))) break;
      try {
        const style = window.getComputedStyle(node);
        if (style.cursor === "pointer" && (node.querySelector("svg, img") || node.getAttribute("tabindex") !== null)) {
          return node;
        }
      } catch {}
    }
    return null;
  }

  getSendButtonElement() {
    const candidates = document.querySelectorAll(
      'button[aria-label*="Send" i], button[aria-label*="ارسال" i], [role="button"][aria-label*="Send" i], [role="button"][aria-label*="ارسال" i], button[class*="send" i], [data-testid*="send" i], button[type="submit"], [class*="send-btn" i], [class*="send-button" i], [class*="btn-send" i]'
    );
    for (const btn of candidates) {
      if (this.isElementVisible(btn) && !this.isExcludedComposerButton(btn)) {
        return btn;
      }
    }

    const inputEl = this.getInputElement();
    let composer = this.getComposerElement();
    if (!composer && inputEl) {
      let node = inputEl.parentElement;
      for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
        const rect = node.getBoundingClientRect?.();
        if (rect && rect.height > 0 && rect.height <= 240 && node.querySelector("button, [role='button'], svg")) {
          composer = node;
          if (rect.width > (inputEl.getBoundingClientRect?.()?.width || 0) + 40) break;
        }
      }
    }

    const searchRoot = composer?.parentElement || composer || document;
    if (searchRoot) {
      const clickableElements = searchRoot.querySelectorAll(
        'button, [role="button"], div[class*="send" i], span[class*="send" i], [tabindex]'
      );
      for (const el of clickableElements) {
        if (!this.isElementVisible(el) || this.isExcludedComposerButton(el)) continue;
        if (inputEl && (el === inputEl || el.contains(inputEl))) continue;

        const html = (el.outerHTML || "").toLowerCase();
        if (
          html.includes("send") ||
          html.includes("ارسال") ||
          html.includes("submit") ||
          html.includes("plane") ||
          el.type === "submit"
        ) {
          return el;
        }
      }

      const scope = composer || searchRoot;
      if (scope && inputEl) {
        const inputRect = inputEl.getBoundingClientRect();
        const isRtl = window.getComputedStyle(inputEl).direction === "rtl" || document.dir === "rtl";
        const iconCandidates = Array.from(
          scope.querySelectorAll('button, [role="button"], div, span')
        ).filter((b) => {
          if (!this.isElementVisible(b) || this.isExcludedComposerButton(b)) return false;
          if (b === inputEl || b.contains(inputEl) || inputEl.contains(b)) return false;
          if (!b.querySelector("svg")) return false;
          const r = b.getBoundingClientRect();
          if (r.width > 90 || r.height > 90) return false;
          const isClickable =
            b.tagName === "BUTTON" ||
            b.getAttribute("role") === "button" ||
            window.getComputedStyle(b).cursor === "pointer";
          if (!isClickable) return false;
          const vAligned = Math.abs(r.bottom - inputRect.bottom) < 70 || Math.abs(r.top - inputRect.top) < 70;
          return vAligned;
        });

        if (iconCandidates.length > 0) {
          iconCandidates.sort((a, b) => {
            const ra = a.getBoundingClientRect().left;
            const rb = b.getBoundingClientRect().left;
            return isRtl ? ra - rb : rb - ra;
          });
          return iconCandidates[0];
        }
      }
    }

    return null;
  }

  isSendButton(target) {
    if (!target || !target.closest) return false;
    if (target.closest('[data-bale-enc-ui="1"]')) return false;

    const sendBtn = this.getSendButtonElement();
    if (sendBtn && (sendBtn === target || sendBtn.contains(target))) {
      return true;
    }

    const btn = this.findClickableAncestor(target);
    if (!btn || !this.isElementVisible(btn)) return false;
    if (this.isExcludedComposerButton(btn)) return false;

    const html = (btn.outerHTML || "").toLowerCase();
    if (
      html.includes("send") ||
      html.includes("ارسال") ||
      html.includes("submit") ||
      html.includes("plane") ||
      btn.type === "submit"
    ) {
      return true;
    }

    const inputEl = this.getInputElement();
    if (inputEl && btn.getBoundingClientRect && inputEl.getBoundingClientRect) {
      const btnRect = btn.getBoundingClientRect();
      const inputRect = inputEl.getBoundingClientRect();
      const verticallyAligned =
        Math.abs(btnRect.bottom - inputRect.bottom) < 70 ||
        Math.abs(btnRect.top - inputRect.top) < 70;
      const horizontallyNear =
        btnRect.left <= inputRect.right + 220 &&
        btnRect.right >= inputRect.left - 220;

      if (
        verticallyAligned &&
        horizontallyNear &&
        btnRect.width <= 90 &&
        btnRect.height <= 90 &&
        btn.querySelector("svg, img")
      ) {
        return true;
      }
    }

    return false;
  }

  isOutgoingMessageElement(el) {
    if (!el || !el.closest) return false;

    let node = el;
    for (
      let depth = 0;
      depth < 6 && node && node !== document.body;
      depth++, node = node.parentElement
    ) {
      const cls = typeof node.className === "string" ? node.className : "";
      const dataOut =
        node.getAttribute?.("data-out") ||
        node.getAttribute?.("data-outgoing") ||
        node.getAttribute?.("data-is-out") ||
        node.getAttribute?.("data-own");

      if (dataOut === "true" || dataOut === "1") return true;
      if (dataOut === "false" || dataOut === "0") return false;

      if (
        /(^|[\s_-])(out|outgoing|own|sent|is-out|isOut|message-out|msg-out|self|me)([\s_-]|$)/i.test(
          cls
        )
      ) {
        return true;
      }
      if (
        /(^|[\s_-])(in|incoming|received|is-in|isIn|message-in|msg-in|peer)([\s_-]|$)/i.test(
          cls
        )
      ) {
        return false;
      }
    }

    return false;
  }

  triggerClick(element) {
    if (!element) return;
    const mouseOpts = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
    const pointerOpts = {
      ...mouseOpts,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    };
    element.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
    element.dispatchEvent(new MouseEvent("mousedown", mouseOpts));
    element.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
    element.dispatchEvent(new MouseEvent("mouseup", mouseOpts));
    if (typeof element.click === "function") {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent("click", mouseOpts));
    }
  }

  cancelEditMode(inputEl) {
    try {
      const targetInput = inputEl && inputEl.isConnected ? inputEl : this.getInputElement();
      const inputRect = targetInput?.getBoundingClientRect?.();
      const composer = this.getComposerElement();
      const searchRoot = composer?.parentElement || composer || document;

      // جستجوی دقیق آیکون بستن بله (svg[aria-label="Close-icon"] یا use[href="#bi-Close"]) و کلیک روی والد قابل کلیک آن
      const closeIconCandidates = document.querySelectorAll(
        'svg[aria-label="Close-icon"], svg[aria-label*="close" i], use[href="#bi-Close"], [aria-label*="Close-icon" i]'
      );
      for (const icon of closeIconCandidates) {
        if (!this.isElementVisible(icon)) continue;
        if (icon.closest('[data-bale-enc-ui="1"]')) continue;
        const clickable =
          icon.closest('button, [role="button"], div[style*="border-radius"], div') ||
          icon.parentElement ||
          icon;
        if (!clickable || !this.isElementVisible(clickable)) continue;
        if (targetInput && (clickable === targetInput || clickable.contains(targetInput))) continue;
        const r = clickable.getBoundingClientRect();
        if (r.width > 64 || r.height > 64) continue;
        if (!inputRect || ((r.bottom <= inputRect.top + 14) && (inputRect.top - r.top < 160))) {
          this.triggerClick(clickable);
          return true;
        }
      }

      // جستجوی پشتیبان دکمه بستن/لغو (×) در نوار «ویرایش پیام» بالای کادر متن
      if (searchRoot) {
        const candidates = searchRoot.querySelectorAll(
          'button, [role="button"], [aria-label*="close" i], [aria-label*="cancel" i], [aria-label*="بستن"], [aria-label*="لغو"], [class*="close" i], [class*="cancel" i]'
        );
        for (const btn of candidates) {
          if (!this.isElementVisible(btn) || this.isExcludedComposerButton(btn)) continue;
          if (targetInput && (btn === targetInput || btn.contains(targetInput))) continue;
          if (this.isSendButton(btn)) continue;
          const clickable = btn.tagName.toLowerCase() === "svg" ? (btn.closest('button, [role="button"], div') || btn) : btn;
          const r = clickable.getBoundingClientRect();
          if (r.width > 56 || r.height > 56) continue;
          if (inputRect && (r.bottom <= inputRect.top + 14) && (inputRect.top - r.top < 160)) {
            this.triggerClick(clickable);
            return true;
          }
        }

        // اگر دکمه × با کلاس هش‌شده و بدون aria-label ساخته شده باشد، نوار «ویرایش پیام» را با متن پیدا می‌کنیم
        if (inputRect) {
          const allEls = searchRoot.querySelectorAll("div, section");
          for (const bar of allEls) {
            if (!this.isElementVisible(bar)) continue;
            const txt = (bar.innerText || "").trim();
            if (!txt.includes("ویرایش") && !txt.toLowerCase().includes("edit")) continue;
            const br = bar.getBoundingClientRect();
            if (br.bottom <= inputRect.top + 8 && inputRect.top - br.top < 130 && br.height <= 90) {
              const barBtn = bar.querySelector('button, [role="button"], svg');
              if (barBtn) {
                const clickable = barBtn.closest?.('button, [role="button"]') || barBtn;
                this.triggerClick(clickable);
                return true;
              }
            }
          }
        }
      }

      if (targetInput) {
        targetInput.focus();
        const escOpts = {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
          view: window
        };
        targetInput.dispatchEvent(new KeyboardEvent("keydown", escOpts));
        targetInput.dispatchEvent(new KeyboardEvent("keyup", escOpts));
      }
    } catch {}
    return false;
  }

  triggerEnter(element) {
    if (!element) return;
    const opts = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      view: window
    };
    element.dispatchEvent(new KeyboardEvent("keydown", opts));
    element.dispatchEvent(new KeyboardEvent("keypress", opts));
    element.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  /**
   * آیا این عنصر مربوط به پیش‌نمایش آخرین پیام در لیست چت‌ها یا صفحه خارج از چت است؟
   */
  isChatListPreviewElement(el) {
    if (!el || !el.closest) return false;

    // اگر هیچ چتی باز نیست (صفحه خارج از چت)، تمام پیام‌های روی صفحه پیش‌نمایش لیست چت‌ها هستند
    if (!this.getActiveChatId() || !this.getInputElement()) {
      return true;
    }

    if (
      el.closest(
        'aside, nav, [role="navigation"], a[href], ' +
          '[class*="last-message" i], [class*="lastMessage" i], ' +
          '[class*="message-preview" i], [class*="messagePreview" i], ' +
          '[class*="dialog-list" i], [class*="dialogList" i], ' +
          '[class*="chat-list" i], [class*="chatList" i], ' +
          '[class*="conversation-list" i], [class*="conversationList" i], ' +
          '[class*="chat-item" i], [class*="chatItem" i], ' +
          '[class*="dialog-item" i], [class*="dialogItem" i]'
      )
    ) {
      return true;
    }

    const chatListContainer = this.getChatListContainer();
    if (chatListContainer && chatListContainer.contains(el)) {
      return true;
    }

    // پیش‌نمایش‌ها معمولاً تک‌خطی و با ellipsis بریده می‌شوند.
    let node = el;
    for (
      let depth = 0;
      depth < 5 && node && node !== document.body;
      depth++, node = node.parentElement
    ) {
      const style = window.getComputedStyle(node);
      const clipped =
        style.overflow === "hidden" ||
        style.overflowX === "hidden" ||
        style.overflowY === "hidden";
      const lineClamped =
        style.webkitLineClamp && style.webkitLineClamp !== "none";

      if ((style.textOverflow === "ellipsis" || lineClamped) && clipped) {
        return true;
      }
      if (style.whiteSpace === "nowrap" && clipped) return true;
    }

    return false;
  }

  isChatNavigationTarget(target) {
    if (!target || !target.closest) return false;

    if (
      target.closest(
        '[data-bale-enc-ui="1"], #bale-enc-floating-lock-btn, #bale-enc-chat-settings-btn, ' +
          '#bale-enc-start-handshake-btn, #bale-enc-consent-prompt, #bale-enc-composer-lock-overlay, ' +
          '#bale-enc-key-request-modal-backdrop, #bale-enc-key-request-modal, ' +
          '#bale-enc-toast-container, .bale-enc-toast'
      )
    ) {
      return false;
    }

    const composer = this.getComposerElement();
    if (composer && composer.contains(target)) return false;
    if (this.isSendButton(target)) return false;

    const link = target.closest("a[href]");
    if (link) {
      const href = link.getAttribute("href") || "";
      if (/\/chat\//i.test(href) || /[?&#](uid|id|peer_id)=/i.test(href)) {
        return true;
      }
    }

    const button = target.closest('button, [role="button"], [aria-label]');
    if (button) {
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.getAttribute("data-testid"),
        button.className
      ]
        .filter((part) => typeof part === "string" && part)
        .join(" ");
      if (/(^|[\s_-])(back|close|بازگشت|بستن)([\s_-]|$)/i.test(label)) {
        return true;
      }
    }

    if (
      target.closest(
        'aside, nav, [role="navigation"], [class*="sidebar" i], ' +
          '[class*="side-bar" i], [class*="dialog-list" i], ' +
          '[class*="dialogList" i], [class*="chat-list" i], ' +
          '[class*="chatList" i], [class*="conversation-list" i], ' +
          '[class*="conversationList" i], [class*="drawer" i]'
      )
    ) {
      return true;
    }

    const listContainer = this.getChatListContainer();
    return Boolean(listContainer && listContainer.contains(target));
  }

  getChatListContainer() {
    const direct = document.querySelector(
      'aside, nav, [role="navigation"], [class*="sidebar" i], ' +
        '[class*="side-bar" i], [class*="dialog-list" i], ' +
        '[class*="dialogList" i], [class*="chat-list" i], ' +
        '[class*="chatList" i], [class*="conversation-list" i], ' +
        '[class*="conversationList" i], [class*="drawer" i]'
    );
    if (direct) return direct;

    const anchors = document.querySelectorAll(
      '[data-bale-enc-preview="1"], ' +
        '[class*="last-message" i], [class*="lastMessage" i], ' +
        '[class*="message-preview" i], [class*="messagePreview" i], ' +
        '[class*="draft" i], a[href*="/chat/"], [data-peer-id], [data-chat-id]'
    );

    const inputEl = this.getInputElement();

    for (const anchor of anchors) {
      let node = anchor.parentElement;
      for (
        let depth = 0;
        depth < 10 && node && node !== document.body;
        depth++, node = node.parentElement
      ) {
        if (inputEl && node.contains(inputEl)) break;
        if (node.getAttribute("role") === "list" || node.getAttribute("role") === "listbox") {
          return node;
        }
        const style = window.getComputedStyle(node);
        const scrollable =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight + 8;
        if (scrollable) return node;
      }
    }

    const scrollContainers = document.querySelectorAll('[role="list"], [role="listbox"], [role="grid"], div');
    const vw = window.innerWidth || 1280;
    for (const candidate of scrollContainers) {
      if (inputEl && candidate.contains(inputEl)) continue;
      const rect = candidate.getBoundingClientRect?.();
      if (!rect || rect.width < 180 || rect.width > vw * 0.48 || rect.height < 220) {
        continue;
      }
      const style = window.getComputedStyle(candidate);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        candidate.children.length >= 2
      ) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * پیدا کردن تمام عناصر متنی حاوی پیشوندهای رمزنگاری یا تبادل کلید (حتی اگر در لیست چت‌ها بریده شده باشند).
   */
  getMessageElements() {
    const decoratedNodes = document.querySelectorAll('[data-bale-enc-decorated="1"]');
    for (const node of decoratedNodes) {
      MessageDecorator.cleanupIfRecycled(node);
    }

    const elements = new Set();

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeValue && CONSTANTS.containsReservedPrefix(node.nodeValue)) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            if (p.closest('.bale-enc-ui-root, [data-bale-enc-ui="1"]')) {
              return NodeFilter.FILTER_REJECT;
            }
            if (p.isContentEditable || p.closest('[contenteditable="true"]')) {
              return NodeFilter.FILTER_REJECT;
            }
            if (
              p.tagName === "SCRIPT" ||
              p.tagName === "STYLE" ||
              p.tagName === "TEXTAREA" ||
              p.tagName === "INPUT"
            ) {
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

    const remainingDecorated = document.querySelectorAll(
      '[data-bale-enc-decorated="1"], [data-bale-enc-failed="true"]'
    );
    for (const el of remainingDecorated) {
      if (!MessageDecorator.cleanupIfRecycled(el)) {
        elements.add(el);
      }
    }

    const result = Array.from(elements);
    for (const el of result) {
      if (this.isChatListPreviewElement(el)) {
        el.dataset.baleEncPreview = "1";
      } else {
        delete el.dataset.baleEncPreview;
      }
    }

    return result;
  }

  getInputValue(inputEl) {
    if (!inputEl) return "";
    if (inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT") {
      return inputEl.value;
    }
    return inputEl.innerText ? inputEl.innerText.replace(/\u00A0/g, " ").trim() : "";
  }

  setInputValue(inputEl, text) {
    if (!inputEl) return;
    inputEl.focus();

    if (inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT") {
      const proto =
        inputEl.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
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

    inputEl.focus();
    try {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(inputEl);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch {}
    document.execCommand("selectAll", false, null);

    let success = false;
    try {
      success = text
        ? document.execCommand("insertText", false, text)
        : document.execCommand("delete", false, null);
    } catch {}

    const current = (this.getInputValue(inputEl) || "").trim();
    const expected = (text || "").trim();

    if (!text || !success || current !== expected) {
      const inputType = text ? "insertText" : "deleteContentBackward";
      const dt = new DataTransfer();
      if (text) dt.setData("text/plain", text);

      inputEl.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType,
          data: text || null,
          dataTransfer: dt
        })
      );

      inputEl.textContent = text;

      inputEl.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType,
          data: text || null
        })
      );
    }
  }
}
