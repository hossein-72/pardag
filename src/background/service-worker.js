import { CONSTANTS } from '../shared/constants.js';

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS);
  if (!current[CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS]) {
    await chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.ENCRYPTED_CHATS]: {} });
  }
});

// مدیریت درخواست باز کردن صفحه اکستنشن با اطلاعات چت فعال
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "open_popup") {
    const uid = request.uid ? String(request.uid).trim() : "";

    chrome.storage.local.set({ pendingOpenUid: uid }, () => {
      // تلاش برای باز کردن پاپ‌آپ نوار ابزار با chrome.action.openPopup
      if (chrome.action && typeof chrome.action.openPopup === "function") {
        chrome.action.openPopup().catch(() => {
          openStandalonePopup(uid);
        });
      } else {
        openStandalonePopup(uid);
      }
    });

    sendResponse({ ok: true });
    return true;
  }
});

function openStandalonePopup(uid) {
  const popupUrl = chrome.runtime.getURL(`src/popup/popup.html?uid=${encodeURIComponent(uid || "")}`);

  chrome.windows.getAll({ populate: true }, (windows) => {
    const existing = windows.find(w =>
      w.tabs && w.tabs.some(t => t.url && t.url.includes("src/popup/popup.html"))
    );

    if (existing) {
      chrome.windows.update(existing.id, { focused: true });
      if (uid && existing.tabs) {
        const tab = existing.tabs.find(t => t.url && t.url.includes("src/popup/popup.html"));
        if (tab && tab.id) {
          chrome.tabs.update(tab.id, { url: popupUrl });
        }
      }
    } else {
      chrome.windows.create({
        url: popupUrl,
        type: "popup",
        width: 415,
        height: 600,
        top: 100,
        left: 100
      });
    }
  });
}
