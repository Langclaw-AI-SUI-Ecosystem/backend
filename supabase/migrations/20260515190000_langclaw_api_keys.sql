create table if not exists public.langclaw_api_keys (
  id uuid primary key default gen_random_uuid(),
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  key_suffix text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint langclaw_api_keys_name_length
    check (char_length(trim(name)) between 1 and 80),
  constraint langclaw_api_keys_hash_format
    check (key_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists langclaw_api_keys_wallet_created_idx
  on public.langclaw_api_keys(wallet_user_id, created_at desc);

create index if not exists langclaw_api_keys_wallet_active_idx
  on public.langclaw_api_keys(wallet_user_id)
  where status = 'active';

drop trigger if exists langclaw_api_keys_touch_updated_at
  on public.langclaw_api_keys;

create trigger langclaw_api_keys_touch_updated_at
before update on public.langclaw_api_keys
for each row execute function public.langclaw_touch_updated_at();

create or replace function public.langclaw_create_api_key(
  p_wallet_user_id uuid,
  p_name text,
  p_key_hash text,
  p_key_prefix text,
  p_key_suffix text
)
returns public.langclaw_api_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.langclaw_api_keys;
begin
  perform 1
  from public.langclaw_wallet_users
  where id = p_wallet_user_id
  for update;

  if not found then
    raise exception 'wallet_user_not_found';
  end if;

  if (
    select count(*)
    from public.langclaw_api_keys
    where wallet_user_id = p_wallet_user_id
      and status = 'active'
  ) >= 3 then
    raise exception 'max_active_api_keys';
  end if;

  insert into public.langclaw_api_keys (
    wallet_user_id,
    name,
    key_hash,
    key_prefix,
    key_suffix
  )
  values (
    p_wallet_user_id,
    trim(p_name),
    p_key_hash,
    p_key_prefix,
    p_key_suffix
  )
  returning * into v_row;

  return v_row;
end;
$$;

alter table public.langclaw_api_keys enable row level security;

drop policy if exists "Langclaw deny direct api keys access"
  on public.langclaw_api_keys;
create policy "Langclaw deny direct api keys access"
  on public.langclaw_api_keys
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke execute on function public.langclaw_create_api_key(uuid, text, text, text, text)
  from anon, authenticated, public;
grant execute on function public.langclaw_create_api_key(uuid, text, text, text, text)
  to service_role;
