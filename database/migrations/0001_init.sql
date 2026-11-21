-- ============================================================================
-- ANT LIFE · esquema inicial do banco (Supabase / PostgreSQL)
-- Aplicado automaticamente pelo backend (npm --workspace backend run migrate)
-- ou por `psql "$DATABASE_URL" -f database/migrations/0001_init.sql`.
-- ============================================================================

create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- mundo
create table if not exists worlds (
  id          text primary key,
  seed        bigint      not null,
  tick        bigint      not null default 0,
  env         jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- colônias
create table if not exists colonies (
  id              text primary key,
  world_id        text not null references worlds(id) on delete cascade,
  name            text not null,
  color           integer not null,
  is_ai           boolean not null default false,
  founder_session text,
  nest_x          double precision not null,
  nest_y          double precision not null,
  stock           jsonb not null default '{}'::jsonb,
  morale          double precision not null default 60,
  population      jsonb not null default '{}'::jsonb,
  stats           jsonb not null default '{}'::jsonb,
  territory       jsonb not null default '[]'::jsonb,
  relations       jsonb not null default '[]'::jsonb,
  queen_dead      boolean not null default false,
  created_at      bigint not null,
  updated_at      timestamptz not null default now()
);

create table if not exists colony_members (
  colony_id    text not null references colonies(id) on delete cascade,
  session_id   text not null,
  name         text not null,
  role         text not null default 'member',
  contribution bigint not null default 0,
  joined_at    timestamptz not null default now(),
  primary key (colony_id, session_id)
);

-- ---------------------------------------------------------------- construções
create table if not exists structures (
  id          bigint primary key,
  world_id    text not null references worlds(id) on delete cascade,
  colony_id   text not null references colonies(id) on delete cascade,
  type        smallint not null,
  cx          smallint not null,
  cy          smallint not null,
  gx          smallint not null,
  gy          smallint not null,
  hp          integer not null default 10,
  progress    integer not null default 0,
  built_at    bigint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint structures_chunk_unique unique (id),
  constraint structures_zone_unique unique (world_id, cx, cy, gx, gy)
);

-- ---------------------------------------------------------------- estado de regiões
-- Um registro por chunk que teve alteração de recursos. JSONB evita dezenas de
-- milhares de linhas quando o mundo é muito explorado.
create table if not exists world_chunks (
  world_id   text not null references worlds(id) on delete cascade,
  chunk_key  text not null,
  nodes      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (world_id, chunk_key)
);

-- ---------------------------------------------------------------- eventos / snapshots
create table if not exists world_events (
  id         bigserial primary key,
  world_id   text not null references worlds(id) on delete cascade,
  kind       text not null,
  text       text not null,
  x          double precision not null default 0,
  y          double precision not null default 0,
  tick       bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists world_snapshots (
  id         bigserial primary key,
  world_id   text not null references worlds(id) on delete cascade,
  label      text not null default 'auto',
  data       jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- jogadores
create table if not exists players (
  session_id  text primary key,
  name        text not null,
  colony_id   text,
  stats       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

-- ---------------------------------------------------------------- índices
create index if not exists idx_colonies_world          on colonies (world_id);
create index if not exists idx_colonies_ai             on colonies (world_id, is_ai);
create index if not exists idx_members_session         on colony_members (session_id);
create index if not exists idx_structures_world        on structures (world_id);
create index if not exists idx_structures_colony       on structures (colony_id);
create index if not exists idx_structures_chunk        on structures (world_id, cx, cy);
create index if not exists idx_world_chunks_world      on world_chunks (world_id);
create index if not exists idx_events_world_time       on world_events (world_id, created_at desc);
create index if not exists idx_snapshots_world_time    on world_snapshots (world_id, created_at desc);
create index if not exists idx_players_colony          on players (colony_id);

-- ---------------------------------------------------------------- RLS
-- O backend usa a service_role (que ignora RLS). Habilitar RLS impede que a
-- chave anônima (se algum dia for usada) leia/escreva estado do jogo direto.
alter table worlds         enable row level security;
alter table colonies       enable row level security;
alter table colony_members enable row level security;
alter table structures     enable row level security;
alter table world_chunks   enable row level security;
alter table world_events   enable row level security;
alter table world_snapshots enable row level security;
alter table players        enable row level security;
-- Nenhuma policy é criada de propósito: somente service_role acessa.
