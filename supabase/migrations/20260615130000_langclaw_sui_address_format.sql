-- Sui + Walrus migration: wallet addresses are now Sui addresses (0x + 64 hex),
-- not EVM addresses (0x + 40 hex). Relax the address-format checks to accept the
-- Sui form. Both widths are allowed so the migration does not fail validation on
-- any legacy EVM rows already in these tables.

alter table public.langclaw_wallet_users
  drop constraint if exists langclaw_wallet_users_address_format;
alter table public.langclaw_wallet_users
  add constraint langclaw_wallet_users_address_format
  check (wallet_address ~ '^0x([0-9a-f]{40}|[0-9a-f]{64})$');

alter table public.langclaw_usage_accounts
  drop constraint if exists langclaw_usage_accounts_address_format;
alter table public.langclaw_usage_accounts
  add constraint langclaw_usage_accounts_address_format
  check (wallet_address ~ '^0x([0-9a-f]{40}|[0-9a-f]{64})$');
