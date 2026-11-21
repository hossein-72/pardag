// محافظ لایه صفحه: جلوگیری از ارسال متن خام پیش‌نویس بله روی WebSocket.
// این فایل باید در world=MAIN و document_start اجرا شود تا پیش از ساخت
// WebSocket توسط خود بله، متد send را جایگزین کند.
//
// بله پیش‌نویس را با دو کلید می‌فرستد:
//   drafts_<chatId>     (قدیمی، مقدار متن خام)
//   draftsv2_<chatId>   (جدید، مقدار JSON مانند {"text":"..."})
// هر دو در یک RPC از نوع bale.v1.Configs/EditParameter ارسال می‌شوند.
//
// به‌جای حذف کامل فریم (که RPC بله را بدون پاسخ می‌گذارد)، مقدار متن در
// همان فریم به رشته خالی بازنویسی می‌شود. این کار هم متن خام را به سرور
// نمی‌فرستد و هم پاسخ RPC و ترتیب درخواست‌ها حفظ می‌شود.
(() => {
  "use strict";

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || !NativeWebSocket.prototype) return;

  const proto = NativeWebSocket.prototype;
  if (proto.__baleEncDraftGuardInstalled) return;

  const nativeSend = proto.send;
  if (typeof nativeSend !== "function") return;

  const MAX_INSPECT_LENGTH = 2 * 1024 * 1024;
  const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
  const DRAFT_KEY_RE = /^(draftsv\d+|draftstv\d+|drafts)_(.+)$/;
  const CONFIG_SERVICE = "bale.v1.Configs";
  const EDIT_METHOD = "EditParameter";
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder("utf-8");

  // تا وقتی Content Script فهرست UID چت‌های رمزنگاری‌شده را نفرستاده، همه
  // پیش‌نویس‌ها خالی می‌شوند تا در لحظه شروع، متن خام خارج نشود.
  let encryptedUids = null;

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;

    const data = event.data;
    if (!data || data.type !== "BALE_ENC_DRAFT_UIDS") return;
    if (!Array.isArray(data.uids)) return;

    const next = new Set();
    for (const uid of data.uids) {
      if (typeof uid !== "string" && typeof uid !== "number") continue;
      const value = String(uid).trim();
      if (value) next.add(value);
    }
    encryptedUids = next;
  });

  // ---------------------------------------------------------------------------
  // ابزارهای Protobuf wire format (پشتیبانی کامل از اعداد ۶۴ بیتی و منفی ۱۰ بایتی)
  // ---------------------------------------------------------------------------

  /**
   * عبور سریع از یک varint تا رسیدن به بایتی که بیت هشتم آن صفر است (حداکثر ۱۰ بایت در Protobuf).
   * برای فیلدهای wire===0 که فقط raw آن‌ها کپی می‌شود نیازی به محاسبه مقدار عددی نیست.
   */
  function skipVarint(bytes, state) {
    for (let count = 0; count < 10 && state.i < bytes.length; count += 1) {
      const byte = bytes[state.i++];
      if ((byte & 0x80) === 0) return;
    }
    throw new Error("invalid varint");
  }

  /**
   * خواندن دقیق یک varint تا ۱۰ بایت کامل ۶۴ بیتی با استفاده از BigInt
   * تا در صورت وجود اعداد منفی یا ۶۴ بیتی بزرگ، خطای سرریز ۵۳ بیتی رخ ندهد.
   */
  function readVarint(bytes, state) {
    let result = 0n;
    let shift = 0n;

    for (let count = 0; count < 10 && state.i < bytes.length; count += 1) {
      const byte = bytes[state.i++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        if (result <= BigInt(Number.MAX_SAFE_INTEGER)) {
          return Number(result);
        }
        return result;
      }
      shift += 7n;
    }

    throw new Error("invalid varint");
  }

  /**
   * فیلدهای یک پیام protobuf را بدون تفسیر محتوای تودرتو برمی‌گرداند.
   * raw برای کپی بایت‌به‌بایت فیلدهای ناشناخته استفاده می‌شود.
   */
  function parseFields(bytes) {
    const fields = [];
    const state = { i: 0 };

    while (state.i < bytes.length) {
      const start = state.i;
      const tagRaw = readVarint(bytes, state);
      const tag = typeof tagRaw === "bigint" ? Number(tagRaw & 0xffffffffn) : tagRaw;
      const field = Math.floor(tag / 8);
      const wire = tag & 7;

      if (!field) throw new Error("invalid field");

      if (wire === 0) {
        const value = readVarint(bytes, state);
        fields.push({
          field,
          wire,
          value,
          raw: bytes.subarray(start, state.i)
        });
        continue;
      }

      if (wire === 1) {
        state.i += 8;
        if (state.i > bytes.length) throw new Error("truncated fixed64");
        fields.push({ field, wire, raw: bytes.subarray(start, state.i) });
        continue;
      }

      if (wire === 2) {
        const lengthRaw = readVarint(bytes, state);
        const length = typeof lengthRaw === "bigint" ? Number(lengthRaw) : lengthRaw;
        if (!Number.isSafeInteger(length) || length < 0) {
          throw new Error("invalid bytes length");
        }
        const dataStart = state.i;
        const end = dataStart + length;
        if (end > bytes.length) throw new Error("truncated bytes");

        state.i = end;
        fields.push({
          field,
          wire,
          data: bytes.subarray(dataStart, end),
          raw: bytes.subarray(start, end)
        });
        continue;
      }

      if (wire === 5) {
        state.i += 4;
        if (state.i > bytes.length) throw new Error("truncated fixed32");
        fields.push({ field, wire, raw: bytes.subarray(start, state.i) });
        continue;
      }

      // groupهای قدیمی protobuf در این پروتکل استفاده نمی‌شوند.
      throw new Error("unsupported wire type");
    }

    return fields;
  }

  function concatBytes(parts) {
    let total = 0;
    for (const part of parts) total += part.length;

    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  /**
   * کدگذاری varint با پشتیبانی کامل از اعداد صحیح بزرگ و اعداد منفی ۶۴ بیتی (۱۰ بایت).
   */
  function encodeVarint(value) {
    const parts = [];
    let current =
      typeof value === "bigint"
        ? BigInt.asUintN(64, value)
        : value < 0
        ? BigInt.asUintN(64, BigInt(Math.trunc(value)))
        : BigInt(Math.trunc(value));

    while (current > 0x7fn) {
      parts.push(Number((current & 0x7fn) | 0x80n));
      current >>= 7n;
    }
    parts.push(Number(current));

    return Uint8Array.from(parts);
  }

  function encodeBytesField(fieldNumber, value) {
    return concatBytes([
      encodeVarint(fieldNumber * 8 + 2),
      encodeVarint(value.length),
      value
    ]);
  }

  function encodeText(value) {
    return textEncoder.encode(value);
  }

  function decodeText(bytes) {
    try {
      return textDecoder.decode(bytes);
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------------------
  // تشخیص فریم پیش‌نویس
  // ---------------------------------------------------------------------------

  function base64ToBytes(value) {
    if (value.length < 8 || value.length > MAX_INSPECT_LENGTH) return null;

    const compact = value.trim();
    if (!BASE64_RE.test(compact)) return null;

    let normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    if (normalized.length % 4 === 2) normalized += "==";
    else if (normalized.length % 4 === 3) normalized += "=";
    else if (normalized.length % 4 !== 0) return null;

    try {
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return null;
    }
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(
        offset,
        Math.min(offset + chunkSize, bytes.length)
      );
      binary += String.fromCharCode.apply(null, chunk);
    }

    return btoa(binary);
  }

  /**
   * @returns {{ bytes: Uint8Array, asString: boolean } | null}
   */
  function getFrameBytes(data) {
    if (typeof data === "string") {
      const bytes = base64ToBytes(data);
      return bytes ? { bytes, asString: true } : null;
    }

    if (data instanceof ArrayBuffer) {
      if (data.byteLength > MAX_INSPECT_LENGTH) return null;
      return { bytes: new Uint8Array(data), asString: false };
    }

    if (ArrayBuffer.isView(data)) {
      if (data.byteLength > MAX_INSPECT_LENGTH) return null;
      return {
        bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        asString: false
      };
    }

    return null;
  }

  function findField(fields, fieldNumber, wireType) {
    return fields.find(
      (item) => item.field === fieldNumber && item.wire === wireType
    );
  }

  function hasV2Text(value) {
    if (!value) return false;

    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object") return true;

      const text = parsed.text;
      const draftText = parsed.draftText;

      if (typeof text === "string" && text.length > 0) return true;
      if (typeof draftText === "string" && draftText.length > 0) return true;
      if (text != null && typeof text !== "string") return true;
      if (draftText != null && typeof draftText !== "string") return true;
      return false;
    } catch {
      return true;
    }
  }

  /**
   * بررسی پشتیبان (Fallback): اگر تجزیه Protobuf به هر دلیل خطا داد ولی بایت‌های فریم
   * حاوی امضای RPC پیش‌نویس برای چت محافظت‌شده بود، اجازه ارسال خام داده نمی‌شود.
   */
  function looksLikeProtectedDraftFrame(bytes) {
    try {
      const decoded = textDecoder.decode(bytes);
      if (
        !decoded.includes(CONFIG_SERVICE) ||
        !decoded.includes(EDIT_METHOD)
      ) {
        return false;
      }
      const match = decoded.match(/(draftsv\d+|draftstv\d+|drafts)_([0-9a-zA-Z_-]+)/);
      if (!match) return false;
      const uid = match[2];
      return shouldClearDraft(uid);
    } catch {
      return false;
    }
  }

  /**
   * فریم bale.v1.Configs/EditParameter را تحلیل می‌کند.
   * اگر فریم پیش‌نویس نباشد null برمی‌گرداند.
   */
  function parseDraftRequest(bytes) {
    const outer = parseFields(bytes);
    const outerRequest = findField(outer, 1, 2);
    if (!outerRequest) return null;

    const request = parseFields(outerRequest.data);
    const serviceField = findField(request, 1, 2);
    const methodField = findField(request, 2, 2);
    if (!serviceField || !methodField) return null;
    if (decodeText(serviceField.data) !== CONFIG_SERVICE) return null;
    if (decodeText(methodField.data) !== EDIT_METHOD) return null;

    const payloadField = findField(request, 3, 2);
    if (!payloadField) return null;

    const payload = parseFields(payloadField.data);
    const keyField = findField(payload, 1, 2);
    const valueField = findField(payload, 2, 2);
    if (!keyField || !valueField) return null;

    const key = decodeText(keyField.data);
    const keyMatch = DRAFT_KEY_RE.exec(key);
    if (!keyMatch) return null;

    const kind = keyMatch[1] === "drafts" ? "old" : "v2";
    const uid = keyMatch[2];
    const valueFields = parseFields(valueField.data);
    const textField = findField(valueFields, 1, 2);
    const value = textField ? decodeText(textField.data) : "";
    const hasText = kind === "old" ? value.length > 0 : hasV2Text(value);

    return {
      outer,
      request,
      payload,
      valueFields,
      kind,
      uid,
      textField,
      hasText
    };
  }

  /**
   * همان RPC را با متن خالی بازمی‌سازد؛ metadata، index و فیلدهای ناشناخته
   * حفظ می‌شوند تا بله پاسخ RPC را دریافت کند.
   */
  function buildClearedFrame(draft) {
    const emptyText =
      draft.kind === "old" ? new Uint8Array(0) : encodeText('{"text":""}');

    const value = concatBytes([
      encodeBytesField(1, emptyText),
      ...draft.valueFields
        .filter((field) => field.field !== 1)
        .map((field) => field.raw)
    ]);

    const payload = concatBytes([
      ...draft.payload
        .filter((field) => field.field !== 2)
        .map((field) => field.raw),
      encodeBytesField(2, value)
    ]);

    const request = concatBytes([
      ...draft.request
        .filter((field) => field.field !== 3)
        .map((field) => field.raw),
      encodeBytesField(3, payload)
    ]);

    return concatBytes([
      ...draft.outer
        .filter((field) => field.field !== 1)
        .map((field) => field.raw),
      encodeBytesField(1, request)
    ]);
  }

  function shouldClearDraft(uid) {
    if (encryptedUids === null) return true;
    return encryptedUids.has(uid);
  }

  let clearedCount = 0;

  const guardedSend = function (data) {
    let frame = null;
    let draft = null;
    let parseFailed = false;

    try {
      frame = getFrameBytes(data);
      if (frame) draft = parseDraftRequest(frame.bytes);
    } catch {
      draft = null;
      parseFailed = true;
    }

    // اگر تجزیه Protobuf با خطا مواجه شد اما بایت‌های فریم نشان‌دهنده ارسال پیش‌نویس چت محافظت‌شده است،
    // هرگز فریم خام را ارسال نمی‌کنیم.
    if (parseFailed && frame && looksLikeProtectedDraftFrame(frame.bytes)) {
      return;
    }

    if (!draft || !draft.hasText || !shouldClearDraft(draft.uid)) {
      return nativeSend.apply(this, arguments);
    }

    clearedCount += 1;

    if (clearedCount <= 3) {
      console.info("[Bale E2EE] plaintext draft WebSocket frame cleared");
    }

    try {
      const cleared = buildClearedFrame(draft);
      const output = frame.asString ? bytesToBase64(cleared) : cleared;
      return nativeSend.call(this, output);
    } catch {
      // اگر بازنویسی ممکن نشد، ارسال فریم خام را متوقف می‌کنیم.
      return;
    }
  };

  function findSubVarint(fields, fieldNumber) {
    const f = findField(fields, fieldNumber, 2);
    if (!f || !f.data || f.data.length === 0) return null;
    try {
      const sub = parseFields(f.data);
      const inner = findField(sub, 1, 0);
      return inner ? inner.value : null;
    } catch {
      return null;
    }
  }

  function detectPeerTypeFromEntity(entity) {
    const uidField = findField(entity, 1, 0);
    if (!uidField || uidField.value === undefined || uidField.value === null) {
      return null;
    }
    const uid = String(uidField.value);
    if (!uid || uid === "0") return null;

    // Group / Channel: f18.f1 === 2 (group), f18.f1 === 3 (channel)
    const f18Val = findSubVarint(entity, 18);
    if (f18Val === 2) return { uid, chatType: "group" };
    if (f18Val === 3) return { uid, chatType: "channel" };

    // User / Bot: f5 is username submessage (wire 2)
    const f5Msg = findField(entity, 5, 2);
    if (f5Msg) {
      const isBotFlag = findSubVarint(entity, 9);
      const userType = findSubVarint(entity, 11);
      if (isBotFlag === 1 || userType === 4) {
        return { uid, chatType: "bot" };
      }
      if (userType === 1) {
        return { uid, chatType: "private" };
      }
    }

    return null;
  }

  function inspectIncomingBytes(bytes) {
    if (!bytes || bytes.length < 8 || bytes.length > MAX_INSPECT_LENGTH) return;
    try {
      const outer = parseFields(bytes);
      const f1 = findField(outer, 1, 2);
      if (!f1) return;
      const inner1 = parseFields(f1.data);
      const f2 = findField(inner1, 2, 2);
      if (!f2) return;
      const inner2 = parseFields(f2.data);
      for (const item of inner2) {
        if (item.wire !== 2 || !item.data || item.data.length < 4) continue;
        try {
          const entity = parseFields(item.data);
          const detected = detectPeerTypeFromEntity(entity);
          if (detected) {
            window.postMessage(
              {
                type: "BALE_ENC_PEER_TYPE",
                uid: detected.uid,
                chatType: detected.chatType
              },
              window.location.origin
            );
          }
        } catch {
          // آیتم غیرمرتبط
        }
      }
    } catch {
      // فریم غیرمرتبط یا غیرپروتوباف را نادیده می‌گیریم.
    }
  }

  function handleIncomingMessage(event) {
    const data = event?.data;
    if (!data) return;

    if (typeof Blob !== "undefined" && data instanceof Blob) {
      if (data.size > MAX_INSPECT_LENGTH) return;
      data.arrayBuffer().then((buf) => {
        inspectIncomingBytes(new Uint8Array(buf));
      }).catch(() => {});
      return;
    }

    const frame = getFrameBytes(data);
    if (frame) {
      inspectIncomingBytes(frame.bytes);
    }
  }

  const observedSockets = new WeakSet();
  function attachSocketObserver(ws) {
    if (!ws || observedSockets.has(ws)) return;
    observedSockets.add(ws);
    try {
      ws.addEventListener("message", handleIncomingMessage);
    } catch {}
  }

  const originalGuardedSend = guardedSend;
  const sendWithObserver = function (data) {
    attachSocketObserver(this);
    return originalGuardedSend.apply(this, arguments);
  };

  try {
    proto.send = sendWithObserver;
  } catch {
    return;
  }

  try {
    const GuardedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        attachSocketObserver(ws);
        return ws;
      }
    });
    window.WebSocket = GuardedWebSocket;
  } catch {
    // در صورت عدم امکان Proxy، attachSocketObserver در send فعال است.
  }

  try {
    Object.defineProperty(proto, "__baleEncDraftGuardInstalled", {
      value: true,
      enumerable: false,
      configurable: false
    });
  } catch {
    // خود جایگزینی send کافی است.
  }
})();
