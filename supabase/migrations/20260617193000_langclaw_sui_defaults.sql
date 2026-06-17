alter table public.langclaw_usage_accounts
  alter column chain_slug set default 'sui-mainnet',
  alter column chain_id set default 0,
  alter column native_symbol set default 'SUI';

alter table public.langclaw_usage_deposits
  alter column chain_slug set default 'sui-mainnet',
  alter column chain_id set default 0,
  alter column native_symbol set default 'SUI';

alter table public.langclaw_usage_reservations
  alter column chain_slug set default 'sui-mainnet',
  alter column chain_id set default 0,
  alter column native_symbol set default 'SUI';

alter table public.langclaw_usage_charges
  alter column chain_slug set default 'sui-mainnet',
  alter column chain_id set default 0,
  alter column native_symbol set default 'SUI';

alter table public.langclaw_usage_refunds
  alter column chain_slug set default 'sui-mainnet',
  alter column chain_id set default 0,
  alter column native_symbol set default 'SUI';

alter table public.langclaw_chat_messages
  drop constraint if exists langclaw_chat_messages_chain_check;

alter table public.langclaw_chat_messages
  add constraint langclaw_chat_messages_chain_check
    check (chain in ('sui-mainnet', 'sui-testnet', 'sui', 'mantle', 'celo') or chain is null);

alter table public.langclaw_alpha_watchlist
  alter column chain set default 'sui-mainnet';

alter table public.langclaw_alpha_watchlist
  drop constraint if exists langclaw_alpha_watchlist_chain_check;

alter table public.langclaw_alpha_watchlist
  add constraint langclaw_alpha_watchlist_chain_check
    check (chain in ('sui-mainnet', 'sui-testnet', 'sui', 'mantle', 'celo'));
