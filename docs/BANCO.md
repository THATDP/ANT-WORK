# Banco de dados (Supabase / PostgreSQL)

O jogo usa **um banco Postgres** (Supabase) e o backend é o único cliente. Nenhum segredo do banco vai para o navegador: o frontend fala apenas com o servidor Node.

Arquivo da migração inicial: [`database/migrations/0001_init.sql`](../database/migrations/0001_init.sql).

## 1. Como aplicar

Opção A — pelo backend (recomendado):

```bash
export DATABASE_URL="postgresql://postgres.SEU_PROJETO:SENHA@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"
npm run migrate
```

O script `backend/scripts/migrate.js` lê os arquivos em ordem, aplica cada um numa transação e registra em `schema_migrations`. Ele usa um advisory lock, então duas instâncias no Render não migram ao mesmo tempo.

O backend também aplica migrações automaticamente no boot quando `AUTO_MIGRATE` não é `false`. Para desligar (por exemplo, se você migra pelo CI):

```env
AUTO_MIGRATE=false
```

Opção B — `psql`:

```bash
psql "$DATABASE_URL" -f database/migrations/0001_init.sql
```

## 2. Tabelas

| Tabela | Papel | Chave |
| --- | --- | --- |
| `schema_migrations` | versões aplicadas | `version` |
| `worlds` | identidade e relógio do mundo, clima em JSONB | `id` |
| `colonies` | colônia: nome, cor, rainha, estoque, moral, população, relações, território | `id` |
| `colony_members` | vínculo jogador ↔ colônia com cargo e contribuição | `(colony_id, session_id)` |
| `structures` | construções (tipo, setor, tile, HP, progresso) | `id` + unicidade por tile |
| `world_chunks` | estado dos nós de recurso por setor em JSONB | `(world_id, chunk_key)` |
| `world_events` | log de eventos importantes | `id` |
| `world_snapshots` | snapshots completos para auditoria/rollback | `id` |
| `players` | sessão, nome, colônia e estatísticas | `session_id` |

### Por que JSONB em algumas colunas

Os nós de recurso de um setor são centenas de pares `{id, amount, respawnAt}` que mudam o tempo todo. Guardar um registro por nó geraria dezenas de milhares de linhas e escritas constantes. Como o servidor carrega o setor inteiro de uma vez, um único JSONB por setor é mais barato e igualmente consistente. O mesmo vale para estoque e população (poucos campos, lidos juntos).

Estruturas, membros e colônias são relacionais porque são consultados, filtrados e crescem independentemente.

## 3. Índices

| Índice | Para quê |
| --- | --- |
| `idx_colonies_world` | listar colônias de um mundo |
| `idx_colonies_ai` | separar colônias selvagens das humanas |
| `idx_members_session` | descobrir a colônia de um jogador |
| `idx_structures_world` / `idx_structures_colony` | carregar o mundo e o painel da colônia |
| `idx_structures_chunk` | carregar construções por setor (AOI) |
| `idx_world_chunks_world` | boot do mundo |
| `idx_events_world_time` | feed de eventos recentes |
| `idx_snapshots_world_time` | recuperação/rollback |
| `idx_players_colony` | jogadores por colônia |

Restrições importantes:

- `structures_zone_unique (world_id, cx, cy, gx, gy)` — impede duas estruturas no mesmo tile, inclusive sob concorrência (a segunda inserção falha).
- `structures.id` é gerado pelo servidor e nunca reutilizado na mesma execução; no boot, `resetStructureSeq` avança além do maior id existente.

## 4. RLS (Row Level Security)

Todas as tabelas têm RLS **habilitado e sem policies**. Isso significa:

- a chave `service_role` (usada só pelo backend) ignora RLS e opera normalmente;
- qualquer chave pública/anon, mesmo que vaze, não lê nem escreve estado de jogo.

Nunca coloque `SUPABASE_SERVICE_ROLE_KEY` em variáveis `VITE_*`, no `index.html` ou em repositório. Ela existe apenas no ambiente do Render.

## 5. Estratégia de persistência

- **Intervalo**: `PERSIST_INTERVAL_MS` (padrão 30 s). O tick não espera o banco.
- **Lote**: colônias, membros, estruturas, chunks alterados, jogadores e eventos são gravados numa única passada.
- **Somente o que mudou**: setores são marcados como sujos (`markDirty`) e só são reescritos quando seus nós mudam.
- **Flush no shutdown**: SIGTERM/SIGINT salvam antes de encerrar (importante no Render, que envia SIGTERM).
- **Snapshots completos**: a cada 10 saves (≈5 min) um snapshot íntegro do mundo é gravado em `world_snapshots`, com rótulo (`auto`, `admin`, `pre-restart`).
- **Eventos**: apenas os marcados como importantes entram na fila e são gravados com tick e coordenadas.

## 6. Recuperação

| Cenário | O que acontece |
| --- | --- |
| Backend reinicia normalmente | Carrega mundo + colônias + membros + estruturas + chunks; jogadores reconectam com token em até 90 s. |
| Queda no meio de um save | Transação é atômica por tabela; o próximo save reescreve o estado. O mundo volta ao último commit consistente. |
| Corrupção de um snapshot | Use o snapshot anterior de `world_snapshots` (ou o arquivo em `backend/data/snapshots` se `PERSIST=file`). |
| Perda total do banco | O mundo pode ser regenerado pela semente (`WORLD_SEED`). Colônias e construções **não** são regeneráveis — faça backup. |
| Migração falha | `migrate.js` faz rollback do arquivo e aborta; nada fica pela metade. |

### Backup no Supabase

1. Plano free: `Database > Backups` mostra backups diários (retenção curta). Exporte manualmente antes de mudanças grandes:
   ```bash
   pg_dump "$DATABASE_URL" --no-owner --format=custom -f antlife-backup.dump
   ```
2. Restauração:
   ```bash
   pg_restore --clean --no-owner -d "$DATABASE_URL" antlife-backup.dump
   ```
3. Guarde o dump **fora** do repositório (nunca comite dados de produção).

## 7. Consultas úteis

```sql
-- colônias e população adulta (population é JSONB: soma dos papéis)
select id, name, is_ai, morale,
       coalesce((population->>'worker')::int,0) +
       coalesce((population->>'scout')::int,0) +
       coalesce((population->>'soldier')::int,0) as adultos
from colonies order by adultos desc;
```

```sql
-- últimas construções
select type, cx, cy, progress, hp, updated_at
from structures order by updated_at desc limit 20;

-- eventos recentes
select kind, text, tick, created_at
from world_events order by created_at desc limit 50;

-- quanto do mundo já foi alterado
select count(*) as setores_com_estado from world_chunks;
```

## 8. Custos e manutenção

- O volume cresce com **setores visitados** (um JSONB por setor), não com o tempo.
- `world_events` e `world_snapshots` crescem com o tempo. Rotina sugerida (mensal):
  ```sql
  delete from world_events where created_at < now() - interval '90 days';
  delete from world_snapshots where created_at < now() - interval '30 days' and label = 'auto';
  ```
- `vacuum analyze` semanal resolve bloat de JSONB reescrito com frequência.

## 9. Desenvolvimento sem Supabase

`PERSIST=file` grava snapshots em `backend/data/snapshots` (ignorado pelo Git). `PERSIST=memory` não grava nada — use em testes e demonstrações. Nenhum dos dois exige `DATABASE_URL`.
