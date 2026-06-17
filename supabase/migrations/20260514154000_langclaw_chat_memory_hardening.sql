create or replace function public.langclaw_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create index if not exists langclaw_research_runs_wallet_created_idx
  on public.langclaw_research_runs(wallet_user_id, created_at desc);

drop policy if exists "Langclaw deny direct wallet users access"
  on public.langclaw_wallet_users;
create policy "Langclaw deny direct wallet users access"
  on public.langclaw_wallet_users
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Langclaw deny direct chat sessions access"
  on public.langclaw_chat_sessions;
create policy "Langclaw deny direct chat sessions access"
  on public.langclaw_chat_sessions
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Langclaw deny direct chat messages access"
  on public.langclaw_chat_messages;
create policy "Langclaw deny direct chat messages access"
  on public.langclaw_chat_messages
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Langclaw deny direct research runs access"
  on public.langclaw_research_runs;
create policy "Langclaw deny direct research runs access"
  on public.langclaw_research_runs
  for all
  to anon, authenticated
  using (false)
  with check (false);

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rls_auto_enable'
      and p.pronargs = 0
  ) then
    revoke execute on function public.rls_auto_enable() from anon;
    revoke execute on function public.rls_auto_enable() from authenticated;
    revoke execute on function public.rls_auto_enable() from public;
  end if;
end;
$$;
