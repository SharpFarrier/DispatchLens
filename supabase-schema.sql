-- DispatchLens Schema
-- Run this in Supabase SQL Editor

-- Sessions table
create table if not exists dispatch_sessions (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references auth.users(id),
  session_date date not null default current_date,
  label text not null default '',
  is_eod_done boolean not null default false,
  total_orders int not null default 0,
  dispatched_count int not null default 0,
  held_count int not null default 0,
  unfulfillable_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Orders table
create table if not exists dispatch_orders (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references dispatch_sessions(id) on delete cascade,
  order_id text not null,
  order_date date,
  dispatch_by_date date,
  customer_name text not null default '',
  qty int not null default 1,
  courier text not null,
  tracking_number text,
  sku text not null default '',
  raw_status text not null default '',
  promise_date date,
  pincode text not null default '',
  city text,
  state text,
  oda text,
  transit_days int not null default 7,
  days_left int,
  urgency text,
  is_cancelled boolean not null default false,
  is_dispatched boolean not null default false,
  is_priority boolean not null default false,
  plan_decision text not null default 'undecided',
  dispatched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for fast session lookups
create index if not exists idx_dispatch_orders_session on dispatch_orders(session_id);
create index if not exists idx_dispatch_orders_plan on dispatch_orders(session_id, plan_decision);
create index if not exists idx_dispatch_sessions_date on dispatch_sessions(session_date desc);

-- RLS
alter table dispatch_sessions enable row level security;
alter table dispatch_orders enable row level security;

-- Policy: authenticated users can do everything
create policy "auth_all_sessions" on dispatch_sessions
  for all using (auth.role() = 'authenticated');

create policy "auth_all_orders" on dispatch_orders
  for all using (auth.role() = 'authenticated');

-- Updated_at trigger
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger sessions_updated_at
  before update on dispatch_sessions
  for each row execute function update_updated_at();

create trigger orders_updated_at
  before update on dispatch_orders
  for each row execute function update_updated_at();
