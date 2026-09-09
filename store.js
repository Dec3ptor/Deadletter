/* ============================================================
   Deadletter — where the ciphertext goes.

   One interface, two implementations. Supabase is the real one: a shared
   Postgres holding rows the server cannot read. The local one keeps the same
   rows in this browser, so the whole app can be driven and tested without a
   backend, and so opening the site before it is configured shows something
   working rather than an error.

   Nothing here has ever seen a code or a key. Everything it stores arrived
   already sealed.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.DEADLETTER_CONFIG || {};
  var configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey &&
    CFG.supabaseUrl.indexOf('YOUR-') === -1);

  function nowISO() { return new Date().toISOString(); }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = [].map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /* ---------- the local store ---------- */
  /* Rows live in localStorage; attachment bytes live in IndexedDB, because a
     photograph does not belong in a string. Same shapes as the real thing, so
     the app above cannot tell them apart. */
  function localStore() {
    var KEY = 'deadletter.rows.v1';
    var dbp = null;

    function read() {
      try { return JSON.parse(localStorage.getItem(KEY) || '{"threads":[],"posts":[]}'); }
      catch (e) { return { threads: [], posts: [] }; }
    }
    function write(data) {
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    }
    function db() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var req = indexedDB.open('deadletter-files', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('files'); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return dbp;
    }
    function tx(mode, fn) {
      return db().then(function (d) {
        return new Promise(function (resolve, reject) {
          var t = d.transaction('files', mode), store = t.objectStore('files'), req = fn(store);
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
        });
      });
    }

    return {
      kind: 'local',
      async listThreads() {
        return read().threads.slice().sort(function (a, b) {
          return (b.last_at || b.created_at).localeCompare(a.last_at || a.created_at);
        });
      },
      async createThread(t) {
        var data = read();
        var row = Object.assign({ id: uuid(), created_at: nowISO(), last_at: nowISO(), post_count: 0 }, t);
        data.threads.push(row); write(data);
        return row;
      },
      async listPosts(threadId) {
        return read().posts.filter(function (p) { return p.thread_id === threadId; })
          .sort(function (a, b) { return a.created_at.localeCompare(b.created_at); });
      },
      async createPost(p) {
        var data = read();
        var row = Object.assign({ id: uuid(), created_at: nowISO() }, p);
        data.posts.push(row);
        data.threads.forEach(function (t) {
          if (t.id !== row.thread_id) return;
          t.last_at = row.created_at;
          t.post_count = (t.post_count || 0) + 1;
        });
        write(data);
        return row;
      },
      async putFile(id, bytes) { await tx('readwrite', function (s) { return s.put(bytes, id); }); return id; },
      async getFile(id) {
        var v = await tx('readonly', function (s) { return s.get(id); });
        return v ? new Uint8Array(v) : null;
      },
      /* No server means no push. Poll instead — same callback shape, so the
         app does not branch on which store it got. */
      subscribe(threadId, onPost) {
        var seen = null, stopped = false;
        var tick = async function () {
          if (stopped) return;
          var rows = await this.listPosts(threadId);
          if (seen === null) seen = rows.length;
          else if (rows.length > seen) { rows.slice(seen).forEach(onPost); seen = rows.length; }
        }.bind(this);
        var h = setInterval(tick, 1500);
        return function () { stopped = true; clearInterval(h); };
      }
    };
  }

  /* ---------- the Supabase store ---------- */
  /* Plain REST, so there is no client library to load and nothing between the
     page and the rows. The anon key is public by design: it identifies the
     project, and row level security decides what it may do — read and append,
     never edit or delete. */
  function supabaseStore() {
    var base = CFG.supabaseUrl.replace(/\/+$/, '');
    var rest = base + '/rest/v1';
    var headers = {
      apikey: CFG.supabaseAnonKey,
      Authorization: 'Bearer ' + CFG.supabaseAnonKey,
      'Content-Type': 'application/json'
    };

    async function call(path, opts) {
      var res = await fetch(rest + path, Object.assign({ headers: headers }, opts || {}));
      if (!res.ok) throw new Error('store ' + res.status + ' ' + (await res.text()).slice(0, 200));
      var text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    return {
      kind: 'supabase',
      async listThreads() {
        return call('/threads?select=*&order=last_at.desc.nullslast&limit=200');
      },
      async createThread(t) {
        var rows = await call('/threads', {
          method: 'POST',
          headers: Object.assign({ Prefer: 'return=representation' }, headers),
          body: JSON.stringify(t)
        });
        return rows[0];
      },
      async listPosts(threadId) {
        return call('/posts?select=*&thread_id=eq.' + encodeURIComponent(threadId) +
          '&order=created_at.asc&limit=1000');
      },
      async createPost(p) {
        var rows = await call('/posts', {
          method: 'POST',
          headers: Object.assign({ Prefer: 'return=representation' }, headers),
          body: JSON.stringify(p)
        });
        return rows[0];
      },
      async putFile(id, bytes) {
        var res = await fetch(base + '/storage/v1/object/files/' + id, {
          method: 'POST',
          headers: { apikey: CFG.supabaseAnonKey, Authorization: 'Bearer ' + CFG.supabaseAnonKey, 'Content-Type': 'application/octet-stream' },
          body: bytes
        });
        if (!res.ok) throw new Error('upload ' + res.status);
        return id;
      },
      async getFile(id) {
        var res = await fetch(base + '/storage/v1/object/public/files/' + id);
        if (!res.ok) return null;
        return new Uint8Array(await res.arrayBuffer());
      },
      /* Realtime over a websocket when it is available, and a poll behind it
         so a blocked socket degrades to slow rather than to silence. */
      subscribe(threadId, onPost) {
        var stopped = false, socket = null, seen = null;
        try {
          var url = base.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' +
            encodeURIComponent(CFG.supabaseAnonKey) + '&vsn=1.0.0';
          socket = new WebSocket(url);
          socket.onopen = function () {
            socket.send(JSON.stringify({
              topic: 'realtime:posts:' + threadId, event: 'phx_join', ref: '1',
              payload: { config: { postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'posts', filter: 'thread_id=eq.' + threadId }] } }
            }));
            setInterval(function () {
              if (socket.readyState === 1) socket.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: '0' }));
            }, 25000);
          };
          socket.onmessage = function (ev) {
            try {
              var msg = JSON.parse(ev.data);
              var rec = msg && msg.payload && msg.payload.data && msg.payload.data.record;
              if (rec && rec.thread_id === threadId) onPost(rec);
            } catch (e) {}
          };
        } catch (e) { socket = null; }

        var h = setInterval(async function () {
          if (stopped) return;
          try {
            var rows = await this.listPosts(threadId);
            if (seen === null) { seen = rows.length; return; }
            if (rows.length > seen) { rows.slice(seen).forEach(onPost); seen = rows.length; }
          } catch (e) {}
        }.bind(this), 8000);

        return function () {
          stopped = true; clearInterval(h);
          try { if (socket) socket.close(); } catch (e) {}
        };
      }
    };
  }

  window.DeadletterStore = configured ? supabaseStore() : localStore();
  window.DeadletterStore.configured = configured;
})();
