# Arquitetura do ANT LIFE

Este documento explica como o mundo funciona por dentro: quem manda, o que é simulado, o que viaja pela rede e o que é gravado no banco.

## 1. Visão geral

```
┌──────────────────────────────┐         ┌────────────────────────────────────┐
│ Cliente (navegador)          │         │ Servidor (Node, 1 processo/mundo)  │
│ Phaser 3 + Vite              │         │ Express + Socket.IO                │
│                              │         │                                    │
│ WorldScene                   │         │ World.step() @ 10 Hz               │
│  ├─ terreno determinístico   │         │  ├─ PlayersSystem (autoridade)     │
│  ├─ interpolação de snapshots│         │  ├─ tickAnts (LOD)                 │
│  ├─ predição local do self   │  ws     │  ├─ PredatorsSystem                │
│  ├─ construção (ghost)       │◀───────▶│  ├─ Defence/Combat/Military        │
│  └─ minimapa/mapa            │         │  ├─ Economy (fome, crias, moral)   │
│ HUD e painéis (DOM)          │         │  ├─ ColonyDirector (IA de colônia) │
│ NetClient (15 Hz de input)   │         │  └─ Events/Env (clima, dia/noite)  │
└──────────────────────────────┘         │ InterestManager (AOI 5×5 setores)  │
                                         │ PersistenceManager (30 s)          │
                                         └───────────────┬────────────────────┘
                                                         │ SQL em lote
                                                 ┌───────▼────────┐
                                                 │ Supabase       │
                                                 │ PostgreSQL     │
                                                 └────────────────┘
```

Princípios:

1. **O servidor é a única fonte de verdade** para posição, vida, inventário, estoque, população, construções e combate.
2. **O cliente envia intenção**, nunca resultado: vetor de movimento, `gather`, `deposit`, `build`, `attack`, `colony`.
3. **A rede transmite diferenças por área de interesse**, não o mundo inteiro.
4. **Cada sistema é um módulo** com uma responsabilidade; `World` compõe e orquestra.
5. **Persistência é assíncrona e em lote**; o tick nunca espera o banco.

## 2. Estrutura de pastas e papéis

### `shared/`

- `constants.js` — números do mundo (tile 32, setor 768, 48×48 setores, 10 Hz), recursos, papéis, tarefas, construções, permissões, limites, clima, mensagens de rede.
- `util-noise.js` — ruído determinístico (hash, value noise, fBm, RNG).
- `worldgen.js` — terreno por semente: elevação, umidade, rios, bioma, cavernas, nós de recurso e decoração por setor.
- `protocol.js` — empacotadores/desempacotadores curtos usados pela rede.

O cliente importa esses arquivos via alias `@shared`; o backend importa por caminho relativo. Não há cópia de lógica: o mesmo código gera o mesmo mundo dos dois lados.

### `backend/src/game/`

| Arquivo | Responsabilidade |
| --- | --- |
| `world.js` | Composição, `step()`, LOD, índices espaciais, ações do jogador, spawn, serialização do mundo. |
| `chunk.js` | Setor: máscara de água, nós de recurso, feromônios, estruturas, `canPlace`. |
| `colony.js` | Estoque/capacidade, moral, membros, permissões, rainha, território, relações e `ColonyDirector`. |
| `ant.js` | Formiga: papel, tarefas, carga, fome, trabalho, dano, morte, `describe()` para debug. |
| `player.js` / `players.js` | Jogador humano: movimento autoritativo, fome/sede, morte, respawn, tokens de sessão. |
| `ai/brain.js` | Prioridades e escolha de tarefa por papel, com saturação de tarefas. |
| `sense.js` | Consultas espaciais: recursos, ameaças, aliados, obras, larvas, estruturas estrangeiras. |
| `economy.js` | Coleta atômica, regeneração de nós, fome/sede, ovos/larvas, moral, produção abstrata. |
| `build.js` | Validação espacial, custos, progresso cooperativo, reparo, demolição, `aiTryBuild`. |
| `predators.js` | Espécies, estados (patrulha, caça, ataque, recuo), alvos e spawn. |
| `defence.js` | Alarmes, ameaças e `MilitarySystem` (raides e coordenação de guerra). |
| `combat.js` | Dano, abates e resolução de combate corpo a corpo. |
| `events.js` | Clima, ciclo dia/noite, eventos de mundo e log de eventos. |

### `backend/src/net/`

- `server.js` — HTTP (health, métricas, API pública, admin), Socket.IO, validação de `hello`, rate limiting, chat, operações de colônia e laço de snapshots.
- `aoi.js` — `InterestManager`: monta snapshots por jogador, rastreia entidades já enviadas por socket, revisões de setor e estruturas.

### `backend/src/persist/`

- `store.js` — fábrica: escolhe `memory`, `file` ou `postgres` conforme `PERSIST`.
- `memory.js` — snapshot em memória (testes e demo).
- `file.js` — snapshots JSON em disco (desenvolvimento).
- `postgres.js` — pool, migrações idempotentes, escrita em lote (colônias, membros, estruturas, chunks, eventos, jogadores, mundo).
- `manager.js` — periodicidade, retentativas, flush no shutdown e gravação de eventos importantes.

## 3. O tick

`World.step()` roda a 10 Hz (`TICK_HZ`), com correção de deriva e descarte de atraso:

```
tick
 ├─ env.tick / worldEvents.tick + efeitos contínuos
 ├─ players.update            (fome, sede, cura, respawn)
 ├─ updatePlayersMovement     (aplica vetores de intenção)
 ├─ tickAnts                  (somente formigas dentro do LOD 0/1)
 ├─ predators.tick
 ├─ defence.update / military.update
 ├─ a cada 10 ticks: economy.step(1) + ColonyDirector.think()
 ├─ a cada 25 ticks: evaporação de feromônio + limpeza de estruturas
 ├─ updateIndexes (a cada 3 ticks)
 └─ gc a cada 200 ticks
```

Intervalos são o mecanismo central de escala: nada de varredura por frame. O laço usa `setInterval` de 10 ms e executa no máximo 3 passos por disparo para não acumular atraso.

## 4. LOD (nível de detalhe)

`World.updateLOD()` roda a cada 10 ticks e calcula a distância de cada formiga ao jogador mais próximo:

| Faixa | Detalhe | Simulação | Pensamento |
| --- | --- | --- | --- |
| < 1.150 px | 0 | movimento, tarefa e combate passo a passo | a cada 3–6 ticks |
| < 2.600 px | 1 | tarefa a cada 2 ticks (alternado) | a cada 10–16 ticks |
| ≥ 2.600 px | 2 | estatística (produção/consumo/obras) | nenhuma |

Detalhe 2 não move a formiga; ela “trabalha” via `abstractTick`, que distribui produção conforme o déficit de cada recurso, consome comida/água no ninho, avança obras e pode sofrer desgaste. O teto de formigas detalhadas é `MAX_DETAILED_ANTS` (420 por padrão) — acima disso, as mais distantes caem para abstrato.

Consequência importante: **nenhuma formiga de IA fora do AOI consome rede**, e mesmo dentro dele só viajam posições que mudaram.

## 5. Área de interesse (AOI)

`InterestManager.aoiChunks()` assina os setores num raio de 2 (5 × 5 setores = 3.840 × 3.840 px) ao redor do jogador. Cada socket guarda:

- `ents`: id → último pacote de formiga enviado;
- `preds`, `players`, `structures`: idem;
- `chunkRev`: revisão de recursos por setor.

### O que vai em cada snapshot

| Campo | Conteúdo | Frequência |
| --- | --- | --- |
| `t` | tick do servidor | sempre |
| `self` | `[x, y, hp, fome, sede, kind, qtd, vivo, respawnAt, colonyId, dir]` | sempre |
| `add` / `up` / `rm` | formigas novas / posições alteradas / saídas | 10 Hz (só mudanças) |
| `padd` / `pup` / `prm` | predadores | 10 Hz (só mudanças) |
| `pl` | jogadores próximos (poucos, completos) | quando há |
| `st` / `strm` | estruturas alteradas / removidas | no snapshot “full” |
| `nd` | nós por setor, apenas quando a revisão muda | no snapshot “full” |
| `env` | dia, parte do dia, clima, temperatura, noite, fase | no snapshot “full” |
| `state` | resumo da colônia + vizinhas | 2 Hz |
| `players` | lista de jogadores online | 0,5 Hz |

A cada 5º snapshot é enviado o modo “full” (estruturas, nós, ambiente). Com mais de 60 jogadores, o intervalo entre snapshots cresce (degradação graciosa) em vez de estourar a banda.

Posições são quantizadas em 0,25 px (`QUANT`) e o cliente interpola — nada de posições absolutas a 60 Hz.

## 6. Autoridade e validação

Toda ação chega em `world.handleAction(player, action)`:

- **gather** — valida existência do nó, distância ≤ 46 px, estoque do nó, capacidade e tipo único de carga; consome do nó e credita no jogador atomicamente.
- **deposit** — exige colônia, carga > 0, proximidade do ninho (110 px) ou depósito (90 px); aceita o que cabe e informa perdas.
- **build** — exige colônia, permissão `build`, custo no estoque, setor do jogador ou vizinho, regras espaciais (sem água, rocha, ocupação, território alheio, 6 setores do ninho, limite de estruturas).
- **work** — ajuda obra/reparo da própria colônia, exige proximidade e permissão.
- **attack** — alvo a ≤ 72 px, dano do papel, cooldown, crédito de abate.
- **eat** — consome do estoque se houver.
- **respawn** — apenas se morto.

Rate limits por socket: input 15 Hz efetivo, ações com cooldown (`actionCooldownMs`), chat 20/min com 1,5 s entre mensagens, operações de colônia limitadas por balde de fichas. Nomes e chat passam por sanitização e limite de tamanho.

## 7. IA

Cada formiga detalhada pensa em intervalos (nunca por frame) e escolhe a **tarefa de maior prioridade**:

1. ameaça imediata → lutar (guerreira ou força suficiente) ou fugir;
2. carga nas costas → entregar;
3. fome/sede perto do ninho → comer/beber;
4. larvas precisando de cuidado → cuidar (com saturação);
5. obra pendente → construir (até 3 formigas);
6. estrutura danificada → reparar;
7. recurso necessário no raio de 620 px (900 para exploradoras) → coletar;
8. gradiente de feromônio → seguir trilha;
9. caso contrário → explorar.

A escolha de recurso respeita **reservas**: material e esporo têm teto; água e comida têm prioridade quando o estoque está baixo. `ColonyDirector` decide, a cada 1,2–2,2 s, o próximo passo da colônia: construir (até 3 obras em andamento), expandir depósitos conforme a população, raides quando há hostilidade e postura de ovos quando há excedente.

Nada é aleatório sem motivo: o “vaguear” só acontece quando explorar é a tarefa de maior valor esperado.

## 8. Ciclo de vida e economia

- **Ovos** são postos pela rainha se moral > 35, comida > população × 1,6, ovos abaixo do teto (berçário/câmara da rainha) e população abaixo do limite.
- **Larvas** desenvolvem em 55 s (mais rápido com cuidado e berçário) e se tornam adultas no papel desejado pela colônia.
- **Fome/sede** sobem continuamente; formigas detalhadas comem/ bebem no ninho; abstratas consomem estatisticamente. Fome > 85 ou sede > 90 causa dano.
- **Morte** gera carcaça comestível (alguns minutos de vida) e reduz moral/população.
- **Sucessão** — com Câmara da Rainha e uma larva madura, a colônia coroa uma nova rainha; sem isso, fica sem postura.

Todos os fluxos passam por `harvest`, `addStock`, `spend`, `takeFood`, `takeWater`: operações atômicas que nunca deixam o estoque negativo nem duplicam recursos. Os testes cobrem concorrência (5 sockets na mesma obra, duas pessoas no mesmo nó).

## 9. Clima, tempo e eventos

`EnvSystem` avança dia/noite (6 min por dia), temperatura e clima; `regenRate` dos nós depende do clima (chuva/storm recarregam água, calor seca). Eventos de mundo (florescimento, seca, migração, contaminação, melada, ventania) alteram recursos, predadores ou moral e entram no log e nos snapshots.

## 10. Persistência e recuperação

- O mundo é salvo a cada `PERSIST_INTERVAL_MS` (30 s) e no shutdown.
- `PERSIST=auto` usa Postgres se `DATABASE_URL` existir; senão arquivo; em testes, memória.
- Estruturas e membros são relacionais; o estado dos nós de recurso é agregado por setor em JSONB; eventos importantes vão para `world_events`; snapshots completos periódicos para auditoria/recuperação.
- No boot, o servidor carrega mundo, colônias, membros, estruturas e recursos, recria a rainha se faltar e reconstrói as formigas a partir da população serializada.
- Jogadores não têm posição salva a cada tick: o token de sessão (90 s) restaura colônia e posição ao reconectar; jogadores offline não são recriados.

## 11. Segurança

- **Segredos só no backend**: `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `ADMIN_TOKEN` nunca são embutidos no bundle do frontend. O cliente recebe apenas a URL pública do servidor.
- **CORS** controlado por `CORS_ORIGIN` (lista separada por vírgula).
- **RLS** habilitado nas tabelas do Supabase para que a chave anônima não leia/escreva dados de jogo.
- **Admin** (`POST /admin/save`) exige o header `x-admin-token`.
- **Anti-cheat básico**: nada de confiar em posição, estoque ou resultado enviados pelo cliente; o servidor revalida distância, permissão, custo, cooldown e ocupação.

## 12. Limitações conhecidas

- Um processo = um mundo. Escalar horizontalmente exige um processo por `WORLD_ID` e roteamento sticky (o estado é local ao processo).
- O AOI tem 5 × 5 setores; jogadores muito espalhados não se veem (é intencional).
- A produção abstrata é estatística: não há caminhos individuais de formigas distantes.
- O terreno é determinístico e imutável; escavação altera estruturas, não tiles.
- Os números de carga estão em [`LIMITES.md`](LIMITES.md) e valem para este hardware — Render, latência e banda mudam o resultado.
