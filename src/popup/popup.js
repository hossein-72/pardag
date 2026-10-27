import { StorageManager } from '../shared/storage.js';
import { IdentityManager } from '../shared/identity.js';
import { CryptoEngine } from '../content/crypto/crypto.js';

document.addEventListener("DOMContentLoaded", async () => {
  // ---------------------------------------------------------------------------
  // ۱. مدیریت تب‌ها
  // ---------------------------------------------------------------------------
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  function switchTab(targetTabId) {
    tabBtns.forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === targetTabId);
    });
    tabContents.forEach((c) => {
      c.classList.toggle("active", c.id === targetTabId);
    });
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
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

    // اطلاعات انتقالی سرویس‌ورکر در هر حالت فقط یک‌بار مصرف می‌شود.
    await chrome.storage.local.remove([
      "pendingOpenUid",
      "pendingOpenDisplayName",
      "pendingOpenTab"
    ]);

    if (!targetUid || !targetDisplayName) {
      const liveInfo = await detectActiveTabInfo();
      if (!targetUid && liveInfo.uid) targetUid = liveInfo.uid;
      if (!targetDisplayName && liveInfo.displayName) {
        targetDisplayName = liveInfo.displayName;
      }
    }

    if (pendingBanner) pendingBanner.style.display = "none";

    if (!targetUid) {
      setSelectedMode("rsa");
      return;
    }

    const pendingPeer = await StorageManager.getPendingPeer("bale", targetUid);
    const chats = await StorageManager.getEncryptedChats();
    const existingChat = chats[`bale_${targetUid}`];

    if (existingChat) {
      const mode =
        existingChat.mode || (existingChat.password ? "password" : "rsa");

      setSelectedMode(mode);
      document.getElementById("messenger").value =
        existingChat.messenger || "bale";
      document.getElementById("uid").value = existingChat.uid;
      document.getElementById("uid").readOnly = true;
      document.getElementById("displayName").value =
        existingChat.displayName || targetDisplayName || "";
      passwordInput.value = existingChat.password || "";

      submitBtn.textContent = "بروزرسانی تغییرات چت";
      cancelEditBtn.style.display = "block";

      const banner = document.getElementById("detected-uid-banner");
      if (banner) {
        banner.style.display = "flex";

        let status = `اطلاعات چت «${existingChat.displayName}» لود شد.`;
        if (mode === "rsa") {
          if (!existingChat.peerPublicKey) {
            status = "رمزنگاری خودکار فعال است؛ در انتظار کلید امنیتی مخاطب...";
          } else if (existingChat.verified) {
            status = "رمزنگاری خودکار فعال و کد امنیتی تأیید شده است.";
          } else {
            status =
              "رمزنگاری خودکار فعال است. برای بررسی کد امنیتی به تب «لیست چت‌ها» بروید.";
          }
        }

        banner.querySelector("span").textContent = status;
        document.getElementById("btn-use-detected").style.display = "none";
      }

      if (pendingPeer && mode !== "rsa" && pendingBanner) {
        pendingBanner.style.display = "flex";
        pendingBanner.querySelector("span").textContent =
          "مخاطب شما رمزنگاری خودکار را فعال کرده است. برای ادامه، روش رمزنگاری را تغییر دهید.";
      }
    } else if (pendingPeer) {
      setSelectedMode("rsa");
      document.getElementById("uid").value = targetUid;
      document.getElementById("displayName").value =
        pendingPeer.displayName || targetDisplayName || "";

      if (pendingBanner) {
        pendingBanner.style.display = "flex";
        pendingBanner.querySelector("span").textContent =
          `مخاطب «${pendingPeer.displayName || targetUid}» رمزنگاری خودکار را فعال کرده است.`;
      }

      submitBtn.focus();
    } else {
      setSelectedMode("rsa");
      document.getElementById("uid").value = targetUid;
      if (targetDisplayName) {
        document.getElementById("displayName").value = targetDisplayName;
      }
      submitBtn.focus();
    }

    if (targetTab === "chats-list") {
      switchTab("tab-chats-list");
    } else {
      switchTab("tab-add-chat");
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

      const pending = await StorageManager.getPendingPeer("bale", info.uid);
      if (pending && pendingBanner) {
        pendingBanner.style.display = "flex";
        pendingBanner.querySelector("span").textContent =
          `مخاطب «${pending.displayName || info.uid}» رمزنگاری خودکار را فعال کرده است.`;
      }

      alert(
        `اطلاعات چت دریافت شد.\nشناسه: ${info.uid}${
          info.displayName ? `\nنام: ${info.displayName}` : ""
        }`
      );
    } else {
      alert(
        "شناسه چت در تب فعال شناسایی نشد. مطمئن شوید در صفحه گفتگوی بله هستید."
      );
    }
  });

  // ---------------------------------------------------------------------------
  // ۶. نمایش / مخفی‌سازی پسورد
  // ---------------------------------------------------------------------------
  const togglePwdBtn = document.getElementById("btn-toggle-pwd");

  togglePwdBtn.addEventListener("click", () => {
    if (passwordInput.type === "password") {
      passwordInput.type = "text";
      togglePwdBtn.textContent = "🙈";
    } else {
      passwordInput.type = "password";
      togglePwdBtn.textContent = "👁️";
    }
  });

  // ---------------------------------------------------------------------------
  // ۷. فعال‌سازی درخواست در انتظار
  // ---------------------------------------------------------------------------
  document.getElementById("btn-enable-pending")?.addEventListener("click", () => {
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

    if (!uid) {
      alert("لطفاً شناسه چت (UID) را وارد کنید.");
      return;
    }

    if (!displayName) {
      alert("لطفاً نام مخاطب یا عنوان چت را وارد کنید.");
      return;
    }

    if (mode === "password" && password.length < 8) {
      alert("طول کلید/پسورد باید حداقل ۸ کاراکتر باشد.");
      return;
    }

    const chats = await StorageManager.getEncryptedChats();
    const existing = chats[`${messenger}_${uid}`] || null;

    let fingerprint = "";
    let extra = { mode };

    if (mode === "password") {
      fingerprint = await CryptoEngine.getKeyFingerprint(password);
    } else {
      let peerData = {
        peerPublicKey: (existing && existing.peerPublicKey) || null,
        peerSigningPublicKey:
          (existing && existing.peerSigningPublicKey) || null,
        peerFingerprint: (existing && existing.peerFingerprint) || null,
        peerKeyReceivedAt: (existing && existing.peerKeyReceivedAt) || null,
        verified: Boolean(existing && existing.verified),
        keyChanged: Boolean(existing && existing.keyChanged),
        announcedFor: (existing && existing.announcedFor) || null
      };

      const pending = await StorageManager.getPendingPeer(messenger, uid);
      if (pending && pending.peerPublicKey && pending.peerSigningPublicKey) {
        const pendingDiffers =
          !peerData.peerPublicKey ||
          pending.peerPublicKey !== peerData.peerPublicKey ||
          pending.peerSigningPublicKey !== peerData.peerSigningPublicKey ||
          pending.peerFingerprint !== peerData.peerFingerprint;

        if (pendingDiffers) {
          // کلید تازه‌تر مخاطب که در حالت پسورد دریافت شده بود را ترجیح می‌دهیم.
          peerData = {
            peerPublicKey: pending.peerPublicKey,
            peerSigningPublicKey: pending.peerSigningPublicKey,
            peerFingerprint: pending.peerFingerprint,
            peerKeyReceivedAt: Date.now(),
            verified: false,
            keyChanged: Boolean(peerData.peerPublicKey),
            announcedFor: null
          };
        }
      }

      fingerprint = peerData.peerFingerprint || "";
      extra = { ...extra, ...peerData };
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
      await StorageManager.removePendingPeer(messenger, uid);
    }

    if (mode === "rsa") {
      alert(
        `چت «${displayName}» با رمزنگاری خودکار فعال شد.\n` +
          "کلید امنیتی شما به‌طور خودکار در چت ارسال می‌شود.\n" +
          "برای تکمیل، مخاطب نیز باید افزونه را داشته باشد و چت را باز کند."
      );
    } else {
      alert(`چت «${displayName}» با موفقیت ذخیره و فعال شد.`);
    }

    resetForm();
    await renderChatsList();
    switchTab("tab-chats-list");
  });

  cancelEditBtn.addEventListener("click", resetForm);

  function resetForm() {
    chatForm.reset();
    submitBtn.textContent = "ذخیره و فعال‌سازی رمزنگاری";
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
      alert("لطفاً ابتدا چت را در بله باز کنید.");
      return;
    }

    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        action: "retry_handshake",
        uid: chat.uid
      });

      if (res && res.ok) {
        alert("درخواست تبادل کلید ارسال شد.");
      } else {
        alert(
          "چت فعال نیست. لطفاً این گفتگو را در بله باز کنید و دوباره تلاش کنید."
        );
      }
    } catch {
      alert(
        "ارتباط با صفحه بله برقرار نشد. لطفاً صفحه را رفرش کنید و دوباره تلاش کنید."
      );
    }
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

      let safetyNumber = "";
      if (
        isRsa &&
        identity &&
        chat.peerPublicKey &&
        chat.peerSigningPublicKey
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
        if (!chat.peerPublicKey) {
          statusBadge = `<span class="status-badge waiting">⏳ در انتظار کلید مخاطب</span>`;
        } else if (chat.keyChanged) {
          statusBadge = `<span class="status-badge key-change">⚠️ کلید مخاطب تغییر کرده</span>`;
        } else if (chat.verified) {
          statusBadge = `<span class="status-badge verified">✅ تأیید شده</span>`;
        } else {
          statusBadge = `<span class="status-badge unverified">🔓 تأیید نشده</span>`;
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

      const retryBlock =
        isRsa && !chat.peerPublicKey
          ? `<button type="button" class="btn small retry-btn">تلاش مجدد برای دریافت کلید</button>`
          : "";

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
        ${retryBlock}
        <div class="chat-card-bottom">
          <div class="fp-badge" title="Fingerprint">${
            isRsa
              ? `FP: ${escapeHtml(chat.peerFingerprint || "---")}`
              : `FP: ${escapeHtml(chat.fingerprint || "---")}`
          }</div>
          <label class="toggle-switch" title="روشن/خاموش کردن رمزنگاری در این چت">
            <span>${chat.enabled !== false ? "فعال" : "غیرفعال"}</span>
            <input type="checkbox" ${chat.enabled !== false ? "checked" : ""}>
            <span class="switch-slider"></span>
          </label>
        </div>
      `;

      // ویرایش
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

      // حذف
      card.querySelector(".del-btn").onclick = async () => {
        if (confirm(`آیا چت «${chat.displayName}» از لیست رمزنگاری حذف شود؟`)) {
          await StorageManager.removeChatConfig(chat.messenger, chat.uid);
          await StorageManager.removePendingPeer(chat.messenger, chat.uid);
          await renderChatsList(searchInput.value.trim().toLowerCase());
        }
      };

      // تغییر وضعیت سوئیچ
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

      // تأیید کد امنیتی
      const verifyBtn = card.querySelector(".verify-btn");
      if (verifyBtn) {
        verifyBtn.onclick = async () => {
          if (
            !confirm(
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

      // تلاش مجدد برای تبادل کلید
      const retryBtn = card.querySelector(".retry-btn");
      if (retryBtn) {
        retryBtn.onclick = () => retryKeyExchange(chat);
      }

      listEl.appendChild(card);
    }
  }

  // ---------------------------------------------------------------------------
  // ۱۰. تولید کلید و تست‌ها
  // ---------------------------------------------------------------------------
  const genKeyBtn = document.getElementById("btn-gen-key");
  const genKeyInput = document.getElementById("generated-key");
  const fpCode = document.getElementById("key-fingerprint");

  genKeyBtn.addEventListener("click", async () => {
    const newKey = CryptoEngine.generateRandomKeyBase64();
    genKeyInput.value = newKey;
    fpCode.textContent = await CryptoEngine.getKeyFingerprint(newKey);
  });

  document.getElementById("btn-copy-key").addEventListener("click", () => {
    if (!genKeyInput.value) return;
    navigator.clipboard.writeText(genKeyInput.value);
    alert("کلید با موفقیت در کلیپ‌بورد کپی شد.");
  });

  document.getElementById("btn-test-crypto").addEventListener("click", async () => {
    const out = document.getElementById("test-result");
    out.textContent =
      "در حال اجرای اشتقاق PBKDF2 (۶۰۰٬۰۰۰ دور) و رمزنگاری AES-256-GCM...";

    try {
      const testPass =
        genKeyInput.value || "sample-test-vector-pass-2026";
      const samplePlaintext =
        "سلام! این یک پیام آزمایشی فوق‌محرمانه است 🔒\nخط دوم با کاراکترهای فارسی و خط جدید.";
      const t0 = performance.now();

      const fp = await CryptoEngine.getKeyFingerprint(testPass);
      const encrypted = await CryptoEngine.encrypt(samplePlaintext, testPass);
      const decrypted = await CryptoEngine.decrypt(encrypted, testPass);
      const t1 = performance.now();

      const passed = decrypted === samplePlaintext;
      out.textContent = [
        `وضعیت تست: ${passed ? "✅ موفق (PASS)" : "❌ ناموفق (FAIL)"}`,
        `مدت زمان اجرا: ${(t1 - t0).toFixed(1)} میلی‌ثانیه`,
        `اثر انگشت کلید: ${fp}`,
        `طول Ciphertext: ${encrypted.length} کاراکتر`,
        `پیش‌نمایش رمزشده: ${encrypted.substring(0, 40)}...`,
        `متن رمزگشایی‌شده: ${decrypted}`
      ].join("\n");
    } catch (err) {
      out.textContent = `❌ خطا در تست: ${err.message}`;
    }
  });

  document.getElementById("btn-test-rsa").addEventListener("click", async () => {
    const out = document.getElementById("rsa-test-result");
    out.textContent =
      "در حال تولید کلیدهای RSA/ECDSA و اجرای تست رمزنگاری هیبریدی...";

    try {
      const [identityA, identityB] = await Promise.all([
        CryptoEngine.generateIdentity(),
        CryptoEngine.generateIdentity()
      ]);
      const message =
        "سلام! این یک پیام آزمایشی RSA است 🔐\nخط دوم با متن فارسی.";

      const t0 = performance.now();
      const encrypted = await CryptoEngine.encryptHybrid(message, {
        peerEncryptionPublicKeySpki: identityB.encryption.publicKeySpki,
        ownEncryptionPublicKeySpki: identityA.encryption.publicKeySpki,
        ownSigningPrivateKeyJwk: identityA.signing.privateKeyJwk,
        senderFingerprint: identityA.fingerprint
      });

      const result = await CryptoEngine.decryptHybrid(encrypted, {
        privateKeyJwk: identityB.encryption.privateKeyJwk,
        signingPublicKeySpki: identityA.signing.publicKeySpki
      });

      const t1 = performance.now();
      const passed = result.plaintext === message;

      // آزمون تشخیص دستکاری
      let tamperDetected = false;
      try {
        const tampered = encrypted.slice(0, -6) + "AAAAAA";
        await CryptoEngine.decryptHybrid(tampered, {
          privateKeyJwk: identityB.encryption.privateKeyJwk,
          signingPublicKeySpki: identityA.signing.publicKeySpki
        });
      } catch {
        tamperDetected = true;
      }

      out.textContent = [
        `وضعیت تست: ${passed ? "✅ موفق (PASS)" : "❌ ناموفق (FAIL)"}`,
        `تشخیص دستکاری: ${tamperDetected ? "✅ بله" : "❌ خیر"}`,
        `مدت زمان: ${(t1 - t0).toFixed(1)} میلی‌ثانیه`,
        `هویت A: ${identityA.fingerprint}`,
        `هویت B: ${identityB.fingerprint}`,
        `طول پیام رمزشده: ${encrypted.length} کاراکتر`,
        `پیش‌نمایش: ${encrypted.substring(0, 48)}...`,
        `متن رمزگشایی‌شده: ${result.plaintext}`
      ].join("\n");
    } catch (err) {
      out.textContent = `❌ خطا در تست RSA: ${err.message}`;
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
  // راه‌اندازی
  // ---------------------------------------------------------------------------
  updateModeUI();
  await checkAndApplyChatContext();
  await renderChatsList();
  renderIdentityFingerprint();
});
