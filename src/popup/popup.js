import { StorageManager } from '../shared/storage.js';
import { IdentityManager } from '../shared/identity.js';
import { CryptoEngine } from '../content/crypto/crypto.js';
import { CONSTANTS } from '../shared/constants.js';

document.addEventListener("DOMContentLoaded", async () => {

  // ---------------------------------------------------------------------------
  // اعلان و دیالوگ تایید داخلی (جایگزین alert و confirm بومی)
  // ---------------------------------------------------------------------------
  function showPopupToast(message, type = "info", duration = 4000) {
    const container = document.getElementById("popup-toast-container");
    if (!container || !message) return;
    const toast = document.createElement("div");
    toast.className = `popup-toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, duration);
  }

  function showPopupConfirm(message) {
    return new Promise((resolve) => {
      const backdrop = document.getElementById("popup-confirm-backdrop");
      const msgEl = document.getElementById("popup-confirm-message");
      const okBtn = document.getElementById("popup-confirm-ok");
      const cancelBtn = document.getElementById("popup-confirm-cancel");
      if (!backdrop || !msgEl || !okBtn || !cancelBtn) {
        resolve(window.confirm(message));
        return;
      }
      msgEl.textContent = message;
      backdrop.style.display = "flex";

      const cleanup = (result) => {
        backdrop.style.display = "none";
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        resolve(result);
      };
      okBtn.onclick = () => cleanup(true);
      cancelBtn.onclick = () => cleanup(false);
    });
  }

  // ---------------------------------------------------------------------------
  // ۱. مدیریت تب‌ها
  // ---------------------------------------------------------------------------
  const tabBtns = Array.from(document.querySelectorAll(".tab-btn"));
  const tabContents = document.querySelectorAll(".tab-content");
  const tabIndicator = document.querySelector(".tab-indicator");
  let tabShrinkTimer = null;

  function positionTabIndicator(activeBtn, animate = false) {
    if (!tabIndicator || !activeBtn) return;
    const idx = tabBtns.indexOf(activeBtn);
    if (idx < 0) return;

    const indicatorWidth = tabIndicator.offsetWidth || activeBtn.offsetWidth;
    const targetX = -idx * (indicatorWidth + 2);
    const prevIdx = tabIndicator.dataset.index;

    if (tabShrinkTimer) {
      clearTimeout(tabShrinkTimer);
      tabShrinkTimer = null;
    }

    if (!animate || prevIdx === String(idx)) {
      tabIndicator.classList.add("no-transition");
      tabIndicator.classList.remove("shrinking");
      tabIndicator.dataset.index = String(idx);
      tabIndicator.style.transform = `translateX(${targetX}px)`;
      void tabIndicator.offsetWidth;
      tabIndicator.classList.remove("no-transition");
      return;
    }

    void tabIndicator.offsetWidth;
    tabIndicator.classList.add("shrinking");
    tabIndicator.dataset.index = String(idx);
    tabIndicator.style.transform = `translateX(${targetX}px)`;

    tabShrinkTimer = setTimeout(() => {
      tabIndicator.classList.remove("shrinking");
      tabShrinkTimer = null;
    }, 240);
  }

  function switchTab(targetTabId, animate = true) {
    let targetBtn = null;
    tabBtns.forEach((b) => {
      const isActive = b.dataset.tab === targetTabId;
      b.classList.toggle("active", isActive);
      if (isActive) targetBtn = b;
    });
    tabContents.forEach((c) => {
      c.classList.toggle("active", c.id === targetTabId);
    });
    if (targetBtn) {
      positionTabIndicator(targetBtn, animate);
    }
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab, true));
  });

  window.addEventListener("resize", () => {
    if (tabShrinkTimer) return;
    const activeBtn = document.querySelector(".tab-btn.active");
    if (activeBtn) positionTabIndicator(activeBtn, false);
  });

  requestAnimationFrame(() => {
    const activeBtn = document.querySelector(".tab-btn.active");
    if (activeBtn) positionTabIndicator(activeBtn, false);
  });

  // ---------------------------------------------------------------------------
  // ۲. روش رمزنگاری
  // ---------------------------------------------------------------------------
  const modeRadios = Array.from(
    document.querySelectorAll('input[name="enc-mode"]')
  );
  const passwordGroup = document.getElementById("password-group");
  const rsaModeInfo = document.getElementById("rsa-mode-info");
  const passwordInput = document.getElementById("password");

  function getSelectedMode() {
    const checked = document.querySelector('input[name="enc-mode"]:checked');
    return checked ? checked.value : "rsa";
  }

  function updateModeUI() {
    const isRsa = getSelectedMode() === "rsa";

    passwordGroup.style.display = isRsa ? "none" : "block";
    rsaModeInfo.style.display = isRsa ? "block" : "none";

    if (isRsa) {
      passwordInput.removeAttribute("required");
      passwordInput.removeAttribute("minlength");
    } else {
      passwordInput.setAttribute("required", "");
      passwordInput.setAttribute("minlength", "8");
    }
  }

  function setSelectedMode(mode) {
    modeRadios.forEach((r) => {
      r.checked = r.value === mode;
    });
    updateModeUI();
  }

  modeRadios.forEach((radio) => {
    radio.addEventListener("change", updateModeUI);
  });

  const rsaOptionLabel = document.querySelector('input[name="enc-mode"][value="rsa"]')?.closest(".mode-option");
  rsaOptionLabel?.addEventListener("click", (e) => {
    const rsaRadio = rsaOptionLabel.querySelector('input[name="enc-mode"][value="rsa"]');
    if (rsaRadio && rsaRadio.disabled) {
      e.preventDefault();
      showPopupToast(
        "در چت‌های گروهی امکان رمزنگاری با RSA وجود ندارد؛ لطفاً از پسورد مشترک استفاده کنید.",
        "warning",
        4500
      );
    }
  });

  // ---------------------------------------------------------------------------
  // ۳. عناصر فرم
  // ---------------------------------------------------------------------------
  const chatForm = document.getElementById("chat-form");
  const submitBtn = document.getElementById("btn-submit-chat");
  const cancelEditBtn = document.getElementById("btn-cancel-edit");
  const pendingBanner = document.getElementById("pending-peer-banner");

  // ---------------------------------------------------------------------------
  // ۴. تشخیص چت فعال
  // ---------------------------------------------------------------------------
  async function findBaleTab() {
    try {
      const tabs = await chrome.tabs.query({ url: "https://web.bale.ai/*" });
      if (tabs.length) {
        return tabs.find((t) => t.active) || tabs[0];
      }
    } catch {}

    try {
      const [active] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });
      return active || null;
    } catch {
      return null;
    }
  }

  async function detectActiveTabInfo() {
    try {
      const activeTab = await findBaleTab();
      if (!activeTab || !activeTab.url) {
        return { uid: null, displayName: null, mode: null, pendingPeer: null };
      }

      if (activeTab.id) {
        try {
          const response = await chrome.tabs.sendMessage(activeTab.id, {
            action: "get_chat_info"
          });
          if (response && (response.uid || response.displayName)) {
            return response;
          }
        } catch {}
      }

      const href = activeTab.url;
      if (!href.includes("bale.ai")) {
        return { uid: null, displayName: null, mode: null, pendingPeer: null };
      }

      const queryMatch = href.match(
        /[?&#](?:uid|id|peer_id)=([0-9a-zA-Z_-]+)/i
      );
      let detectedUid = queryMatch ? queryMatch[1] : null;

      if (!detectedUid) {
        const url = new URL(href);
        detectedUid = url.searchParams.get("uid") || url.searchParams.get("id");
      }

      return {
        uid: detectedUid,
        displayName: null,
        mode: null,
        pendingPeer: null
      };
    } catch {
      return { uid: null, displayName: null, mode: null, pendingPeer: null };
    }
  }

  async function checkAndApplyChatContext() {
    const urlParams = new URLSearchParams(window.location.search);
    let targetUid = urlParams.get("uid");
    let targetDisplayName = urlParams.get("displayName");
    let targetTab = urlParams.get("tab");

    if (!targetUid) {
      const storageData = await chrome.storage.local.get([
        "pendingOpenUid",
        "pendingOpenDisplayName",
        "pendingOpenTab"
      ]);

      if (storageData.pendingOpenUid) {
        targetUid = storageData.pendingOpenUid;
        if (!targetDisplayName) {
          targetDisplayName = storageData.pendingOpenDisplayName;
        }
        if (!targetTab) targetTab = storageData.pendingOpenTab;
      }
    }

    await chrome.storage.local.remove([
      "pendingOpenUid",
      "pendingOpenDisplayName",
      "pendingOpenTab"
    ]);

    const liveInfo = await detectActiveTabInfo();
    if (!targetUid && liveInfo.uid) targetUid = liveInfo.uid;
    if (!targetDisplayName && liveInfo.displayName) {
      targetDisplayName = liveInfo.displayName;
    }
    const detectedChatType = liveInfo.chatType || "private";
    const rsaRadio = document.querySelector('input[name="enc-mode"][value="rsa"]');
    if (detectedChatType === "group" && rsaRadio) {
      rsaRadio.disabled = true;
      setSelectedMode("password");
    } else if (rsaRadio) {
      rsaRadio.disabled = false;
    }

    if (detectedChatType === "bot" || detectedChatType === "channel") {
      showPopupToast(
        "در ربات‌ها و کانال‌ها امکان رمزنگاری پیام وجود ندارد.",
        "warning",
        5000
      );
    }

    if (pendingBanner) pendingBanner.style.display = "none";

    if (!targetUid) {
      setSelectedMode("rsa");
      if (targetTab === "keys") {
        switchTab("tab-keys", false);
      } else if (targetTab === "chats-list") {
        switchTab("tab-chats-list", false);
      }
      return;
    }

    const ttlMs = await StorageManager.getKeyExchangeTtlMs();
    let pendingPeer = await StorageManager.getPendingPeer("bale", targetUid);
    if (
      pendingPeer &&
      CryptoEngine.isKeyExchangeExpired({ timestamp: pendingPeer.peerKeyTimestamp }, ttlMs)
    ) {
      await StorageManager.removePendingPeer("bale", targetUid);
      pendingPeer = null;
    }

    const chats = await StorageManager.getEncryptedChats();
    const existingChat = chats[`bale_${targetUid}`];

    if (existingChat) {
      const rawMode =
        existingChat.mode || (existingChat.password ? "password" : "rsa");
      const mode = detectedChatType === "group" ? "password" : rawMode;

      setSelectedMode(mode);
      document.getElementById("messenger").value =
        existingChat.messenger || "bale";
      document.getElementById("uid").value = existingChat.uid;
      document.getElementById("uid").readOnly = true;
      document.getElementById("displayName").value =
        existingChat.displayName || targetDisplayName || "";
      passwordInput.value = existingChat.password || "";

      submitBtn.textContent =
        mode === "rsa" ? "ارسال درخواست تبادل کلید جدید" : "بروزرسانی پسورد چت";
      cancelEditBtn.style.display = "block";

      const banner = document.getElementById("detected-uid-banner");
      if (banner) {
        banner.style.display = "flex";

        let status = `اطلاعات چت «${existingChat.displayName}» لود شد.`;
        if (mode === "rsa") {
          if (existingChat.handshakeState === CONSTANTS.HANDSHAKE_STATES.EXPIRED) {
            status = "مهلت درخواست تبادل کلید قبلی به پایان رسید.";
          } else if (!existingChat.peerPublicKey) {
            status = "درخواست تبادل کلید ارسال شده؛ منتظر تایید کاربر هدف...";
          } else if (existingChat.verified) {
            status = "تبادل کلید انجام شده و کد امنیتی تأیید شده است.";
          } else {
            status =
              "تبادل کلید فعال است. برای بررسی کد امنیتی به تب «لیست چت‌ها» بروید.";
          }
        }

        banner.querySelector("span").textContent = status;
        document.getElementById("btn-use-detected").style.display = "none";
      }

      if (pendingPeer && pendingBanner) {
        pendingBanner.style.display = "flex";
        pendingBanner.querySelector("span").textContent =
          `کاربر «${pendingPeer.displayName || existingChat.displayName || targetUid}» قصد تبادل کلید با شما را دارد.`;
      }
    } else if (pendingPeer) {
      setSelectedMode("rsa");
      document.getElementById("uid").value = targetUid;
      document.getElementById("displayName").value =
        pendingPeer.displayName || targetDisplayName || "";

      if (pendingBanner) {
        pendingBanner.style.display = "flex";
        pendingBanner.querySelector("span").textContent =
          `کاربر «${pendingPeer.displayName || targetUid}» قصد تبادل کلید با شما را دارد. آیا مایل به اشتراک‌گذاری کلید هستید؟`;
      }

    } else {
      setSelectedMode(detectedChatType === "group" ? "password" : "rsa");
      if (detectedChatType === "group") {
        const banner = document.getElementById("detected-uid-banner");
        if (banner) {
          banner.style.display = "flex";
          banner.querySelector("span").textContent = "این گفتگو یک گروه است؛ در گروه‌ها فقط رمزنگاری با کلید مشترک پشتیبانی می‌شود.";
          document.getElementById("btn-use-detected").style.display = "none";
        }
      } else if (detectedChatType === "channel" || detectedChatType === "bot") {
        const banner = document.getElementById("detected-uid-banner");
        if (banner) {
          banner.style.display = "flex";
          banner.querySelector("span").textContent = "رمزنگاری در کانال‌ها و ربات‌ها پشتیبانی نمی‌شود.";
          document.getElementById("btn-use-detected").style.display = "none";
        }
      }
      document.getElementById("uid").value = targetUid;
      if (targetDisplayName) {
        document.getElementById("displayName").value = targetDisplayName;
      }
    }

    if (targetTab === "chats-list") {
      switchTab("tab-chats-list", false);
    } else if (targetTab === "keys") {
      switchTab("tab-keys", false);
    } else {
      switchTab("tab-add-chat", false);
    }
  }

  // ---------------------------------------------------------------------------
  // ۵. تشخیص خودکار شناسه
  // ---------------------------------------------------------------------------
  document.getElementById("btn-detect-uid")?.addEventListener("click", async () => {
    if (pendingBanner) pendingBanner.style.display = "none";
    const info = await detectActiveTabInfo();

    if (info.uid) {
      document.getElementById("uid").value = info.uid;
      if (info.displayName) {
        document.getElementById("displayName").value = info.displayName;
      }
      if (info.mode === "rsa" || info.mode === "password") {
        setSelectedMode(info.mode);
      }

      const ttlMs = await StorageManager.getKeyExchangeTtlMs();
      const pending = await StorageManager.getPendingPeer("bale", info.uid);
      if (
        pending &&
        !CryptoEngine.isKeyExchangeExpired({ timestamp: pending.peerKeyTimestamp }, ttlMs) &&
        pendingBanner
      ) {
        pendingBanner.style.display = "flex";
        pendingBanner.querySelector("span").textContent =
          `کاربر «${pending.displayName || info.uid}» قصد تبادل کلید دارد.`;
      }

      showPopupToast(
        `اطلاعات چت دریافت شد.\nشناسه: ${info.uid}${
          info.displayName ? `\nنام: ${info.displayName}` : ""
        }`
      , "success");
    } else {
      showPopupToast(
        "شناسه چت در تب فعال شناسایی نشد. مطمئن شوید در صفحه گفتگوی بله هستید."
      , "warning");
    }
  });

  // ---------------------------------------------------------------------------
  // ۶. تولید رمز تصادفی قوی و نمایش/مخفی‌سازی پسورد در تب اول
  // ---------------------------------------------------------------------------
  const togglePwdBtn = document.getElementById("btn-toggle-pwd");
  const genPwdInlineBtn = document.getElementById("btn-gen-pwd-inline");

  togglePwdBtn?.addEventListener("click", () => {
    if (passwordInput.type === "password") {
      passwordInput.type = "text";
      togglePwdBtn.textContent = "🙈";
    } else {
      passwordInput.type = "password";
      togglePwdBtn.textContent = "👁️";
    }
  });

  genPwdInlineBtn?.addEventListener("click", async () => {
    const newKey = CryptoEngine.generateRandomKeyBase64();
    passwordInput.value = newKey;
    passwordInput.type = "text";
    if (togglePwdBtn) togglePwdBtn.textContent = "🙈";
    try {
      await navigator.clipboard.writeText(newKey);
      showPopupToast("رمز تصادفی قوی ساخته شد و در کلیپ‌بورد کپی گردید.\nآن را از یک کانال امن برای مخاطب بفرستید.", "success");
    } catch {
      showPopupToast("رمز تصادفی قوی در کادر قرار داده شد.", "info");
    }
  });

  // ---------------------------------------------------------------------------
  // ۷. فعال‌سازی درخواست در انتظار
  // ---------------------------------------------------------------------------
  let explicitPendingApproval = false;
  document.getElementById("btn-enable-pending")?.addEventListener("click", () => {
    explicitPendingApproval = true;
    setSelectedMode("rsa");
    chatForm.requestSubmit();
  });

  // ---------------------------------------------------------------------------
  // ۸. فرم افزودن / ویرایش چت
  // ---------------------------------------------------------------------------
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const messenger = document.getElementById("messenger").value;
    const uid = document.getElementById("uid").value.trim();
    const displayName = document.getElementById("displayName").value.trim();
    const mode = getSelectedMode();
    const password = passwordInput.value;
    const approvedViaBanner = explicitPendingApproval;
    explicitPendingApproval = false;

    if (!uid) {
      showPopupToast("لطفاً شناسه چت (UID) را وارد کنید.", "warning");
      return;
    }

    if (!displayName) {
      showPopupToast("لطفاً نام مخاطب یا عنوان چت را وارد کنید.", "warning");
      return;
    }

    const liveTabInfo = await detectActiveTabInfo();
    if (
      liveTabInfo &&
      liveTabInfo.uid &&
      String(liveTabInfo.uid) === String(uid) &&
      (liveTabInfo.chatType === "bot" || liveTabInfo.chatType === "channel")
    ) {
      showPopupToast(
        "در ربات‌ها و کانال‌ها امکان رمزنگاری وجود ندارد؛ رمزنگاری فقط برای چت‌های شخصی و گروه‌ها فعال است.",
        "error",
        5000
      );
      return;
    }

    const rsaRadioBtn = document.querySelector('input[name="enc-mode"][value="rsa"]');
    if (mode === "rsa" && (rsaRadioBtn?.disabled || (liveTabInfo?.uid === uid && liveTabInfo?.chatType === "group"))) {
      showPopupToast("در چت‌های گروهی امکان تبادل کلید RSA وجود ندارد؛ لطفاً از پسورد مشترک استفاده کنید.", "warning");
      setSelectedMode("password");
      return;
    }

    if (mode === "password" && password.length < 8) {
      showPopupToast("طول کلید/پسورد باید حداقل ۸ کاراکتر باشد.", "info");
      return;
    }

    const chats = await StorageManager.getEncryptedChats();
    const existing = chats[`${messenger}_${uid}`] || null;
    const ttlMs = await StorageManager.getKeyExchangeTtlMs();

    let fingerprint = "";
    let extra = { mode };
    let shouldTriggerAckInTab = false;
    let shouldTriggerSynInTab = false;

    if (mode === "password") {
      fingerprint = await CryptoEngine.getKeyFingerprint(password);
    } else {
      let pending =
        (existing && existing.pendingCandidate) ||
        (await StorageManager.getPendingPeer(messenger, uid));

      if (
        pending &&
        CryptoEngine.isKeyExchangeExpired({ timestamp: pending.peerKeyTimestamp }, ttlMs)
      ) {
        await StorageManager.removePendingPeer(messenger, uid);
        pending = null;
      }

      if (pending && pending.peerPublicKey && pending.peerSigningPublicKey) {
        const userConfirmed =
          approvedViaBanner ||
          await showPopupConfirm(
            `کاربر «${pending.displayName || displayName}» (اثرانگشت: ${pending.peerFingerprint}) قصد تبادل کلید دارد.\n\n` +
              "آیا می‌خواهید کلید خود را به اشتراک بگذارید تا فرایند تبادل کلید به اتمام برسد؟"
          );

        if (userConfirmed) {
          shouldTriggerAckInTab = true;
          fingerprint = pending.peerFingerprint || "";
          extra = {
            ...extra,
            handshakeState: "pending_approval",
            sessionId: pending.sessionId || null,
            peerPublicKey: null,
            peerSigningPublicKey: null,
            peerEcdhPublicKey: null,
            peerFingerprint: pending.peerFingerprint,
            pendingCandidate: pending,
            verified: false,
            keyChanged: false,
            announcedFor: null
          };
        } else {
          await StorageManager.removePendingPeer(messenger, uid);
          shouldTriggerSynInTab = true;
          fingerprint = "";
          extra = {
            ...extra,
            handshakeState: "awaiting_ack",
            sessionId: CryptoEngine.generateSessionId(),
            peerPublicKey: null,
            peerSigningPublicKey: null,
            peerEcdhPublicKey: null,
            peerFingerprint: null,
            pendingCandidate: null,
            verified: false,
            keyChanged: false,
            announcedFor: null,
            lastAnnouncedAt: Date.now()
          };
        }
      } else {
        shouldTriggerSynInTab = true;
        fingerprint = "";
        extra = {
          ...extra,
          handshakeState: "awaiting_ack",
          sessionId: CryptoEngine.generateSessionId(),
          peerPublicKey: null,
          peerSigningPublicKey: null,
          peerEcdhPublicKey: null,
          peerFingerprint: null,
          pendingCandidate: null,
          verified: false,
          keyChanged: false,
          announcedFor: null,
          lastAnnouncedAt: Date.now()
        };
      }
    }

    await StorageManager.saveChatConfig(
      messenger,
      uid,
      displayName,
      mode === "password" ? password : undefined,
      fingerprint,
      true,
      extra
    );

    if (mode === "rsa") {
      const tab = await findBaleTabForAction();
      let handshakeRes = null;
      if (tab) {
        try {
          handshakeRes = await chrome.tabs.sendMessage(tab.id, {
            action: shouldTriggerAckInTab ? "approve_peer_key" : "start_handshake",
            uid
          });
        } catch {}
      }

      if (!handshakeRes || !handshakeRes.ok) {
        // بازگردانی تغییر ذخیره‌شده تا چت نامعتبر (مثلاً گروه یا چت غیرفعال) در لیست باقی نماند
        if (existing) {
          await StorageManager.saveChatConfig(
            messenger,
            uid,
            existing.displayName,
            existing.password,
            existing.fingerprint,
            existing.enabled !== false,
            existing
          );
        } else {
          await StorageManager.removeChatConfig(messenger, uid);
        }
        await renderChatsList();
        showPopupToast(
          "تبادل کلید RSA انجام نشد. تبادل کلید فقط در چت‌های خصوصی ۱:۱ فعال در بله ممکن است.",
          "warning",
          5500
        );
        return;
      }

      if (shouldTriggerAckInTab) {
        showPopupToast(
          `اشتراک‌گذاری کلید با «${displayName}» تایید شد.\n` +
            "کلید شما ارسال و فرایند تبادل کلید به اتمام می‌رسد.",
          "success"
        );
      } else if (shouldTriggerSynInTab) {
        showPopupToast(
          `درخواست تبادل کلید برای «${displayName}» ارسال شد.\n` +
            "کاربر هدف یک پنجره پاپ‌آپ دریافت می‌کند و در صورت تایید او، فرایند به اتمام می‌رسد.",
          "success"
        );
      }
    } else {
      showPopupToast(`پسورد جدید چت «${displayName}» ذخیره شد (پسوردهای قبلی برای رمزگشایی پیام‌های قدیمی حفظ شدند).`, "success");
    }

    resetForm();
    await renderChatsList();
    switchTab("tab-chats-list");
  });

  cancelEditBtn.addEventListener("click", resetForm);

  function resetForm() {
    chatForm.reset();
    submitBtn.textContent = "ارسال درخواست تبادل کلید / ذخیره";
    cancelEditBtn.style.display = "none";
    document.getElementById("uid").readOnly = false;
    if (pendingBanner) pendingBanner.style.display = "none";
    setSelectedMode("rsa");
  }

  // ---------------------------------------------------------------------------
  // ۹. رندر و جستجو در لیست چت‌ها
  // ---------------------------------------------------------------------------
  const searchInput = document.getElementById("search-chats");

  searchInput.addEventListener("input", () => {
    renderChatsList(searchInput.value.trim().toLowerCase());
  });

  async function findBaleTabForAction() {
    const tab = await findBaleTab();
    return tab && tab.id ? tab : null;
  }

  async function retryKeyExchange(chat) {
    const tab = await findBaleTabForAction();
    if (!tab) {
      showPopupToast("لطفاً ابتدا چت را در بله باز کنید.", "warning");
      return;
    }

    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        action: "start_handshake",
        uid: chat.uid
      });

      if (res && res.ok) {
        showPopupToast("درخواست تبادل کلید جدید در چت ارسال شد.", "success");
        await renderChatsList(searchInput.value.trim().toLowerCase());
      } else {
        showPopupToast(
          "چت فعال نیست. لطفاً این گفتگو را در بله باز کنید و دوباره تلاش کنید."
        , "warning");
      }
    } catch {
      showPopupToast(
        "ارتباط با صفحه بله برقرار نشد. لطفاً صفحه را رفرش کنید و دوباره تلاش کنید."
      , "warning");
    }
  }

  async function approvePeerKeyFromPopup(chat) {
    const tab = await findBaleTabForAction();
    if (!tab) {
      showPopupToast("لطفاً ابتدا چت را در بله باز کنید تا کلید شما به اشتراک گذاشته شود.", "warning");
      return;
    }

    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        action: "approve_peer_key",
        uid: chat.uid
      });

      if (res && res.ok) {
        showPopupToast("کلید شما به اشتراک گذاشته شد و فرایند تبادل کلید به اتمام رسید.", "success");
        await renderChatsList(searchInput.value.trim().toLowerCase());
      } else {
        showPopupToast(
          "لطفاً ابتدا همین گفتگو را در تب بله باز کنید (یا مهلت زمانی درخواست به پایان رسیده است)."
        , "warning");
      }
    } catch {
      showPopupToast(
        "ارتباط با صفحه بله برقرار نشد. لطفاً صفحه بله را رفرش کنید و دوباره تلاش کنید."
      , "warning");
    }
  }


  async function revokeHandshakeFromPopup(chat) {
    if (
      !(await showPopupConfirm(
        `آیا می‌خواهید فرایند تبادل کلید با «${chat.displayName}» را لغو (باطل) کنید؟\n` +
          "پس از لغو، محدودیت ارسال پیام در این چت برداشته می‌شود و می‌توانید پیام عادی ارسال کنید."
      ))
    ) {
      return;
    }

    const tab = await findBaleTabForAction();
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: "cancel_handshake",
          uid: chat.uid
        });
      } catch {}
    }

    await StorageManager.removePendingPeer(chat.messenger, chat.uid);
    await StorageManager.removeChatConfig(chat.messenger, chat.uid);
    showPopupToast("فرایند تبادل کلید با موفقیت لغو شد.", "info");
    await renderChatsList(searchInput.value.trim().toLowerCase());
  }

  async function rejectPeerKeyFromPopup(chat) {
    const tab = await findBaleTabForAction();
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: "reject_peer_key",
          uid: chat.uid
        });
      } catch {}
    }
    await StorageManager.removePendingPeer(chat.messenger, chat.uid);
    if (!chat.peerPublicKey || chat.keyChanged) {
      await StorageManager.removeChatConfig(chat.messenger, chat.uid);
    }
    await renderChatsList(searchInput.value.trim().toLowerCase());
  }

  async function renderChatsList(filterQuery = "") {
    const listEl = document.getElementById("chats-list");
    const countBadge = document.getElementById("chats-count");
    const chats = await StorageManager.getEncryptedChats();
    const entries = Object.values(chats);

    if (countBadge) countBadge.textContent = String(entries.length);

    if (entries.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">💬</span>
          <p>هیچ چتی برای رمزنگاری ثبت نشده است.</p>
          <small>از تب «افزودن چت» اولین چت خود را اضافه کنید.</small>
        </div>
      `;
      return;
    }

    const filtered = entries.filter((c) => {
      if (!filterQuery) return true;
      return (
        (c.displayName && c.displayName.toLowerCase().includes(filterQuery)) ||
        (c.uid && c.uid.includes(filterQuery)) ||
        (c.fingerprint && c.fingerprint.toLowerCase().includes(filterQuery)) ||
        (c.peerFingerprint &&
          c.peerFingerprint.toLowerCase().includes(filterQuery))
      );
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `<p style="color:#64748b; font-size:11.5px; text-align:center; padding:16px;">موردی یافت نشد.</p>`;
      return;
    }

    let identity = null;
    try {
      identity = await IdentityManager.getIdentity();
    } catch {}

    listEl.innerHTML = "";

    for (const chat of filtered) {
      const mode = chat.mode || (chat.password ? "password" : "rsa");
      const isRsa = mode === "rsa";
      const hsState =
        chat.handshakeState ||
        (chat.keyChanged
          ? "key_changed"
          : chat.pendingCandidate && !chat.peerPublicKey
          ? "pending_approval"
          : chat.peerPublicKey
          ? "active"
          : "awaiting_ack");

      let safetyNumber = "";
      if (
        isRsa &&
        identity &&
        chat.peerPublicKey &&
        chat.peerSigningPublicKey &&
        hsState === "active"
      ) {
        try {
          safetyNumber = await CryptoEngine.computeSafetyNumber(identity, {
            encryptionPublicKeySpki: chat.peerPublicKey,
            signingPublicKeySpki: chat.peerSigningPublicKey,
            chatUid: chat.uid
          });
        } catch {}
      }

      let statusBadge = "";
      if (isRsa) {
        if (hsState === "expired") {
          statusBadge = `<span class="status-badge key-change">⌛ مهلت درخواست تبادل کلید به پایان رسید</span>`;
        } else if (hsState === "key_changed" || chat.keyChanged) {
          statusBadge = `<span class="status-badge key-change">🔐 درخواست تبادل کلید جدید از مخاطب (در انتظار تایید)</span>`;
        } else if (hsState === "pending_approval") {
          statusBadge = `<span class="status-badge waiting">🔐 درخواست تبادل کلید از مخاطب (در انتظار تایید شما)</span>`;
        } else if (hsState === "awaiting_ack" || !chat.peerPublicKey) {
          statusBadge = `<span class="status-badge waiting">⏳ منتظر تایید کاربر هدف در پنجره پاپ‌آپ</span>`;
        } else if (chat.verified) {
          statusBadge = `<span class="status-badge verified">✅ تبادل کلید به اتمام رسید (تأیید شده)</span>`;
        } else {
          statusBadge = `<span class="status-badge unverified">🔒 تبادل کلید به اتمام رسید (فعال)</span>`;
        }
      }

      const safetyBlock = safetyNumber
        ? `
          <div class="safety-block">
            <div class="safety-label">کد امنیتی (با مخاطب مقایسه کنید):</div>
            <code class="safety-number">${escapeHtml(safetyNumber)}</code>
            ${
              chat.verified
                ? ""
                : `<button type="button" class="btn small verify-btn">تأیید کردم</button>`
            }
          </div>
        `
        : "";

      let actionBlock = "";
      if (isRsa) {
        if (hsState === "pending_approval" || hsState === "key_changed" || chat.keyChanged) {
          const candFp =
            chat.pendingCandidate?.peerFingerprint || chat.peerFingerprint || "";
          actionBlock = `
            <div class="action-row">
              <button type="button" class="btn small approve-peer-btn">✅ اشتراک کلید (${escapeHtml(candFp)})</button>
              <button type="button" class="btn small reject-peer-btn">❌ رد درخواست</button>
            </div>
          `;
        } else if (hsState === "awaiting_ack" || hsState === "expired" || !chat.peerPublicKey) {
          actionBlock = `
            <button type="button" class="btn small retry-btn">🔑 ارسال درخواست تبادل کلید جدید</button>
            <button type="button" class="btn small revoke-btn">❌ لغو و ابطال تبادل کلید</button>
          `;
        } else if (hsState === "active") {
          actionBlock = `<button type="button" class="btn small retry-btn">🔄 درخواست تبادل کلید مجدد (تعویض کلید)</button>`;
        }
      }

      const card = document.createElement("div");
      card.className = "chat-card";
      card.innerHTML = `
        <div class="chat-card-top">
          <div>
            <div class="chat-card-title">
              ${escapeHtml(chat.displayName)}
              <span class="mode-badge ${isRsa ? "rsa" : "password"}">${
        isRsa ? "RSA" : "پسورد"
      }</span>
            </div>
            <div class="chat-card-meta">شناسه: ${escapeHtml(chat.uid)}</div>
          </div>
          <div class="chat-card-actions">
            <button type="button" class="action-icon-btn edit-btn" title="ویرایش">✏️</button>
            <button type="button" class="action-icon-btn del-btn" title="حذف">🗑️</button>
          </div>
        </div>
        ${statusBadge ? `<div class="chat-card-status">${statusBadge}</div>` : ""}
        ${safetyBlock}
        ${actionBlock}
        <div class="chat-card-bottom">
          <div class="fp-badge" title="Fingerprint">${
            isRsa
              ? `FP: ${escapeHtml(
                  chat.peerFingerprint ||
                    chat.pendingCandidate?.peerFingerprint ||
                    "---"
                )}`
              : `FP: ${escapeHtml(chat.fingerprint || "---")}`
          }</div>
          <label class="toggle-switch" title="روشن/خاموش کردن رمزنگاری در این چت">
            <span>${chat.enabled !== false ? "فعال" : "غیرفعال"}</span>
            <input type="checkbox" ${chat.enabled !== false ? "checked" : ""}>
            <span class="switch-slider"></span>
          </label>
        </div>
      `;

      card.querySelector(".edit-btn").onclick = () => {
        if (pendingBanner) pendingBanner.style.display = "none";
        setSelectedMode(mode);
        document.getElementById("messenger").value = chat.messenger;
        document.getElementById("uid").value = chat.uid;
        document.getElementById("uid").readOnly = true;
        document.getElementById("displayName").value = chat.displayName;
        passwordInput.value = chat.password || "";

        submitBtn.textContent = "بروزرسانی تغییرات چت";
        cancelEditBtn.style.display = "block";
        switchTab("tab-add-chat");
      };

      card.querySelector(".del-btn").onclick = async () => {
        if (await showPopupConfirm(`آیا چت «${chat.displayName}» از لیست رمزنگاری حذف شود؟`)) {
          await StorageManager.removeChatConfig(chat.messenger, chat.uid);
          await StorageManager.removePendingPeer(chat.messenger, chat.uid);
          await renderChatsList(searchInput.value.trim().toLowerCase());
        }
      };

      const toggleInput = card.querySelector(".toggle-switch input");
      toggleInput.onchange = async () => {
        const newState = await StorageManager.toggleChatEnabled(
          chat.messenger,
          chat.uid
        );
        chat.enabled = newState;
        card.querySelector(".toggle-switch span").textContent = newState
          ? "فعال"
          : "غیرفعال";
      };

      const verifyBtn = card.querySelector(".verify-btn");
      if (verifyBtn) {
        verifyBtn.onclick = async () => {
          if (
            !await showPopupConfirm(
              "آیا کد امنیتی را با مخاطب خود مقایسه کرده‌اید و مطابقت دارد؟"
            )
          ) {
            return;
          }
          await StorageManager.updateChatConfig(chat.messenger, chat.uid, {
            verified: true,
            keyChanged: false
          });
          await renderChatsList(searchInput.value.trim().toLowerCase());
        };
      }

      const approveBtn = card.querySelector(".approve-peer-btn");
      if (approveBtn) {
        approveBtn.onclick = () => approvePeerKeyFromPopup(chat);
      }

      const rejectBtn = card.querySelector(".reject-peer-btn");
      if (rejectBtn) {
        rejectBtn.onclick = () => rejectPeerKeyFromPopup(chat);
      }

      const retryBtn = card.querySelector(".retry-btn");
      if (retryBtn) {
        retryBtn.onclick = () => retryKeyExchange(chat);
      }

      const revokeBtn = card.querySelector(".revoke-btn");
      if (revokeBtn) {
        revokeBtn.onclick = () => revokeHandshakeFromPopup(chat);
      }

      listEl.appendChild(card);
    }
  }

  // ---------------------------------------------------------------------------
  // ۱۰. تب امنیت و پشتیبان‌گیری (تعویض هویت، Export/Import رمزنگاری‌شده و تنظیم زمان انقضا)
  // ---------------------------------------------------------------------------

  document.getElementById("btn-rotate-identity")?.addEventListener("click", async () => {
    if (
      !await showPopupConfirm(
        "آیا مطمئن هستید که می‌خواهید کلید هویت RSA خود را تعویض کنید؟\n" +
          "کلید قبلی در تاریخچه محلی برای خواندن پیام‌های قدیم حفظ می‌شود و برای ارسال پیام جدید باید دوباره تبادل کلید انجام دهید."
      )
    ) {
      return;
    }

    const fpEl = document.getElementById("identity-fingerprint");
    if (fpEl) fpEl.textContent = "در حال تولید کلید جدید...";

    try {
      const newIdentity = await IdentityManager.regenerateIdentity();
      const resetCount = await StorageManager.resetRsaChatsForIdentityRotation();
      await renderChatsList(searchInput.value.trim().toLowerCase());

      const baleTab = await findBaleTabForAction();
      if (baleTab) {
        try {
          await chrome.tabs.sendMessage(baleTab.id, { action: "sync_after_backup" });
        } catch {}
      }

      if (fpEl) fpEl.textContent = newIdentity.fingerprint;
      showPopupToast(
        resetCount > 0
          ? `کلید هویت جدید ساخته شد (${newIdentity.fingerprint}).\n${resetCount} چت RSA برای تبادل کلید مجدد بازنشانی شدند.`
          : `کلید هویت جدید با موفقیت ساخته شد.\nاثرانگشت جدید: ${newIdentity.fingerprint}`,
        "success",
        5500
      );
    } catch (err) {
      showPopupToast(`خطا در تعویض کلید هویت: ${err.message}`, "warning");
      renderIdentityFingerprint();
    }
  });

  // پشتیبان‌گیری و بازیابی رمزنگاری‌شده
  const backupPwdInput = document.getElementById("backup-password");
  const toggleBackupPwdBtn = document.getElementById("btn-toggle-backup-pwd");
  const backupStatusEl = document.getElementById("backup-status");

  function showBackupStatus(message, isError = false) {
    showPopupToast(message, isError ? "error" : "success", 5000);
    if (!backupStatusEl) return;
    backupStatusEl.style.display = "block";
    backupStatusEl.className = `backup-status ${isError ? "error" : "success"}`;
    backupStatusEl.textContent = message;
    try {
      backupStatusEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch {}
  }

  toggleBackupPwdBtn?.addEventListener("click", () => {
    if (!backupPwdInput) return;
    if (backupPwdInput.type === "password") {
      backupPwdInput.type = "text";
      toggleBackupPwdBtn.textContent = "🙈";
    } else {
      backupPwdInput.type = "password";
      toggleBackupPwdBtn.textContent = "👁️";
    }
  });

  document.getElementById("btn-export-backup")?.addEventListener("click", async () => {
    const pwd = backupPwdInput ? backupPwdInput.value : "";
    if (!pwd || pwd.length < 8) {
      if (backupPwdInput) {
        backupPwdInput.classList.add("input-error");
        backupPwdInput.focus();
      }
      showBackupStatus("⚠️ رمز فایل پشتیبان ضعیف است! لطفاً یک رمز حداقل ۸ کاراکتری وارد کنید.", true);
      return;
    }
    if (backupPwdInput) backupPwdInput.classList.remove("input-error");

    try {
      const identity = await IdentityManager.getIdentity();
      const encryptedChats = await StorageManager.getEncryptedChats();
      const recoveredPeerKeys = await StorageManager.getAllRecoveredPeerKeys();
      const ttlMinutes = 10;

      const rawPayload = JSON.stringify({
        format: "pardag-backup-v1",
        exportedAt: Date.now(),
        identity,
        encryptedChats,
        recoveredPeerKeys,
        keyExchangeTtlMinutes: ttlMinutes
      });

      const encryptedBlob = await CryptoEngine.encrypt(rawPayload, pwd);
      const fileContent = JSON.stringify(
        {
          app: "Pardag E2EE",
          version: 1,
          fingerprint: identity.fingerprint,
          createdAt: new Date().toISOString(),
          payload: encryptedBlob
        },
        null,
        2
      );

      const blob = new Blob([fileContent], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `pardag-backup-${identity.fingerprint}-${dateStr}.pardag`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      await chrome.storage.local.set({ backupCompleted: true });
      const remBanner = document.getElementById("backup-reminder-banner");
      if (remBanner) remBanner.style.display = "none";
      showBackupStatus(
        `✅ فایل پشتیبان رمزنگاری‌شده با موفقیت دانلود شد (اثرانگشت: ${identity.fingerprint}).`
      );
    } catch (err) {
      showBackupStatus(`❌ خطا در ساخت فایل پشتیبان: ${err.message}`, true);
    }
  });

  const backupModeBtns = document.querySelectorAll(".backup-mode-btn");
  const exportPanel = document.getElementById("backup-panel-export");
  const importPanel = document.getElementById("backup-panel-import");

  backupModeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.backupMode;
      backupModeBtns.forEach((b) => b.classList.toggle("active", b === btn));
      if (exportPanel) exportPanel.style.display = mode === "export" ? "flex" : "none";
      if (importPanel) importPanel.style.display = mode === "import" ? "flex" : "none";
    });
  });

  document.getElementById("import-backup-file")?.addEventListener("change", (e) => {
    const file = e.target?.files?.[0];
    const label = document.getElementById("import-file-label");
    const nameEl = document.getElementById("import-file-name");
    if (!label || !nameEl) return;
    if (file) {
      nameEl.textContent = file.name;
      label.classList.add("has-file");
    } else {
      nameEl.textContent = "انتخاب فایل پشتیبان";
      label.classList.remove("has-file");
    }
  });

  document.getElementById("btn-import-backup")?.addEventListener("click", async () => {
    const fileInput = document.getElementById("import-backup-file");
    const file = fileInput?.files?.[0];
    if (!file) {
      showBackupStatus("لطفاً ابتدا فایل پشتیبان (.pardag) را انتخاب کنید.", true);
      return;
    }

    const pwd = backupPwdInput ? backupPwdInput.value : "";
    if (!pwd || pwd.length < 8) {
      showBackupStatus("لطفاً رمز عبور فایل پشتیبان را وارد کنید.", true);
      backupPwdInput?.focus();
      return;
    }

    try {
      const text = await file.text();
      let encryptedPayload = text.trim();
      if (encryptedPayload.startsWith("{")) {
        const wrapper = JSON.parse(encryptedPayload);
        encryptedPayload = wrapper.payload;
      }

      if (!encryptedPayload) {
        throw new Error("فرمت فایل پشتیبان نامعتبر است.");
      }

      const decryptedJson = await CryptoEngine.decrypt(encryptedPayload, pwd);
      const parsed = JSON.parse(decryptedJson);

      if (!parsed || parsed.format !== "pardag-backup-v1" || !IdentityManager.isValid(parsed.identity)) {
        throw new Error("محتوای فایل پشتیبان معتبر نیست.");
      }

      if (
        !await showPopupConfirm(
          `فایل پشتیبان با اثرانگشت ${parsed.identity.fingerprint} تایید شد.\n` +
            "آیا مطمئن هستید که می‌خواهید هویت و تنظیمات چت‌های ذخیره‌شده بازیابی شوند؟"
        )
      ) {
        return;
      }

      const toStore = {
        [CONSTANTS.STORAGE_KEYS.IDENTITY]: parsed.identity,
        [CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS]: parsed.encryptedChats || {},
        [CONSTANTS.STORAGE_KEYS.RECOVERED_PEER_KEYS]: parsed.recoveredPeerKeys || {}
      };

      await chrome.storage.local.set(toStore);
      IdentityManager.clearCache();

      renderIdentityFingerprint();
  await initOnboardingCard();
  await initBackupReminder();
      await renderChatsList();

      let syncedLive = false;
      const baleTab = await findBaleTabForAction();
      if (baleTab) {
        try {
          const res = await chrome.tabs.sendMessage(baleTab.id, {
            action: "sync_after_backup"
          });
          if (res && res.ok) syncedLive = true;
        } catch {}
      }

      showBackupStatus(
        syncedLive
          ? `✅ هویت (${parsed.identity.fingerprint}) و چت‌ها بازیابی و صفحه بله به‌صورت خودکار همگام‌سازی شد.`
          : `✅ هویت (${parsed.identity.fingerprint}) و چت‌ها با موفقیت بازیابی شدند.`
      );
    } catch {
      showBackupStatus("❌ رمز عبور اشتباه است یا فایل پشتیبان آسیب دیده است.", true);
    }
  });

  // ---------------------------------------------------------------------------
  // ۱۱. نمایش اثر انگشت هویت
  // ---------------------------------------------------------------------------
  function renderIdentityFingerprint() {
    IdentityManager.getIdentity()
      .then((identity) => {
        const el = document.getElementById("identity-fingerprint");
        if (el) el.textContent = identity.fingerprint;
      })
      .catch(() => {
        const el = document.getElementById("identity-fingerprint");
        if (el) el.textContent = "خطا در ساخت کلید";
      });
  }

  function escapeHtml(str) {
    if (!str) return "";
    const p = document.createElement("p");
    p.textContent = str;
    return p.innerHTML;
  }


  // ---------------------------------------------------------------------------
  // ۱۲. راهنمای چندمرحله‌ای اولین نصب (Onboarding Wizard)
  // ---------------------------------------------------------------------------
  async function initOnboardingCard() {
    const backdrop = document.getElementById("onboarding-wizard-backdrop");
    const prevBtn = document.getElementById("wizard-prev-btn");
    const nextBtn = document.getElementById("wizard-next-btn");
    if (!backdrop || !prevBtn || !nextBtn) return;

    const prefs = await chrome.storage.local.get([
      "onboardingCompleted",
      "onboardingDismissed"
    ]);
    if (prefs.onboardingCompleted || prefs.onboardingDismissed) {
      backdrop.style.display = "none";
      return;
    }

    const tabs = Array.from(backdrop.querySelectorAll(".wizard-step-tab"));
    const panes = Array.from(backdrop.querySelectorAll(".wizard-pane"));
    const totalSteps = panes.length;
    let currentStep = 0;

    const renderStep = () => {
      tabs.forEach((tab, idx) => {
        tab.classList.toggle("active", idx === currentStep);
        tab.classList.toggle("done", idx < currentStep);
      });
      panes.forEach((pane, idx) => {
        pane.classList.toggle("active", idx === currentStep);
      });
      prevBtn.style.display = currentStep > 0 ? "inline-flex" : "none";
      nextBtn.textContent = currentStep === totalSteps - 1 ? "پایان" : "بعدی";
    };

    prevBtn.onclick = () => {
      if (currentStep > 0) {
        currentStep -= 1;
        renderStep();
      }
    };

    nextBtn.onclick = async () => {
      if (currentStep < totalSteps - 1) {
        currentStep += 1;
        renderStep();
      } else {
        backdrop.style.display = "none";
        await chrome.storage.local.set({
          onboardingCompleted: true,
          onboardingDismissed: true
        });
      }
    };

    renderStep();
    backdrop.style.display = "flex";
  }


  async function initBackupReminder() {
    const banner = document.getElementById("backup-reminder-banner");
    const goBtn = document.getElementById("btn-go-backup");
    const dismissBtn = document.getElementById("btn-dismiss-backup-reminder");
    if (!banner) return;

    const [chats, prefs] = await Promise.all([
      StorageManager.getEncryptedChats(),
      chrome.storage.local.get(["backupCompleted", "backupReminderDismissed"])
    ]);

    const hasActiveRsa = Object.values(chats || {}).some(
      (c) => c && c.mode === "rsa" && c.handshakeState === "active" && c.peerPublicKey
    );

    if (hasActiveRsa && !prefs.backupCompleted && !prefs.backupReminderDismissed) {
      banner.style.display = "flex";
    }

    goBtn?.addEventListener("click", () => {
      switchTab("tab-keys");
      document.getElementById("backup-password")?.focus();
    });

    dismissBtn?.addEventListener("click", async () => {
      banner.style.display = "none";
      await chrome.storage.local.set({ backupReminderDismissed: true });
    });
  }

  // ---------------------------------------------------------------------------
  // راه‌اندازی
  // ---------------------------------------------------------------------------
  updateModeUI();
  await checkAndApplyChatContext();
  await initOnboardingCard();
  await initBackupReminder();
  await renderChatsList();
  renderIdentityFingerprint();
  const activeTabBtn = document.querySelector(".tab-btn.active");
  if (activeTabBtn) positionTabIndicator(activeTabBtn, false);
  window.scrollTo(0, 0);
});
