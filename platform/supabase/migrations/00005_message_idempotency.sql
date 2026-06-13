-- ============================================================================
-- Migration 00005: idempotency key on agent_messages
--
-- Adds client_message_id so callers can pass a stable UUID with each request.
-- ON CONFLICT DO NOTHING on that column makes chat/plan inserts idempotent —
-- a network retry that re-sends the same client_message_id is a no-op.
-- ============================================================================

alter table public.agent_messages
  add column if not exists client_message_id text;

create unique index if not exists idx_messages_client_id
  on public.agent_messages (client_message_id)
  where client_message_id is not null;
