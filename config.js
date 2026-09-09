/* Deadletter configuration.

   Paste your Supabase project URL and anon key here and the site switches
   from the local demo store to the shared one. Until then everything works,
   but only in this browser — nothing is shared with anyone.

   The anon key belongs in a public file. It identifies the project and
   nothing more; what it is allowed to do is decided by the row level
   security policies in supabase/schema.sql, which permit reading and
   appending and nothing else. It is not a password, and it cannot read a
   thread — the server only ever holds ciphertext.

   Never paste the service_role key here. That one bypasses every policy. */
window.DEADLETTER_CONFIG = Object.assign({
  productName: 'Deadletter',
  siteUrl: 'https://dec3ptor.github.io/Deadletter/',

  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-KEY',

  // Largest attachment accepted, before encryption.
  maxFileBytes: 5 * 1024 * 1024
}, window.DEADLETTER_CONFIG || {});
