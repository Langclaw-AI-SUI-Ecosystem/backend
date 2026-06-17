create table if not exists public.langclaw_usage_vault_withdrawals (
  id uuid primary key default gen_random_uuid(),
  admin_wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete restrict,
  admin_wallet_address text not null,
  recipient_address text not null,
  chain_slug text not null,
  chain_id integer not null,
  native_symbol text not null,
  tx_hash text not null,
  amount_neuron numeric(78, 0) not null,
  balance_after_neuron numeric(78, 0) not null,
  block_number numeric(78, 0),
  event_seq integer,
  status text not null default 'confirmed',
  created_at timestamptz not null default now(),
  constraint langclaw_usage_vault_withdrawals_admin_address_lowercase
    check (admin_wallet_address = lower(admin_wallet_address)),
  constraint langclaw_usage_vault_withdrawals_admin_address_format
    check (admin_wallet_address ~ '^0x[0-9a-f]{64}$'),
  constraint langclaw_usage_vault_withdrawals_recipient_address_lowercase
    check (recipient_address = lower(recipient_address)),
  constraint langclaw_usage_vault_withdrawals_recipient_address_format
    check (recipient_address ~ '^0x[0-9a-f]{64}$'),
  constraint langclaw_usage_vault_withdrawals_chain_slug_check
    check (chain_slug in ('sui-testnet', 'sui-mainnet')),
  constraint langclaw_usage_vault_withdrawals_native_symbol_check
    check (native_symbol = 'SUI'),
  constraint langclaw_usage_vault_withdrawals_tx_hash_format
    check (
      tx_hash ~ '^0x[0-9a-f]{64}$'
      or tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$'
    ),
  constraint langclaw_usage_vault_withdrawals_amount_positive
    check (amount_neuron > 0),
  constraint langclaw_usage_vault_withdrawals_balance_nonnegative
    check (balance_after_neuron >= 0),
  constraint langclaw_usage_vault_withdrawals_status_check
    check (status in ('confirmed')),
  constraint langclaw_usage_vault_withdrawals_chain_tx_unique
    unique (chain_slug, tx_hash)
);

create index if not exists langclaw_usage_vault_withdrawals_created_idx
  on public.langclaw_usage_vault_withdrawals(created_at desc);

create index if not exists langclaw_usage_vault_withdrawals_admin_created_idx
  on public.langclaw_usage_vault_withdrawals(admin_wallet_user_id, created_at desc);

alter table public.langclaw_usage_vault_withdrawals enable row level security;
