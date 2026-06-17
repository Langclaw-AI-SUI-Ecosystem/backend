alter table public.langclaw_automation_settings
  add column if not exists notification_channels text[] not null default array['email']::text[],
  add column if not exists notification_email text,
  add column if not exists telegram_chat_id text;

alter table public.langclaw_automation_settings
  drop constraint if exists langclaw_automation_settings_channels_allowed;

alter table public.langclaw_automation_settings
  add constraint langclaw_automation_settings_channels_allowed
    check (notification_channels <@ array['email', 'telegram', 'in-app']::text[]);
