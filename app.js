/* ============================================================
   Deadletter — the board.

   Keys live in memory for the life of the tab and nowhere else. Reloading
   locks every thread again, which is the intended behaviour: a key sitting
   in storage is a key that outlives the person who typed it.
   ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var C = window.DeadletterCrypto, Store = window.DeadletterStore, CFG = window.DEADLETTER_CONFIG || {};

  var threads = [];        // rows from the store, newest activity first
  var current = null;      // the open thread row
  var keys = {};           // thread id -> CryptoKey, this tab only
  var posts = [];          // rows for the open thread
  var opened = {};         // post id -> decrypted payload
  var pending = [];        // attachments staged for the next post
  var unsubscribe = null;

  function say(msg) { $('status').textContent = msg || ''; }

  function when(iso) {
    var d = new Date(iso), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- the rail ---------- */
  async function loadThreads(selectId) {
    try { threads = await Store.listThreads(); }
    catch (e) { console.error(e); say('Could not reach the store. Your posts are safe; the list is not loading.'); return; }
    drawRail();
    if (selectId) {
      var row = threads.filter(function (t) { return t.id === selectId; })[0];
      if (row) openThread(row);
    }
  }

  function drawRail() {
    var list = $('railList');
    list.innerHTML = '';
    $('railEmpty').hidden = threads.length > 0;
    threads.forEach(function (t) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'thread';
      if (current && current.id === t.id) b.setAttribute('aria-current', 'true');

      var title = document.createElement('span');
      title.className = 't';
      title.textContent = t.title;

      var meta = document.createElement('span');
      meta.className = 'm';
      var n = t.post_count || 0;
      var count = document.createElement('span');
      count.textContent = n + (n === 1 ? ' post' : ' posts');
      meta.appendChild(count);
      var state = document.createElement('span');
      if (keys[t.id]) { state.className = 'open'; state.textContent = 'OPEN'; }
      else state.textContent = 'SEALED';
      meta.appendChild(state);

      b.appendChild(title);
      b.appendChild(meta);
      b.onclick = function () { openThread(t); };
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  /* ---------- opening a thread ---------- */
  async function openThread(t) {
    current = t;
    opened = {};
    pending = [];
    drawAttached();
    document.body.dataset.pane = 'view';
    $('viewTitle').textContent = t.title;
    $('viewEmpty').hidden = true;
    $('viewState').hidden = false;
    drawRail();
    setLocked(!keys[t.id]);
    say('');

    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    $('posts').innerHTML = '';
    try { posts = await Store.listPosts(t.id); }
    catch (e) { console.error(e); posts = []; say('Could not load this thread.'); }
    await drawPosts();

    unsubscribe = Store.subscribe(t.id, async function (row) {
      if (posts.some(function (p) { return p.id === row.id; })) return;
      posts.push(row);
      await drawPosts();
    });
  }

  function setLocked(locked) {
    $('viewState').textContent = locked ? 'Sealed' : 'Open';
    $('viewState').classList.toggle('open', !locked);
    $('lockBar').hidden = !locked;
    $('compose').hidden = locked;
    if (locked) $('codeInput').value = '';
  }

  /* ---------- posts ---------- */
  async function drawPosts() {
    var host = $('posts'), key = current && keys[current.id];
    host.innerHTML = '';

    if (!posts.length) {
      var none = document.createElement('p');
      none.className = 'railempty';
      none.textContent = key
        ? 'Nothing posted yet. You have the code, so you can be first.'
        : 'Nothing posted yet.';
      host.appendChild(none);
      return;
    }

    for (var i = 0; i < posts.length; i++) {
      var row = posts[i];
      if (key && !opened[row.id]) {
        try { opened[row.id] = await C.openPost(key, current.id, row.body); }
        catch (e) { opened[row.id] = { broken: true }; }
      }
      host.appendChild(key ? drawOpen(row, opened[row.id]) : drawSealed(row));
    }
    host.scrollTop = host.scrollHeight;
  }

  function drawSealed(row) {
    var el = document.createElement('div');
    el.className = 'post locked';
    var w = document.createElement('span');
    w.className = 'when';
    w.textContent = when(row.created_at) + ' · sealed';
    /* The real stored bytes, not a placeholder. What is on screen is what the
       server holds and what anyone else who asks for it receives. */
    var pre = document.createElement('pre');
    pre.className = 'cipher';
    pre.textContent = row.body;
    el.appendChild(w);
    el.appendChild(pre);
    return el;
  }

  function drawOpen(row, payload) {
    var el = document.createElement('div');
    el.className = 'post';
    var w = document.createElement('span');
    w.className = 'when';
    w.textContent = when(row.created_at);
    el.appendChild(w);

    if (!payload || payload.broken) {
      var bad = document.createElement('p');
      bad.className = 'text';
      bad.textContent = 'This post did not open with the thread key. It was written under a different code, or it has been altered since.';
      el.appendChild(bad);
      return el;
    }

    if (payload.text) {
      var p = document.createElement('p');
      p.className = 'text';
      linkify(p, payload.text);
      el.appendChild(p);
    }
    (payload.files || []).forEach(function (f) {
      var fig = document.createElement('figure');
      var img = document.createElement('img');
      img.alt = f.name || 'attached image';
      img.loading = 'lazy';
      fig.appendChild(img);
      var cap = document.createElement('figcaption');
      cap.textContent = 'decrypting…';
      fig.appendChild(cap);
      el.appendChild(fig);
      showFile(f, img, cap);
    });
    return el;
  }

  /* Links are built as real nodes from matched spans rather than by writing
     HTML, so a post can never inject markup into the page it appears on. */
  function linkify(host, text) {
    var re = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, at = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > at) host.appendChild(document.createTextNode(text.slice(at, m.index)));
      var a = document.createElement('a');
      a.href = m[0];
      a.textContent = m[0];
      a.rel = 'noopener noreferrer nofollow ugc';
      a.target = '_blank';
      host.appendChild(a);
      at = m.index + m[0].length;
    }
    if (at < text.length) host.appendChild(document.createTextNode(text.slice(at)));
  }

  async function showFile(f, img, cap) {
    try {
      var blob = await Store.getFile(f.id);
      if (!blob) { cap.textContent = 'attachment missing from the store'; return; }
      var bytes = await C.openBytes(keys[current.id], current.id, blob);
      var url = URL.createObjectURL(new Blob([bytes], { type: f.type || 'application/octet-stream' }));
      img.src = url;
      img.onload = function () { URL.revokeObjectURL(url); };
      cap.textContent = f.name || '';
    } catch (e) {
      console.error(e);
      cap.textContent = 'this attachment did not open with the thread key';
    }
  }

  /* ---------- unlocking ---------- */
  $('showCodeBtn').onclick = function () {
    var i = $('codeInput'), show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
  };
  $('codeInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('unlockBtn').click(); }
  });

  $('unlockBtn').onclick = async function () {
    if (!current) return;
    var code = $('codeInput').value;
    if (!code) { say('Enter the thread code.'); return; }
    this.disabled = true;
    say('Deriving the key…');
    try {
      keys[current.id] = await C.openThread(current, code);
    } catch (e) {
      this.disabled = false;
      // AES-GCM fails closed: a wrong code and a tampered thread look the same.
      say('That code does not open this thread.');
      return;
    }
    this.disabled = false;
    say('Open. The key stays in this tab and is forgotten when you close it.');
    setLocked(false);
    drawRail();
    opened = {};
    await drawPosts();
  };

  /* ---------- posting ---------- */
  $('attachBtn').onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function () {
    [].forEach.call(this.files, function (f) {
      if (f.size > (CFG.maxFileBytes || 5242880)) {
        say('“' + f.name + '” is larger than the ' + Math.round((CFG.maxFileBytes || 5242880) / 1048576) + ' MB limit and was not attached.');
        return;
      }
      pending.push(f);
    });
    this.value = '';
    drawAttached();
  };

  function drawAttached() {
    var host = $('attached');
    host.innerHTML = '';
    pending.forEach(function (f, i) {
      var s = document.createElement('span');
      s.appendChild(document.createTextNode(f.name));
      var x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', 'Remove ' + f.name);
      x.onclick = function () { pending.splice(i, 1); drawAttached(); };
      s.appendChild(x);
      host.appendChild(s);
    });
  }

  $('compose').onsubmit = async function (e) {
    e.preventDefault();
    if (!current || !keys[current.id]) return;
    var text = $('postText').value.trim();
    if (!text && !pending.length) return;

    var btn = $('postBtn');
    btn.disabled = true;
    say('Encrypting…');
    try {
      var key = keys[current.id], files = [];
      for (var i = 0; i < pending.length; i++) {
        var f = pending[i];
        var sealed = await C.sealBytes(key, current.id, new Uint8Array(await f.arrayBuffer()));
        var id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + i) + '.bin';
        await Store.putFile(id, sealed);
        files.push({ id: id, name: f.name, type: f.type, size: f.size });
      }
      var body = await C.sealPost(key, current.id, { v: 1, text: text, files: files });
      var row = await Store.createPost({ thread_id: current.id, body: body });

      $('postText').value = '';
      pending = [];
      drawAttached();
      if (!posts.some(function (p) { return p.id === row.id; })) posts.push(row);
      await drawPosts();
      say('Posted. It left this browser already sealed.');
      loadThreads();
    } catch (err) {
      console.error(err);
      say('That post could not be sent. Nothing was written.');
    }
    btn.disabled = false;
  };

  /* ---------- starting a thread ---------- */
  var dlg = $('newDialog');
  $('newThreadBtn').onclick = function () {
    $('newTitle').value = '';
    $('newCode').value = '';
    $('strength').textContent = '';
    $('strength').className = 'strength';
    dlg.showModal();
    $('newTitle').focus();
  };
  $('genCodeBtn').onclick = function () {
    $('newCode').value = C.generateCode();
    $('newCode').type = 'text';
    rate();
  };
  $('newCode').addEventListener('input', rate);
  function rate() {
    var r = C.rateCode($('newCode').value);
    $('strength').textContent = r.text;
    $('strength').className = 'strength' + (r.level === 'weak' ? ' weak' : '');
  }

  $('newForm').onsubmit = async function (e) {
    // The dialog's own submit closes it; only the create button does work.
    if (e.submitter && e.submitter.value !== 'create') return;
    e.preventDefault();
    var title = $('newTitle').value.trim(), code = $('newCode').value;
    if (!title || !code) return;

    $('createBtn').disabled = true;
    say('Sealing the thread…');
    try {
      var s = await C.newThreadSecrets(code);
      var row = await Store.createThread({
        title: title,
        version: s.meta.version,
        kdf: s.meta.kdf,
        iterations: s.meta.iterations,
        salt: s.meta.salt,
        verifier: s.meta.verifier
      });
      keys[row.id] = s.key;
      dlg.close();
      await loadThreads(row.id);
      say('Thread created and already open in this tab. Give the code to whoever should read it — there is no other way in.');
    } catch (err) {
      console.error(err);
      say('The thread could not be created. Nothing was written.');
    }
    $('createBtn').disabled = false;
  };

  $('backBtn').onclick = function () { document.body.dataset.pane = 'rail'; };

  /* ---------- start ---------- */
  if (!Store.configured) {
    $('modeNote').innerHTML = '';
    var b = document.createElement('b');
    b.textContent = 'Running on local storage.';
    $('modeNote').appendChild(b);
    $('modeNote').appendChild(document.createTextNode(
      ' No backend is configured yet, so threads live in this browser only and nobody else can see them. ' +
      'The encryption is real and identical either way — paste your Supabase URL and anon key into config.js and the same threads become shared.'));
  }
  loadThreads();
})();
