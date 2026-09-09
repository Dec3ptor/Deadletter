-- ============================================================
-- Deadletter — schema and policies.
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New
-- query → paste → Run). It creates the two tables, the bucket attachments
-- live in, and the policies that decide what the public anon key may do.
--
-- The shape of the security is: anyone may read, anyone may append, nobody
-- may change or remove anything. Deletion is left out deliberately — a
-- public board where any passer-by can erase other people's threads is not
-- a board. It also means there is no delete button in the app; if you want
-- one, it needs an owner concept first, which this version does not have.
--
-- None of this protects the content. The content protects itself: every
-- body in here is already sealed before it arrives, and this database
-- cannot read a single one of them.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- threads ----------
-- title is plaintext, and deliberately so: the rail has to list something.
-- Everything needed to derive the key is here except the code itself.
create table if not exists public.threads (
  id          uuid primary key default gen_random_uuid(),
  title       text        not null check (char_length(title) between 1 and 120),
  version     int         not null default 1,
  kdf         text        not null,
  iterations  int         not null,
  salt        text        not null,
  verifier    text        not null,
  created_at  timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  post_count  int         not null default 0
);

-- ---------- posts ----------
-- body is the whole post, sealed: text, links and attachment references all
-- live inside it. The server sees a base64 blob and a timestamp.
create table if not exists public.posts (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid        not null references public.threads(id) on delete cascade,
  body       text        not null check (char_length(body) <= 200000),
  created_at timestamptz not null default now()
);

create index if not exists posts_thread_created on public.posts (thread_id, created_at);
create index if not exists threads_last_at on public.threads (last_at desc);

-- ---------- keeping the rail current ----------
-- The rail sorts by most recent activity, so the count and timestamp are
-- maintained here rather than trusted from the client.
create or replace function public.bump_thread() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.threads
     set last_at = new.created_at,
         post_count = post_count + 1
   where id = new.thread_id;
  return new;
end $$;

drop trigger if exists posts_bump_thread on public.posts;
create trigger posts_bump_thread after insert on public.posts
  for each row execute function public.bump_thread();

-- ---------- who may do what ----------
alter table public.threads enable row level security;
alter table public.posts   enable row level security;

drop policy if exists threads_read   on public.threads;
drop policy if exists threads_append on public.threads;
drop policy if exists posts_read     on public.posts;
drop policy if exists posts_append   on public.posts;

create policy threads_read   on public.threads for select using (true);
create policy threads_append on public.threads for insert with check (true);
create policy posts_read     on public.posts   for select using (true);
create policy posts_append   on public.posts   for insert with check (true);
-- No update and no delete policy anywhere, so neither is permitted at all.

-- ---------- attachments ----------
-- Encrypted bytes, one object per file, named by a random id the post body
-- refers to. Public read is fine: without the thread code the bytes are noise.
--
-- The rest of this file is wrapped so that a failure here cannot take the
-- tables with it. The SQL editor runs a script as one transaction: if a later
-- statement errors, everything before it is rolled back too, and you are left
-- believing the tables were made when they were not. Storage and realtime are
-- exactly where that bites — they depend on extensions and ownership that vary
-- between projects, and neither is needed for text threads to work.
do $$
begin
  insert into storage.buckets (id, name, public)
       values ('files', 'files', true)
  on conflict (id) do update set public = true;
exception when others then
  raise notice 'Could not create the files bucket (%). Text threads still work; make a public bucket named files under Storage to enable attachments.', sqlerrm;
end $$;

do $$
begin
  drop policy if exists files_read   on storage.objects;
  drop policy if exists files_append on storage.objects;
  create policy files_read   on storage.objects for select
    using (bucket_id = 'files');
  create policy files_append on storage.objects for insert
    with check (bucket_id = 'files');
exception when others then
  raise notice 'Could not set storage policies (%). Set them under Storage → Policies if attachments fail.', sqlerrm;
end $$;

-- ---------- realtime ----------
-- Lets the thread view receive new posts the moment they arrive. Entirely
-- optional: the board polls as well, so without this new posts show up within
-- a few seconds instead of instantly.
do $$
begin
  alter publication supabase_realtime add table public.posts;
exception when others then
  raise notice 'Realtime not enabled for posts (%). The board polls instead.', sqlerrm;
end $$;
