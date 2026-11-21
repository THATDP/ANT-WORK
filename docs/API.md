# API e protocolo de rede

O backend expõe HTTP para saúde, métricas e dados públicos, e Socket.IO para o jogo. Todos os nomes de constantes ficam em [`shared/constants.js`](../shared/constants.js) (`MSG`, `NET`).

## 1. HTTP

Base local: `http://localhost:8080`. Em produção: a URL do serviço no Render.

### `GET /health`

Verificação de vida usada pelo Render e pelo painel.

```json
{
  "ok": true,
  "version": "1.0.0",
  "uptimeS": 123,
  "world": {
    "tick": 4521, "uptimeS": 452, "tickMsAvg": 0.42, "tickMsPeak": 9.8,
    "ants": 212, "antsDetailed": 120, "predators": 14,
    "players": { "total": 3, "alive": 3, "carrying": 4 },
    "colonies": 5, "structures": 37, "chunks": 96,
    "weather": "clear", "night": false, "aiThinks": 15321
  },
  "store": { "mode": "postgres", "ok": true, "lastSaveAt": "…" },
  "memory": { "rssMb": 210, "heapMb": 84 },
  "limits": { "players": 120, "detailedAnts": 420, "ants": 2600, "predators": 90 }
}
```

Responde 503 se o armazenamento estiver degradado (o processo continua vivo).

### `GET /metrics`

Texto Prometheus:

```
ant_life_ticks_total 4521
ant_life_tick_ms_avg 0.42
ant_life_tick_ms_peak 9.8
ant_life_ants 212
ant_life_ants_detailed 120
ant_life_predators 14
ant_life_players 3
ant_life_colonies 5
ant_life_structures 37
ant_life_chunks_loaded 96
ant_life_snapshot_bytes 912345
ant_life_ai_thinks_total 15321
ant_life_population_total 289
```

### `GET /api/config`

Parâmetros públicos do mundo (não revela segredos):

```json
{ "worldId": "ant-life-1", "seed": 20261121, "tickHz": 10, "worldChunks": 48, "chunkPx": 768, "snapshotHz": 10 }
```

### `GET /api/world`

Métricas + ambiente + colônias + eventos recentes. Usado pelo menu para mostrar jogadores/colônias/população.

### `GET /api/colonies`

Lista pública de colônias (nome, cor, população, membros, ninho, moral). Colônias de IA aparecem como `isAi: true`.

### `POST /admin/save` e `POST /admin/snapshot`

Forçam um save imediato / um snapshot completo do mundo. Exigem header `x-admin-token: $ADMIN_TOKEN`.

```bash
curl -X POST https://seu-servico.onrender.com/admin/save -H "x-admin-token: SEU_TOKEN"
curl -X POST https://seu-servico.onrender.com/admin/snapshot -H "x-admin-token: SEU_TOKEN"
```

## 2. Socket.IO

```js
import { io } from 'socket.io-client';
const socket = io('https://seu-servico.onrender.com', { transports: ['websocket', 'polling'] });
```

Em desenvolvimento, o Vite faz proxy de `/socket.io`; o cliente pode usar a própria origem.

### Cliente → servidor

| Evento (`MSG`) | Payload | Observações |
| --- | --- | --- |
| `hello` | `{ name, token?, colonyId? }` | Primeiro evento. `token` reconecta à sessão anterior (90 s). Resposta: `welcome` ou `error`. |
| `input` | `{ vx, vy, seq }` | Vetor normalizado, 15 Hz. O servidor limita a 40/s e ignora valores inválidos. |
| `act` | `{ action: {...} }` | Ações do jogo (abaixo). Limite de 12 tokens com recarga. |
| `chat` | `{ text, channel }` | `channel`: `global` ou `colony`. 20/min, 1,5 s entre mensagens, 160 caracteres. |
| `colony` | `{ op, ... }` | `create`, `join`, `leave`, `rename`, `role`, `kick`, `war`. |
| `settings` | `{ aoiRadius }` | Raio de AOI 1–3 (padrão 2). |
| `ping` | `{ t }` | Resposta `pong` com o mesmo `t`. |

#### Ações (`act.action.type`)

| Tipo | Campos | Validação principal |
| --- | --- | --- |
| `gather` | `nodeId?` | distância ≤ 46 px, nó com recurso, carga ≤ 8 |
| `deposit` | — | colônia, carga > 0, perto do ninho (110 px) ou depósito (90 px) |
| `build` | `building, cx?, cy?, gx?, gy?` | permissão, custo, setor do jogador/vizinho, água/rocha/ocupação, 6 setores do ninho |
| `work` | `id` | obra/reparo da própria colônia, distância ≤ 90 px |
| `demolish` | `id` | permissão `demolish`, dono da estrutura |
| `attack` | `kind, id` | alvo a ≤ 52 px, cooldown 600 ms, 6 de dano |
| `eat` | — | no ninho (120 px) ou consumindo a própria carga |
| `respawn` | — | apenas se morto |

### Servidor → cliente

| Evento (`MSG`) | Payload | Quando |
| --- | --- | --- |
| `welcome` | `{ token, sessionId, selfId, name, world, spawn, colony, colonies, events, limits }` | Após `hello`. `colony` é resumido (`id, name, color, role`); o estado completo vem em `state`. |
| `snap` | `{ t, self, add?, up?, rm?, padd?, pup?, prm?, pl?, st?, strm?, nd?, env? }` | 10 Hz (5 Hz/3,3 Hz com muita gente). Só diferenças do AOI. |
| `state` | `{ colony, nearby, threats }` | 2 Hz com o resumo da colônia (estoque, população, obras, membros, permissões). |
| `players` | `[{ id, name, colony, color, hp, dist, x, y }]` | 0,5 Hz (poucos jogadores por perto). |
| `colonies` | `[{ id, name, color, isAi, pop, members, structures, nest, open }]` | Ao fundar/entrar/sair/renomear. |
| `notice` | `{ kind, text }` ou `{ kind: 'ok', action, data }` ou `{ kind: 'colony', op, colony? }` | Resultado de ações, erros, morte, respawn e operações de colônia. |
| `event` | `{ k, t, x, y, i? }` | Eventos de mundo (clima, ataques, obras, mortes, guerra). |
| `chat` | `{ from, text, channel, at, colony?, system? }` | Mensagens de chat. |
| `pong` | `{ t, server, tick }` | Resposta ao ping (latência no cliente). |
| `error` | `{ error }` | Falha de handshake, servidor cheio, operação inválida. |
| `kick` | `{ reason }` | Sessão aberta em outra aba ou removida da colônia. |

### Formatos compactos

- **Formiga** (`add`): `[id, x, y, role, task, hp, state, carryKind, carryAmount, flags]`.
- **Atualização** (`up`): `[id, x, y, state, ...]` repetido (4 valores por formiga).
- **Predador** (`padd`): `[id, x, y, tipo, hp, state]`; `pup`: `[id, x, y, state, hp]`.
- **Estrutura** (`st`): `[id, cx, cy, gx, gy, type, colonyId, hp, progress, wx, wy]`.
- **Nós** (`nd`): `[[chunkKey, revisão, [id, x, y, kind, amount, max, ...]]]`.
- **Self**: `[x, y, hp, fome, sede, carryKind, carryAmount, vivo, respawnAt, colonyId, dir]`.
- **Ambiente** (`env`): `[dia, parte, clima, temperatura, noite, fase]`.
- **Jogador** (`pl`): `[id, x, y, nome, colonyId, hp, carryKind, cor]`.

Coordenadas são quantizadas em 0,25 px. O cliente interpola e corrige suavemente a posição local.

## 3. Exemplo mínimo (Node)

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:8080', { transports: ['websocket'] });
socket.on('connect', () => socket.emit('hello', { name: 'Exploradora' }));
socket.on('welcome', (w) => console.log('entrei', w.world, w.spawn));
socket.on('snap', (p) => {
  const [x, y, hp] = p.self;
  if (hp < 40) socket.emit('act', { action: { type: 'eat' } });
});
socket.on('notice', (n) => n.kind === 'error' && console.log('erro:', n.text));
```

## 4. Erros comuns

| Mensagem | Significado |
| --- | --- |
| `Nome inválido (2 a 20 caracteres)` | Nome fora do padrão ou com caracteres bloqueados. |
| `Servidor cheio no momento` | `maxPlayers` atingido (120 por padrão). |
| `Ações muito rápidas` | Balde de ações esgotado. |
| `Você está morto — aguarde o respawn` | Ação enviada antes do respawn. |
| `Longe do recurso` | Distância > 46 px do nó. |
| `Sem permissão de construção` | Cargo sem `build` ou jogador sem colônia. |
| `Longe do local da obra` | Setor clicado a mais de 1 setor do jogador. |
| `Sessão aberta em outra aba` | Token duplicado — a aba antiga recebe `kick`. |
