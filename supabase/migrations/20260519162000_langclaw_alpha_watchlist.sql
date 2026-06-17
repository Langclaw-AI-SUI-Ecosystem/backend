create table if not exists public.langclaw_alpha_watchlist (
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  id text not null,
  title text not null,
  signal_type text not null,
  intent text not null,
  chain text not null default 'mantle',
  subject text not null,
  summary text not null,
  recommendation text not null,
  caveat text not null,
  source_count integer not null default 0 check (source_count >= 0),
  gap_count integer not null default 0 check (gap_count >= 0),
  proof_tx text,
  explorer_url text,
  decision_id text,
  decision_hash text,
  evidence_uri text,
  agent_id text,
  added_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (wallet_user_id, id)
);

create index if not exists langclaw_alpha_watchlist_wallet_added_idx
  on public.langclaw_alpha_watchlist(wallet_user_id, added_at desc);

create index if not exists langclaw_alpha_watchlist_wallet_signal_idx
  on public.langclaw_alpha_watchlist(wallet_user_id, signal_type);

drop trigger if exists langclaw_alpha_watchlist_touch_updated_at
  on public.langclaw_alpha_watchlist;

create trigger langclaw_alpha_watchlist_touch_updated_at
before update on public.langclaw_alpha_watchlist
for each row execute function public.langclaw_touch_updated_at();

alter table public.langclaw_alpha_watchlist enable row level security;
