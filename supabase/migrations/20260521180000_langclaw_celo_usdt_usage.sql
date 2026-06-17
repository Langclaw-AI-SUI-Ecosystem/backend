alter table public.langclaw_usage_accounts
  drop constraint if exists langclaw_usage_accounts_native_symbol_check;

alter table public.langclaw_usage_accounts
  add constraint langclaw_usage_accounts_native_symbol_check
    check (native_symbol in ('MNT', 'CELO', 'USDT'));
