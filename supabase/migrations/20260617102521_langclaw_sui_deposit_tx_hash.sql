alter table public.langclaw_usage_deposits
  drop constraint if exists langclaw_usage_deposits_tx_hash_format;

alter table public.langclaw_usage_deposits
  add constraint langclaw_usage_deposits_tx_hash_format
    check (
      tx_hash ~ '^0x[0-9a-f]{64}$'
      or tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$'
    );

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
      and tx_hash = p_tx_hash
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
    p_tx_hash,
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
