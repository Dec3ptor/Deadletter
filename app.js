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

  /* Who wrote a post. There is nowhere to keep an identity — nothing is
     written to this machine — so it lasts as long as the tab and no longer.
     The token is random, travels inside the sealed body, and is meaningless
     to anyone without the code. What it buys is being able to tell one
     poster from another within a thread; reload and you are a new person,
     which is the honest ceiling for a board with no accounts and no storage. */
  var me = C.b64(crypto.getRandomValues(new Uint8Array(16)));

  /* Media is fetched and unsealed only when asked for. Off means even the
     small preview waits for a click. Like everything else, it resets with
     the tab. */
  var autoMedia = true;
  /* What has already been revealed in the open thread. A thread redraws
     whenever a post arrives, and without this an attachment someone chose to
     open would fold itself back up under a Show button each time. */
  var revealed = {};

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
    releaseURLs();
    revealed = {};
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

  /* Numbers are assigned in the order people first appear in the thread, so
     everyone holding the code sees the same Anonymous 3. */
  function authorNames() {
    var seen = {}, n = 0, out = {};
    posts.forEach(function (row) {
      var p = opened[row.id];
      if (!p || p.broken || !p.who) return;
      if (!seen[p.who]) { seen[p.who] = 'Anonymous ' + (++n); }
      out[row.id] = seen[p.who];
    });
    return out;
  }

  /* ---------- posts ---------- */
  /* Two renders can be in flight at once — posting a message triggers one,
     and the arrival of that same message from the store triggers another.
     Decryption is awaited part way through, so a version that cleared the
     list and then appended would let both halves interleave and show the
     post twice. Each render therefore builds its own fragment, and only the
     newest one is allowed to reach the page. */
  var renderSeq = 0;

  async function drawPosts() {
    var mine = ++renderSeq;
    var host = $('posts'), key = current && keys[current.id];
    var frag = document.createDocumentFragment();

    if (!posts.length) {
      var none = document.createElement('p');
      none.className = 'railempty';
      none.textContent = key
        ? 'Nothing posted yet. You have the code, so you can be first.'
        : 'Nothing posted yet.';
      frag.appendChild(none);
    } else {
      for (var i = 0; i < posts.length; i++) {
        var row = posts[i];
        if (key && !opened[row.id]) {
          try { opened[row.id] = await C.openPost(key, current.id, row.body); }
          catch (e) { opened[row.id] = { broken: true }; }
        }
        if (mine !== renderSeq) return;          // overtaken; drop this one
      }
      var names = key ? authorNames() : {};
      for (var j = 0; j < posts.length; j++) {
        var r2 = posts[j];
        frag.appendChild(key ? drawOpen(r2, opened[r2.id], names[r2.id]) : drawSealed(r2));
      }
    }

    if (mine !== renderSeq) return;
    host.replaceChildren(frag);
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

  function drawOpen(row, payload, name) {
    var el = document.createElement('div');
    el.className = 'post';

    var head = document.createElement('span');
    head.className = 'when';
    if (name) {
      var who = document.createElement('b');
      who.className = 'who';
      who.textContent = name;
      if (payload && payload.who === me) who.classList.add('mine');
      head.appendChild(who);
      head.appendChild(document.createTextNode(' · '));
    }
    // the authenticated time if the post carries one, the server's if not
    var stamp = (payload && payload.at) ? new Date(payload.at).toISOString() : row.created_at;
    head.appendChild(document.createTextNode(when(stamp)));
    el.appendChild(head);

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

    var files = payload.files || [];
    if (files.length) {
      var grid = document.createElement('div');
      grid.className = 'media';
      files.forEach(function (f) { grid.appendChild(mediaTile(f)); });
      el.appendChild(grid);
    }
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

  function newFileId(n) {
    return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + n) + '.bin';
  }

  /* A still frame, scaled down. Images give one directly; a video gives its
     first frame, which is the only way to show something before fetching
     however many megabytes the whole clip is. Anything that will not decode
     simply has no preview and shows as a card instead. */
  async function frameOf(file) {
    if ((file.type || '').indexOf('image/') === 0) {
      try { return await createImageBitmap(file); } catch (e) { return null; }
    }
    if ((file.type || '').indexOf('video/') !== 0) return null;
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file), v = document.createElement('video');
      var done = function (out) { URL.revokeObjectURL(url); resolve(out); };
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.onloadeddata = function () {
        try { v.currentTime = Math.min(0.1, (v.duration || 1) / 10); }
        catch (e) { done(null); }
      };
      v.onseeked = function () { done(v); };
      v.onerror = function () { done(null); };
      setTimeout(function () { done(null); }, 5000);   // a codec the browser will not decode
      v.src = url;
    });
  }

  async function makeThumb(file) {
    var frame = await frameOf(file);
    if (!frame) return null;
    var w0 = frame.videoWidth || frame.width, h0 = frame.videoHeight || frame.height;
    if (!w0 || !h0) return null;
    var max = CFG.thumbMax || 480, scale = Math.min(1, max / Math.max(w0, h0));
    var w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    try { c.getContext('2d').drawImage(frame, 0, 0, w, h); } catch (e) { return null; }
    if (frame.close) frame.close();
    var blob = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', 0.72); });
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w: w, h: h };
  }

  /* ---------- media ----------
     Nothing about an attachment is fetched until it is wanted. A post carries
     a small sealed preview alongside the sealed original, so a thread of
     photographs costs a few kilobytes to read rather than a few megabytes,
     and the original is only ever fetched when someone asks to see it full
     size. With automatic loading off, even the preview waits to be asked. */

  function bytesLabel(n) {
    if (!n && n !== 0) return '';
    var u = ['B', 'KB', 'MB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n) + ' ' + u[i];
  }
  function kindOf(f) {
    var t = f.type || '';
    if (t.indexOf('video/') === 0) return 'video';
    if (t === 'image/gif') return 'gif';
    if (t.indexOf('image/') === 0) return 'image';
    return 'file';
  }

  function mediaTile(f) {
    var tile = document.createElement('figure');
    tile.className = 'tile';

    var frame = document.createElement('div');
    frame.className = 'frame';
    tile.appendChild(frame);

    var cap = document.createElement('figcaption');
    var kind = kindOf(f);
    cap.textContent = (f.name || kind) + (f.size ? ' · ' + bytesLabel(f.size) : '');
    tile.appendChild(cap);

    if (kind === 'video' || kind === 'gif') {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = kind === 'video' ? 'VIDEO' : 'GIF';
      frame.appendChild(badge);
    }

    var reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'reveal';
    reveal.textContent = 'Show';
    frame.appendChild(reveal);

    var loaded = false;
    async function preview() {
      if (loaded) return;
      loaded = true;
      revealed[f.id] = true;
      reveal.remove();
      var note = document.createElement('span');
      note.className = 'loading';
      note.textContent = 'unsealing…';
      frame.appendChild(note);
      try {
        var src = f.thumb ? f.thumb.id : f.id;
        var url = await openAsURL(src, f.thumb ? 'image/jpeg' : (f.type || ''));
        note.remove();
        var img = document.createElement('img');
        img.alt = f.name || '';
        img.src = url;
        frame.insertBefore(img, frame.firstChild);
        frame.classList.add('ready');
        frame.onclick = function () { openFull(f); };
        frame.title = 'Show full size';
      } catch (e) {
        note.textContent = 'this attachment did not open with the thread key';
      }
    }

    reveal.onclick = preview;
    if (autoMedia || revealed[f.id]) preview();
    return tile;
  }

  /* Fetch, unseal, and hand back an object URL. The URLs are tracked so a
     thread that has been scrolled through does not leave blobs behind. */
  var liveURLs = [];
  async function openAsURL(id, type) {
    var blob = await Store.getFile(id);
    if (!blob) throw new Error('missing');
    var bytes = await C.openBytes(keys[current.id], current.id, blob);
    var url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
    liveURLs.push(url);
    return url;
  }
  function releaseURLs() {
    liveURLs.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    liveURLs = [];
  }

  /* ---------- full size ---------- */
  var viewerURL = null;
  async function openFull(f) {
    var body = $('viewerBody'), dlg = $('viewer');
    body.replaceChildren();
    $('viewerName').textContent = (f.name || '') + (f.size ? ' · ' + bytesLabel(f.size) : '');
    var note = document.createElement('p');
    note.className = 'loading';
    note.textContent = 'unsealing the original…';
    body.appendChild(note);
    if (!dlg.open) dlg.showModal();
    try {
      var url = await openAsURL(f.id, f.type);
      if (viewerURL) { try { URL.revokeObjectURL(viewerURL); } catch (e) {} }
      viewerURL = url;
      var el;
      if (kindOf(f) === 'video') {
        el = document.createElement('video');
        el.controls = true;
        el.playsInline = true;
        el.src = url;
      } else {
        el = document.createElement('img');
        el.alt = f.name || '';
        el.src = url;
      }
      body.replaceChildren(el);
    } catch (e) {
      note.textContent = 'that attachment did not open with the thread key';
    }
  }
  $('viewerClose').onclick = function () { $('viewer').close(); };
  $('viewer').addEventListener('close', function () {
    $('viewerBody').replaceChildren();
    if (viewerURL) { try { URL.revokeObjectURL(viewerURL); } catch (e) {} viewerURL = null; }
  });
  // clicking the backdrop rather than the picture closes it
  $('viewer').addEventListener('click', function (e) { if (e.target === this) this.close(); });

  $('autoMedia').onchange = function () {
    autoMedia = this.checked;
    if (autoMedia) drawPosts();
  };

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
      var cap = CFG.maxFileBytes || 20971520;
      if (f.size > cap) {
        say('“' + f.name + '” is larger than the ' + Math.round(cap / 1048576) + ' MB limit and was not attached.');
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
        var entry = { name: f.name, type: f.type, size: f.size };

        /* The preview is made here, once, and sealed on its own. Readers then
           fetch a few kilobytes to see a thread rather than everything in it,
           and the original is only ever fetched by someone who asks for it. */
        var thumb = await makeThumb(f);
        if (thumb) {
          var tid = newFileId(i) + '.t';
          await Store.putFile(tid, await C.sealBytes(key, current.id, thumb.bytes));
          entry.thumb = { id: tid, w: thumb.w, h: thumb.h };
        }

        var id = newFileId(i);
        await Store.putFile(id, await C.sealBytes(key, current.id, new Uint8Array(await f.arrayBuffer())));
        entry.id = id;
        files.push(entry);
      }
      /* The server supplies created_at, and a hostile one could supply
         whatever it liked. The author's own clock goes inside the sealed
         body, where it cannot be edited without failing the tag, and that is
         the time shown when it is there. */
      var body = await C.sealPost(key, current.id, { v: 1, at: Date.now(), who: me, text: text, files: files });
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
    /* A generated key is the default rather than the alternative. Everything
       stored here is public, so a weak code is guessable offline by anyone who
       ever cared to — making the strong option the one you have to go out of
       your way to discard is the only version of this that survives contact
       with real use. */
    $('newCode').value = C.generateCode();
    rate();
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
  /* Unconfigured is a state only whoever deploys the site should ever see, so
     it says what a reader needs and no more. Naming the pieces behind it
     belongs in the repository, not on a public page. */
  if (!Store.configured) {
    $('modeNote').innerHTML = '';
    var b = document.createElement('b');
    b.textContent = 'Not connected.';
    $('modeNote').appendChild(b);
    $('modeNote').appendChild(document.createTextNode(
      ' Threads made here stay in this tab and are shared with nobody. ' +
      'Everything is still sealed exactly as it would be otherwise, and nothing is kept once the tab is closed.'));
  }
  loadThreads();
})();
