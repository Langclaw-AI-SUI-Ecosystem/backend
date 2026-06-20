alter table public.langclaw_alpha_watchlist
  add column if not exists session_id text;

alter table public.langclaw_alpha_watchlist
  drop constraint if exists langclaw_alpha_watchlist_session_id_fkey;

alter table public.langclaw_alpha_watchlist
  add constraint langclaw_alpha_watchlist_session_id_fkey
  foreign key (session_id)
  references public.langclaw_chat_sessions(id)
  on delete set null;

create index if not exists langclaw_alpha_watchlist_wallet_session_idx
  on public.langclaw_alpha_watchlist(wallet_user_id, session_id)
  where session_id is not null;
