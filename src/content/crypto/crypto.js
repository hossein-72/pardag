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
    // پاکسازی فاصله‌ها، شکستگی‌های خط و کاراکترهای نامرئی یونیکد/BiDi
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
  // حالت پسورد مشترک (BALEENC1) — برای سازگاری با نسخه قبلی
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
      true, // extractable برای محاسبه fingerprint
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

  /**
   * رمزنگاری متن با پسورد مشترک
   * خروجی: BALEENC1:<base64(IV(12B) || ciphertext || GCM_tag(16B))>
   */
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

  /**
   * رمزگشایی متن BALEENC1 با پسورد مشترک
   */
  static async decrypt(payload, password) {
    const token = CONSTANTS.extractCiphertext(payload);
    if (!token || !token.startsWith(CONSTANTS.PREFIXES.PASSWORD)) {
      throw new Error("Invalid prefix");
    }

    const base64Data = token.slice(CONSTANTS.PREFIXES.PASSWORD.length);
    const combined = this.base64ToBuffer(base64Data);

    // حداقل طول: 12 بایت IV + 16 بایت تگ = 28 بایت
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
  // هویت رمزنگاری: RSA-OAEP برای رمزنگاری + ECDSA برای امضا
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
    const [encryption, signing] = await Promise.all([
      this.generateRsaKeyPair(),
      this.generateEcdsaKeyPair()
    ]);
    const fingerprint = await this.getIdentityFingerprint(
      encryption.publicKeySpki,
      signing.publicKeySpki
    );

    return {
      version: 1,
      encryption,
      signing,
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
  // پیام هیبریدی (BALEENC2):
  // AES-256-GCM برای متن + RSA-OAEP برای بسته‌بندی کلید AES + ECDSA برای امضا
  // ---------------------------------------------------------------------------

  /**
   * @param {string} plaintext
   * @param {object} options
   * @param {string} options.peerEncryptionPublicKeySpki
   * @param {string} options.ownEncryptionPublicKeySpki
   * @param {object} options.ownSigningPrivateKeyJwk
   * @param {string} options.senderFingerprint
   */
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

    // ۱. کلید AES تصادفی برای همین پیام
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

    // ۲. بسته‌بندی کلید AES برای مخاطب و برای خودمان (خواندن روی دستگاه‌های دیگر)
    const peerWrapped = await this.wrapAesKey(aesKeyBytes, peerEncryptionPublicKeySpki);
    const selfWrapped = await this.wrapAesKey(aesKeyBytes, ownEncryptionPublicKeySpki);

    const kid = String(senderFingerprint || "").trim().slice(0, 16);
    const kidBytes = this.encoder.encode(kid);

    const meta = this.concatBytes(
      new Uint8Array([1]), // version
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

    // ۳. امضای دیجیتال برای اثبات اینکه پیام واقعاً از طرف فرستنده است
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

  /**
   * رمزگشایی و اعتبارسنجی پیام BALEENC2
   * @param {string} payload
   * @param {object} options
   * @param {object} options.privateKeyJwk - کلید خصوصی RSA خودمان
   * @param {string} options.signingPublicKeySpki - کلید عمومی امضای فرستنده
   */
  static async decryptHybrid(payload, options = {}) {
    const token = CONSTANTS.extractCiphertext(payload);
    if (!token || !token.startsWith(CONSTANTS.PREFIXES.HYBRID)) {
      throw new Error("Invalid hybrid payload");
    }

    const base64Data = token.slice(CONSTANTS.PREFIXES.HYBRID.length);
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
    if (!options.privateKeyJwk) throw new Error("Missing private key");

    // یکی از دو نسخه بسته‌بندی‌شده باید با کلید خصوصی ما باز شود.
    let aesKeyBytes = null;
    for (const wrapped of [data.peerWrapped, data.selfWrapped]) {
      try {
        aesKeyBytes = await this.unwrapAesKey(wrapped, options.privateKeyJwk);
        break;
      } catch {
        // نسخه مربوط به طرف مقابل است؛ نسخه بعدی را امتحان می‌کنیم.
      }
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

  static peekHybridKid(payload) {
    try {
      const token = CONSTANTS.extractCiphertext(payload);
      if (!token || !token.startsWith(CONSTANTS.PREFIXES.HYBRID)) return null;

      const bytes = this.base64ToBuffer(token.slice(CONSTANTS.PREFIXES.HYBRID.length));
      if (bytes.length < 2 || bytes[0] !== 1) return null;

      const kidLength = bytes[1];
      if (bytes.length < 2 + kidLength) return null;

      return this.decoder.decode(bytes.slice(2, 2 + kidLength));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // تبادل کلید و کد امنیتی
  // ---------------------------------------------------------------------------

  static formatKeyExchange(identity) {
    return (
      `${CONSTANTS.PREFIXES.KEY_EXCHANGE}${CONSTANTS.KEY_EXCHANGE_VERSION}:` +
      `${identity.encryption.publicKeySpki}:${identity.signing.publicKeySpki}`
    );
  }

  static parseKeyExchange(text) {
    const clean = CONSTANTS.stripFormatting(text);
    const match = clean.match(CONSTANTS.KEY_EXCHANGE_REGEX);
    if (!match) return null;

    const encryptionPublicKeySpki = match[1].replace(/\s+/g, "");
    const signingPublicKeySpki = match[2].replace(/\s+/g, "");
    if (!encryptionPublicKeySpki || !signingPublicKeySpki) return null;

    return { encryptionPublicKeySpki, signingPublicKeySpki };
  }

  /**
   * کد امنیتی مشترک برای مقایسه شفاهی/حضوری توسط دو طرف.
   */
  static async computeSafetyNumber(ownIdentity, peer) {
    const own = `ENC:${ownIdentity.encryption.publicKeySpki}|SIG:${ownIdentity.signing.publicKeySpki}`;
    const other = `ENC:${peer.encryptionPublicKeySpki}|SIG:${peer.signingPublicKeySpki}`;
    const [first, second] = [own, other].sort();

    const data = this.encoder.encode(`${first}|${second}|${peer.chatUid || ""}`);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hex = this.hex(hashBuffer).slice(0, 32);
    return hex.match(/.{1,4}/g).join(" ");
  }
}
