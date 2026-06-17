create or replace function public.langclaw_usage_finalize_reservation(
  p_reservation_id uuid,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_total_tokens integer,
  p_charged_neuron numeric,
  p_status text,
  p_topic text
)
returns table (
  status text,
  charged_neuron numeric,
  released_neuron numeric,
  balance_after_neuron numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.langclaw_usage_accounts%rowtype;
  v_reservation public.langclaw_usage_reservations%rowtype;
  v_charge public.langclaw_usage_charges%rowtype;
  v_status text;
  v_charge_neuron numeric(78, 0);
  v_extra_neuron numeric(78, 0);
  v_release_neuron numeric(78, 0);
  v_after numeric(78, 0);
begin
  select *
  into v_reservation
  from public.langclaw_usage_reservations
  where id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found';
  end if;

  select *
  into v_account
  from public.langclaw_usage_accounts
  where wallet_user_id = v_reservation.wallet_user_id
  for update;

  if v_reservation.status <> 'reserved' then
    select *
    into v_charge
    from public.langclaw_usage_charges
    where reservation_id = p_reservation_id;

    return query
    select
      coalesce(v_charge.status, v_reservation.status),
      coalesce(v_charge.charged_neuron, v_reservation.charged_neuron),
      coalesce(v_charge.released_neuron, v_reservation.released_neuron),
      v_account.available_neuron;
    return;
  end if;

  if p_charged_neuron < 0 then
    raise exception 'charged_neuron_must_be_nonnegative';
  end if;

  if p_status not in ('charged', 'estimated', 'refunded') then
    raise exception 'invalid_charge_status';
  end if;

  v_status := p_status;
  v_charge_neuron := p_charged_neuron;
  v_extra_neuron := greatest(v_charge_neuron - v_reservation.reserved_neuron, 0);
  v_release_neuron := greatest(v_reservation.reserved_neuron - v_charge_neuron, 0);

  if v_charge_neuron = 0 then
    v_status := 'refunded';
    v_release_neuron := v_reservation.reserved_neuron;
    v_extra_neuron := 0;
  elsif v_extra_neuron > v_account.available_neuron then
    v_charge_neuron := v_reservation.reserved_neuron + v_account.available_neuron;
    v_extra_neuron := v_account.available_neuron;
    v_release_neuron := 0;
    v_status := 'estimated';
  end if;

  update public.langclaw_usage_accounts as account
  set
    available_neuron = account.available_neuron + v_release_neuron - v_extra_neuron,
    reserved_neuron = account.reserved_neuron - v_reservation.reserved_neuron,
    lifetime_charged_neuron = account.lifetime_charged_neuron + v_charge_neuron
  where account.wallet_user_id = v_reservation.wallet_user_id
  returning account.available_neuron into v_after;

  update public.langclaw_usage_reservations
  set
    charged_neuron = v_charge_neuron,
    released_neuron = v_release_neuron,
    prompt_tokens = greatest(coalesce(p_prompt_tokens, 0), 0),
    completion_tokens = greatest(coalesce(p_completion_tokens, 0), 0),
    total_tokens = greatest(coalesce(p_total_tokens, 0), 0),
    topic = p_topic,
    status = v_status
  where id = p_reservation_id;

  insert into public.langclaw_usage_charges (
    reservation_id,
    wallet_user_id,
    wallet_address,
    model,
    prompt_tokens,
    completion_tokens,
    total_tokens,
    prompt_price_neuron,
    completion_price_neuron,
    reserved_neuron,
    charged_neuron,
    released_neuron,
    topic,
    status
  )
  values (
    p_reservation_id,
    v_reservation.wallet_user_id,
    v_reservation.wallet_address,
    v_reservation.model,
    greatest(coalesce(p_prompt_tokens, 0), 0),
    greatest(coalesce(p_completion_tokens, 0), 0),
    greatest(coalesce(p_total_tokens, 0), 0),
    v_reservation.prompt_price_neuron,
    v_reservation.completion_price_neuron,
    v_reservation.reserved_neuron,
    v_charge_neuron,
    v_release_neuron,
    p_topic,
    v_status
  );

  return query
  select
    v_status,
    v_charge_neuron,
    v_release_neuron,
    v_after;
end;
$$;
