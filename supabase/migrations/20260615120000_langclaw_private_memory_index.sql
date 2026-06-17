-- Sui + Walrus private memory metadata index.
--
-- Stores ONLY metadata pointers to encrypted Walrus memory artifacts — never
-- decrypted private content. Mirrors MemoryIndexRecord in
-- backend/src/lib/memory-types.ts and the row mapping in memory-index.ts.

create table if not exists public.langclaw_private_memory_index (
  id text primary key,
  owner_address text not null,
  run_id text not null,
  topic text not null,
  content_hash text not null,
  walrus_blob_id text not null,
  walrus_object_id text not null,
  seal_policy_id text not null,
  sui_tx_digest text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists langclaw_private_memory_index_owner_created_idx
  on public.langclaw_private_memory_index (owner_address, created_at desc);
