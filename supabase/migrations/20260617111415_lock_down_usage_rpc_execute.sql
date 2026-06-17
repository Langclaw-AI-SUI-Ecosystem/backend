revoke all on function public.langclaw_usage_credit_deposit(
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
) from public;

revoke all on function public.langclaw_usage_reserve_balance(
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
) from public;

grant execute on function public.langclaw_usage_credit_deposit(
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
) to service_role;

grant execute on function public.langclaw_usage_reserve_balance(
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
) to service_role;
