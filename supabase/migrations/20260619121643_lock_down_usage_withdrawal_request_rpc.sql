revoke execute on function public.langclaw_usage_request_withdrawal(
  uuid,
  text,
  text,
  integer,
  text,
  numeric,
  text
) from anon, authenticated;

revoke execute on function public.langclaw_usage_complete_withdrawal(
  uuid,
  uuid,
  text,
  text
) from anon, authenticated;

revoke execute on function public.langclaw_usage_reject_withdrawal(
  uuid,
  uuid,
  text,
  text
) from anon, authenticated;

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
