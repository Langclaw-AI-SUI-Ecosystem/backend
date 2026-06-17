create table if not exists public.langclaw_automation_notifications (
  id uuid primary key default gen_random_uuid(),
  wallet_user_id uuid not null references public.langclaw_wallet_users(id) on delete cascade,
  task_id uuid references public.langclaw_automation_tasks(id) on delete set null,
  run_id uuid references public.langclaw_automation_runs(id) on delete set null,
  title text not null,
  body text not null,
  status text not null default 'unread'
    check (status in ('unread', 'read')),
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint langclaw_automation_notifications_title_not_blank
    check (length(trim(title)) > 0),
  constraint langclaw_automation_notifications_body_not_blank
    check (length(trim(body)) > 0)
);

create index if not exists langclaw_automation_notifications_wallet_created_idx
  on public.langclaw_automation_notifications(wallet_user_id, created_at desc);

create index if not exists langclaw_automation_notifications_wallet_status_idx
  on public.langclaw_automation_notifications(wallet_user_id, status, created_at desc);

alter table public.langclaw_automation_notifications enable row level security;

drop policy if exists "Langclaw deny direct automation notifications access"
  on public.langclaw_automation_notifications;
create policy "Langclaw deny direct automation notifications access"
  on public.langclaw_automation_notifications
  for all
  to anon, authenticated
  using (false)
  with check (false);
