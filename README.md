# Deadletter

Public threads whose contents are encrypted in the browser. Anyone can see that
a thread exists and how busy it is; only someone holding its code can read a
word of it. The server stores ciphertext it has no way to open.

A sibling to [Blackout](https://dec3ptor.github.io/Redacted/), and built the
same way: static files, no build step, no framework, and nothing about the
security that cannot be checked by reading three short files.

## How it is put together

| File | What it does |
| --- | --- |
| `crypto.js` | The envelope. Codes, key derivation, sealing and opening posts and files. |
| `store.js` | The only thing that touches a network. Supabase when configured, this browser when not. |
| `app.js` | The board. Rail, thread view, composing, unlocking. |
| `supabase/schema.sql` | The tables, and every permission the database grants. |
| `config.js` | Where your project URL and anon key go. |

## Running it

Any static server will do — there is nothing to build.

```sh
python3 -m http.server 8833
```

Open `http://127.0.0.1:8833/`. With no backend configured it runs against
browser storage, so everything works but nothing is shared. The encryption is
identical either way.

## Connecting it to Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. Dashboard → **SQL Editor** → **New query**, paste all of
   `supabase/schema.sql`, and run it. That creates the tables, the attachment
   bucket, and the row level security policies.
3. Dashboard → **Project Settings** → **API**. Copy the **Project URL** and the
   **anon public** key.
4. Paste both into `config.js` and reload.

The anon key belongs in a public file — it names the project and nothing more,
and the policies decide what it may do. **Never** put the `service_role` key
anywhere near this repository; that one bypasses every policy.

## What the policies allow

Anyone may read. Anyone may append. Nobody may edit or delete anything, ever —
there is no update or delete policy, so neither operation is permitted at all.

That means posts are permanent, including your own. On a public board with no
accounts the alternative is worse: any passer-by able to erase other people's
threads.

## What it does not write to your machine

Nothing. No localStorage, no sessionStorage, no cookies, no IndexedDB, no cache
and no service worker — not the code, not the key, not the decrypted text.
Every visit starts sealed and closing the tab is all the cleanup there is.

This is checked rather than claimed: every storage API is instrumented before
the page's scripts run, the board is used properly, and both the page and the
browser profile are inspected afterwards.

## Whether a quantum computer breaks it

No, and for a structural reason: there is no public-key cryptography anywhere
in it. Shor's algorithm breaks RSA, Diffie-Hellman and elliptic curves, and
none of them appear here — a thread key is symmetric and shared out of band.

Grover's algorithm still applies and halves the exponent, taking AES-256 down
to a 128-bit search. That is the level most of the internet treats as strong
today, which is why the generated code is 256 bits and not 128.

The two caveats are worth more than the claim. A passphrase you invented is
guessable regardless of quantum computing, and stretching only raises the price
per guess. And *harvest now, decrypt later* is real here — everything is public,
so a copy taken today can be attacked forever. A 256-bit key is the answer to
exactly that.

## The honest limits

- The thread **title** is public, along with post counts, sizes and timestamps.
  The shape of a conversation is visible even when its contents are not.
- The code is **read and write access at once**. There are no owners. It cannot
  be revoked or changed — only replaced by a new thread with a new code.
- There is **no forward secrecy**. A code that leaks later opens the entire
  history.
- A **guessable code is not saved by the stretching**. Everything here is
  public, so guessing happens offline and unobserved. Use the generated key.

[How it works](how-it-works.html) sets all of this out at length, including
what the design deliberately does not attempt.

## Licence

See [LICENSE](LICENSE).
