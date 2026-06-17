create extension if not exists pgcrypto with schema extensions;

update public.langclaw_automation_tasks
set
  webhook_slug = concat(
    regexp_replace(webhook_slug, '-[a-f0-9]{8}$', ''),
    '-',
    encode(extensions.gen_random_bytes(16), 'hex')
  ),
  updated_at = now()
where
  trigger_type = 'webhook'
  and webhook_slug is not null
  and webhook_slug ~ '-[a-f0-9]{8}$';
