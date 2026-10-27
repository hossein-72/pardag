import { CryptoEngine } from './src/content/crypto/crypto.js';
import { CONSTANTS } from './src/shared/constants.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    throw new Error(message);
  }
}

async function expectReject(promise, expectedMessage, label) {
  try {
    await promise;
  } catch (err) {
    if (expectedMessage && !String(err && err.message).includes(expectedMessage)) {
      throw new Error(`${label}: unexpected error "${err.message}"`);
    }
    return;
  }
  throw new Error(`${label}: operation should have failed`);
}

/**
 * مجموعه تست‌های رمزنگاری نسخه ۱.۴
 * - حالت قدیمی مبتنی بر رمز عبور (BALEENC1)
 * - حالت هیبریدی RSA-OAEP + AES-GCM + امضای ECDSA (BALEENC2)
 * - تبادل کلید و کد امنیتی
 */
export async function runCryptoTestSuite() {
  // -------------------------------------------------------------------------
  // ۱. سازگاری با حالت قدیمی مبتنی بر رمز عبور
  // -------------------------------------------------------------------------
  const vectorPassword = "correct-horse-battery-staple";
  const expectedFingerprint = await CryptoEngine.getKeyFingerprint(vectorPassword);

  const fp2 = await CryptoEngine.getKeyFingerprint(vectorPassword);
  assert(expectedFingerprint === fp2, "Fingerprint mismatch!");

  const legacyMessage = "پیام محرمانه آزمایشی\nخط دوم";
  const legacyC1 = await CryptoEngine.encrypt(legacyMessage, vectorPassword);
  const legacyC2 = await CryptoEngine.encrypt(legacyMessage, vectorPassword);
  assert(
    legacyC1 !== legacyC2,
    "CRITICAL: IV reuse detected! Ciphertexts must not match."
  );
  assert(
    legacyC1.startsWith(CONSTANTS.PREFIXES.PASSWORD),
    "Legacy ciphertext must keep BALEENC1 prefix"
  );

  const legacyDecrypted = await CryptoEngine.decrypt(legacyC1, vectorPassword);
  assert(legacyDecrypted === legacyMessage, "Legacy decryption mismatch!");

  const tamperedLegacy = legacyC1.slice(0, -4) + "AAAA";
  await expectReject(
    CryptoEngine.decrypt(tamperedLegacy, vectorPassword),
    null,
    "Legacy GCM tamper detection"
  );

  // -------------------------------------------------------------------------
  // ۲. تولید هویت و تبادل کلید
  // -------------------------------------------------------------------------
  const [identityA, identityB, identityC] = await Promise.all([
    CryptoEngine.generateIdentity(),
    CryptoEngine.generateIdentity(),
    CryptoEngine.generateIdentity()
  ]);

  assert(
    identityA.fingerprint !== identityB.fingerprint,
    "Identities must have different fingerprints"
  );
  assert(
    /^[0-9A-F]{8,}$/.test(identityA.fingerprint),
    "Fingerprint must be uppercase hex"
  );

  const keyExchangeMessage = CryptoEngine.formatKeyExchange(identityA);
  assert(
    keyExchangeMessage.startsWith(
      `${CONSTANTS.PREFIXES.KEY_EXCHANGE}${CONSTANTS.KEY_EXCHANGE_VERSION}:`
    ),
    "Key exchange message has wrong prefix"
  );

  const parsedKeys = CryptoEngine.parseKeyExchange(
    `\u200f${keyExchangeMessage}\u200f`
  );
  assert(parsedKeys, "Key exchange message could not be parsed");
  assert(
    parsedKeys.encryptionPublicKeySpki === identityA.encryption.publicKeySpki,
    "Parsed encryption key mismatch"
  );
  assert(
    parsedKeys.signingPublicKeySpki === identityA.signing.publicKeySpki,
    "Parsed signing key mismatch"
  );
  assert(
    CryptoEngine.parseKeyExchange("سلام، این پیام کلید نیست") === null,
    "Non-key message must not parse"
  );

  // -------------------------------------------------------------------------
  // ۳. رمزنگاری هیبریدی
  // -------------------------------------------------------------------------
  const hybridMessage =
    "سلام! این یک پیام آزمایشی RSA است 🔐\nخط دوم با متن فارسی.";

  const hybridPayload = await CryptoEngine.encryptHybrid(hybridMessage, {
    peerEncryptionPublicKeySpki: identityB.encryption.publicKeySpki,
    ownEncryptionPublicKeySpki: identityA.encryption.publicKeySpki,
    ownSigningPrivateKeyJwk: identityA.signing.privateKeyJwk,
    senderFingerprint: identityA.fingerprint
  });

  assert(
    hybridPayload.startsWith(CONSTANTS.PREFIXES.HYBRID),
    "Hybrid payload must use BALEENC2 prefix"
  );
  assert(
    CryptoEngine.peekHybridKid(hybridPayload) ===
      identityA.fingerprint.slice(0, 16),
    "peekHybridKid mismatch"
  );

  const hybridResult = await CryptoEngine.decryptHybrid(hybridPayload, {
    privateKeyJwk: identityB.encryption.privateKeyJwk,
    signingPublicKeySpki: identityA.signing.publicKeySpki
  });
  assert(hybridResult.plaintext === hybridMessage, "Hybrid decryption mismatch!");
  assert(
    hybridResult.kid === identityA.fingerprint.slice(0, 16),
    "Hybrid kid mismatch"
  );

  // فرستنده هم باید بتواند پیام ارسالی خودش را بعد از بارگذاری مجدد بخواند
  const selfResult = await CryptoEngine.decryptHybrid(hybridPayload, {
    privateKeyJwk: identityA.encryption.privateKeyJwk,
    signingPublicKeySpki: identityA.signing.publicKeySpki
  });
  assert(selfResult.plaintext === hybridMessage, "Self decryption mismatch!");

  // دو بار رمزنگاری یک متن باید خروجی متفاوت بدهد (IV و کلید AES تصادفی)
  const hybridPayload2 = await CryptoEngine.encryptHybrid(hybridMessage, {
    peerEncryptionPublicKeySpki: identityB.encryption.publicKeySpki,
    ownEncryptionPublicKeySpki: identityA.encryption.publicKeySpki,
    ownSigningPrivateKeyJwk: identityA.signing.privateKeyJwk,
    senderFingerprint: identityA.fingerprint
  });
  assert(
    hybridPayload !== hybridPayload2,
    "Hybrid ciphertexts must differ for identical plaintext"
  );

  // -------------------------------------------------------------------------
  // ۴. تشخیص دستکاری، امضای جعلی و کلید اشتباه
  // -------------------------------------------------------------------------
  const tamperedHybrid = hybridPayload.slice(0, -6) + "AAAAAA";
  await expectReject(
    CryptoEngine.decryptHybrid(tamperedHybrid, {
      privateKeyJwk: identityB.encryption.privateKeyJwk,
      signingPublicKeySpki: identityA.signing.publicKeySpki
    }),
    null,
    "Hybrid tamper detection"
  );

  await expectReject(
    CryptoEngine.decryptHybrid(hybridPayload, {
      privateKeyJwk: identityB.encryption.privateKeyJwk,
      signingPublicKeySpki: identityB.signing.publicKeySpki
    }),
    "INVALID_SIGNATURE",
    "Hybrid signature verification"
  );

  await expectReject(
    CryptoEngine.decryptHybrid(hybridPayload, {
      privateKeyJwk: identityC.encryption.privateKeyJwk,
      signingPublicKeySpki: identityA.signing.publicKeySpki
    }),
    "KEY_UNWRAP_FAILED",
    "Hybrid wrong recipient key"
  );

  await expectReject(
    CryptoEngine.decryptHybrid(hybridPayload, {
      privateKeyJwk: identityB.encryption.privateKeyJwk
    }),
    "UNKNOWN_SENDER",
    "Hybrid missing sender signing key"
  );

  // -------------------------------------------------------------------------
  // ۵. کد امنیتی (Safety Number)
  // -------------------------------------------------------------------------
  const safetyNumberA = await CryptoEngine.computeSafetyNumber(identityA, {
    encryptionPublicKeySpki: identityB.encryption.publicKeySpki,
    signingPublicKeySpki: identityB.signing.publicKeySpki,
    chatUid: "bale_123"
  });
  const safetyNumberB = await CryptoEngine.computeSafetyNumber(identityB, {
    encryptionPublicKeySpki: identityA.encryption.publicKeySpki,
    signingPublicKeySpki: identityA.signing.publicKeySpki,
    chatUid: "bale_123"
  });

  assert(
    safetyNumberA === safetyNumberB,
    "Safety numbers must match on both sides"
  );
  assert(
    /^[0-9A-F]{4}( [0-9A-F]{4}){7}$/.test(safetyNumberA),
    "Safety number format is invalid"
  );

  const safetyNumberOtherChat = await CryptoEngine.computeSafetyNumber(identityA, {
    encryptionPublicKeySpki: identityB.encryption.publicKeySpki,
    signingPublicKeySpki: identityB.signing.publicKeySpki,
    chatUid: "bale_999"
  });
  assert(
    safetyNumberA !== safetyNumberOtherChat,
    "Safety numbers must be bound to the chat"
  );

  // -------------------------------------------------------------------------
  // ۶. جدا بودن فضای نام پیام‌های قدیمی و جدید
  // -------------------------------------------------------------------------
  await expectReject(
    CryptoEngine.decrypt(hybridPayload, vectorPassword),
    null,
    "Legacy decrypt must reject hybrid payload"
  );

  return true;
}
