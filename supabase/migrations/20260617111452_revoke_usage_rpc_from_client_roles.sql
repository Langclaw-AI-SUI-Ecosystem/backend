revoke execute on function public.langclaw_usage_credit_deposit(
  uuid,
  text,
  text,
  numeric,
  text,
  numeric,
  integer,
  text,
  integer,
  text
) from anon, authenticated;

revoke execute on function public.langclaw_usage_reserve_balance(
  uuid,
  text,
  uuid,
  text,
  numeric,
  numeric,
  integer,
  integer,
  numeric,
  text,
  integer,
  text
) from anon, authenticated;
