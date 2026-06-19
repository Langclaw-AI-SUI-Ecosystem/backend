create table if not exists public.langclaw_usage_withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete restrict,
  wallet_address text not null,
  recipient_address text not null,
  chain_slug text not null,
  chain_id integer not null,
  native_symbol text not null,
  amount_neuron numeric(78, 0) not null,
  balance_before_neuron numeric(78, 0) not null,
  balance_after_neuron numeric(78, 0) not null,
  status text not null default 'pending',
  tx_hash text,
  admin_wallet_user_id uuid references public.langclaw_wallet_users(id) on delete restrict,
  admin_wallet_address text,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  rejected_at timestamptz,
  constraint langclaw_usage_withdrawal_requests_wallet_address_lowercase
    check (wallet_address = lower(wallet_address)),
  constraint langclaw_usage_withdrawal_requests_wallet_address_format
    check (wallet_address ~ '^0x([0-9a-f]{40}|[0-9a-f]{64})$'),
  constraint langclaw_usage_withdrawal_requests_recipient_address_lowercase
    check (recipient_address = lower(recipient_address)),
  constraint langclaw_usage_withdrawal_requests_recipient_address_format
    check (recipient_address ~ '^0x([0-9a-f]{40}|[0-9a-f]{64})$'),
  constraint langclaw_usage_withdrawal_requests_admin_address_lowercase
    check (admin_wallet_address is null or admin_wallet_address = lower(admin_wallet_address)),
  constraint langclaw_usage_withdrawal_requests_admin_address_format
    check (admin_wallet_address is null or admin_wallet_address ~ '^0x([0-9a-f]{40}|[0-9a-f]{64})$'),
  constraint langclaw_usage_withdrawal_requests_chain_slug_check
    check (chain_slug in ('sui-testnet', 'sui-mainnet')),
  constraint langclaw_usage_withdrawal_requests_native_symbol_check
    check (native_symbol = 'SUI'),
  constraint langclaw_usage_withdrawal_requests_tx_hash_format
    check (
      tx_hash is null
      or tx_hash ~ '^0x[0-9a-f]{64}$'
      or tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$'
    ),
  constraint langclaw_usage_withdrawal_requests_amount_positive
    check (amount_neuron > 0),
  constraint langclaw_usage_withdrawal_requests_balance_before_nonnegative
    check (balance_before_neuron >= 0),
  constraint langclaw_usage_withdrawal_requests_balance_after_nonnegative
    check (balance_after_neuron >= 0),
  constraint langclaw_usage_withdrawal_requests_status_check
    check (status in ('pending', 'completed', 'rejected')),
  constraint langclaw_usage_withdrawal_requests_completed_has_tx
    check (status <> 'completed' or tx_hash is not null),
  constraint langclaw_usage_withdrawal_requests_rejected_has_timestamp
    check (status <> 'rejected' or rejected_at is not null)
);

create index if not exists langclaw_usage_withdrawal_requests_wallet_created_idx
  on public.langclaw_usage_withdrawal_requests(wallet_user_id, chain_slug, created_at desc);

create index if not exists langclaw_usage_withdrawal_requests_status_created_idx
  on public.langclaw_usage_withdrawal_requests(status, chain_slug, created_at desc);

create unique index if not exists langclaw_usage_withdrawal_requests_chain_tx_key
  on public.langclaw_usage_withdrawal_requests(chain_slug, tx_hash)
  where tx_hash is not null;

drop trigger if exists langclaw_usage_withdrawal_requests_touch_updated_at
  on public.langclaw_usage_withdrawal_requests;

create trigger langclaw_usage_withdrawal_requests_touch_updated_at
before update on public.langclaw_usage_withdrawal_requests
for each row execute function public.langclaw_touch_updated_at();

alter table public.langclaw_usage_withdrawal_requests enable row level security;

drop policy if exists langclaw_usage_withdrawal_requests_deny_all
  on public.langclaw_usage_withdrawal_requests;

create policy langclaw_usage_withdrawal_requests_deny_all
  on public.langclaw_usage_withdrawal_requests
  for all
  to public
  using (false)
  with check (false);

create or replace function public.langclaw_usage_request_withdrawal(
  p_wallet_user_id uuid,
  p_wallet_address text,
  p_chain_slug text,
  p_chain_id integer,
  p_native_symbol text,
  p_amount_neuron numeric,
  p_recipient_address text
)
returns table (
  request_id uuid,
  status text,
  balance_before_neuron numeric,
  balance_after_neuron numeric,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.langclaw_usage_accounts%rowtype;
  v_after numeric(78, 0);
  v_request public.langclaw_usage_withdrawal_requests%rowtype;
begin
  if p_amount_neuron <= 0 then
    raise exception 'withdrawal_amount_must_be_positive';
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
    v_request.created_at;
end;
$$;

create or replace function public.langclaw_usage_complete_withdrawal(
  p_request_id uuid,
  p_admin_wallet_user_id uuid,
  p_admin_wallet_address text,
  p_tx_hash text
)
returns table (
  request_id uuid,
  status text,
  tx_hash text,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.langclaw_usage_withdrawal_requests%rowtype;
begin
  select *
  into v_request
  from public.langclaw_usage_withdrawal_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'withdrawal_request_not_found';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'withdrawal_request_not_pending';
  end if;

  update public.langclaw_usage_withdrawal_requests
  set
    admin_wallet_user_id = p_admin_wallet_user_id,
    admin_wallet_address = lower(p_admin_wallet_address),
    tx_hash = p_tx_hash,
    status = 'completed',
    completed_at = now()
  where id = p_request_id
  returning * into v_request;

  return query
  select
    v_request.id,
    v_request.status,
    v_request.tx_hash,
    v_request.completed_at;
end;
$$;

create or replace function public.langclaw_usage_reject_withdrawal(
  p_request_id uuid,
  p_admin_wallet_user_id uuid,
  p_admin_wallet_address text,
  p_rejection_reason text
)
returns table (
  request_id uuid,
  status text,
  balance_after_refund_neuron numeric,
  rejected_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.langclaw_usage_withdrawal_requests%rowtype;
  v_after numeric(78, 0);
begin
  select *
  into v_request
  from public.langclaw_usage_withdrawal_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'withdrawal_request_not_found';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'withdrawal_request_not_pending';
  end if;

  update public.langclaw_usage_accounts as account
  set available_neuron = account.available_neuron + v_request.amount_neuron
  where account.wallet_user_id = v_request.wallet_user_id
    and account.chain_slug = v_request.chain_slug
  returning account.available_neuron into v_after;

  update public.langclaw_usage_withdrawal_requests
  set
    admin_wallet_user_id = p_admin_wallet_user_id,
    admin_wallet_address = lower(p_admin_wallet_address),
    rejection_reason = nullif(trim(p_rejection_reason), ''),
    status = 'rejected',
    rejected_at = now()
  where id = p_request_id
  returning * into v_request;

  return query
  select
    v_request.id,
    v_request.status,
    v_after,
    v_request.rejected_at;
end;
$$;

revoke all on table public.langclaw_usage_withdrawal_requests
  from anon, authenticated;

revoke all on function public.langclaw_usage_request_withdrawal(
  uuid,
  text,
  text,
  integer,
  text,
  numeric,
  text
) from public;

revoke all on function public.langclaw_usage_complete_withdrawal(
  uuid,
  uuid,
  text,
  text
) from public;

revoke all on function public.langclaw_usage_reject_withdrawal(
  uuid,
  uuid,
  text,
  text
) from public;

grant execute on function public.langclaw_usage_request_withdrawal(
  uuid,
  text,
  text,
  integer,
  text,
  numeric,
  text
) to service_role;

grant execute on function public.langclaw_usage_complete_withdrawal(
  uuid,
  uuid,
  text,
  text
) to service_role;

grant execute on function public.langclaw_usage_reject_withdrawal(
  uuid,
  uuid,
  text,
  text
) to service_role;
