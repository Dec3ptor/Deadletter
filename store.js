/* ============================================================
   Deadletter — where the ciphertext goes.

   One interface, two implementations. Supabase is the real one: a shared
   Postgres holding rows the server cannot read. The other keeps the same rows
   in memory, so the board can be driven with no backend configured.

   Neither writes anything to this browser. There is no localStorage here, no
   IndexedDB, no cookie and no cache — nothing that outlives the tab. That is
   a deliberate constraint rather than an oversight: anything written to disk
   outlives the person who typed it, and a shared or seized machine then gives
   up what the encryption was supposed to protect.

   Nothing here has ever seen a code or a key. Everything it stores arrived
   already sealed.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.DEADLETTER_CONFIG || {};
  var configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey &&
    CFG.supabaseUrl.indexOf('YOUR-') === -1 && CFG.supabaseAnonKey.indexOf('YOUR-') === -1);

  function nowISO() { return new Date().toISOString(); }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = [].map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /* ---------- the memory store ---------- */
  /* Used when no project is configured. It keeps the same row shapes as the
     real thing so the app above cannot tell them apart, and keeps them in
     variables — not localStorage, not IndexedDB, not anywhere that survives
     the tab. Closing the page loses everything, which is the correct
     behaviour for a store that exists only to demonstrate the board. */
  function memoryStore() {
    var threads = [], posts = [], files = {};
    var watchers = {};

    return {
      kind: 'memory',
      async listThreads() {
        return threads.slice().sort(function (a, b) {
          return (b.last_at || b.created_at).localeCompare(a.last_at || a.created_at);
        });
      },
      async createThread(t) {
        var row = Object.assign({ id: uuid(), created_at: nowISO(), last_at: nowISO(), post_count: 0 }, t);
        threads.push(row);
        return row;
      },
      async listPosts(threadId) {
        return posts.filter(function (p) { return p.thread_id === threadId; })
          .sort(function (a, b) { return a.created_at.localeCompare(b.created_at); });
      },
      async createPost(p) {
        var row = Object.assign({ id: uuid(), created_at: nowISO() }, p);
        posts.push(row);
        threads.forEach(function (t) {
          if (t.id !== row.thread_id) return;
          t.last_at = row.created_at;
          t.post_count = (t.post_count || 0) + 1;
        });
        (watchers[row.thread_id] || []).forEach(function (fn) { fn(row); });
        return row;
      },
      async putFile(id, bytes) { files[id] = bytes; return id; },
      async getFile(id) { return files[id] || null; },
      /* Nothing to poll — a post made in this tab is delivered directly. */
      subscribe(threadId, onPost) {
        (watchers[threadId] = watchers[threadId] || []).push(onPost);
        return function () {
          watchers[threadId] = (watchers[threadId] || []).filter(function (f) { return f !== onPost; });
        };
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
        /* A public object needs no credentials. Sending them anyway costs
           nothing and keeps this working if the bucket is ever closed. */
        var res = await fetch(base + '/storage/v1/object/public/files/' + id, {
          headers: { apikey: CFG.supabaseAnonKey, Authorization: 'Bearer ' + CFG.supabaseAnonKey }
        });
        if (!res.ok) return null;
        return new Uint8Array(await res.arrayBuffer());
      },
      /* Realtime over a websocket when it is available, and a poll behind it
         so a blocked socket degrades to slow rather than to silence. */
      /* Two ways to hear about a new post. The socket delivers it at once when
         it connects; the poll behind it delivers it regardless. The socket is
         therefore treated as an optimisation and never as a requirement — a
         network that blocks websockets, or a project with realtime switched
         off, should make the board slower, not silent, and should not fill the
         console with failures on a path nothing depends on. */
      subscribe(threadId, onPost) {
        var stopped = false, socket = null, beat = null, seen = null;

        function fresh(row) {
          if (!stopped && row && row.thread_id === threadId) onPost(row);
        }

        try {
          var url = base.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' +
            encodeURIComponent(CFG.supabaseAnonKey) + '&vsn=1.0.0';
          socket = new WebSocket(url);
          socket.onopen = function () {
            socket.send(JSON.stringify({
              topic: 'realtime:posts:' + threadId, event: 'phx_join', ref: '1',
              payload: {
                config: { postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'posts', filter: 'thread_id=eq.' + threadId }] },
                access_token: CFG.supabaseAnonKey
              }
            }));
            beat = setInterval(function () {
              if (socket && socket.readyState === 1)
                socket.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: '0' }));
              else { clearInterval(beat); beat = null; }
            }, 25000);
          };
          socket.onmessage = function (ev) {
            try {
              var msg = JSON.parse(ev.data);
              var rec = msg && msg.payload && msg.payload.data && msg.payload.data.record;
              if (rec) fresh(rec);
            } catch (e) {}
          };
          // Expected often enough not to be worth reporting; the poll covers it.
          socket.onerror = function () {};
          socket.onclose = function () { if (beat) { clearInterval(beat); beat = null; } };
        } catch (e) { socket = null; }

        var h = setInterval(async function () {
          if (stopped) return;
          try {
            var rows = await this.listPosts(threadId);
            if (seen === null) { seen = rows.length; return; }
            if (rows.length > seen) { rows.slice(seen).forEach(fresh); seen = rows.length; }
          } catch (e) {}
        }.bind(this), 5000);

        return function () {
          stopped = true;
          clearInterval(h);
          if (beat) { clearInterval(beat); beat = null; }
          try { if (socket) { socket.onclose = null; socket.close(); } } catch (e) {}
          socket = null;
        };
      }
    };
  }

  window.DeadletterStore = configured ? supabaseStore() : memoryStore();
  window.DeadletterStore.configured = configured;
})();
