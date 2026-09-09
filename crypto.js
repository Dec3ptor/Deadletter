/* ============================================================
   Deadletter — the envelope.

   A thread has a code. The code never leaves this browser: it is turned into
   a key here, and only ciphertext is ever handed to the store. The server
   holds posts it cannot read, and neither can anyone who loads the page
   without the code.

   What is encrypted, and what is not, stated plainly because the difference
   is the whole security model:

     encrypted   the body of every post, and every attached file
     public      the thread title, the number of posts, their sizes, and
                 when each one was written

   Anyone can copy every byte this site stores. That is what "public" means
   here, and it decides the rest of the design: the code is the only secret,
   so it has to be strong enough to survive an attacker working offline
   against a copy of the ciphertext for as long as they like. Generated codes
   carry 256 bits and are used as the key directly. A code someone types
   themselves is stretched with PBKDF2-HMAC-SHA256 at 600,000 iterations,
   which raises the cost of each guess but cannot rescue a guessable code.
   ============================================================ */
(function () {
  'use strict';

  var te = new TextEncoder(), td = new TextDecoder();

  var VERSION = 1;
  var ITERATIONS = 600000;
  var CODE_PREFIX = 'DL1-';
  /* The plaintext of the verifier. It is a fixed, public string on purpose:
     its only job is to fail its tag when the key is wrong. */
  var VERIFY_PLAINTEXT = 'deadletter-verify-v1';

  /* ---------- bytes ---------- */
  function join() {
    var parts = [].slice.call(arguments);
    var n = parts.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(n), at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }
  function b64(bytes) {
    var s = '', i;
    for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(str) {
    var raw = atob(String(str || '')), out = new Uint8Array(raw.length), i;
    for (i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function b64url(bytes) {
    return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(str) {
    var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return unb64(s);
  }

  /* ---------- codes ---------- */
  /* 256 bits from the system generator, used as the key with no stretching:
     there is nothing to stretch, the entropy is already there. */
  function generateCode() {
    return CODE_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  }
  function isGeneratedCode(code) {
    return /^DL1-[A-Za-z0-9_-]{43}$/.test(String(code || ''));
  }

  /* A typed code is only as good as it is. This is advisory — it never blocks
     anyone — but a thread is public forever and the code cannot be changed
     afterwards without rewriting every post, so it is worth saying up front. */
  function rateCode(code) {
    var s = String(code || '');
    if (isGeneratedCode(s)) return { level: 'strong', text: 'Generated key, 256 bits. Nothing to guess.' };
    if (!s) return { level: 'none', text: '' };
    var classes = (/[a-z]/.test(s) ? 1 : 0) + (/[A-Z]/.test(s) ? 1 : 0) +
                  (/[0-9]/.test(s) ? 1 : 0) + (/[^A-Za-z0-9]/.test(s) ? 1 : 0);
    if (s.length < 12) return { level: 'weak', text: 'Short enough to be guessed offline. Use the generated key.' };
    if (s.length < 20 || classes < 3) return { level: 'fair', text: 'Workable, but the generated key is far stronger.' };
    return { level: 'good', text: 'Long enough to be reasonable. The generated key is still stronger.' };
  }

  /* ---------- keys ---------- */
  async function deriveKey(code, saltB64, iterations) {
    if (isGeneratedCode(code)) {
      return crypto.subtle.importKey('raw', unb64url(code.slice(CODE_PREFIX.length)),
        { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }
    var material = await crypto.subtle.importKey('raw', te.encode(String(code)),
      'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64(saltB64), iterations: iterations || ITERATIONS, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /* The stored iteration count is read back rather than assumed, so a later
     version can raise it and old threads still open. Reading it is safe: it
     sits inside the additional data of the verifier, so changing it changes
     the key and the tag fails. The bounds only stop a malformed row from
     asking the browser for absurd work. */
  function iterationsOf(thread) {
    var n = parseInt(thread && thread.iterations, 10);
    return (n >= 100000 && n <= 10000000) ? n : ITERATIONS;
  }

  /* ---------- a new thread ---------- */
  /* The verifier is a known plaintext sealed with the thread key. It lets the
     page say "that code is wrong" instead of showing someone a wall of
     mojibake and letting them wonder. It gives an attacker nothing: every
     post is a known-format ciphertext under the same key already, so there
     was always something to test a guess against. */
  async function newThreadSecrets(code) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var saltB64 = b64(salt);
    var meta = { version: VERSION, kdf: isGeneratedCode(code) ? 'RAW-256' : 'PBKDF2-HMAC-SHA256', iterations: ITERATIONS, salt: saltB64 };
    var key = await deriveKey(code, saltB64, ITERATIONS);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var aad = te.encode('deadletter:verify:' + VERSION);
    var sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv, additionalData: aad, tagLength: 128 },
      key, te.encode(VERIFY_PLAINTEXT)));
    meta.verifier = b64(join(iv, sealed));
    return { meta: meta, key: key };
  }

  /* Open a thread with a code. Fails closed: a wrong code and a tampered
     verifier are indistinguishable, and both refuse. */
  async function openThread(thread, code) {
    var key = await deriveKey(code, thread.salt, iterationsOf(thread));
    var blob = unb64(thread.verifier);
    var iv = blob.slice(0, 12), sealed = blob.slice(12);
    var aad = te.encode('deadletter:verify:' + (thread.version || VERSION));
    var plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv, additionalData: aad, tagLength: 128 }, key, sealed);
    } catch (e) {
      throw new Error('wrong-code');
    }
    if (td.decode(plain) !== VERIFY_PLAINTEXT) throw new Error('wrong-code');
    return key;
  }

  /* ---------- posts ---------- */
  /* The thread id is the additional data, so a ciphertext lifted out of one
     thread and dropped into another fails its tag rather than decrypting into
     a conversation it was never part of. */
  function postAAD(threadId) {
    return te.encode('deadletter:post:' + VERSION + ':' + threadId);
  }

  async function sealPost(key, threadId, payload) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var plain = te.encode(JSON.stringify(payload));
    var sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv, additionalData: postAAD(threadId), tagLength: 128 }, key, plain));
    return b64(join(iv, sealed));
  }

  async function openPost(key, threadId, body) {
    var blob = unb64(body);
    if (blob.length < 13) throw new Error('short');
    var plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: postAAD(threadId), tagLength: 128 },
      key, blob.slice(12));
    return JSON.parse(td.decode(plain));
  }

  /* ---------- attachments ---------- */
  /* Files are sealed the same way and stored apart from the row, so a thread
     of photographs does not turn every listing into a megabyte of base64. The
     id is public; the bytes are not. */
  async function sealBytes(key, threadId, bytes) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv, additionalData: postAAD(threadId), tagLength: 128 }, key, bytes));
    return join(iv, sealed);
  }
  async function openBytes(key, threadId, blob) {
    var b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b.slice(0, 12), additionalData: postAAD(threadId), tagLength: 128 },
      key, b.slice(12)));
  }

  window.DeadletterCrypto = {
    VERSION: VERSION,
    ITERATIONS: ITERATIONS,
    generateCode: generateCode,
    isGeneratedCode: isGeneratedCode,
    rateCode: rateCode,
    newThreadSecrets: newThreadSecrets,
    openThread: openThread,
    sealPost: sealPost,
    openPost: openPost,
    sealBytes: sealBytes,
    openBytes: openBytes,
    b64: b64,
    unb64: unb64
  };
})();
