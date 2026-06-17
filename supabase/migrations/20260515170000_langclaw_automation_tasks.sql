create table if not exists public.langclaw_automation_settings (
  wallet_user_id uuid primary key references public.langclaw_wallet_users(id) on delete cascade,
  retry_policy text not null default '3-attempts'
    check (retry_policy in ('none', '3-attempts', '5-attempts')),
  failure_notification text not null default 'email'
    check (failure_notification in ('email', 'in-app', 'none')),
  auto_pause_repeated_failures boolean not null default true,
  write_run_logs_to_memory boolean not null default false,
  daily_limit_neuron numeric(78, 0) not null default 25000000000000000000,
  monthly_cap_neuron numeric(78, 0) not null default 500000000000000000000,
  limit_behavior text not null default 'pause'
    check (limit_behavior in ('pause', 'alert', 'allow')),
  low_balance_threshold_neuron numeric(78, 0) not null default 10000000000000000000,
  threshold_action text not null default 'notify'
    check (threshold_action in ('notify', 'pause', 'continue')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint langclaw_automation_settings_daily_limit_nonnegative
    check (daily_limit_neuron >= 0),
  constraint langclaw_automation_settings_monthly_cap_nonnegative
    check (monthly_cap_neuron >= 0),
  constraint langclaw_automation_settings_low_balance_nonnegative
    check (low_balance_threshold_neuron >= 0)
);

create table if not exists public.langclaw_automation_tasks (
  id uuid primary key default gen_random_uuid(),
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  name text not null,
  project text not null default 'Langclaw Website',
  prompt text,
  model text,
  trigger_type text not null default 'schedule'
    check (trigger_type in ('schedule', 'event', 'webhook')),
  schedule_frequency text
    check (schedule_frequency in ('daily', 'weekly', 'monthly')),
  schedule_time text not null default '09:00',
  schedule_weekday integer check (schedule_weekday between 0 and 6),
  schedule_month_day integer check (schedule_month_day between 1 and 31),
  timezone text not null default 'Asia/Jakarta',
  event_name text,
  webhook_slug text unique,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'archived')),
  last_run_at timestamptz,
  last_run_status text
    check (last_run_status in ('queued', 'running', 'completed', 'failed', 'skipped', 'canceled')),
  next_run_at timestamptz,
  consecutive_failures integer not null default 0,
  max_retries integer not null default 3,
  failure_threshold integer not null default 5,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint langclaw_automation_tasks_name_not_blank
    check (length(trim(name)) > 0),
  constraint langclaw_automation_tasks_schedule_time_format
    check (schedule_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  constraint langclaw_automation_tasks_failures_nonnegative
    check (consecutive_failures >= 0),
  constraint langclaw_automation_tasks_retries_nonnegative
    check (max_retries >= 0),
  constraint langclaw_automation_tasks_failure_threshold_positive
    check (failure_threshold > 0)
);

create table if not exists public.langclaw_automation_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.langclaw_automation_tasks(id) on delete cascade,
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'skipped', 'canceled')),
  triggered_by text not null default 'manual'
    check (triggered_by in ('schedule', 'event', 'webhook', 'manual', 'system')),
  attempt integer not null default 1,
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  error text,
  result jsonb,
  usage jsonb,
  created_at timestamptz not null default now(),
  constraint langclaw_automation_runs_attempt_positive
    check (attempt > 0),
  constraint langclaw_automation_runs_duration_nonnegative
    check (duration_ms is null or duration_ms >= 0)
);

create index if not exists langclaw_automation_tasks_wallet_updated_idx
  on public.langclaw_automation_tasks(wallet_user_id, updated_at desc);

create index if not exists langclaw_automation_tasks_due_idx
  on public.langclaw_automation_tasks(status, next_run_at)
  where status = 'active' and next_run_at is not null;

create index if not exists langclaw_automation_tasks_webhook_slug_idx
  on public.langclaw_automation_tasks(webhook_slug)
  where webhook_slug is not null;

create index if not exists langclaw_automation_runs_task_created_idx
  on public.langclaw_automation_runs(task_id, created_at desc);

create index if not exists langclaw_automation_runs_wallet_created_idx
  on public.langclaw_automation_runs(wallet_user_id, created_at desc);

create index if not exists langclaw_automation_runs_status_created_idx
  on public.langclaw_automation_runs(status, created_at desc);

drop trigger if exists langclaw_automation_settings_touch_updated_at
  on public.langclaw_automation_settings;

create trigger langclaw_automation_settings_touch_updated_at
before update on public.langclaw_automation_settings
for each row execute function public.langclaw_touch_updated_at();

drop trigger if exists langclaw_automation_tasks_touch_updated_at
  on public.langclaw_automation_tasks;

create trigger langclaw_automation_tasks_touch_updated_at
before update on public.langclaw_automation_tasks
for each row execute function public.langclaw_touch_updated_at();

alter table public.langclaw_automation_settings enable row level security;
alter table public.langclaw_automation_tasks enable row level security;
alter table public.langclaw_automation_runs enable row level security;

drop policy if exists "Langclaw deny direct automation settings access"
  on public.langclaw_automation_settings;
create policy "Langclaw deny direct automation settings access"
  on public.langclaw_automation_settings
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Langclaw deny direct automation tasks access"
  on public.langclaw_automation_tasks;
create policy "Langclaw deny direct automation tasks access"
  on public.langclaw_automation_tasks
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "Langclaw deny direct automation runs access"
  on public.langclaw_automation_runs;
create policy "Langclaw deny direct automation runs access"
  on public.langclaw_automation_runs
  for all
  to anon, authenticated
  using (false)
  with check (false);
