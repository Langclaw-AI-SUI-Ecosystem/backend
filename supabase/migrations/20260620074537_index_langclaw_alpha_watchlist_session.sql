create index if not exists langclaw_alpha_watchlist_session_idx
  on public.langclaw_alpha_watchlist(session_id)
  where session_id is not null;
