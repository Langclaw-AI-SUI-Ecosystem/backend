create extension if not exists pgcrypto with schema extensions;

create table if not exists public.langclaw_wallet_users (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null unique,
  last_signature text,
  last_login_message text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint langclaw_wallet_users_address_lowercase
    check (wallet_address = lower(wallet_address)),
  constraint langclaw_wallet_users_address_format
    check (wallet_address ~ '^0x[0-9a-f]{40}$')
);

create table if not exists public.langclaw_chat_sessions (
  id text primary key,
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  title text not null,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.langclaw_chat_messages (
  id text primary key,
  session_id text not null references public.langclaw_chat_sessions(id) on delete cascade,
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  role text not null check (role in ('assistant', 'user')),
  content text not null,
  result jsonb,
  direct_answer jsonb,
  progress_events jsonb,
  error text,
  stopped boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.langclaw_research_runs (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references public.langclaw_chat_sessions(id) on delete cascade,
  message_id text unique references public.langclaw_chat_messages(id) on delete set null,
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  topic text not null,
  result jsonb not null,
  proof jsonb,
  created_at timestamptz not null default now()
);

create index if not exists langclaw_chat_sessions_wallet_updated_idx
  on public.langclaw_chat_sessions(wallet_user_id, updated_at desc);

create index if not exists langclaw_chat_messages_session_position_idx
  on public.langclaw_chat_messages(session_id, position asc);

create index if not exists langclaw_chat_messages_wallet_created_idx
  on public.langclaw_chat_messages(wallet_user_id, created_at desc);

create index if not exists langclaw_research_runs_session_created_idx
  on public.langclaw_research_runs(session_id, created_at desc);

create or replace function public.langclaw_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists langclaw_wallet_users_touch_updated_at
  on public.langclaw_wallet_users;

create trigger langclaw_wallet_users_touch_updated_at
before update on public.langclaw_wallet_users
for each row execute function public.langclaw_touch_updated_at();

drop trigger if exists langclaw_chat_sessions_touch_updated_at
  on public.langclaw_chat_sessions;

create trigger langclaw_chat_sessions_touch_updated_at
before update on public.langclaw_chat_sessions
for each row execute function public.langclaw_touch_updated_at();

alter table public.langclaw_wallet_users enable row level security;
alter table public.langclaw_chat_sessions enable row level security;
alter table public.langclaw_chat_messages enable row level security;
alter table public.langclaw_research_runs enable row level security;
