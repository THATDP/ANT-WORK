# Requisitos atendidos

Este documento liga cada exigência do projeto ao que existe no repositório e à evidência de funcionamento. Se algo não foi implementado, está dito aqui — não escondido.

## 1. Requisitos obrigatórios

| Exigência | Como foi atendida | Evidência |
| --- | --- | --- |
| Quatro pastas: `frontend`, `backend`, `database`, `docs` | Estrutura na raiz (mais `shared/` e `scripts/`, por necessidade técnica) | `ls` na raiz |
| Jogo de formigas funcional | Simulação autoritativa + Phaser com coleta, construção, defesa e colônia | `npm run dev`, jogar no navegador |
| Mundo grande e contínuo | 48 × 48 setores de 768 px = 36.864 × 36.864 px, sem telas de carregamento entre regiões | `shared/constants.js`, câmera e minimapa |
| Geração procedural determinística | `shared/worldgen.js` com semente (elevação, umidade, rios, biomas, cavernas, recursos) | 7 testes em `worldgen.test.js` |
| Câmera top-down | Segue o jogador, zoom por scroll, mapa grande com `M` | `WorldScene.js`, `Minimap.js`, `BigMap.js` |
| Colônias compartilhadas | Fundar/entrar, cargos, permissões, estoque comum, território | `colony.js`, `net.test.js` (dois jogadores na mesma colônia) |
| Formigas trabalhando | Operárias, exploradoras, guerreiras, rainha e larvas com tarefas priorizadas | `ai/brain.js`, 12 testes em `ai.test.js` |
| Coleta de recursos | Folhas, sementes, frutas, insetos, água, materiais, esporos | `economy.js`, `handleAction('gather')` |
| Construção do ninho | Túnel, câmara, depósito, berçário, alimentação, defesa, entrada, torre, jardim, câmara da rainha | `build.js`, 10 testes em `build.test.js` |
| Ciclo de vida | Ovos → larvas → adultas; fome, sede, cura, morte, carcaça, sucessão | `economy.test.js` (ciclo e fome) |
| IA com prioridades e comportamentos | 14 tarefas com pontuação por contexto e papel | `ai.test.js` |
| Predadores distintos | Besouro, aranha, vespa, cupim, lagarto, formiga-leão | `predators.js`, cenários em `ai.test.js` |
| Clima e dia/noite | Chuva, tempestade, neblina, calor; ciclo de 6 min | `events.js`, `env` nos snapshots |
| Persistência | Supabase/Postgres, arquivo ou memória; save a cada 30 s e no shutdown | `persist/`, `persistence.test.js` |
| Multiplayer / rede | Socket.IO autoritativo, snapshots por AOI, reconexão por token | `net.test.js` |
| HUD completa | Estoque, vitais, população, ameaças, dicas, painéis, minimapa | `frontend/index.html`, `src/ui/` |
| Instruções | README em português + docs de jogo, arquitetura, banco, API, deploy | este diretório `docs/` |
| Deploy online | GitHub Actions + Pages, Render, Supabase | `render.yaml`, `.github/workflows/` |
| Funcionar sem dependências externas | Arte procedural, som sintetizado, sem CDN | `textures.js`, `audio.js` |
| Desempenho | Alvo: 120 jogadores e centenas de formigas | limites reais em [`LIMITES.md`](LIMITES.md) (recomendado: 50–60 por instância) |

## 2. Requisitos de jogo

### Formigas e colônia

- **Papéis**: rainha, operária, exploradora, guerreira e larva. Cada papel tem velocidade, vida, dano, raio de percepção e tarefas possíveis.
- **Tarefas**: ociosidade, coleta, transporte, construção, reparo, cuidado, alimentação, exploração, patrulha, defesa, ataque, recuo e fuga. A escolha é reavaliada em intervalos, com pontuação por necessidade, distância e risco.
- **Prioridade**: sobrevivência (fuga/combate) > entrega de carga > fome/sede > larvas > obras > coleta > exploração.
- **Trilhas de feromônio**: operárias depositam feromônio ao coletar; o gradiente atrai outras e decai com o tempo.

### Colônias

- Estoque comum, moral, rainha, ovos, população e obras.
- Cargos fundador/oficial/membro com permissões explícitas; guerra entre colônias altera relações.
- Colônias de IA nascem com o mundo, expandem, constroem e defendem.
- Território: raio de 460 px do ninho e limite de 6 setores para construir.

### Construções

Cada uma tem custo, tamanho, ocupação de tiles, efeito e pré-requisitos espaciais. Progresso é cooperativo (até 3 formigas, jogador contribui mais). Demolir devolve 40% e exige permissão. Reparo consome material.

### Mundo

- Biomas com recursos e riscos próprios, água intransponível com rios e lagos.
- Nós de recurso regeneram e esgotam; clima afeta água, comida e visão.
- Eventos (florescimento, seca, migração, contaminação, melada, ventania) afetam o mundo e o log.
- Cavernas/subterrâneo com materiais e esporos.

### Rede e persistência

- Handshake com token, spawn seguro e resumo do mundo.
- AOI 5 × 5 setores, diffs de posição, snapshots completos periódicos.
- Reconexão por 90 s preservando colônia e posição.
- Save periódico em lote, sem bloquear o tick; restauração completa no boot.

### Interface

Tela de carregamento com dicas, menu, lista/criação de colônias, HUD com estoque e vitais, inventário, catálogo de construção, panel da colônia, lista de jogadores, chat, mapa grande, configurações, ajuda, créditos e controles de toque.

### Desempenho

Medido: 25 jogadores com CPU ~29%, 60 com ~57% e tick ~1,6 ms. Acima disso, ver [`LIMITES.md`](LIMITES.md) — a promessa honesta é **50–60 jogadores por instância neste hardware**, não 120.

## 3. Requisitos técnicos

| Requisito | Situação |
| --- | --- |
| Servidor autoritativo (anti-cheat básico) | Sim: posição, estoque, dano, construção e permissões só no servidor |
| Interest management (AOI) | Sim, 5 × 5 setores, configurável 1–3 |
| Sincronização de estado | Diffs a 10 Hz, snapshots completos a 2 Hz (espaçados sob carga) |
| Reconexão | Token de sessão de 90 s + retomada no cliente |
| Salvamento periódico | 30 s + flush no shutdown + snapshots completos |
| Recuperação | Boot restaura colônias, membros, estruturas, estoque e recursos |
| Carregamento por região | Setores gerados sob demanda e cacheados no cliente |
| Combate predador ↔ formiga | Sim, com espécies, estados, dano e recuo |
| IA não custa caro | Pensamentos escalonados + LOD abstrato |
| Depuração de desempenho | `sim.js`, `/metrics`, `world.debugStats()` |
| Documentação | `docs/` completa |

## 4. Requisitos visuais

- **Arte top-down coerente**: formigas desenhadas por papel, predadores com silhueta distinta, estruturas com progresso e dano visíveis.
- **Paleta natural**: floresta, campo, rocha, água, solo; iluminação de dia/noite e clima.
- **Animações**: caminhada, carregar, atacar, construir, morrer; interpolação de rede suave.
- **Feedback**: toasts, flash de dano, barras de vida, partículas, som de coleta/construção/alerta.
- **UI sem depender de imagens externas**: tudo desenhado em canvas ou CSS.

## 5. O que está incompleto ou simplificado

Assumido de forma explícita:

- **Arte procedural** em vez de sprites artesanais: funcional e leve, mas mais simples que um jogo comercial.
- **Sem áudio gravado**: sons sintetizados (WebAudio) para não depender de arquivos externos.
- **Sem login/OAuth**: sessão anônima por token; trocar de navegador perde a identidade (a colônia permanece).
- **Sem editor de mapas**: o mundo vem da semente.
- **Sem servidor de matchmaking**: um processo = um mundo.
- **Sem testes de navegador**: validado por build e contrato de rede (veja [`TESTES.md`](TESTES.md)).
- **`migrate.js` e `render.yaml` não foram executados contra a infraestrutura real** neste ambiente; o primeiro deploy é a validação.
- **120 jogadores simultâneos** não foi atingido com folga: o teto medido confortável é 50–60 por instância. Dizer o contrário seria vender fumaça.

## 6. Decisões de engenharia

| Decisão | Motivo |
| --- | --- |
| Terreno no cliente + semente compartilhada | Economiza banda e permite mundo enorme |
| Simulação a 10 Hz, render a 60 Hz com interpolação | Percepção fluida com custo de rede baixo |
| JSON quantizado por AOI | Simples de depurar; compactação binária é a próxima alavanca |
| JSONB para nós de recurso | Milhares de valores pequenos por setor, lidos juntos |
| Colônias e estruturas relacionais | Consultas, filtros, unicidade por tile e crescimento independente |
| IA escalonada + LOD estatístico | Mantém o tick abaixo de 3 ms com centenas de formigas |
| Persistência em lote e assíncrona | Save nunca trava o jogo |
| Arte e som procedurais | Sem CDN, funciona offline e em previews restritos |
| Docs em português | Público e avaliadores do projeto |

## 7. Próximos passos possíveis

1. Compactar snapshots (msgpack/ArrayBuffer) — maior ganho de banda.
2. Playwright para testar o cliente de ponta a ponta.
3. Contas persistentes (e-mail/OAuth) e perfis.
4. Múltiplos mundos por processo com roteamento por `WORLD_ID`.
5. Balanceamento de água por bioma (colônias isoladas ainda podem sofrer sede).
6. Editor de colônia (mover/remover câmaras) e fila de obras.
7. Testes de 24 h e monitoramento com Prometheus/Grafana.
