alter table public.langclaw_alpha_watchlist
  add column if not exists status text not null default 'watching',
  add column if not exists priority text not null default 'medium',
  add column if not exists source_prompt text,
  add column if not exists note text,
  add column if not exists snoozed_until timestamptz,
  add column if not exists reviewed_at timestamptz;

alter table public.langclaw_alpha_watchlist
  drop constraint if exists langclaw_alpha_watchlist_status_check;

alter table public.langclaw_alpha_watchlist
  add constraint langclaw_alpha_watchlist_status_check
  check (status in ('watching', 'reviewed', 'snoozed', 'stale'));

alter table public.langclaw_alpha_watchlist
  drop constraint if exists langclaw_alpha_watchlist_priority_check;

alter table public.langclaw_alpha_watchlist
  add constraint langclaw_alpha_watchlist_priority_check
  check (priority in ('low', 'medium', 'high'));

alter table public.langclaw_alpha_watchlist
  drop constraint if exists langclaw_alpha_watchlist_snooze_check;

alter table public.langclaw_alpha_watchlist
  add constraint langclaw_alpha_watchlist_snooze_check
  check (
    (status = 'snoozed' and snoozed_until is not null)
    or (status <> 'snoozed' and snoozed_until is null)
  );

create index if not exists langclaw_alpha_watchlist_wallet_status_idx
  on public.langclaw_alpha_watchlist(wallet_user_id, status, added_at desc);

create index if not exists langclaw_alpha_watchlist_snoozed_until_idx
  on public.langclaw_alpha_watchlist(snoozed_until)
  where status = 'snoozed';
