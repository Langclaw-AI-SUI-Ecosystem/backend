alter table public.langclaw_usage_accounts
  add column if not exists chain_slug text not null default 'mantle',
  add column if not exists chain_id integer not null default 5000,
  add column if not exists native_symbol text not null default 'MNT';

alter table public.langclaw_usage_deposits
  add column if not exists chain_slug text not null default 'mantle',
  add column if not exists chain_id integer not null default 5000,
  add column if not exists native_symbol text not null default 'MNT';

alter table public.langclaw_usage_reservations
  add column if not exists chain_slug text not null default 'mantle',
  add column if not exists chain_id integer not null default 5000,
  add column if not exists native_symbol text not null default 'MNT';

alter table public.langclaw_usage_charges
  add column if not exists chain_slug text not null default 'mantle',
  add column if not exists chain_id integer not null default 5000,
  add column if not exists native_symbol text not null default 'MNT';

alter table public.langclaw_usage_refunds
  add column if not exists chain_slug text not null default 'mantle',
  add column if not exists chain_id integer not null default 5000,
  add column if not exists native_symbol text not null default 'MNT';

alter table public.langclaw_usage_accounts
  drop constraint if exists langclaw_usage_accounts_pkey,
  drop constraint if exists langclaw_usage_accounts_wallet_address_key;

alter table public.langclaw_usage_accounts
  add constraint langclaw_usage_accounts_pkey primary key (wallet_user_id, chain_slug);

alter table public.langclaw_usage_accounts
  add constraint langclaw_usage_accounts_chain_slug_check
    check (chain_slug in ('mantle', 'celo')),
  add constraint langclaw_usage_accounts_native_symbol_check
    check (native_symbol in ('MNT', 'CELO'));

alter table public.langclaw_usage_deposits
  drop constraint if exists langclaw_usage_deposits_tx_hash_key;

create unique index if not exists langclaw_usage_deposits_chain_tx_hash_key
  on public.langclaw_usage_deposits(chain_slug, tx_hash);

create index if not exists langclaw_usage_accounts_wallet_chain_idx
  on public.langclaw_usage_accounts(wallet_user_id, chain_slug);

create index if not exists langclaw_usage_reservations_wallet_chain_created_idx
  on public.langclaw_usage_reservations(wallet_user_id, chain_slug, created_at desc);

create or replace function public.langclaw_usage_credit_deposit(
  p_wallet_user_id uuid,
  p_wallet_address text,
  p_tx_hash text,
  p_amount_neuron numeric,
  p_reference text,
  p_block_number numeric,
  p_log_index integer,
  p_chain_slug text,
  p_chain_id integer,
  p_native_symbol text
)
returns table (
  credited boolean,
  balance_before_neuron numeric,
  balance_after_neuron numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.langclaw_usage_accounts%rowtype;
  v_before numeric(78, 0);
  v_after numeric(78, 0);
begin
  if p_amount_neuron <= 0 then
    raise exception 'deposit_amount_must_be_positive';
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

  if exists (
    select 1
    from public.langclaw_usage_deposits
    where chain_slug = p_chain_slug
      and tx_hash = lower(p_tx_hash)
  ) then
    return query
    select
      false,
      v_account.available_neuron,
      v_account.available_neuron;
    return;
  end if;

  v_before := v_account.available_neuron;

  update public.langclaw_usage_accounts
  set
    available_neuron = available_neuron + p_amount_neuron,
    lifetime_deposited_neuron = lifetime_deposited_neuron + p_amount_neuron
  where wallet_user_id = p_wallet_user_id
    and chain_slug = p_chain_slug
  returning available_neuron into v_after;

  insert into public.langclaw_usage_deposits (
    wallet_user_id,
    wallet_address,
    chain_slug,
    chain_id,
    native_symbol,
    tx_hash,
    amount_neuron,
    reference,
    block_number,
    log_index,
    status
  )
  values (
    p_wallet_user_id,
    lower(p_wallet_address),
    p_chain_slug,
    p_chain_id,
    p_native_symbol,
    lower(p_tx_hash),
    p_amount_neuron,
    p_reference,
    p_block_number,
    p_log_index,
    'credited'
  );

  return query
  select
    true,
    v_before,
    v_after;
end;
$$;

create or replace function public.langclaw_usage_reserve_balance(
  p_wallet_user_id uuid,
  p_wallet_address text,
  p_reservation_id uuid,
  p_model text,
  p_prompt_price_neuron numeric,
  p_completion_price_neuron numeric,
  p_estimated_prompt_tokens integer,
  p_estimated_completion_tokens integer,
  p_reserved_neuron numeric,
  p_chain_slug text,
  p_chain_id integer,
  p_native_symbol text
)
returns table (
  reservation_id uuid,
  balance_before_neuron numeric,
  balance_after_neuron numeric,
  reserved_neuron numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.langclaw_usage_accounts%rowtype;
  v_before numeric(78, 0);
  v_after numeric(78, 0);
begin
  if p_reserved_neuron < 0 then
    raise exception 'reserved_neuron_must_be_nonnegative';
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

  if v_account.available_neuron < p_reserved_neuron then
    raise exception 'insufficient_balance';
  end if;

  v_before := v_account.available_neuron;

  update public.langclaw_usage_accounts as account
  set
    available_neuron = account.available_neuron - p_reserved_neuron,
    reserved_neuron = account.reserved_neuron + p_reserved_neuron
  where account.wallet_user_id = p_wallet_user_id
    and account.chain_slug = p_chain_slug
  returning account.available_neuron into v_after;

  insert into public.langclaw_usage_reservations (
    id,
    wallet_user_id,
    wallet_address,
    chain_slug,
    chain_id,
    native_symbol,
    model,
    prompt_price_neuron,
    completion_price_neuron,
    estimated_prompt_tokens,
    estimated_completion_tokens,
    reserved_neuron,
    balance_before_neuron,
    balance_after_reserve_neuron,
    status
  )
  values (
    p_reservation_id,
    p_wallet_user_id,
    lower(p_wallet_address),
    p_chain_slug,
    p_chain_id,
    p_native_symbol,
    p_model,
    p_prompt_price_neuron,
    p_completion_price_neuron,
    p_estimated_prompt_tokens,
    p_estimated_completion_tokens,
    p_reserved_neuron,
    v_before,
    v_after,
    'reserved'
  );

  return query
  select
    p_reservation_id,
    v_before,
    v_after,
    p_reserved_neuron;
end;
$$;

create or replace function public.langclaw_usage_finalize_reservation(
  p_reservation_id uuid,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_total_tokens integer,
  p_charged_neuron numeric,
  p_status text,
  p_topic text
)
returns table (
  status text,
  charged_neuron numeric,
  released_neuron numeric,
  balance_after_neuron numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.langclaw_usage_accounts%rowtype;
  v_reservation public.langclaw_usage_reservations%rowtype;
  v_charge public.langclaw_usage_charges%rowtype;
  v_status text;
  v_charge_neuron numeric(78, 0);
  v_extra_neuron numeric(78, 0);
  v_release_neuron numeric(78, 0);
  v_after numeric(78, 0);
begin
  select *
  into v_reservation
  from public.langclaw_usage_reservations
  where id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found';
  end if;

  select *
  into v_account
  from public.langclaw_usage_accounts
  where wallet_user_id = v_reservation.wallet_user_id
    and chain_slug = v_reservation.chain_slug
  for update;

  if v_reservation.status <> 'reserved' then
    select *
    into v_charge
    from public.langclaw_usage_charges
    where reservation_id = p_reservation_id;

    return query
    select
      coalesce(v_charge.status, v_reservation.status),
      coalesce(v_charge.charged_neuron, v_reservation.charged_neuron),
      coalesce(v_charge.released_neuron, v_reservation.released_neuron),
      v_account.available_neuron;
    return;
  end if;

  if p_charged_neuron < 0 then
    raise exception 'charged_neuron_must_be_nonnegative';
  end if;

  if p_status not in ('charged', 'estimated', 'refunded') then
    raise exception 'invalid_charge_status';
  end if;

  v_status := p_status;
  v_charge_neuron := p_charged_neuron;
  v_extra_neuron := greatest(v_charge_neuron - v_reservation.reserved_neuron, 0);
  v_release_neuron := greatest(v_reservation.reserved_neuron - v_charge_neuron, 0);

  if v_charge_neuron = 0 then
    v_status := 'refunded';
    v_release_neuron := v_reservation.reserved_neuron;
    v_extra_neuron := 0;
  elsif v_extra_neuron > v_account.available_neuron then
    v_charge_neuron := v_reservation.reserved_neuron + v_account.available_neuron;
    v_extra_neuron := v_account.available_neuron;
    v_release_neuron := 0;
    v_status := 'estimated';
  end if;

  update public.langclaw_usage_accounts as account
  set
    available_neuron = account.available_neuron + v_release_neuron - v_extra_neuron,
    reserved_neuron = account.reserved_neuron - v_reservation.reserved_neuron,
    lifetime_charged_neuron = account.lifetime_charged_neuron + v_charge_neuron
  where account.wallet_user_id = v_reservation.wallet_user_id
    and account.chain_slug = v_reservation.chain_slug
  returning account.available_neuron into v_after;

  update public.langclaw_usage_reservations
  set
    charged_neuron = v_charge_neuron,
    released_neuron = v_release_neuron,
    prompt_tokens = greatest(coalesce(p_prompt_tokens, 0), 0),
    completion_tokens = greatest(coalesce(p_completion_tokens, 0), 0),
    total_tokens = greatest(coalesce(p_total_tokens, 0), 0),
    topic = p_topic,
    status = v_status
  where id = p_reservation_id;

  insert into public.langclaw_usage_charges (
    reservation_id,
    wallet_user_id,
    wallet_address,
    chain_slug,
    chain_id,
    native_symbol,
    model,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    prompt_price_neuron,
    completion_price_neuron,
    reserved_neuron,
    charged_neuron,
    released_neuron,
    topic,
    status
  )
  values (
    p_reservation_id,
    v_reservation.wallet_user_id,
    v_reservation.wallet_address,
    v_reservation.chain_slug,
    v_reservation.chain_id,
    v_reservation.native_symbol,
    v_reservation.model,
    greatest(coalesce(p_prompt_tokens, 0), 0),
    greatest(coalesce(p_completion_tokens, 0), 0),
    greatest(coalesce(p_total_tokens, 0), 0),
    v_reservation.prompt_price_neuron,
    v_reservation.completion_price_neuron,
    v_reservation.reserved_neuron,
    v_charge_neuron,
    v_release_neuron,
    p_topic,
    v_status
  );

  return query
  select
    v_status,
    v_charge_neuron,
    v_release_neuron,
    v_after;
end;
$$;

create or replace function public.langclaw_usage_refund_reservation(
  p_reservation_id uuid,
  p_reason text
)
returns table (
  released_neuron numeric,
  balance_after_neuron numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.langclaw_usage_accounts%rowtype;
  v_reservation public.langclaw_usage_reservations%rowtype;
  v_after numeric(78, 0);
begin
  select *
  into v_reservation
  from public.langclaw_usage_reservations
  where id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found';
  end if;

  select *
  into v_account
  from public.langclaw_usage_accounts
  where wallet_user_id = v_reservation.wallet_user_id
    and chain_slug = v_reservation.chain_slug
  for update;

  if v_reservation.status <> 'reserved' then
    return query
    select
      0::numeric,
      v_account.available_neuron;
    return;
  end if;

  update public.langclaw_usage_accounts as account
  set
    available_neuron = account.available_neuron + v_reservation.reserved_neuron,
    reserved_neuron = account.reserved_neuron - v_reservation.reserved_neuron
  where account.wallet_user_id = v_reservation.wallet_user_id
    and account.chain_slug = v_reservation.chain_slug
  returning account.available_neuron into v_after;

  update public.langclaw_usage_reservations
  set
    released_neuron = v_reservation.reserved_neuron,
    status = 'failed_after_charge'
  where id = p_reservation_id;

  insert into public.langclaw_usage_refunds (
    reservation_id,
    wallet_user_id,
    wallet_address,
    chain_slug,
    chain_id,
    native_symbol,
    amount_neuron,
    reason
  )
  values (
    p_reservation_id,
    v_reservation.wallet_user_id,
    v_reservation.wallet_address,
    v_reservation.chain_slug,
    v_reservation.chain_id,
    v_reservation.native_symbol,
    v_reservation.reserved_neuron,
    p_reason
  );

  return query
  select
    v_reservation.reserved_neuron,
    v_after;
end;
$$;
