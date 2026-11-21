# ANT LIFE

**Um simulador multiplayer de uma civilização de formigas em um mundo vivo.**

Você é uma formiga num ecossistema compartilhado e persistente: coleta folhas, sementes, frutas, insetos, água e materiais; escava túneis e câmaras; alimenta larvas; defende a colônia de besouros, aranhas, vespas, lagartos e formigas-leão. Enquanto você joga, centenas de formigas de IA trabalham, exploram, patrulham e disputam território com regras próprias — e o que você constrói fica salvo.

O projeto é um monorepo com quatro pastas (exigência do projeto):

```
frontend/   Phaser 3 + Vite + HTML/CSS (cliente)
backend/    Node.js + Express + Socket.IO (simulação autoritativa)
database/   migrações SQL para Supabase/PostgreSQL
docs/       documentação em português (arquitetura, limites, deploy, testes)
shared/     constantes, protocolo e geração procedural usados pelos dois lados
```

> **GitHub Pages não roda Node.js.** O cliente estático vai para o GitHub Pages; o servidor autoritativo vai para o Render. Passo a passo em [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## O que está implementado

- **Mundo grande e determinístico** — 48 × 48 setores de 768 px (36.864 × 36.864 px), gerado por semente. O terreno é recalculado localmente pelo cliente (nada de tiles pela rede); só as mudanças persistentes viajam.
- **Câmera top-down** com seguir, zoom por scroll, minimapa e mapa grande.
- **Colônias compartilhadas** — fundação, entrada e saída, cargos (fundador, oficial, membro), permissões anti-griefing, estoque comum, moral, rainha, ovos, larvas e obras cooperativas.
- **IA de verdade** — operárias, exploradoras, guerreiras, rainhas e larvas com tarefas priorizadas (coletar, transportar, construir, cuidar, reparar, explorar, patrulhar, defender, atacar, recuar, alimentar) e pensamento em intervalos, nunca por frame.
- **LOD de simulação** — formigas perto de jogadores são simuladas passo a passo; longe, produzem e consomem por estatística (inclusive obras), sem travar o servidor.
- **Recursos com utilidade real** — comida, água, material e esporos entram no estoque e são consumidos por fome, sede, crias, obras e fungicultura. Nada duplica: `harvest`/`addStock`/`spend` são atômicos.
- **Construção espacial** — túnel, câmara, depósito, berçário, sala de alimentação, área de defesa, entrada alternativa, torre de vigia, jardim de fungos e câmara da rainha, com custo, ocupação de tiles, limite de 6 setores do ninho e progresso cooperativo.
- **Ciclo de vida** — ovos → larvas → adultas, fome, sede, cura, morte, carcaças que viram comida e sucessão da rainha.
- **Biomas, clima e tempo** — floresta, jardim, campo, rocha, solo úmido, água, subterrâneo e área contaminada; chuva, tempestade, neblina e calor; ciclo dia/noite e eventos de mundo (florescimento, seca, migração, contaminação, melada, ventania).
- **Predadores com comportamentos distintos** — caçar formigas isoladas, atacar trilhas, invadir colônia, roubar carga, atacar larvas e recuar quando a defesa cresce.
- **Multiplayer autoritativo** — movimento por vetor de intenção, snapshots por área de interesse (AOI), interpolação no cliente, reconexão por token de até 90 s, chat global e de colônia.
- **UI completa em pt-BR** — tela de carregamento, menu, seleção/criação de colônia, HUD (estoque, vitais, população, ameaças, dicas), inventário, mapa, menu de construção, painel da colônia, lista de jogadores, configurações, ajuda, créditos e sons procedurais.
- **Deploy pronto** — GitHub Actions (CI + Pages), `render.yaml`, migrações SQL, health check, métricas Prometheus e CORS por variável de ambiente.

## Começando a jogar (local)

Requisitos: **Node.js 20+** (testado no 22) e npm.

```bash
git clone https://github.com/SEU-USUARIO/ANT-WORK.git
cd ANT-WORK
npm install          # instala backend + frontend (workspaces)
npm run dev          # backend em :8080 e Vite em :5173
```

Abra **http://localhost:5173**, escolha um nome e entre. O Vite faz proxy de `/socket.io`, `/api` e `/health` para o backend, então não há CORS no meio do caminho.

Para subir separado:

```bash
npm run dev:backend
npm run dev:frontend
```

O backend salva o mundo em `backend/data/snapshots` por padrão (`PERSIST=file`). Para começar do zero, apague essa pasta. Para usar Supabase, veja [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Controles

| Ação | Tecla / mouse |
| --- | --- |
| Mover | `W A S D` ou setas (ou clique no chão, ou joystick no celular) |
| Coletar | `E` (segure para repetir) |
| Entregar no ninho/depósito | `F` |
| Comer/beber | `R` |
| Atacar | `Espaço` ou clique no alvo |
| Construir | `B` (catálogo) → clique no chão; `Esc`/botão direito cancela |
| Mapa grande | `M` |
| Colônia | `K` |
| Jogadores | `Tab` |
| Chat | `Enter` (globais e de colônia) |
| Menu/configurações | `Esc` |
| Zoom | scroll do mouse |

Detalhes de jogo, cargos e construções em [`docs/COMO-JOGAR.md`](docs/COMO-JOGAR.md).

## Testes e números medidos

```bash
npm test                       # 55 testes do backend (node:test), ~7 s
node backend/scripts/sim.js --minutes=10 --bots=4
node backend/scripts/loadtest.js --players=60 --seconds=30
```

- Suíte: **55 testes, 55 passam** (mundo, economia, construção, IA, persistência e rede).
- Simulação de 10 min com 4 jogadores-bot: tick médio **0,46 ms**, p95 **1,0 ms**, 189 formigas, 55 estruturas.
- Carga com **60 clientes reais via Socket.IO**: CPU **57%**, tick médio **1,6 ms**, **~37 KB/s por cliente**, RTT p95 **37 ms** (mesma máquina).
- Teto testado: **100 clientes** no mesmo processo, CPU ~88% e latência degradada.

Números completos, metodologia e o que eles **não** provam: [`docs/LIMITES.md`](docs/LIMITES.md).

## Arquitetura em uma tela

```
cliente (Phaser)                    servidor (Node)                      banco
─────────────────                   ────────────────                    ─────
input 15 Hz (vx,vy)  ───────────▶   PlayersSystem (autoridade)
ações (gather/deposit/              World.step() 10 Hz
 build/attack/colony)  ─────────▶    ├─ IA (pensamento escalonado)
                                    ├─ economia/fome/crias
snapshots AOI    ◀───────────────   ├─ construção/defesa
 (add/up/rm, estruturas,            ├─ predadores/clima/eventos
  nós por setor, self)              └─ LOD por distância
estado da colônia ◀──────────────   InterestManager (AOI 5×5 setores)
                                    PersistenceManager (30 s)  ─────▶  Supabase
                                    snapshots + eventos                (Postgres)
```

Separação de responsabilidades: estado persistente (`game/`), simulação, rede (`net/`), persistência (`persist/`) e apresentação (`frontend/src`). O cliente **nunca** decide estoque, posição, construção, combate ou população.

Leia mais em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md), os eventos de rede em [`docs/API.md`](docs/API.md) e o banco em [`docs/BANCO.md`](docs/BANCO.md).

## Deploy resumido

1. **Supabase** — crie o projeto, copie a `DATABASE_URL` (pooler, porta 6543).
2. **Render** — New → Blueprint → este repositório; preencha `DATABASE_URL` e `CORS_ORIGIN` com a URL do Pages.
3. **GitHub Pages** — Settings → Pages → Source: GitHub Actions; crie a variável `VITE_SERVER_URL` com a URL do Render; rode o workflow “Publicar frontend no GitHub Pages”.
4. **Confira** — `https://SEU-SERVICO.onrender.com/health` deve responder `{"ok":true,...}`.

Cada passo, com o que colar e o que verificar, está em [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [`docs/COMO-JOGAR.md`](docs/COMO-JOGAR.md) | controles, recursos, construções, predadores, colônia e dicas |
| [`docs/PROJETO.md`](docs/PROJETO.md) | requisitos → implementação → evidência, decisões e o que ficou de fora |
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | tick, LOD, AOI, autoridade, IA, economia, persistência e segurança |
| [`docs/API.md`](docs/API.md) | endpoints HTTP e todos os eventos Socket.IO |
| [`docs/BANCO.md`](docs/BANCO.md) | tabelas, índices, RLS, migrações, backup e consultas |
| [`docs/LIMITES.md`](docs/LIMITES.md) | números medidos de simulação e carga, capacidade e o que não foi provado |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Supabase → Render → GitHub Pages, passo a passo |
| [`docs/TESTES.md`](docs/TESTES.md) | os 55 testes, o que cobrem e como reproduzir |

## Estrutura detalhada

```
backend/
  src/index.js              entrada (HTTP + Socket.IO + tick)
  src/config.js             env e limites
  src/game/world.js         simulação autoritativa e composição dos sistemas
  src/game/colony.js        colônia, estoque, permissões, diretoria de IA
  src/game/{ant,player,players}.js
  src/game/ai/brain.js      prioridades e tarefas
  src/game/{economy,build,defence,combat,predators,events,sense,chunk}.js
  src/net/{server,aoi}.js   Socket.IO, snapshots por AOI, chat
  src/persist/*             memória, arquivo, Postgres, gerenciador
  scripts/{sim,loadtest,migrate}.js
  test/*.test.js            55 testes
frontend/
  index.html                marcação pt-BR de todas as telas
  src/main.js               bootstrap, menus, rede, joystick
  src/state.js              estado do cliente e eventos (bus)
  src/net/client.js         Socket.IO, 15 Hz, reconexão
  src/game/art/textures.js  arte procedural (formigas, predadores, estruturas)
  src/game/render/*         terreno por setor em cache + mapa de biomas
  src/game/scenes/WorldScene.js
  src/ui/{hud,panels}.js    HUD e painéis
  src/audio.js              sons/ambiente procedurais (WebAudio)
database/migrations/0001_init.sql
docs/                     documentação em português (este índice)
shared/
scripts/dev.mjs
.github/workflows/{ci,deploy-pages}.yml
render.yaml
```

## Decisões que valem saber

- **Sem CDNs e sem fontes externas** — a arte é desenhada em canvas no boot e os sons são sintetizados; o jogo funciona offline (na rede local) e em previews restritos.
- **Determinismo do terreno** — `shared/worldgen.js` é importado pelos dois lados; a mesma semente gera o mesmo solo, rios e recursos iniciais.
- **Não transmitimos a população de IA inteira** — o AOI assina 5 × 5 setores ao redor do jogador e envia só o que mudou.
- **Não salvamos posições de formigas a cada tick** — o snapshot periódico guarda o estado agregado; jogadores são restaurados pelo token de sessão.
- **Limites honestos** — os números de [`docs/LIMITES.md`](docs/LIMITES.md) saíram de execuções reais neste ambiente, não de estimativas de marketing.

## Licença

Código e arte procedurais deste repositório são de uso livre para estudo e portfólio. Se for publicar uma instância pública, configure seu próprio Supabase, Render e variáveis de ambiente — não reutilize credenciais de terceiros.
