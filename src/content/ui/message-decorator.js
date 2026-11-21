import { CONSTANTS } from '../../shared/constants.js';
import { StorageManager } from '../../shared/storage.js';
import { IdentityManager } from '../../shared/identity.js';
import { CryptoEngine } from '../crypto/crypto.js';

export class MessageDecorator {
  static sessionCache = new Map();

  static cachePlaintext(ciphertext, plaintext) {
    if (!ciphertext || !plaintext) return;
    const key = CONSTANTS.extractCiphertext(ciphertext) || ciphertext.trim();
    this.sessionCache.set(key, plaintext);
  }

  static clearCache() {
    this.sessionCache.clear();
  }

  static getRawText(el) {
    if (!el) return "";
    let text = "";
    for (const node of el.childNodes) {
      if (
        node.nodeType === Node.ELEMENT_NODE &&
        (node.classList?.contains("bale-enc-ui-root") ||
          node.dataset?.baleEncUi === "1")
      ) {
        continue;
      }
      text += node.textContent || "";
    }
    return text;
  }

  static cleanupIfRecycled(el) {
    if (!el || el.dataset?.baleEncDecorated !== "1") return false;
    const raw = this.getRawText(el);

    const stillEncrypted =
      CONSTANTS.containsReservedPrefix(raw) ||
      CONSTANTS.isKeyExchangeMessage(raw) ||
      Boolean(CONSTANTS.extractCiphertext(raw));

    if (!stillEncrypted) {
      this.unmountUI(el);
      return true;
    }
    return false;
  }

  static unmountUI(el) {
    if (!el) return;
    const roots = el.querySelectorAll('.bale-enc-ui-root, [data-bale-enc-ui="1"]');
    for (const r of roots) {
      r.remove();
    }
    el.classList.remove("bale-enc-host");
    delete el.dataset.baleEncDecorated;
    delete el.dataset.baleEncProcessed;
    delete el.dataset.baleEncKeyProcessed;
    delete el.dataset.baleEncFailed;
    delete el.dataset.baleEncCiphertext;
    delete el.dataset.baleEncPreview;
  }

  static mountUI(el, contentNode, ciphertext = "") {
    if (!el) return;

    if (!el.classList.contains("bale-enc-host") && typeof window !== "undefined" && window.getComputedStyle) {
      try {
        const computed = window.getComputedStyle(el);
        if (computed.fontSize && computed.fontSize !== "0px") {
          el.dataset.baleEncOrigFontSize = computed.fontSize;
        }
        if (computed.color && computed.color !== "rgba(0, 0, 0, 0)") {
          el.dataset.baleEncOrigColor = computed.color;
        }
      } catch {}
    }

    let uiRoot = el.querySelector(':scope > .bale-enc-ui-root');
    if (!uiRoot) {
      uiRoot = document.createElement("span");
      uiRoot.className = "bale-enc-ui-root";
      uiRoot.dataset.baleEncUi = "1";
      el.appendChild(uiRoot);
    }

    if (el.dataset.baleEncOrigFontSize) {
      uiRoot.style.setProperty("--bale-enc-font-size", el.dataset.baleEncOrigFontSize);
    }
    if (el.dataset.baleEncOrigColor) {
      uiRoot.style.setProperty("--bale-enc-text-color", el.dataset.baleEncOrigColor);
    }

    uiRoot.textContent = "";
    uiRoot.appendChild(contentNode);

    el.classList.add("bale-enc-host");
    el.dataset.baleEncDecorated = "1";
    if (ciphertext) {
      el.dataset.baleEncCiphertext = ciphertext;
    }
  }

  static async processElement(el, chatConfig, ciphertextOverride = null) {
    if (!el) return;

    if (!ciphertextOverride && this.cleanupIfRecycled(el)) {
      return;
    }

    const rawContent = this.getRawText(el);

    if (el.dataset.baleEncPreview === "1") {
      if (CONSTANTS.isKeyExchangePreview(rawContent)) {
        this.renderPreview(el, CONSTANTS.MESSAGES.KEY_EXCHANGE_PREVIEW, rawContent);
        return;
      }
      if (
        CONSTANTS.isCiphertextPreview(rawContent) ||
        CONSTANTS.containsReservedPrefix(rawContent) ||
        ciphertextOverride
      ) {
        this.renderPreview(
          el,
          CONSTANTS.MESSAGES.DECRYPTED_BADGE,
          ciphertextOverride || rawContent
        );
        return;
      }
      return;
    }

    if (!ciphertextOverride && CONSTANTS.isKeyExchangeMessage(rawContent)) return;

    if (!ciphertextOverride && CONSTANTS.isKeyExchangePreview(rawContent)) {
      this.renderPreview(el, CONSTANTS.MESSAGES.KEY_EXCHANGE_PREVIEW, rawContent);
      return;
    }

    const ciphertext =
      ciphertextOverride ||
      CONSTANTS.extractCiphertext(rawContent) ||
      el.dataset.baleEncCiphertext;
    if (!ciphertext) return;

    const isHybrid =
      ciphertext.startsWith(CONSTANTS.PREFIXES.HYBRID) ||
      ciphertext.startsWith(CONSTANTS.LEGACY_PREFIXES.HYBRID);
    const isEcdh =
      ciphertext.startsWith(CONSTANTS.PREFIXES.ECDH) ||
      ciphertext.startsWith(CONSTANTS.LEGACY_PREFIXES.ECDH);
    const recoveredKeysAll = await StorageManager.getAllRecoveredPeerKeys();
    const recoveredCount = Object.values(recoveredKeysAll).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    );
    const peerMarker = chatConfig
      ? `${chatConfig.mode || "rsa"}:${chatConfig.peerFingerprint || "none"}:${chatConfig.fingerprint || "none"}:${(chatConfig.peerKeyHistory || []).length}:${(chatConfig.passwordHistory || []).length}:${recoveredCount}:${chatConfig.updatedAt || 0}`
      : `none:${recoveredCount}`;
    const marker = `${ciphertext}|${peerMarker}`;

    if (el.dataset.baleEncProcessed === marker && el.dataset.baleEncFailed !== "true") {
      return;
    }
    el.dataset.baleEncProcessed = marker;

    if (this.sessionCache.has(ciphertext)) {
      this.renderSuccess(el, this.sessionCache.get(ciphertext), ciphertext);
      return;
    }

    if (isHybrid) {
      await this.processHybrid(el, ciphertext, chatConfig);
    } else if (isEcdh) {
      await this.processEcdh(el, ciphertext, chatConfig);
    } else {
      await this.processPassword(el, ciphertext, chatConfig);
    }
  }

  static async collectCandidatePasswords(chatConfig) {
    const passwords = [];
    const addPwd = (p) => {
      if (typeof p === "string" && p.length > 0 && !passwords.includes(p)) {
        passwords.push(p);
      }
    };

    if (chatConfig) {
      addPwd(chatConfig.password);
      if (Array.isArray(chatConfig.passwordHistory)) {
        for (let i = chatConfig.passwordHistory.length - 1; i >= 0; i--) {
          addPwd(chatConfig.passwordHistory[i]);
        }
      }
    }

    const allChats = await StorageManager.getEncryptedChats();
    for (const cfg of Object.values(allChats)) {
      addPwd(cfg.password);
      if (Array.isArray(cfg.passwordHistory)) {
        for (let i = cfg.passwordHistory.length - 1; i >= 0; i--) {
          addPwd(cfg.passwordHistory[i]);
        }
      }
    }

    return passwords;
  }

  static async processPassword(el, ciphertext, chatConfig) {
    const candidatePasswords = await this.collectCandidatePasswords(chatConfig);

    if (candidatePasswords.length === 0) {
      this.renderWarning(el, CONSTANTS.MESSAGES.UNCONFIGURED_CHAT_WARN, ciphertext);
      return;
    }

    for (const pwd of candidatePasswords) {
      try {
        const plaintext = await CryptoEngine.decrypt(ciphertext, pwd);
        this.sessionCache.set(ciphertext, plaintext);
        this.renderSuccess(el, plaintext, ciphertext);
        return;
      } catch {
        // ادامه به پسورد بعدی
      }
    }

    this.renderWarning(el, CONSTANTS.MESSAGES.DECRYPT_FAILED, ciphertext);
  }

  static getOwnPrivateKeyList(identity) {
    const list = [];
    if (identity?.encryption?.privateKeyJwk) {
      list.push(identity.encryption.privateKeyJwk);
    }
    if (Array.isArray(identity?.history)) {
      for (let i = identity.history.length - 1; i >= 0; i--) {
        const item = identity.history[i];
        if (item?.encryption?.privateKeyJwk) {
          list.push(item.encryption.privateKeyJwk);
        }
      }
    }
    return list;
  }

  static getOwnEcdhPrivateKeyList(identity) {
    const list = [];
    if (identity?.ecdh?.privateKeyJwk) {
      list.push(identity.ecdh.privateKeyJwk);
    }
    if (Array.isArray(identity?.history)) {
      for (let i = identity.history.length - 1; i >= 0; i--) {
        const item = identity.history[i];
        if (item?.ecdh?.privateKeyJwk) {
          list.push(item.ecdh.privateKeyJwk);
        }
      }
    }
    return list;
  }

  static resolveOwnSigningKey(kid, identity) {
    if (!kid || !identity) return null;
    if (identity.fingerprint === kid && identity.signing?.publicKeySpki) {
      return identity.signing.publicKeySpki;
    }
    if (Array.isArray(identity.history)) {
      const match = identity.history.find(
        (h) => h && h.fingerprint === kid && h.signing?.publicKeySpki
      );
      if (match) return match.signing.publicKeySpki;
    }
    return null;
  }

  static async resolvePeerSigningKey(kid, chatConfig) {
    if (!kid) return null;

    const fromConfig = (cfg) => {
      if (!cfg) return null;
      if (cfg.peerFingerprint === kid && cfg.peerSigningPublicKey) {
        return cfg.peerSigningPublicKey;
      }
      if (Array.isArray(cfg.peerKeyHistory)) {
        const old = cfg.peerKeyHistory.find(
          (entry) =>
            entry &&
            entry.fingerprint === kid &&
            entry.signingPublicKeySpki
        );
        if (old) return old.signingPublicKeySpki;
      }
      return null;
    };

    const direct = fromConfig(chatConfig);
    if (direct) return direct;

    const allChats = await StorageManager.getEncryptedChats();
    for (const cfg of Object.values(allChats)) {
      const key = fromConfig(cfg);
      if (key) return key;
    }

    // جستجو در کلیدهای بازیابی‌شده از تاریخچه چت (پس از نصب مجدد)
    const recoveredAll = await StorageManager.getAllRecoveredPeerKeys();
    for (const list of Object.values(recoveredAll)) {
      if (!Array.isArray(list)) continue;
      const match = list.find(
        (entry) => entry && entry.fingerprint === kid && entry.signingPublicKeySpki
      );
      if (match) return match.signingPublicKeySpki;
    }

    const pendingPeers = await StorageManager.getPendingPeers();
    for (const peer of Object.values(pendingPeers)) {
      if (peer && peer.peerFingerprint === kid && peer.peerSigningPublicKey) {
        return peer.peerSigningPublicKey;
      }
    }

    return null;
  }

  static async resolvePeerEcdhKeys(kid, chatConfig, identity) {
    const keys = [];
    const addKey = (k) => {
      if (k && !keys.includes(k)) keys.push(k);
    };

    const fromConfig = (cfg) => {
      if (!cfg) return;
      if ((!kid || cfg.peerFingerprint === kid) && cfg.peerEcdhPublicKey) {
        addKey(cfg.peerEcdhPublicKey);
      }
      if (Array.isArray(cfg.peerKeyHistory)) {
        for (let i = cfg.peerKeyHistory.length - 1; i >= 0; i--) {
          const entry = cfg.peerKeyHistory[i];
          if (entry && (!kid || entry.fingerprint === kid) && entry.ecdhPublicKeySpki) {
            addKey(entry.ecdhPublicKeySpki);
          }
        }
      }
      if (cfg.peerEcdhPublicKey) addKey(cfg.peerEcdhPublicKey);
      if (Array.isArray(cfg.peerKeyHistory)) {
        for (let i = cfg.peerKeyHistory.length - 1; i >= 0; i--) {
          const entry = cfg.peerKeyHistory[i];
          if (entry?.ecdhPublicKeySpki) addKey(entry.ecdhPublicKeySpki);
        }
      }
    };

    fromConfig(chatConfig);

    const allChats = await StorageManager.getEncryptedChats();
    for (const cfg of Object.values(allChats)) {
      fromConfig(cfg);
    }

    const recoveredAll = await StorageManager.getAllRecoveredPeerKeys();
    for (const list of Object.values(recoveredAll)) {
      if (!Array.isArray(list)) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i];
        if (entry?.ecdhPublicKeySpki) addKey(entry.ecdhPublicKeySpki);
      }
    }

    if (identity?.ecdh?.publicKeySpki) {
      addKey(identity.ecdh.publicKeySpki);
    }

    return keys;
  }

  static async processHybrid(el, ciphertext, chatConfig) {
    let identity;
    try {
      identity = await IdentityManager.getIdentity();
    } catch {
      this.renderWarning(el, CONSTANTS.MESSAGES.DECRYPT_FAILED, ciphertext);
      return;
    }

    const kid = CryptoEngine.peekHybridKid(ciphertext);
    const signingPublicKeySpki =
      this.resolveOwnSigningKey(kid, identity) ||
      (await this.resolvePeerSigningKey(kid, chatConfig));

    if (!signingPublicKeySpki) {
      this.renderWarning(el, CONSTANTS.MESSAGES.UNKNOWN_SENDER, ciphertext);
      return;
    }

    try {
      const privateKeyJwks = this.getOwnPrivateKeyList(identity);
      const result = await CryptoEngine.decryptHybrid(ciphertext, {
        privateKeyJwk: identity.encryption.privateKeyJwk,
        privateKeyJwks,
        signingPublicKeySpki
      });

      this.sessionCache.set(ciphertext, result.plaintext);
      this.renderSuccess(el, result.plaintext, ciphertext);
    } catch (err) {
      if (err && err.message === "INVALID_SIGNATURE") {
        this.renderWarning(el, CONSTANTS.MESSAGES.INVALID_SIGNATURE, ciphertext);
      } else if (err && err.message === "KEY_UNWRAP_FAILED") {
        this.renderWarning(el, CONSTANTS.MESSAGES.OLD_PRIVATE_KEY_LOST, ciphertext);
      } else {
        this.renderWarning(el, CONSTANTS.MESSAGES.DECRYPT_FAILED, ciphertext);
      }
    }
  }

  static async processEcdh(el, ciphertext, chatConfig) {
    let identity;
    try {
      identity = await IdentityManager.getIdentity();
    } catch {
      this.renderWarning(el, CONSTANTS.MESSAGES.DECRYPT_FAILED, ciphertext);
      return;
    }

    const kid = CryptoEngine.peekHybridKid(ciphertext);
    const signingPublicKeySpki =
      this.resolveOwnSigningKey(kid, identity) ||
      (await this.resolvePeerSigningKey(kid, chatConfig));

    if (!signingPublicKeySpki) {
      this.renderWarning(el, CONSTANTS.MESSAGES.UNKNOWN_SENDER, ciphertext);
      return;
    }

    const ownEcdhPrivateKeys = this.getOwnEcdhPrivateKeyList(identity);
    const peerEcdhPublicKeys = await this.resolvePeerEcdhKeys(kid, chatConfig, identity);

    if (ownEcdhPrivateKeys.length === 0 || peerEcdhPublicKeys.length === 0) {
      this.renderWarning(el, CONSTANTS.MESSAGES.OLD_PRIVATE_KEY_LOST, ciphertext);
      return;
    }

    let lastErr = null;
    for (const ownPriv of ownEcdhPrivateKeys) {
      for (const peerPub of peerEcdhPublicKeys) {
        try {
          const result = await CryptoEngine.decryptEcdh(ciphertext, {
            ownEcdhPrivateKeyJwk: ownPriv,
            peerEcdhPublicKeySpki: peerPub,
            signingPublicKeySpki
          });
          this.sessionCache.set(ciphertext, result.plaintext);
          this.renderSuccess(el, result.plaintext, ciphertext);
          return;
        } catch (err) {
          lastErr = err;
          if (err && err.message === "INVALID_SIGNATURE") break;
        }
      }
      if (lastErr && lastErr.message === "INVALID_SIGNATURE") break;
    }

    if (lastErr && lastErr.message === "INVALID_SIGNATURE") {
      this.renderWarning(el, CONSTANTS.MESSAGES.INVALID_SIGNATURE, ciphertext);
    } else {
      this.renderWarning(el, CONSTANTS.MESSAGES.OLD_PRIVATE_KEY_LOST, ciphertext);
    }
  }

  static async decryptForEdit(ciphertext, chatConfig) {
    const token = CONSTANTS.extractCiphertext(ciphertext);
    if (!token) return null;

    if (this.sessionCache.has(token)) {
      return this.sessionCache.get(token);
    }

    if (
      token.startsWith(CONSTANTS.PREFIXES.HYBRID) ||
      token.startsWith(CONSTANTS.LEGACY_PREFIXES.HYBRID)
    ) {
      let identity;
      try {
        identity = await IdentityManager.getIdentity();
      } catch {
        return null;
      }

      const kid = CryptoEngine.peekHybridKid(token);
      const signingPublicKeySpki =
        this.resolveOwnSigningKey(kid, identity) ||
        (await this.resolvePeerSigningKey(kid, chatConfig));

      if (!signingPublicKeySpki) return null;

      try {
        const result = await CryptoEngine.decryptHybrid(token, {
          privateKeyJwk: identity.encryption.privateKeyJwk,
          privateKeyJwks: this.getOwnPrivateKeyList(identity),
          signingPublicKeySpki
        });
        this.sessionCache.set(token, result.plaintext);
        return result.plaintext;
      } catch {
        return null;
      }
    }

    if (
      token.startsWith(CONSTANTS.PREFIXES.ECDH) ||
      token.startsWith(CONSTANTS.LEGACY_PREFIXES.ECDH)
    ) {
      let identity;
      try {
        identity = await IdentityManager.getIdentity();
      } catch {
        return null;
      }

      const kid = CryptoEngine.peekHybridKid(token);
      const signingPublicKeySpki =
        this.resolveOwnSigningKey(kid, identity) ||
        (await this.resolvePeerSigningKey(kid, chatConfig));
      if (!signingPublicKeySpki) return null;

      const ownEcdhPrivateKeys = this.getOwnEcdhPrivateKeyList(identity);
      const peerEcdhPublicKeys = await this.resolvePeerEcdhKeys(kid, chatConfig, identity);

      for (const ownPriv of ownEcdhPrivateKeys) {
        for (const peerPub of peerEcdhPublicKeys) {
          try {
            const result = await CryptoEngine.decryptEcdh(token, {
              ownEcdhPrivateKeyJwk: ownPriv,
              peerEcdhPublicKeySpki: peerPub,
              signingPublicKeySpki
            });
            this.sessionCache.set(token, result.plaintext);
            return result.plaintext;
          } catch {
            // ادامه به کلید بعدی
          }
        }
      }
      return null;
    }

    const passwords = await this.collectCandidatePasswords(chatConfig);
    for (const password of passwords) {
      try {
        const plaintext = await CryptoEngine.decrypt(token, password);
        this.sessionCache.set(token, plaintext);
        return plaintext;
      } catch {
        // ادامه
      }
    }

    return null;
  }

  static renderPreview(el, text = CONSTANTS.MESSAGES.DECRYPTED_BADGE, ciphertext = "") {
    const badge = document.createElement("span");
    badge.className = "bale-enc-preview";
    badge.textContent = text;
    this.mountUI(el, badge, ciphertext || el.dataset.baleEncCiphertext || "");
    delete el.dataset.baleEncFailed;
  }

  static renderKeyExchange(el, text, rawPayload = "") {
    const notice = document.createElement("span");
    notice.className = "bale-enc-key-exchange";
    notice.textContent = text;
    notice.title = CONSTANTS.MESSAGES.KEEP_KEY_MSG_WARN;
    this.mountUI(el, notice, rawPayload);
    delete el.dataset.baleEncFailed;
  }

  static renderSuccess(el, plaintext, ciphertext = "") {
    const container = document.createElement("div");
    container.className = "bale-enc-container";

    const badge = document.createElement("span");
    badge.className = "bale-enc-badge";
    badge.textContent = CONSTANTS.MESSAGES.DECRYPTED_BADGE;

    const textNode = document.createElement("div");
    textNode.className = "bale-enc-plaintext";
    textNode.textContent = plaintext;

    container.appendChild(badge);
    container.appendChild(textNode);

    this.mountUI(el, container, ciphertext || el.dataset.baleEncCiphertext || "");
    delete el.dataset.baleEncFailed;
  }

  static renderWarning(el, warningText, ciphertext = "") {
    const errSpan = document.createElement("span");
    errSpan.className = "bale-enc-error";
    errSpan.textContent = warningText;

    if (warningText === CONSTANTS.MESSAGES.OLD_PRIVATE_KEY_LOST) {
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "bale-enc-restore-link";
      restoreBtn.textContent = "📤 بازیابی پشتیبان";
      restoreBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          chrome.runtime.sendMessage({ action: "open_popup", tab: "keys" });
        } catch {}
      };
      errSpan.appendChild(document.createTextNode(" "));
      errSpan.appendChild(restoreBtn);
    }

    this.mountUI(el, errSpan, ciphertext || el.dataset.baleEncCiphertext || "");
    el.dataset.baleEncFailed = "true";
  }
}
