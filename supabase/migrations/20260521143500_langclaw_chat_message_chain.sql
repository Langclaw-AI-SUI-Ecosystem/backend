alter table public.langclaw_chat_messages
  add column if not exists chain text
    check (chain in ('mantle', 'celo'));

create index if not exists langclaw_chat_messages_chain_idx
  on public.langclaw_chat_messages(wallet_user_id, chain, created_at desc);
