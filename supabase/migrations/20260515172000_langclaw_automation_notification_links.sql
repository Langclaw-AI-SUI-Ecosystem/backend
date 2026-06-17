alter table public.langclaw_automation_settings
  add column if not exists notification_email_verified boolean not null default false,
  add column if not exists notification_email_pending text,
  add column if not exists notification_email_code_hash text,
  add column if not exists notification_email_expires_at timestamptz,
  add column if not exists notification_email_linked_at timestamptz,
  add column if not exists telegram_verified boolean not null default false,
  add column if not exists telegram_username text,
  add column if not exists telegram_link_code_hash text,
  add column if not exists telegram_link_expires_at timestamptz,
  add column if not exists telegram_linked_at timestamptz;

create index if not exists langclaw_automation_settings_email_code_idx
  on public.langclaw_automation_settings(notification_email_code_hash)
  where notification_email_code_hash is not null;

create index if not exists langclaw_automation_settings_telegram_code_idx
  on public.langclaw_automation_settings(telegram_link_code_hash)
  where telegram_link_code_hash is not null;
