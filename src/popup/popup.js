import { StorageManager } from '../shared/storage.js';
import { CryptoEngine } from '../content/crypto/crypto.js';

document.addEventListener("DOMContentLoaded", async () => {
  // ۱. مدیریت ۳ تب
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  function switchTab(targetTabId) {
    tabBtns.forEach(b => {
      b.classList.toggle("active", b.dataset.tab === targetTabId);
    });
    tabContents.forEach(c => {
      c.classList.toggle("active", c.id === targetTabId);
    });
  }

  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
    });
  });

  // ۲. استخراج و اعمال شناسه چت
  async function detectActiveTabUid() {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab || !activeTab.url) return null;

      const href = activeTab.url;
      if (!href.includes("bale.ai")) return null;

      const queryMatch = href.match(/[?&#](?:uid|id|peer_id)=([0-9a-zA-Z_-]+)/i);
      if (queryMatch && queryMatch[1]) {
        return queryMatch[1];
      }

      const url = new URL(href);
      const fromSearch = url.searchParams.get("uid") || url.searchParams.get("id");
      if (fromSearch) return fromSearch;

      const pathMatch = url.pathname.match(/\/chat\/([0-9a-zA-Z_-]+)/i);
      if (pathMatch && pathMatch[1] && pathMatch[1] !== "chat") {
        return pathMatch[1];
      }
    } catch {}
    return null;
  }

  async function checkAndApplyChatContext() {
    // الف. اولویت اول: مقدار ارسالی از دکمه تنظیم رمزنگاری (URL param یا pendingOpenUid)
    const urlParams = new URLSearchParams(window.location.search);
    let targetUid = urlParams.get("uid");

    if (!targetUid) {
      const storageData = await chrome.storage.local.get("pendingOpenUid");
      if (storageData.pendingOpenUid) {
        targetUid = storageData.pendingOpenUid;
        await chrome.storage.local.remove("pendingOpenUid");
      }
    }

    // ب. اولویت دوم: استخراج زنده از تب فعال
    if (!targetUid) {
      targetUid = await detectActiveTabUid();
    }

    if (!targetUid) return;

    // بررسی اینکه آیا این چت از قبل ذخیره شده یا خیر
    const chats = await StorageManager.getEncryptedChats();
    const existingKey = `bale_${targetUid}`;
    const existingChat = chats[existingKey];

    if (existingChat) {
      // بارگذاری اطلاعات چت ذخیره‌شده جهت ویرایش یا بررسی وضعیت
      isEditingUid = targetUid;
      document.getElementById("messenger").value = existingChat.messenger || "bale";
      document.getElementById("uid").value = existingChat.uid;
      document.getElementById("uid").readOnly = true;
      document.getElementById("displayName").value = existingChat.displayName || "";
      document.getElementById("password").value = existingChat.password || "";

      submitBtn.textContent = "بروزرسانی تغییرات چت";
      cancelEditBtn.style.display = "block";

      const banner = document.getElementById("detected-uid-banner");
      if (banner) {
        banner.style.display = "flex";
        banner.querySelector("span").textContent = `اطلاعات چت «${existingChat.displayName}» (شناسه: ${targetUid}) لود شد.`;
        document.getElementById("btn-use-detected").style.display = "none";
      }
      switchTab("tab-add-chat");
    } else {
      // چت جدید است: پر کردن فیلد UID
      document.getElementById("uid").value = targetUid;
      const banner = document.getElementById("detected-uid-banner");
      if (banner) {
        banner.style.display = "flex";
        banner.querySelector("span").textContent = `شناسه چت (${targetUid}) در تب فعال شناسایی شد.`;
        document.getElementById("btn-use-detected").style.display = "none";
      }
      document.getElementById("displayName").focus();
    }
  }

  document.getElementById("btn-detect-uid")?.addEventListener("click", async () => {
    const uid = await detectActiveTabUid();
    if (uid) {
      document.getElementById("uid").value = uid;
      alert(`شناسه چت (${uid}) دریافت و جایگذاری شد.`);
    } else {
      alert("شناسه چت در تب فعال شناسایی نشد. مطمئن شوید در صفحه گفتگوی بله هستید.");
    }
  });

  // ۳. دکمه نمایش / مخفی‌سازی پسورد
  const togglePwdBtn = document.getElementById("btn-toggle-pwd");
  const pwdInput = document.getElementById("password");
  togglePwdBtn.addEventListener("click", () => {
    if (pwdInput.type === "password") {
      pwdInput.type = "text";
      togglePwdBtn.textContent = "🙈";
    } else {
      pwdInput.type = "password";
      togglePwdBtn.textContent = "👁️";
    }
  });

  // ۴. فرم افزودن / ویرایش چت
  const chatForm = document.getElementById("chat-form");
  const submitBtn = document.getElementById("btn-submit-chat");
  const cancelEditBtn = document.getElementById("btn-cancel-edit");
  let isEditingUid = null;

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const messenger = document.getElementById("messenger").value;
    const uid = document.getElementById("uid").value.trim();
    const displayName = document.getElementById("displayName").value.trim();
    const password = document.getElementById("password").value;

    if (!uid) {
      alert("لطفاً شناسه چت (UID) را وارد کنید.");
      return;
    }
    if (password.length < 8) {
      alert("طول کلید/پسورد باید حداقل ۸ کاراکتر باشد.");
      return;
    }

    const fingerprint = await CryptoEngine.getKeyFingerprint(password);
    await StorageManager.saveChatConfig(messenger, uid, displayName, password, fingerprint, true);

    alert(`چت «${displayName}» با موفقیت ذخیره و فعال شد.`);
    resetForm();
    await renderChatsList();
    switchTab("tab-chats-list");
  });

  cancelEditBtn.addEventListener("click", () => {
    resetForm();
  });

  function resetForm() {
    isEditingUid = null;
    chatForm.reset();
    submitBtn.textContent = "ذخیره و فعال‌سازی رمزنگاری";
    cancelEditBtn.style.display = "none";
    document.getElementById("uid").readOnly = false;
  }

  // ۵. رندر و جستجو در لیست چت‌ها
  const searchInput = document.getElementById("search-chats");
  searchInput.addEventListener("input", () => {
    renderChatsList(searchInput.value.trim().toLowerCase());
  });

  async function renderChatsList(filterQuery = "") {
    const listEl = document.getElementById("chats-list");
    const countBadge = document.getElementById("chats-count");
    const chats = await StorageManager.getEncryptedChats();
    const entries = Object.values(chats);

    if (countBadge) {
      countBadge.textContent = String(entries.length);
    }

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

    const filtered = entries.filter(c => {
      if (!filterQuery) return true;
      return (
        (c.displayName && c.displayName.toLowerCase().includes(filterQuery)) ||
        (c.uid && c.uid.includes(filterQuery)) ||
        (c.fingerprint && c.fingerprint.toLowerCase().includes(filterQuery))
      );
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `<p style="color:#64748b; font-size:11.5px; text-align:center; padding:16px;">موردی یافت نشد.</p>`;
      return;
    }

    listEl.innerHTML = "";
    filtered.forEach(chat => {
      const card = document.createElement("div");
      card.className = "chat-card";
      card.innerHTML = `
        <div class="chat-card-top">
          <div>
            <div class="chat-card-title">${escapeHtml(chat.displayName)}</div>
            <div class="chat-card-meta">شناسه: ${escapeHtml(chat.uid)}</div>
          </div>
          <div class="chat-card-actions">
            <button class="action-icon-btn edit-btn" title="ویرایش">✏️</button>
            <button class="action-icon-btn del-btn" title="حذف">🗑️</button>
          </div>
        </div>
        <div class="chat-card-bottom">
          <div class="fp-badge" title="Fingerprint (SHA-256)">FP: ${chat.fingerprint}</div>
          <label class="toggle-switch" title="روشن/خاموش کردن رمزنگاری در این چت">
            <span>${chat.enabled ? "فعال" : "غیرفعال"}</span>
            <input type="checkbox" ${chat.enabled ? "checked" : ""}>
            <span class="switch-slider"></span>
          </label>
        </div>
      `;

      // ویرایش
      card.querySelector(".edit-btn").onclick = () => {
        isEditingUid = chat.uid;
        document.getElementById("messenger").value = chat.messenger;
        document.getElementById("uid").value = chat.uid;
        document.getElementById("uid").readOnly = true;
        document.getElementById("displayName").value = chat.displayName;
        document.getElementById("password").value = chat.password;

        submitBtn.textContent = "بروزرسانی تغییرات چت";
        cancelEditBtn.style.display = "block";
        switchTab("tab-add-chat");
      };

      // حذف
      card.querySelector(".del-btn").onclick = async () => {
        if (confirm(`آیا چت «${chat.displayName}» از لیست رمزنگاری حذف شود؟`)) {
          await StorageManager.removeChatConfig(chat.messenger, chat.uid);
          await renderChatsList(searchInput.value.trim().toLowerCase());
        }
      };

      // تغییر وضعیت سوئیچ
      const toggleInput = card.querySelector(".toggle-switch input");
      toggleInput.onchange = async () => {
        const newState = await StorageManager.toggleChatEnabled(chat.messenger, chat.uid);
        chat.enabled = newState;
        card.querySelector(".toggle-switch span").textContent = newState ? "فعال" : "غیرفعال";
      };

      listEl.appendChild(card);
    });
  }

  // ۶. تب ۳: تولید کلید و اثر انگشت
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

  // ۷. آزمایشگر خودکار رمزنگاری (Self-Test)
  document.getElementById("btn-test-crypto").addEventListener("click", async () => {
    const out = document.getElementById("test-result");
    out.textContent = "در حال اجرای اشتقاق PBKDF2 (۶۰۰٬۰۰۰ دور) و رمزنگاری AES-256-GCM...";

    try {
      const testPass = genKeyInput.value || "sample-test-vector-pass-2026";
      const samplePlaintext = "سلام! این یک پیام آزمایشی فوق‌محرمانه است 🔒\nخط دوم با کاراکترهای فارسی و خط جدید.";
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

  function escapeHtml(str) {
    if (!str) return "";
    const p = document.createElement("p");
    p.textContent = str;
    return p.innerHTML;
  }

  // راه‌اندازی فوری
  await checkAndApplyChatContext();
  await renderChatsList();
});
