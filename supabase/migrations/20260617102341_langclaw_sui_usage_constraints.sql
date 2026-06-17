alter table public.langclaw_usage_accounts
  drop constraint if exists langclaw_usage_accounts_chain_slug_check;

alter table public.langclaw_usage_accounts
  add constraint langclaw_usage_accounts_chain_slug_check
    check (chain_slug in ('mantle', 'celo', 'sui-testnet', 'sui-mainnet'));

alter table public.langclaw_usage_accounts
  drop constraint if exists langclaw_usage_accounts_native_symbol_check;

alter table public.langclaw_usage_accounts
  add constraint langclaw_usage_accounts_native_symbol_check
    check (native_symbol in ('MNT', 'CELO', 'USDT', 'SUI'));
