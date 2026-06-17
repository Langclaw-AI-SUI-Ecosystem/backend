alter table public.langclaw_chat_messages
  add column if not exists mode text
    check (mode in ('chat', 'research', 'onchain')),
  add column if not exists model text,
  add column if not exists onchain_result jsonb;
