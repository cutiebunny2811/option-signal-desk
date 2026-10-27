create table if not exists public.option_desk_monitor_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  symbols text[] not null default '{}',
  asset_types jsonb not null default '{}'::jsonb,
  enabled boolean not null default false,
  pause_until timestamptz,
  last_test_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint option_desk_symbols_count check (cardinality(symbols) <= 10)
);
alter table public.option_desk_monitor_settings add column if not exists pause_until timestamptz;

create table if not exists public.option_desk_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists option_desk_push_by_user on public.option_desk_push_subscriptions(user_id);

create table if not exists public.option_desk_monitor_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  direction text not null default 'wait' check (direction in ('up','down','wait')),
  tier text not null default 'wait' check (tier in ('aligned','early','wait')),
  fresh boolean not null default false,
  price numeric,
  as_of bigint not null default 0,
  checked_at timestamptz,
  next_scan_at timestamptz not null default now(),
  last_error text,
  primary key (user_id, symbol)
);
create index if not exists option_desk_monitor_due on public.option_desk_monitor_state(next_scan_at);

create table if not exists public.option_desk_monitor_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  direction text not null check (direction in ('up','down')),
  tier text not null check (tier in ('aligned','early')),
  as_of bigint not null,
  created_at timestamptz not null default now(),
  unique (user_id,symbol,direction,as_of)
);
create index if not exists option_desk_events_by_user on public.option_desk_monitor_events(user_id,created_at desc);

alter table public.option_desk_monitor_settings enable row level security;
alter table public.option_desk_push_subscriptions enable row level security;
alter table public.option_desk_monitor_state enable row level security;
alter table public.option_desk_monitor_events enable row level security;

revoke all on public.option_desk_monitor_settings, public.option_desk_push_subscriptions, public.option_desk_monitor_state, public.option_desk_monitor_events from anon;
grant select, insert, update on public.option_desk_monitor_settings to authenticated;
grant select, insert, update, delete on public.option_desk_push_subscriptions to authenticated;
grant select on public.option_desk_monitor_state, public.option_desk_monitor_events to authenticated;

drop policy if exists option_desk_settings_own on public.option_desk_monitor_settings;
create policy option_desk_settings_own on public.option_desk_monitor_settings for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists option_desk_subscriptions_own on public.option_desk_push_subscriptions;
create policy option_desk_subscriptions_own on public.option_desk_push_subscriptions for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists option_desk_state_own on public.option_desk_monitor_state;
create policy option_desk_state_own on public.option_desk_monitor_state for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists option_desk_events_own on public.option_desk_monitor_events;
create policy option_desk_events_own on public.option_desk_monitor_events for select to authenticated using (user_id = (select auth.uid()));

-- Keep the active server scan set in sync with the user's focus list.
create or replace function public.option_desk_sync_monitor_symbols()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.option_desk_monitor_state
    where user_id = new.user_id and not (symbol = any(new.symbols));
  insert into public.option_desk_monitor_state(user_id,symbol)
    select new.user_id, item from unnest(new.symbols) as item
    on conflict (user_id,symbol) do nothing;
  return new;
end;
$$;
revoke all on function public.option_desk_sync_monitor_symbols() from public, anon, authenticated;
drop trigger if exists option_desk_sync_monitor_symbols on public.option_desk_monitor_settings;
create trigger option_desk_sync_monitor_symbols after insert or update of symbols on public.option_desk_monitor_settings
for each row execute function public.option_desk_sync_monitor_symbols();
