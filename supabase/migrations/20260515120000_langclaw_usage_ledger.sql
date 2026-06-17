create table if not exists public.langclaw_usage_accounts (
  wallet_user_id uuid primary key references public.langclaw_wallet_users(id) on delete cascade,
  wallet_address text not null unique,
  available_neuron numeric(78, 0) not null default 0,
  reserved_neuron numeric(78, 0) not null default 0,
  lifetime_deposited_neuron numeric(78, 0) not null default 0,
  lifetime_charged_neuron numeric(78, 0) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint langclaw_usage_accounts_address_lowercase
    check (wallet_address = lower(wallet_address)),
  constraint langclaw_usage_accounts_address_format
    check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  constraint langclaw_usage_accounts_available_nonnegative
    check (available_neuron >= 0),
  constraint langclaw_usage_accounts_reserved_nonnegative
    check (reserved_neuron >= 0),
  constraint langclaw_usage_accounts_lifetime_deposited_nonnegative
    check (lifetime_deposited_neuron >= 0),
  constraint langclaw_usage_accounts_lifetime_charged_nonnegative
    check (lifetime_charged_neuron >= 0)
);

create table if not exists public.langclaw_usage_deposits (
  id uuid primary key default gen_random_uuid(),
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  wallet_address text not null,
  tx_hash text not null unique,
  amount_neuron numeric(78, 0) not null,
  reference text,
  block_number numeric(78, 0) not null,
  log_index integer not null,
  status text not null default 'credited' check (status in ('credited', 'duplicate', 'rejected')),
  created_at timestamptz not null default now(),
  constraint langclaw_usage_deposits_amount_positive
    check (amount_neuron > 0),
  constraint langclaw_usage_deposits_tx_hash_format
    check (tx_hash ~ '^0x[0-9a-f]{64}$')
);

create table if not exists public.langclaw_usage_reservations (
  id uuid primary key,
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  wallet_address text not null,
  model text not null,
  prompt_price_neuron numeric(78, 0) not null,
  completion_price_neuron numeric(78, 0) not null,
  estimated_prompt_tokens integer not null,
  estimated_completion_tokens integer not null,
  reserved_neuron numeric(78, 0) not null,
  charged_neuron numeric(78, 0) not null default 0,
  released_neuron numeric(78, 0) not null default 0,
  balance_before_neuron numeric(78, 0) not null,
  balance_after_reserve_neuron numeric(78, 0) not null,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  topic text,
  status text not null default 'reserved'
    check (status in ('reserved', 'charged', 'estimated', 'refunded', 'failed_after_charge')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint langclaw_usage_reservations_prompt_price_nonnegative
    check (prompt_price_neuron >= 0),
  constraint langclaw_usage_reservations_completion_price_nonnegative
    check (completion_price_neuron >= 0),
  constraint langclaw_usage_reservations_estimated_prompt_nonnegative
    check (estimated_prompt_tokens >= 0),
  constraint langclaw_usage_reservations_estimated_completion_nonnegative
    check (estimated_completion_tokens >= 0),
  constraint langclaw_usage_reservations_reserved_nonnegative
    check (reserved_neuron >= 0),
  constraint langclaw_usage_reservations_charged_nonnegative
    check (charged_neuron >= 0),
  constraint langclaw_usage_reservations_released_nonnegative
    check (released_neuron >= 0)
);

create table if not exists public.langclaw_usage_charges (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null unique references public.langclaw_usage_reservations(id) on delete cascade,
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  wallet_address text not null,
  model text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  prompt_price_neuron numeric(78, 0) not null,
  completion_price_neuron numeric(78, 0) not null,
  reserved_neuron numeric(78, 0) not null,
  charged_neuron numeric(78, 0) not null,
  released_neuron numeric(78, 0) not null,
  topic text,
  status text not null check (status in ('charged', 'estimated', 'refunded', 'failed_after_charge')),
  created_at timestamptz not null default now()
);

create table if not exists public.langclaw_usage_refunds (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.langclaw_usage_reservations(id) on delete cascade,
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  wallet_address text not null,
  amount_neuron numeric(78, 0) not null,
  reason text,
  created_at timestamptz not null default now(),
  constraint langclaw_usage_refunds_amount_nonnegative
    check (amount_neuron >= 0)
);

create index if not exists langclaw_usage_deposits_wallet_created_idx
  on public.langclaw_usage_deposits(wallet_user_id, created_at desc);

create index if not exists langclaw_usage_reservations_wallet_created_idx
  on public.langclaw_usage_reservations(wallet_user_id, created_at desc);

create index if not exists langclaw_usage_charges_wallet_created_idx
  on public.langclaw_usage_charges(wallet_user_id, created_at desc);

create index if not exists langclaw_usage_refunds_wallet_created_idx
  on public.langclaw_usage_refunds(wallet_user_id, created_at desc);

drop trigger if exists langclaw_usage_accounts_touch_updated_at
  on public.langclaw_usage_accounts;

create trigger langclaw_usage_accounts_touch_updated_at
before update on public.langclaw_usage_accounts
for each row execute function public.langclaw_touch_updated_at();

drop trigger if exists langclaw_usage_reservations_touch_updated_at
  on public.langclaw_usage_reservations;

create trigger langclaw_usage_reservations_touch_updated_at
before update on public.langclaw_usage_reservations
for each row execute function public.langclaw_touch_updated_at();

create or replace function public.langclaw_usage_credit_deposit(
  p_wallet_user_id uuid,
  p_wallet_address text,
  p_tx_hash text,
  p_amount_neuron numeric,
  p_reference text,
  p_block_number numeric,
  p_log_index integer
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
    wallet_address
  )
  values (
    p_wallet_user_id,
    lower(p_wallet_address)
  )
  on conflict (wallet_user_id) do update
    set wallet_address = excluded.wallet_address;

  select *
  into v_account
  from public.langclaw_usage_accounts
  where wallet_user_id = p_wallet_user_id
  for update;

  if exists (
    select 1
    from public.langclaw_usage_deposits
    where tx_hash = lower(p_tx_hash)
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
  returning available_neuron into v_after;

  insert into public.langclaw_usage_deposits (
    wallet_user_id,
    wallet_address,
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
  p_reserved_neuron numeric
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
    wallet_address
  )
  values (
    p_wallet_user_id,
    lower(p_wallet_address)
  )
  on conflict (wallet_user_id) do update
    set wallet_address = excluded.wallet_address;

  select *
  into v_account
  from public.langclaw_usage_accounts
  where wallet_user_id = p_wallet_user_id
  for update;

  if v_account.available_neuron < p_reserved_neuron then
    raise exception 'insufficient_balance';
  end if;

  v_before := v_account.available_neuron;

  update public.langclaw_usage_accounts
  set
    available_neuron = available_neuron - p_reserved_neuron,
    reserved_neuron = reserved_neuron + p_reserved_neuron
  where wallet_user_id = p_wallet_user_id
  returning available_neuron into v_after;

  insert into public.langclaw_usage_reservations (
    id,
    wallet_user_id,
    wallet_address,
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

  update public.langclaw_usage_accounts
  set
    available_neuron = available_neuron + v_release_neuron - v_extra_neuron,
    reserved_neuron = reserved_neuron - v_reservation.reserved_neuron,
    lifetime_charged_neuron = lifetime_charged_neuron + v_charge_neuron
  where wallet_user_id = v_reservation.wallet_user_id
  returning available_neuron into v_after;

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
  for update;

  if v_reservation.status <> 'reserved' then
    return query
    select
      0::numeric,
      v_account.available_neuron;
    return;
  end if;

  update public.langclaw_usage_accounts
  set
    available_neuron = available_neuron + v_reservation.reserved_neuron,
    reserved_neuron = reserved_neuron - v_reservation.reserved_neuron
  where wallet_user_id = v_reservation.wallet_user_id
  returning available_neuron into v_after;

  update public.langclaw_usage_reservations
  set
    released_neuron = v_reservation.reserved_neuron,
    status = 'failed_after_charge'
  where id = p_reservation_id;

  insert into public.langclaw_usage_refunds (
    reservation_id,
    wallet_user_id,
    wallet_address,
    amount_neuron,
    reason
  )
  values (
    p_reservation_id,
    v_reservation.wallet_user_id,
    v_reservation.wallet_address,
    v_reservation.reserved_neuron,
    p_reason
  );

  return query
  select
    v_reservation.reserved_neuron,
    v_after;
end;
$$;

alter table public.langclaw_usage_accounts enable row level security;
alter table public.langclaw_usage_deposits enable row level security;
alter table public.langclaw_usage_reservations enable row level security;
alter table public.langclaw_usage_charges enable row level security;
alter table public.langclaw_usage_refunds enable row level security;

drop policy if exists "Langclaw deny direct usage accounts access"
  on public.langclaw_usage_accounts;
create policy "Langclaw deny direct usage accounts access"
  on public.langclaw_usage_accounts
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Langclaw deny direct usage deposits access"
  on public.langclaw_usage_deposits;
create policy "Langclaw deny direct usage deposits access"
  on public.langclaw_usage_deposits
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Langclaw deny direct usage reservations access"
  on public.langclaw_usage_reservations;
create policy "Langclaw deny direct usage reservations access"
  on public.langclaw_usage_reservations
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Langclaw deny direct usage charges access"
  on public.langclaw_usage_charges;
create policy "Langclaw deny direct usage charges access"
  on public.langclaw_usage_charges
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Langclaw deny direct usage refunds access"
  on public.langclaw_usage_refunds;
create policy "Langclaw deny direct usage refunds access"
  on public.langclaw_usage_refunds
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke execute on function public.langclaw_usage_credit_deposit(uuid, text, text, numeric, text, numeric, integer)
  from anon, authenticated, public;
revoke execute on function public.langclaw_usage_reserve_balance(uuid, text, uuid, text, numeric, numeric, integer, integer, numeric)
  from anon, authenticated, public;
revoke execute on function public.langclaw_usage_finalize_reservation(uuid, integer, integer, integer, numeric, text, text)
  from anon, authenticated, public;
revoke execute on function public.langclaw_usage_refund_reservation(uuid, text)
  from anon, authenticated, public;
