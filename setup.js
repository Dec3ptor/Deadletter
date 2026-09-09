/* ============================================================
   Deadletter — connecting it to a project.

   Every check here runs from this browser against the project you name. That
   is the only way to test it honestly: it is exactly the request the site
   itself will make, with exactly the key it will use, subject to exactly the
   policies you set. A green row means the real thing works, not that a
   configuration file looks plausible.
   ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* This page reads config.js and nothing else. It used to be able to keep
     settings for the browser, which meant writing to localStorage — and the
     site's promise is that it writes nothing at all. Checking a project and
     printing the two lines to commit does the same job and leaves no trace. */
  var cfg = window.DEADLETTER_CONFIG || {};
  if (cfg.supabaseUrl && cfg.supabaseUrl.indexOf('YOUR-') === -1) $('urlInput').value = cfg.supabaseUrl;
  if (cfg.supabaseAnonKey && cfg.supabaseAnonKey.indexOf('YOUR-') === -1) $('keyInput').value = cfg.supabaseAnonKey;

  function tidyUrl(v) {
    v = String(v || '').trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//.test(v)) v = 'https://' + v;
    return v;
  }

  /* ---------- the checklist ---------- */
  function row(name, state, detail, fix) {
    var li = document.createElement('li');
    li.className = 'chk ' + state;
    var mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = state === 'ok' ? '✓' : (state === 'run' ? '·' : '✕');
    var body = document.createElement('div');
    var t = document.createElement('strong');
    t.textContent = name;
    body.appendChild(t);
    if (detail) {
      var d = document.createElement('span');
      d.textContent = detail;
      body.appendChild(d);
    }
    if (fix) {
      var f = document.createElement('span');
      f.className = 'fix';
      f.textContent = fix;
      body.appendChild(f);
    }
    li.appendChild(mark);
    li.appendChild(body);
    return li;
  }

  var SQL_FIX = 'Run supabase/schema.sql in the SQL Editor — it creates this.';

  async function check(url, key) {
    var list = $('checks');
    list.innerHTML = '';
    var headers = { apikey: key, Authorization: 'Bearer ' + key };
    var allGood = true;
    function add(name, state, detail, fix) {
      if (state !== 'ok') allGood = false;
      list.appendChild(row(name, state, detail, fix));
    }

    // 1. is anything there at all
    try {
      var probe = await fetch(url + '/rest/v1/', { headers: headers });
      if (probe.status === 401) {
        add('Reach the project', 'bad', 'The project answered, but rejected that key.',
          'Copy the anon public key from Project Settings → API. It is a long value beginning "eyJ".');
        return allGood;
      }
      add('Reach the project', 'ok', 'Answered on ' + url.replace(/^https?:\/\//, '') + '.');
    } catch (e) {
      add('Reach the project', 'bad', 'Nothing answered at that address.',
        'Check the Project URL in Project Settings → API. It looks like https://abcdefgh.supabase.co');
      return allGood;
    }

    // 2. the two tables, readable by the public key
    for (var i = 0; i < 2; i++) {
      var table = ['threads', 'posts'][i];
      try {
        var res = await fetch(url + '/rest/v1/' + table + '?select=id&limit=1', { headers: headers });
        if (res.status === 404 || res.status === 400) {
          add('Table “' + table + '”', 'bad', 'Not found in this project.', SQL_FIX);
        } else if (res.status === 401 || res.status === 403) {
          add('Table “' + table + '”', 'bad', 'Exists, but the public key may not read it.',
            'The read policy is missing. Re-run supabase/schema.sql.');
        } else if (!res.ok) {
          add('Table “' + table + '”', 'bad', 'Answered ' + res.status + '.', SQL_FIX);
        } else {
          var rows = await res.json();
          add('Table “' + table + '”', 'ok', 'Readable. ' + (rows.length ? 'Holds data already.' : 'Empty, as expected on a new project.'));
        }
      } catch (e) {
        add('Table “' + table + '”', 'bad', 'Could not be reached.', SQL_FIX);
      }
    }

    // 3. the attachment bucket
    try {
      var b = await fetch(url + '/storage/v1/object/public/files/setup-probe-does-not-exist', { headers: headers });
      /* A missing object inside an existing public bucket answers 400 or 404
         with an object-level error; a missing bucket says so explicitly. The
         distinction is what tells us whether the bucket is there at all. */
      var text = (await b.text()).toLowerCase();
      if (text.indexOf('bucket') !== -1 && text.indexOf('not found') !== -1) {
        add('Attachment bucket', 'bad', 'The “files” bucket does not exist.',
          'Re-run supabase/schema.sql, or create a public bucket named files under Storage.');
      } else {
        add('Attachment bucket', 'ok', 'Present and publicly readable, so sealed attachments can be fetched.');
      }
    } catch (e) {
      add('Attachment bucket', 'warn', 'Could not be checked from here.',
        'Not fatal — text-only threads work regardless.');
    }

    return allGood;
  }

  /* A Supabase key is a JWT whose middle segment names the role it carries.
     Reading it is worth the few lines: pasting the service key into a public
     file is the one mistake here that cannot be walked back. */
  function roleOf(key) {
    try {
      var part = String(key).split('.')[1];
      if (!part) return '';
      part = part.replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      return (JSON.parse(atob(part)) || {}).role || '';
    } catch (e) { return ''; }
  }

  /* ---------- actions ---------- */
  $('checkBtn').onclick = async function () {
    var url = tidyUrl($('urlInput').value), key = $('keyInput').value.trim();
    if (!url || !key) { $('setupStatus').textContent = 'Both values are needed.'; return; }
    if (roleOf(key) === 'service_role') {
      $('setupStatus').textContent = 'That is the service_role key. It bypasses every policy, so publishing it would hand the whole database to anyone who viewed the page. Use the anon public key instead.';
      return;
    }
    this.disabled = true;
    $('setupStatus').textContent = 'Checking…';
    $('results').hidden = false;
    var ok = false;
    try { ok = await check(url, key); } catch (e) { console.error(e); }
    this.disabled = false;
    $('setupStatus').textContent = ok
      ? 'Everything answered. Save it below to use this project in this browser.'
      : 'Something is not ready yet. Each line above says what and how to fix it.';
    if (ok) writeSnippet(url, key);
  };

  function writeSnippet(url, key) {
    $('snippetBox').hidden = false;
    $('snippet').textContent =
      "  supabaseUrl: '" + url + "',\n" +
      "  supabaseAnonKey: '" + key + "',";
  }

  $('copyBtn').onclick = async function () {
    try {
      await navigator.clipboard.writeText($('snippet').textContent);
      this.textContent = 'Copied';
      setTimeout(function () { $('copyBtn').textContent = 'Copy'; }, 1600);
    } catch (e) {
      // Clipboard access is refused in plenty of ordinary situations; selecting
      // the text is the fallback that always works.
      var r = document.createRange();
      r.selectNodeContents($('snippet'));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      this.textContent = 'Selected — copy it';
    }
  };

})();
