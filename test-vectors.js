import { CryptoEngine } from './src/content/crypto/crypto.js';

export async function runCryptoTestSuite() {
  const vectorPassword = "correct-horse-battery-staple";
  const expectedFingerprint = await CryptoEngine.getKeyFingerprint(vectorPassword);

  // ۱. بررسی قطعی بودن Fingerprint (Deterministic PBKDF2)
  const fp2 = await CryptoEngine.getKeyFingerprint(vectorPassword);
  console.assert(expectedFingerprint === fp2, "Fingerprint mismatch!");

  // ۲. بررسی یکتا بودن IV در دو بار رمزنگاریِ یک متن یکسان
  const msg = "پیام محرمانه آزمایشی";
  const c1 = await CryptoEngine.encrypt(msg, vectorPassword);
  const c2 = await CryptoEngine.encrypt(msg, vectorPassword);
  console.assert(c1 !== c2, "CRITICAL: IV reuse detected! Ciphertexts must not match.");

  // ۳. صحت رمزگشایی و حفظ خطوط جدید
  const d1 = await CryptoEngine.decrypt(c1, vectorPassword);
  console.assert(d1 === msg, "Decryption mismatch!");

  // ۴. بررسی خطای دستکاری (GCM Auth Tag Integrity)
  let tampered = c1.slice(0, -4) + "AAAA";
  let failedAsExpected = false;
  try {
    await CryptoEngine.decrypt(tampered, vectorPassword);
  } catch {
    failedAsExpected = true;
  }
  console.assert(failedAsExpected, "CRITICAL: GCM authentication tag tampering was not detected!");
  return true;
}
