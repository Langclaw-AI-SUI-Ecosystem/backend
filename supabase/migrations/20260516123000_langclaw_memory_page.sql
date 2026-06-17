create extension if not exists pgcrypto with schema extensions;

create table if not exists public.langclaw_memories (
  id uuid primary key default gen_random_uuid(),
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  memory text not null,
  category text not null default 'Preference'
    check (category in ('Preference', 'Project', 'Workflow', 'Personal', 'API')),
  scope text not null default 'Global',
  status text not null default 'active'
    check (status in ('active', 'disabled')),
  source text not null default 'Manual',
  last_used_at timestamptz,
  confidence integer not null default 80
    check (confidence between 0 and 100),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint langclaw_memories_memory_not_blank
    check (length(trim(memory)) > 0),
  constraint langclaw_memories_scope_not_blank
    check (length(trim(scope)) > 0),
  constraint langclaw_memories_source_not_blank
    check (length(trim(source)) > 0)
);

create table if not exists public.langclaw_memory_settings (
  wallet_user_id uuid primary key references public.langclaw_wallet_users(id) on delete cascade,
  capture_enabled boolean not null default true,
  cross_chat_recall boolean not null default true,
  project_scoped_recall boolean not null default true,
  auto_disable_low_confidence boolean not null default false,
  retention_days integer not null default 365
    check (retention_days between 0 and 3650),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists langclaw_memories_wallet_updated_idx
  on public.langclaw_memories(wallet_user_id, updated_at desc);

create index if not exists langclaw_memories_wallet_status_updated_idx
  on public.langclaw_memories(wallet_user_id, status, updated_at desc);

create index if not exists langclaw_memories_wallet_category_updated_idx
  on public.langclaw_memories(wallet_user_id, category, updated_at desc);

drop trigger if exists langclaw_memories_touch_updated_at
  on public.langclaw_memories;

create trigger langclaw_memories_touch_updated_at
before update on public.langclaw_memories
for each row execute function public.langclaw_touch_updated_at();

drop trigger if exists langclaw_memory_settings_touch_updated_at
  on public.langclaw_memory_settings;

create trigger langclaw_memory_settings_touch_updated_at
before update on public.langclaw_memory_settings
for each row execute function public.langclaw_touch_updated_at();

alter table public.langclaw_memories enable row level security;
alter table public.langclaw_memory_settings enable row level security;

drop policy if exists "Langclaw deny direct memories access"
  on public.langclaw_memories;
create policy "Langclaw deny direct memories access"
  on public.langclaw_memories
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Langclaw deny direct memory settings access"
  on public.langclaw_memory_settings;
create policy "Langclaw deny direct memory settings access"
  on public.langclaw_memory_settings
  for all
  to anon, authenticated
  using (false)
  with check (false);
