-- Manual, closed paper-option trades for Option Signal Desk.
-- No broker order, PCC portfolio execution, or real cash balance is written here.
begin;

create table if not exists public.option_desk_demo_trades (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  contract_label text not null check (length(btrim(contract_label)) between 1 and 80),
  underlying_symbol text not null check (underlying_symbol ~ '^[A-Z][A-Z0-9.-]{0,9}$'),
  option_side text not null check (option_side in ('call', 'put')),
  contracts integer not null check (contracts between 1 and 100000),
  buy_total numeric(18, 2) not null check (buy_total between 0 and 1000000000000),
  sell_total numeric(18, 2) not null check (sell_total between 0 and 1000000000000),
  fees_total numeric(18, 2) not null default 0 check (fees_total between 0 and 1000000000000),
  opened_at timestamptz not null,
  closed_at timestamptz not null check (closed_at >= opened_at),
  followed_signal boolean not null default false,
  signal_tier text check (signal_tier in ('early', 'aligned', 'self_reported')),
  notes text not null default '' check (length(notes) <= 500),
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists option_desk_demo_trades_owner_closed_idx
  on public.option_desk_demo_trades (user_id, closed_at desc)
  where voided_at is null;

alter table public.option_desk_demo_trades enable row level security;
revoke all on public.option_desk_demo_trades from anon, authenticated;
grant select, insert, update on public.option_desk_demo_trades to authenticated;

drop policy if exists option_desk_demo_select_own on public.option_desk_demo_trades;
create policy option_desk_demo_select_own on public.option_desk_demo_trades
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists option_desk_demo_insert_own on public.option_desk_demo_trades;
create policy option_desk_demo_insert_own on public.option_desk_demo_trades
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists option_desk_demo_update_own on public.option_desk_demo_trades;
create policy option_desk_demo_update_own on public.option_desk_demo_trades
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

commit;
