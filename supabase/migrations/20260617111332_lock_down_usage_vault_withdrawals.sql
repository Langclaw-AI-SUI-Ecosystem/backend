revoke all on table public.langclaw_usage_vault_withdrawals
  from anon, authenticated;

drop policy if exists langclaw_usage_vault_withdrawals_deny_all
  on public.langclaw_usage_vault_withdrawals;

create policy langclaw_usage_vault_withdrawals_deny_all
  on public.langclaw_usage_vault_withdrawals
  for all
  to public
  using (false)
  with check (false);
