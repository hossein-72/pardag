import { CONSTANTS } from '../../shared/constants.js';

// کش کردن کلیدهای مشتق‌شده در طول نشست برای جلوگیری از اجرای مکرر 600,000 دور PBKDF2
const derivedKeyCache = new Map();

export class CryptoEngine {
  static encoder = new TextEncoder();
  static decoder = new TextDecoder();

  // ---------------------------------------------------------------------------
  // ابزارهای پایه
  // ---------------------------------------------------------------------------

  static bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  static base64ToBuffer(base64) {
    const cleanBase64 = String(base64).replace(/[^A-Za-z0-9+/=]/g, '');
    const binary = atob(cleanBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  static hex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  static concatBytes(...arrays) {
    const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrays) {
      out.set(arr, offset);
      offset += arr.length;
    }
    return out;
  }

  static u16Bytes(value) {
    return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
  }

  // ---------------------------------------------------------------------------
  // حالت پسورد مشترک (PARDAG1)
  // ---------------------------------------------------------------------------

  static generateRandomKeyBase64() {
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    return this.bufferToBase64(randomBytes);
  }

  static async deriveKeyAndRaw(password) {
    if (derivedKeyCache.has(password)) {
      return derivedKeyCache.get(password);
    }

    const baseKey = await crypto.subtle.importKey(
      "raw",
      this.encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );

    const saltBuffer = this.encoder.encode(CONSTANTS.SALT);

    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBuffer,
        iterations: CONSTANTS.PBKDF2_ITERATIONS,
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: CONSTANTS.KEY_LENGTH },
      true,
      ["encrypt", "decrypt"]
    );

    const rawKeyBuffer = await crypto.subtle.exportKey("raw", aesKey);
    const result = { aesKey, rawKeyBuffer };
    derivedKeyCache.set(password, result);
    return result;
  }

  static async getKeyFingerprint(password) {
    const { rawKeyBuffer } = await this.deriveKeyAndRaw(password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", rawKeyBuffer);
    return this.hex(hashBuffer).substring(0, 8);
  }

  static async encrypt(plaintext, password) {
    const { aesKey } = await this.deriveKeyAndRaw(password);
    const iv = crypto.getRandomValues(new Uint8Array(CONSTANTS.IV_LENGTH));
    const encodedText = this.encoder.encode(plaintext);

    const cipherBuffer = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128
      },
      aesKey,
      encodedText
    );

    const cipherBytes = new Uint8Array(cipherBuffer);
    const combined = new Uint8Array(iv.byteLength + cipherBytes.byteLength);
    combined.set(iv, 0);
    combined.set(cipherBytes, iv.byteLength);

    return CONSTANTS.PREFIXES.PASSWORD + this.bufferToBase64(combined);
  }

  static async decrypt(payload, password) {
    const token = CONSTANTS.extractCiphertext(payload);
    if (!token) {
      throw new Error("Invalid prefix");
    }

    let prefixLen = 0;
    if (token.startsWith(CONSTANTS.PREFIXES.PASSWORD)) {
      prefixLen = CONSTANTS.PREFIXES.PASSWORD.length;
    } else if (token.startsWith(CONSTANTS.LEGACY_PREFIXES.PASSWORD)) {
      prefixLen = CONSTANTS.LEGACY_PREFIXES.PASSWORD.length;
    } else {
      throw new Error("Invalid prefix");
    }

    const base64Data = token.slice(prefixLen);
    const combined = this.base64ToBuffer(base64Data);

    if (combined.byteLength < 28) {
      throw new Error("Payload too short");
    }

    const iv = combined.slice(0, CONSTANTS.IV_LENGTH);
    const ciphertextWithTag = combined.slice(CONSTANTS.IV_LENGTH);

    const { aesKey } = await this.deriveKeyAndRaw(password);

    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128
      },
      aesKey,
      ciphertextWithTag
    );

    return this.decoder.decode(decryptedBuffer);
  }

  // ---------------------------------------------------------------------------
  // هویت رمزنگاری: RSA-OAEP + ECDH P-256 برای رمزنگاری + ECDSA P-256 برای امضا
  // ---------------------------------------------------------------------------

  static async generateRsaKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: CONSTANTS.RSA_MODULUS_LENGTH,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: CONSTANTS.RSA_HASH
      },
      true,
      ["encrypt", "decrypt"]
    );

    const publicKeySpki = this.bufferToBase64(
      await crypto.subtle.exportKey("spki", keyPair.publicKey)
    );
    const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

    return { publicKeySpki, privateKeyJwk };
  }

  static async generateEcdhKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: CONSTANTS.ECDH_CURVE || "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );

    const publicKeySpki = this.bufferToBase64(
      await crypto.subtle.exportKey("spki", keyPair.publicKey)
    );
    const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

    return { publicKeySpki, privateKeyJwk };
  }

  static async generateEcdsaKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: CONSTANTS.ECDSA_CURVE },
      true,
      ["sign", "verify"]
    );

    const publicKeySpki = this.bufferToBase64(
      await crypto.subtle.exportKey("spki", keyPair.publicKey)
    );
    const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

    return { publicKeySpki, privateKeyJwk };
  }

  static async generateIdentity() {
    const [encryption, ecdh, signing] = await Promise.all([
      this.generateRsaKeyPair(),
      this.generateEcdhKeyPair(),
      this.generateEcdsaKeyPair()
    ]);
    const fingerprint = await this.getIdentityFingerprint(
      encryption.publicKeySpki,
      signing.publicKeySpki
    );

    return {
      version: 1,
      encryption,
      ecdh,
      signing,
      history: [],
      fingerprint,
      createdAt: Date.now()
    };
  }

  static async getIdentityFingerprint(encryptionPublicKeySpki, signingPublicKeySpki) {
    const data = this.encoder.encode(
      `ENC:${encryptionPublicKeySpki}|SIG:${signingPublicKeySpki}`
    );
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return this.hex(hashBuffer).substring(0, 8);
  }

  static async importRsaPublicKey(spkiBase64) {
    return crypto.subtle.importKey(
      "spki",
      this.base64ToBuffer(spkiBase64),
      { name: "RSA-OAEP", hash: CONSTANTS.RSA_HASH },
      true,
      ["encrypt"]
    );
  }

  static async importRsaPrivateKey(privateKeyJwk) {
    return crypto.subtle.importKey(
      "jwk",
      privateKeyJwk,
      { name: "RSA-OAEP", hash: CONSTANTS.RSA_HASH },
      false,
      ["decrypt"]
    );
  }

  static async importEcdhPublicKey(spkiBase64) {
    return crypto.subtle.importKey(
      "spki",
      this.base64ToBuffer(spkiBase64),
      { name: "ECDH", namedCurve: CONSTANTS.ECDH_CURVE || "P-256" },
      true,
      []
    );
  }

  static async importEcdhPrivateKey(privateKeyJwk) {
    return crypto.subtle.importKey(
      "jwk",
      privateKeyJwk,
      { name: "ECDH", namedCurve: CONSTANTS.ECDH_CURVE || "P-256" },
      false,
      ["deriveKey", "deriveBits"]
    );
  }

  static async importEcdsaPublicKey(spkiBase64) {
    return crypto.subtle.importKey(
      "spki",
      this.base64ToBuffer(spkiBase64),
      { name: "ECDSA", namedCurve: CONSTANTS.ECDSA_CURVE },
      true,
      ["verify"]
    );
  }

  static async importEcdsaPrivateKey(privateKeyJwk) {
    return crypto.subtle.importKey(
      "jwk",
      privateKeyJwk,
      { name: "ECDSA", namedCurve: CONSTANTS.ECDSA_CURVE },
      false,
      ["sign"]
    );
  }

  static async wrapAesKey(aesKeyBytes, rsaPublicKeySpki) {
    const publicKey = await this.importRsaPublicKey(rsaPublicKeySpki);
    const wrapped = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      publicKey,
      aesKeyBytes
    );
    return new Uint8Array(wrapped);
  }

  static async unwrapAesKey(wrappedBytes, rsaPrivateKeyJwk) {
    const privateKey = await this.importRsaPrivateKey(rsaPrivateKeyJwk);
    const raw = await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      wrappedBytes
    );
    return new Uint8Array(raw);
  }

  // ---------------------------------------------------------------------------
  // پیام هیبریدی (PARDAG2)
  // ---------------------------------------------------------------------------

  static async encryptHybrid(plaintext, options) {
    const {
      peerEncryptionPublicKeySpki,
      ownEncryptionPublicKeySpki,
      ownSigningPrivateKeyJwk,
      senderFingerprint
    } = options || {};

    if (!peerEncryptionPublicKeySpki) throw new Error("Missing peer public key");
    if (!ownEncryptionPublicKeySpki || !ownSigningPrivateKeyJwk) {
      throw new Error("Missing own identity");
    }

    const aesKeyBytes = crypto.getRandomValues(
      new Uint8Array(CONSTANTS.AES_KEY_LENGTH)
    );
    const aesKey = await crypto.subtle.importKey(
      "raw",
      aesKeyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt"]
    );

    const iv = crypto.getRandomValues(new Uint8Array(CONSTANTS.IV_LENGTH));
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      aesKey,
      this.encoder.encode(plaintext)
    );
    const ciphertext = new Uint8Array(cipherBuffer);

    const peerWrapped = await this.wrapAesKey(aesKeyBytes, peerEncryptionPublicKeySpki);
    const selfWrapped = await this.wrapAesKey(aesKeyBytes, ownEncryptionPublicKeySpki);

    const kid = String(senderFingerprint || "").trim().slice(0, 16);
    const kidBytes = this.encoder.encode(kid);

    const meta = this.concatBytes(
      new Uint8Array([1]),
      new Uint8Array([kidBytes.length]),
      kidBytes,
      this.u16Bytes(peerWrapped.length),
      peerWrapped,
      this.u16Bytes(selfWrapped.length),
      selfWrapped,
      new Uint8Array([iv.length]),
      iv
    );

    const signedData = this.concatBytes(meta, ciphertext);

    const signingKey = await this.importEcdsaPrivateKey(ownSigningPrivateKeyJwk);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: CONSTANTS.RSA_HASH },
        signingKey,
        signedData
      )
    );

    const payload = this.concatBytes(
      meta,
      this.u16Bytes(signature.length),
      signature,
      ciphertext
    );

    return CONSTANTS.PREFIXES.HYBRID + this.bufferToBase64(payload);
  }

  static unpackHybrid(base64Data) {
    const bytes = this.base64ToBuffer(base64Data);
    let offset = 0;

    const ensure = (n) => {
      if (offset + n > bytes.length) throw new Error("Malformed hybrid payload");
    };
    const readU8 = () => {
      ensure(1);
      const value = bytes[offset];
      offset += 1;
      return value;
    };
    const readU16 = () => {
      ensure(2);
      const value = (bytes[offset] << 8) | bytes[offset + 1];
      offset += 2;
      return value;
    };
    const readBytes = (length) => {
      ensure(length);
      const value = bytes.slice(offset, offset + length);
      offset += length;
      return value;
    };

    const version = readU8();
    if (version !== 1) throw new Error("Unsupported hybrid version");

    const kidLength = readU8();
    const kid = this.decoder.decode(readBytes(kidLength));
    const peerWrapped = readBytes(readU16());
    const selfWrapped = readBytes(readU16());
    const iv = readBytes(readU8());

    if (peerWrapped.length === 0 || selfWrapped.length === 0) {
      throw new Error("Missing wrapped keys");
    }
    if (iv.length !== CONSTANTS.IV_LENGTH) {
      throw new Error("Invalid IV length");
    }

    const metaEnd = offset;
    const signature = readBytes(readU16());
    const ciphertext = bytes.slice(offset);

    if (signature.length === 0) throw new Error("Missing signature");
    if (ciphertext.length < 16) throw new Error("Ciphertext too short");

    const signedData = this.concatBytes(bytes.slice(0, metaEnd), ciphertext);

    return {
      version,
      kid,
      peerWrapped,
      selfWrapped,
      iv,
      signature,
      ciphertext,
      signedData
    };
  }

  static async decryptHybrid(payload, options = {}) {
    const token = CONSTANTS.extractCiphertext(payload);
    if (!token) {
      throw new Error("Invalid hybrid payload");
    }

    let prefixLen = 0;
    if (token.startsWith(CONSTANTS.PREFIXES.HYBRID)) {
      prefixLen = CONSTANTS.PREFIXES.HYBRID.length;
    } else if (token.startsWith(CONSTANTS.LEGACY_PREFIXES.HYBRID)) {
      prefixLen = CONSTANTS.LEGACY_PREFIXES.HYBRID.length;
    } else {
      throw new Error("Invalid hybrid payload");
    }

    const base64Data = token.slice(prefixLen);
    const data = this.unpackHybrid(base64Data);

    if (!options.signingPublicKeySpki) {
      throw new Error("UNKNOWN_SENDER");
    }

    const verifyKey = await this.importEcdsaPublicKey(options.signingPublicKeySpki);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: CONSTANTS.RSA_HASH },
      verifyKey,
      data.signature,
      data.signedData
    );

    if (!valid) throw new Error("INVALID_SIGNATURE");

    const candidatePrivateKeys = [];
    if (options.privateKeyJwk) candidatePrivateKeys.push(options.privateKeyJwk);
    if (Array.isArray(options.privateKeyJwks)) {
      for (const k of options.privateKeyJwks) {
        if (k && !candidatePrivateKeys.includes(k)) {
          candidatePrivateKeys.push(k);
        }
      }
    }

    if (candidatePrivateKeys.length === 0) throw new Error("Missing private key");

    let aesKeyBytes = null;
    for (const privJwk of candidatePrivateKeys) {
      for (const wrapped of [data.peerWrapped, data.selfWrapped]) {
        try {
          aesKeyBytes = await this.unwrapAesKey(wrapped, privJwk);
          break;
        } catch {
          // ادامه به کلید کاندید بعدی
        }
      }
      if (aesKeyBytes) break;
    }

    if (!aesKeyBytes) throw new Error("KEY_UNWRAP_FAILED");

    const aesKey = await crypto.subtle.importKey(
      "raw",
      aesKeyBytes,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );

    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.iv, tagLength: 128 },
      aesKey,
      data.ciphertext
    );

    return {
      plaintext: this.decoder.decode(plaintextBuffer),
      kid: data.kid
    };
  }

  // ---------------------------------------------------------------------------
  // پیام هیبریدی فشرده مبتنی بر ECDH P-256 + HKDF-SHA256 + AES-GCM (PARDAG3)
  // ---------------------------------------------------------------------------

  static async deriveEcdhAesKey(ownEcdhPrivateKeyJwk, peerEcdhPublicKeySpki, saltBytes, infoStr = "bale-e2ee-ecdh-v1") {
    const privateKey = await this.importEcdhPrivateKey(ownEcdhPrivateKeyJwk);
    const publicKey = await this.importEcdhPublicKey(peerEcdhPublicKeySpki);

    const sharedBits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: publicKey },
      privateKey,
      256
    );

    const hkdfKey = await crypto.subtle.importKey(
      "raw",
      sharedBits,
      "HKDF",
      false,
      ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: saltBytes,
        info: this.encoder.encode(infoStr)
      },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  static async encryptEcdh(plaintext, options) {
    const {
      peerEcdhPublicKeySpki,
      ownEcdhPrivateKeyJwk,
      ownSigningPrivateKeyJwk,
      senderFingerprint
    } = options || {};

    if (!peerEcdhPublicKeySpki) throw new Error("Missing peer ECDH public key");
    if (!ownEcdhPrivateKeyJwk || !ownSigningPrivateKeyJwk) {
      throw new Error("Missing own ECDH/signing identity");
    }

    const iv = crypto.getRandomValues(new Uint8Array(CONSTANTS.IV_LENGTH));
    const kid = String(senderFingerprint || "").trim().slice(0, 16);
    const kidBytes = this.encoder.encode(kid);

    const aesKey = await this.deriveEcdhAesKey(
      ownEcdhPrivateKeyJwk,
      peerEcdhPublicKeySpki,
      iv,
      `bale-e2ee-ecdh-v1:${kid}`
    );

    const cipherBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      aesKey,
      this.encoder.encode(plaintext)
    );
    const ciphertext = new Uint8Array(cipherBuffer);

    const meta = this.concatBytes(
      new Uint8Array([1]),
      new Uint8Array([kidBytes.length]),
      kidBytes,
      new Uint8Array([iv.length]),
      iv
    );

    const signedData = this.concatBytes(meta, ciphertext);
    const signingKey = await this.importEcdsaPrivateKey(ownSigningPrivateKeyJwk);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: CONSTANTS.RSA_HASH },
        signingKey,
        signedData
      )
    );

    const payload = this.concatBytes(
      meta,
      this.u16Bytes(signature.length),
      signature,
      ciphertext
    );

    return CONSTANTS.PREFIXES.ECDH + this.bufferToBase64(payload);
  }

  static unpackEcdh(base64Data) {
    const bytes = this.base64ToBuffer(base64Data);
    let offset = 0;

    const ensure = (n) => {
      if (offset + n > bytes.length) throw new Error("Malformed ECDH payload");
    };
    const readU8 = () => {
      ensure(1);
      return bytes[offset++];
    };
    const readU16 = () => {
      ensure(2);
      const val = (bytes[offset] << 8) | bytes[offset + 1];
      offset += 2;
      return val;
    };
    const readBytes = (len) => {
      ensure(len);
      const val = bytes.slice(offset, offset + len);
      offset += len;
      return val;
    };

    const version = readU8();
    if (version !== 1) throw new Error("Unsupported ECDH version");

    const kidLength = readU8();
    const kid = this.decoder.decode(readBytes(kidLength));
    const iv = readBytes(readU8());
    if (iv.length !== CONSTANTS.IV_LENGTH) throw new Error("Invalid IV length");

    const metaEnd = offset;
    const signature = readBytes(readU16());
    const ciphertext = bytes.slice(offset);

    if (signature.length === 0) throw new Error("Missing signature");
    if (ciphertext.length < 16) throw new Error("Ciphertext too short");

    const signedData = this.concatBytes(bytes.slice(0, metaEnd), ciphertext);

    return { version, kid, iv, signature, ciphertext, signedData };
  }

  static async decryptEcdh(payload, options = {}) {
    const token = CONSTANTS.extractCiphertext(payload);
    if (!token) {
      throw new Error("Invalid ECDH payload");
    }

    let prefixLen = 0;
    if (token.startsWith(CONSTANTS.PREFIXES.ECDH)) {
      prefixLen = CONSTANTS.PREFIXES.ECDH.length;
    } else if (token.startsWith(CONSTANTS.LEGACY_PREFIXES.ECDH)) {
      prefixLen = CONSTANTS.LEGACY_PREFIXES.ECDH.length;
    } else {
      throw new Error("Invalid ECDH payload");
    }

    const base64Data = token.slice(prefixLen);
    const data = this.unpackEcdh(base64Data);

    if (!options.signingPublicKeySpki) {
      throw new Error("UNKNOWN_SENDER");
    }

    const verifyKey = await this.importEcdsaPublicKey(options.signingPublicKeySpki);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: CONSTANTS.RSA_HASH },
      verifyKey,
      data.signature,
      data.signedData
    );

    if (!valid) throw new Error("INVALID_SIGNATURE");

    if (!options.ownEcdhPrivateKeyJwk || !options.peerEcdhPublicKeySpki) {
      throw new Error("KEY_UNWRAP_FAILED");
    }

    const aesKey = await this.deriveEcdhAesKey(
      options.ownEcdhPrivateKeyJwk,
      options.peerEcdhPublicKeySpki,
      data.iv,
      `bale-e2ee-ecdh-v1:${data.kid}`
    );

    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.iv, tagLength: 128 },
      aesKey,
      data.ciphertext
    );

    return {
      plaintext: this.decoder.decode(plaintextBuffer),
      kid: data.kid
    };
  }

  static peekHybridKid(payload) {
    try {
      const token = CONSTANTS.extractCiphertext(payload);
      if (!token) return null;

      let prefixLen = 0;
      if (token.startsWith(CONSTANTS.PREFIXES.HYBRID)) {
        prefixLen = CONSTANTS.PREFIXES.HYBRID.length;
      } else if (token.startsWith(CONSTANTS.LEGACY_PREFIXES.HYBRID)) {
        prefixLen = CONSTANTS.LEGACY_PREFIXES.HYBRID.length;
      } else if (token.startsWith(CONSTANTS.PREFIXES.ECDH)) {
        prefixLen = CONSTANTS.PREFIXES.ECDH.length;
      } else if (token.startsWith(CONSTANTS.LEGACY_PREFIXES.ECDH)) {
        prefixLen = CONSTANTS.LEGACY_PREFIXES.ECDH.length;
      } else {
        return null;
      }

      const bytes = this.base64ToBuffer(token.slice(prefixLen));
      if (bytes.length < 2 || bytes[0] !== 1) return null;

      const kidLength = bytes[1];
      if (bytes.length < 2 + kidLength) return null;

      return this.decoder.decode(bytes.slice(2, 2 + kidLength));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // تبادل کلید (PARDAG-KEY) + بررسی انقضای زمانی درخواست (TTL)
  // ---------------------------------------------------------------------------

  static formatKeyExchange(identity) {
    return (
      `${CONSTANTS.PREFIXES.KEY_EXCHANGE}${CONSTANTS.KEY_EXCHANGE_VERSION}:` +
      `${identity.encryption.publicKeySpki}:${identity.signing.publicKeySpki}`
    );
  }

  static generateSessionId() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return this.hex(bytes);
  }

  /**
   * بررسی می‌کند آیا از زمان ارسال بسته تبادل کلید بیش از بازه مجاز (KEY_EXCHANGE_TTL_MS) گذشته است یا خیر.
   * اگر ساعت سیستم فرستنده کمی جلوتر از گیرنده باشد (elapsed < 0 تا سقف ۱ ساعت اختلاف ساعت)، منقضی محسوب نمی‌شود.
   */
  static isKeyExchangeExpired(
    bundle,
    ttlMs = CONSTANTS.KEY_EXCHANGE_TTL_MS,
    now = Date.now()
  ) {
    if (!bundle) return true;
    if (!Number.isFinite(bundle.timestamp) || bundle.timestamp <= 0) {
      return true;
    }
    const elapsed = now - bundle.timestamp;
    if (elapsed > ttlMs) return true;
    return false;
  }

  /**
   * ساخت پیام تبادل کلید امضاشده و زمان‌دار (نسخه ۲):
   * PARDAG-KEY:2:<EncPubKey>:<SigPubKey>:<ChatUID>:<Timestamp>:<Signature>[:<EcdhPubKey>[:<Role>:<SessionId>:<AckForFingerprint>]]
   */
  static async formatSignedKeyExchange(identity, chatUid = "", timestampOrOptions = Date.now(), extraOptions = {}) {
    const opts =
      typeof timestampOrOptions === "object" && timestampOrOptions !== null
        ? timestampOrOptions
        : { timestamp: timestampOrOptions, ...(extraOptions || {}) };

    const safeUid = String(chatUid || "").replace(/[^0-9a-zA-Z_-]/g, "");
    const ts = Number.isFinite(opts.timestamp) ? Math.trunc(opts.timestamp) : Date.now();
    const ecdhSpki = identity.ecdh?.publicKeySpki || "";
    const role = ["SYN", "ACK", "REJECT", "ROTATE"].includes(opts.role) ? opts.role : "";
    const sessionId = String(opts.sessionId || "").replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 24);
    const ackForFingerprint = String(opts.ackForFingerprint || "")
      .replace(/[^0-9A-Fa-f]/g, "")
      .toUpperCase()
      .slice(0, 16);

    let signedPayload;
    if (role) {
      signedPayload = `${CONSTANTS.PREFIXES.KEY_EXCHANGE}${CONSTANTS.SIGNED_KEY_EXCHANGE_VERSION}:${identity.encryption.publicKeySpki}:${identity.signing.publicKeySpki}:${safeUid}:${ts}:${ecdhSpki}:${role}:${sessionId}:${ackForFingerprint}`;
    } else if (ecdhSpki) {
      signedPayload = `${CONSTANTS.PREFIXES.KEY_EXCHANGE}${CONSTANTS.SIGNED_KEY_EXCHANGE_VERSION}:${identity.encryption.publicKeySpki}:${identity.signing.publicKeySpki}:${safeUid}:${ts}:${ecdhSpki}`;
    } else {
      signedPayload = `${CONSTANTS.PREFIXES.KEY_EXCHANGE}${CONSTANTS.SIGNED_KEY_EXCHANGE_VERSION}:${identity.encryption.publicKeySpki}:${identity.signing.publicKeySpki}:${safeUid}:${ts}`;
    }

    const signingKey = await this.importEcdsaPrivateKey(identity.signing.privateKeyJwk);
    const sigBuffer = await crypto.subtle.sign(
      { name: "ECDSA", hash: CONSTANTS.RSA_HASH },
      signingKey,
      this.encoder.encode(signedPayload)
    );
    const signatureBase64 = this.bufferToBase64(sigBuffer);

    if (role) {
      return (
        `${CONSTANTS.PREFIXES.KEY_EXCHANGE}${CONSTANTS.SIGNED_KEY_EXCHANGE_VERSION}:` +
        `${identity.encryption.publicKeySpki}:${identity.signing.publicKeySpki}:` +
        `${safeUid}:${ts}:${signatureBase64}:${ecdhSpki}:${role}:${sessionId}:${ackForFingerprint}`
      );
    }

    if (ecdhSpki) {
      return (
        `${CONSTANTS.PREFIXES.KEY_EXCHANGE}${CONSTANTS.SIGNED_KEY_EXCHANGE_VERSION}:` +
        `${identity.encryption.publicKeySpki}:${identity.signing.publicKeySpki}:` +
        `${safeUid}:${ts}:${signatureBase64}:${ecdhSpki}`
      );
    }

    return `${signedPayload}:${signatureBase64}`;
  }

  /**
   * تجزیه سخت‌گیرانه پیام تبادل کلید (پشتیبانی از PARDAG-KEY و BALEENC-KEY).
   */
  static parseKeyExchange(text) {
    if (!text) return null;
    const clean = CONSTANTS.stripFormatting(text).trim();
    const match = clean.match(CONSTANTS.KEY_EXCHANGE_REGEX);
    if (!match) return null;

    const usedPrefix = clean.startsWith(CONSTANTS.LEGACY_PREFIXES.KEY_EXCHANGE)
      ? CONSTANTS.LEGACY_PREFIXES.KEY_EXCHANGE
      : CONSTANTS.PREFIXES.KEY_EXCHANGE;

    const version = Number(match[1]);
    const encryptionPublicKeySpki = (match[2] || "").replace(/\s+/g, "");
    const signingPublicKeySpki = (match[3] || "").replace(/\s+/g, "");
    if (!encryptionPublicKeySpki || !signingPublicKeySpki) return null;

    const chatUid = match[4] !== undefined ? match[4] : null;
    const timestamp = match[5] !== undefined ? Number(match[5]) : null;
    const signature = match[6] ? match[6].replace(/\s+/g, "") : null;
    const ecdhPublicKeySpki = match[7] ? match[7].replace(/\s+/g, "") : null;
    const role = match[8] || null;
    const sessionId = match[9] !== undefined ? match[9] : null;
    const ackForFingerprint = match[10] ? match[10].toUpperCase() : null;

    if (version === 2 && (!timestamp || !signature)) {
      return null;
    }

    let signedPayload = null;
    if (timestamp !== null && signature) {
      if (role) {
        signedPayload = `${usedPrefix}${version}:${encryptionPublicKeySpki}:${signingPublicKeySpki}:${chatUid || ""}:${timestamp}:${ecdhPublicKeySpki || ""}:${role}:${sessionId || ""}:${ackForFingerprint || ""}`;
      } else if (ecdhPublicKeySpki) {
        signedPayload = `${usedPrefix}${version}:${encryptionPublicKeySpki}:${signingPublicKeySpki}:${chatUid || ""}:${timestamp}:${ecdhPublicKeySpki}`;
      } else {
        signedPayload = `${usedPrefix}${version}:${encryptionPublicKeySpki}:${signingPublicKeySpki}:${chatUid || ""}:${timestamp}`;
      }
    }

    return {
      version,
      encryptionPublicKeySpki,
      signingPublicKeySpki,
      ecdhPublicKeySpki: ecdhPublicKeySpki || null,
      chatUid,
      timestamp,
      signature,
      role: role || "SYN",
      hasExplicitRole: Boolean(role),
      sessionId: sessionId || null,
      ackForFingerprint: ackForFingerprint || null,
      signedPayload
    };
  }

  /**
   * اعتبارسنجی کامل بسته تبادل کلید:
   * نکته مهم در پیام‌رسان بله: در چت ۱:۱، پارامتر uid در آدرس مرورگر هر کاربر برابر با شناسه کاربری طرف مقابل است
   * (کاربر الف uid=B را می‌بیند و کاربر ب uid=A را می‌بیند)؛ بنابراین مقایسه مستقیم bundle.chatUid با expectedChatUid
   * به صورت پیش‌فرض غیرفعال است (مگر اینکه options.strictChatMatch صریحاً فعال شود) تا خطای کاذب «متعلق به این چت نیست» رخ ندهد.
   */
  static async verifyKeyExchange(textOrBundle, expectedChatUid = null, options = {}) {
    const bundle =
      typeof textOrBundle === "string"
        ? this.parseKeyExchange(textOrBundle)
        : textOrBundle;

    if (!bundle) {
      throw new Error("INVALID_KEY_EXCHANGE_FORMAT");
    }

    await this.importRsaPublicKey(bundle.encryptionPublicKeySpki);
    const verifyKey = await this.importEcdsaPublicKey(bundle.signingPublicKeySpki);

    if (bundle.ecdhPublicKeySpki) {
      await this.importEcdhPublicKey(bundle.ecdhPublicKeySpki);
    }

    if (bundle.signature && bundle.signedPayload) {
      if (
        options.strictChatMatch &&
        expectedChatUid &&
        bundle.chatUid &&
        String(bundle.chatUid).trim() !== String(expectedChatUid).trim()
      ) {
        throw new Error("KEY_EXCHANGE_CHAT_MISMATCH");
      }

      const sigValid = await crypto.subtle.verify(
        { name: "ECDSA", hash: CONSTANTS.RSA_HASH },
        verifyKey,
        this.base64ToBuffer(bundle.signature),
        this.encoder.encode(bundle.signedPayload)
      );

      if (!sigValid) {
        throw new Error("KEY_EXCHANGE_INVALID_SIGNATURE");
      }
    } else if (options.requireSignature) {
      throw new Error("KEY_EXCHANGE_UNSIGNED");
    }

    const isExpired = this.isKeyExchangeExpired(
      bundle,
      options.ttlMs ?? CONSTANTS.KEY_EXCHANGE_TTL_MS,
      options.now ?? Date.now()
    );

    if (options.enforceFreshness && isExpired) {
      throw new Error("KEY_EXCHANGE_EXPIRED");
    }

    const fingerprint = await this.getIdentityFingerprint(
      bundle.encryptionPublicKeySpki,
      bundle.signingPublicKeySpki
    );

    return {
      ...bundle,
      fingerprint,
      isExpired,
      signatureVerified: Boolean(bundle.signature && bundle.signedPayload)
    };
  }

  /**
   * کد امنیتی مشترک برای مقایسه شفاهی/حضوری توسط دو طرف.
   * بر اساس کلیدهای عمومی مرتب‌شده دو طرف محاسبه می‌شود تا مستقل از تفاوت uid در URL دو کاربر، در هر دو سمت یکسان باشد.
   */
  static async computeSafetyNumber(ownIdentity, peer) {
    const own = `ENC:${ownIdentity.encryption.publicKeySpki}|SIG:${ownIdentity.signing.publicKeySpki}`;
    const other = `ENC:${peer.encryptionPublicKeySpki}|SIG:${peer.signingPublicKeySpki}`;
    const [first, second] = [own, other].sort();

    const data = this.encoder.encode(`${first}|${second}`);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hex = this.hex(hashBuffer).slice(0, 32);
    return hex.match(/.{1,4}/g).join(" ");
  }
}
