alter table public.langclaw_automation_settings
  add column if not exists developer_mode_enabled boolean not null default false;
