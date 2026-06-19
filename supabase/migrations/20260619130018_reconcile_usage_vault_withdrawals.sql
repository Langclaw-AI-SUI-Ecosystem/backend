create table if not exists public.langclaw_usage_adjustments (
  id uuid primary key default gen_random_uuid(),
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  wallet_address text not null,
  chain_slug text not null,
  chain_id integer not null,
  native_symbol text not null,
  direction text not null,
  amount_neuron numeric(78, 0) not null,
  balance_before_neuron numeric(78, 0) not null,
  balance_after_neuron numeric(78, 0) not null,
  reason text not null,
  reference text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint langclaw_usage_adjustments_direction_check
    check (direction in ('credit', 'debit')),
  constraint langclaw_usage_adjustments_amount_positive
    check (amount_neuron > 0),
  constraint langclaw_usage_adjustments_balance_before_nonnegative
    check (balance_before_neuron >= 0),
  constraint langclaw_usage_adjustments_balance_after_nonnegative
    check (balance_after_neuron >= 0),
  constraint langclaw_usage_adjustments_wallet_address_lowercase
    check (wallet_address = lower(wallet_address)),
  constraint langclaw_usage_adjustments_chain_reference_key
    unique (chain_slug, reference)
);

create index if not exists langclaw_usage_adjustments_wallet_created_idx
  on public.langclaw_usage_adjustments(wallet_user_id, chain_slug, created_at desc);

alter table public.langclaw_usage_adjustments enable row level security;

drop policy if exists langclaw_usage_adjustments_deny_all
  on public.langclaw_usage_adjustments;

create policy langclaw_usage_adjustments_deny_all
  on public.langclaw_usage_adjustments
  for all
  to public
  using (false)
  with check (false);

drop function if exists public.langclaw_usage_request_withdrawal(
  uuid,
  text,
  text,
  integer,
  text,
  numeric,
  text
);

create or replace function public.langclaw_usage_read_vault_liquidity(
  p_chain_slug text,
  p_vault_balance_neuron numeric
)
returns table (
  vault_balance_neuron numeric,
  pending_neuron numeric,
  available_neuron numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending numeric(78, 0);
begin
  if p_vault_balance_neuron < 0 then
    raise exception 'vault_balance_must_be_nonnegative';
  end if;

  select coalesce(sum(request.amount_neuron), 0)
  into v_pending
  from public.langclaw_usage_withdrawal_requests as request
  where request.chain_slug = p_chain_slug
    and request.status = 'pending';

  return query
  select
    p_vault_balance_neuron,
    v_pending,
    greatest(p_vault_balance_neuron - v_pending, 0);
end;
$$;

create or replace function public.langclaw_usage_request_withdrawal(
  p_wallet_user_id uuid,
  p_wallet_address text,
  p_chain_slug text,
  p_chain_id integer,
  p_native_symbol text,
  p_amount_neuron numeric,
  p_recipient_address text,
  p_vault_balance_neuron numeric
)
returns table (
  request_id uuid,
  status text,
  balance_before_neuron numeric,
  balance_after_neuron numeric,
  created_at timestamptz,
  vault_balance_neuron numeric,
  pending_before_neuron numeric,
  vault_available_after_neuron numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.langclaw_usage_accounts%rowtype;
  v_after numeric(78, 0);
  v_pending numeric(78, 0);
  v_request public.langclaw_usage_withdrawal_requests%rowtype;
begin
  if p_amount_neuron <= 0 then
    raise exception 'withdrawal_amount_must_be_positive';
  end if;

  if p_vault_balance_neuron < 0 then
    raise exception 'vault_balance_must_be_nonnegative';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_chain_slug, 0));

  select coalesce(sum(request.amount_neuron), 0)
  into v_pending
  from public.langclaw_usage_withdrawal_requests as request
  where request.chain_slug = p_chain_slug
    and request.status = 'pending';

  if v_pending + p_amount_neuron > p_vault_balance_neuron then
    raise exception 'insufficient_vault_liquidity';
  end if;

  insert into public.langclaw_usage_accounts (
    wallet_user_id,
    wallet_address,
    chain_slug,
    chain_id,
    native_symbol
  )
  values (
    p_wallet_user_id,
    lower(p_wallet_address),
    p_chain_slug,
    p_chain_id,
    p_native_symbol
  )
  on conflict (wallet_user_id, chain_slug) do update
    set wallet_address = excluded.wallet_address,
        chain_id = excluded.chain_id,
        native_symbol = excluded.native_symbol;

  select *
  into v_account
  from public.langclaw_usage_accounts
  where wallet_user_id = p_wallet_user_id
    and chain_slug = p_chain_slug
  for update;

  if v_account.available_neuron < p_amount_neuron then
    raise exception 'insufficient_withdrawable_balance';
  end if;

  update public.langclaw_usage_accounts as account
  set available_neuron = account.available_neuron - p_amount_neuron
  where account.wallet_user_id = p_wallet_user_id
    and account.chain_slug = p_chain_slug
  returning account.available_neuron into v_after;

  insert into public.langclaw_usage_withdrawal_requests (
    wallet_user_id,
    wallet_address,
    recipient_address,
    chain_slug,
    chain_id,
    native_symbol,
    amount_neuron,
    balance_before_neuron,
    balance_after_neuron,
    status
  )
  values (
    p_wallet_user_id,
    lower(p_wallet_address),
    lower(p_recipient_address),
    p_chain_slug,
    p_chain_id,
    p_native_symbol,
    p_amount_neuron,
    v_account.available_neuron,
    v_after,
    'pending'
  )
  returning * into v_request;

  return query
  select
    v_request.id,
    v_request.status,
    v_request.balance_before_neuron,
    v_request.balance_after_neuron,
    v_request.created_at,
    p_vault_balance_neuron,
    v_pending,
    greatest(p_vault_balance_neuron - v_pending - p_amount_neuron, 0);
end;
$$;

create or replace function public.langclaw_usage_apply_adjustment(
  p_wallet_user_id uuid,
  p_wallet_address text,
  p_chain_slug text,
  p_chain_id integer,
  p_native_symbol text,
  p_direction text,
  p_amount_neuron numeric,
  p_reason text,
  p_reference text,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  adjustment_id uuid,
  applied boolean,
  balance_before_neuron numeric,
  balance_after_neuron numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.langclaw_usage_accounts%rowtype;
  v_adjustment public.langclaw_usage_adjustments%rowtype;
  v_after numeric(78, 0);
begin
  if p_direction not in ('credit', 'debit') then
    raise exception 'invalid_usage_adjustment_direction';
  end if;

  if p_amount_neuron <= 0 then
    raise exception 'usage_adjustment_amount_must_be_positive';
  end if;

  if nullif(trim(p_reason), '') is null or nullif(trim(p_reference), '') is null then
    raise exception 'usage_adjustment_audit_fields_required';
  end if;

  select *
  into v_account
  from public.langclaw_usage_accounts
  where wallet_user_id = p_wallet_user_id
    and chain_slug = p_chain_slug
  for update;

  if not found then
    raise exception 'usage_account_not_found';
  end if;

  select *
  into v_adjustment
  from public.langclaw_usage_adjustments
  where chain_slug = p_chain_slug
    and reference = p_reference;

  if found then
    return query
    select
      v_adjustment.id,
      false,
      v_adjustment.balance_before_neuron,
      v_adjustment.balance_after_neuron;
    return;
  end if;

  if p_direction = 'debit' and v_account.available_neuron < p_amount_neuron then
    raise exception 'insufficient_balance_for_usage_adjustment';
  end if;

  update public.langclaw_usage_accounts as account
  set available_neuron = case
    when p_direction = 'credit'
      then account.available_neuron + p_amount_neuron
    else account.available_neuron - p_amount_neuron
  end
  where account.wallet_user_id = p_wallet_user_id
    and account.chain_slug = p_chain_slug
  returning account.available_neuron into v_after;

  insert into public.langclaw_usage_adjustments (
    wallet_user_id,
    wallet_address,
    chain_slug,
    chain_id,
    native_symbol,
    direction,
    amount_neuron,
    balance_before_neuron,
    balance_after_neuron,
    reason,
    reference,
    metadata
  )
  values (
    p_wallet_user_id,
    lower(p_wallet_address),
    p_chain_slug,
    p_chain_id,
    p_native_symbol,
    p_direction,
    p_amount_neuron,
    v_account.available_neuron,
    v_after,
    trim(p_reason),
    trim(p_reference),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into v_adjustment;

  return query
  select
    v_adjustment.id,
    true,
    v_adjustment.balance_before_neuron,
    v_adjustment.balance_after_neuron;
end;
$$;

revoke all on table public.langclaw_usage_adjustments
  from anon, authenticated;

revoke all on function public.langclaw_usage_read_vault_liquidity(
  text,
  numeric
) from public, anon, authenticated;

revoke all on function public.langclaw_usage_request_withdrawal(
  uuid,
  text,
  text,
  integer,
  text,
  numeric,
  text,
  numeric
) from public, anon, authenticated;

revoke all on function public.langclaw_usage_apply_adjustment(
  uuid,
  text,
  text,
  integer,
  text,
  text,
  numeric,
  text,
  text,
  jsonb
) from public, anon, authenticated;

grant execute on function public.langclaw_usage_read_vault_liquidity(
  text,
  numeric
) to service_role;

grant execute on function public.langclaw_usage_request_withdrawal(
  uuid,
  text,
  text,
  integer,
  text,
  numeric,
  text,
  numeric
) to service_role;

grant execute on function public.langclaw_usage_apply_adjustment(
  uuid,
  text,
  text,
  integer,
  text,
  text,
  numeric,
  text,
  text,
  jsonb
) to service_role;
