// بارگذاری ماژول اصلی با پشتیبانی کامل از ES Modules در Content Script
(async () => {
  const src = chrome.runtime.getURL("src/content/content.js");
  await import(src);
})();
