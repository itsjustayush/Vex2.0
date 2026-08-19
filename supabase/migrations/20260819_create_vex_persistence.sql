create table if not exists public.vex_pages (
  id text not null,
  user_id text not null,
  title text not null default 'Untitled page',
  content text not null default '',
  page_type text not null default 'ruled-single',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (user_id, id)
);

create index if not exists vex_pages_user_updated_idx
  on public.vex_pages (user_id, updated_at desc);

create table if not exists public.vex_boards (
  id text not null,
  user_id text not null,
  title text not null default 'Moodboard',
  item_count integer not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (user_id, id)
);

create index if not exists vex_boards_user_updated_idx
  on public.vex_boards (user_id, updated_at desc);

create table if not exists public.vex_board_items (
  id text not null,
  user_id text not null,
  board_id text not null,
  item_type text not null default 'note',
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id, board_id, id),
  constraint vex_board_items_board_fk
    foreign key (user_id, board_id)
    references public.vex_boards (user_id, id)
    on delete cascade
);

create index if not exists vex_board_items_user_board_idx
  on public.vex_board_items (user_id, board_id);

create table if not exists public.vex_settings (
  user_id text primary key,
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.vex_typing_stats (
  user_id text primary key,
  stats jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.vex_pages enable row level security;
alter table public.vex_boards enable row level security;
alter table public.vex_board_items enable row level security;
alter table public.vex_settings enable row level security;
alter table public.vex_typing_stats enable row level security;

-- Vex currently accesses these tables only through the Firebase-verified Flask bridge.
-- The bridge uses the Supabase service-role key server-side and applies an explicit
-- user_id filter after verifying the Firebase ID token. No browser client receives
-- the service-role key.
