# Testes e como reproduzir

A suíte usa o runner nativo do Node (`node:test`), sem dependências extras de teste. Roda em ~7 segundos e não precisa de Supabase nem de navegador.

```bash
cd backend
node --test --test-concurrency=1 test/*.test.js
# ou
npm test         # na raiz do repositório
```

Resultado atual: **55 testes, 55 passam, 0 falham** (~6,5 s).

> `--test-concurrency=1` é intencional: os testes de rede sobem servidores em portas aleatórias e compartilham diretórios temporários; rodar em paralelo gera flakiness de infraestrutura, não de lógica. Não afrouxe asserções para “resolver” flakiness.

## 1. O que cada arquivo cobre

### `test/worldgen.test.js` (7)

- determinismo do mundo por semente;
- setores reprodutíveis e ids de recurso únicos;
- cobertura de biomas e água coerente com rios/lagos;
- nomes de setores estáveis (`Floresta Cinzenta`, etc.);
- cavernas existentes mas não onipresentes;
- elevação em [0,1] e bioma do centro do setor;
- todos os tipos de recurso alcançáveis.

### `test/economy.test.js` (12)

- estoque nunca ultrapassa a capacidade; `addStock` aceita só o que cabe;
- `spend` atômico (tudo ou nada);
- **coleta concorrente** do mesmo nó não duplica recurso;
- cliente não declara quantidade: o servidor decide;
- coleta bloqueada por distância;
- depósito exige proximidade e respeita o limite;
- depósito aumenta capacidade em +250;
- fome leva a morte e gera carcaça comestível;
- consumo nunca deixa estoque negativo;
- ciclo de vida ovos → larvas → adultas;
- economia abstrata (LOD 2) mantém a colônia viva;
- recursos regeneram com o tempo.

### `test/build.test.js` (10)

- custo debitado na construção e reembolso na demolição;
- estruturas não se sobrepõem nem saem do setor;
- água bloqueia construção;
- limite de 6 setores do ninho;
- permissão: membro não demole, fundador demole;
- jogador sem colônia não constrói;
- progresso cooperativo conclui a obra;
- não se constrói no ninho de outra colônia;
- limite de estruturas por colônia;
- IA constrói sozinha dentro do território.

### `test/ai.test.js` (12)

- operária faminta não fica ociosa;
- operária com carga prioriza entrega;
- soldado enfrenta predador quando a força permite;
- operária sozinha foge;
- predador recua diante de resistência;
- vespa prefere larvas;
- cupim ataca estruturas;
- formiga-leão fica emboscada (não persegue);
- pensamentos escalonados (não milhares por tick);
- LOD abstrato para formigas distantes;
- descoberta compartilhada via sensoriamento;
- feromônio decai e atrai operárias.

### `test/persistence.test.js` (5)

- **reinício do backend** preserva colônias, estruturas e estoque;
- estado dos nós de recurso sobrevive ao reinício;
- snapshot completo permite voltar no tempo;
- eventos importantes são registrados;
- falha de persistência não derruba a simulação.

### `test/net.test.js` (9, servidor HTTP/Socket.IO real)

- handshake entrega token, mundo, spawn, colônias e limites;
- **dois jogadores compartilham a mesma colônia e se veem**;
- **construções simultâneas no mesmo tile**: 5 sockets → 1 estrutura, custo debitado uma vez;
- **reconexão com token** preserva colônia e nome;
- **AOI**: snapshots não carregam o mundo inteiro (média < 20 KB e sem formigas distantes);
- servidor autoritativo: input absurdo não teletransporta; água bloqueia;
- rate limit barra spam de ações;
- chat sanitizado e distribuído para a colônia;
- `/health` e `/metrics` respondem com dados reais.

## 2. Cobertura dos critérios de aceitação

| Critério pedido | Onde é testado |
| --- | --- |
| Entrada no multiplayer | `net`: handshake |
| Colônias compartilhadas | `net`: dois jogadores na mesma colônia |
| Construção simultânea | `net`: 5 sockets no mesmo tile |
| Coleta concorrente | `economy`: duas pessoas no mesmo nó |
| Sincronização de recursos | `economy` + `net` (depósito/estoque) |
| IA (tarefas, prioridades, LOD) | `ai` (12) |
| Predadores (comportamentos distintos) | `ai`: 6 cenários |
| Reconexão | `net`: token preserva sessão |
| Salvamento | `persistence`: reinício + eventos |
| Recuperação após reinício | `persistence`: mundo restaurado |
| Carregamento por região | `worldgen` + `net`: AOI |
| Desempenho por contagem de entidades | `ai`: pensamentos escalonados; números em `LIMITES.md` |

Não há teste automatizado de navegador: o cliente é validado por build (`vite build`), pelo contrato de rede exercitado em `net.test.js` e por inspeção manual no preview. Se quiser adicionar Playwright, o caminho natural é um teste que sobe backend + Vite e verifica o canvas e os elementos da HUD.

## 3. Convenções dos testes

`test/helpers.js` exporta:

- `makeWorld(overrides)` — mundo com store em memória e log silencioso;
- `advance(world, ticks)` — avança a simulação sem tempo real;
- `startServer(world, overrides)` — sobe HTTP + Socket.IO em porta aleatória;
- `wait(ms)` / `waitFor(fn, timeout)` — utilidades assíncronas;
- `TEST_SEED = 777001`.

Sempre que um teste precisar de um lugar para construir, use `chunk.canPlace(seed, gx, gy, size, type)` em vez de fixar coordenadas: o ninho ocupa células e o bioma varia com a semente.

## 4. Testes que já falharam (e por quê)

| Sintoma | Causa | Correção definitiva |
| --- | --- | --- |
| `Cannot find module .../test/` | `node --test test/` não aceita diretório nessa versão | usar `test/*.test.js` |
| Tick de 14 s | array compartilhado no `sense` gerava O(n²) | buffers reutilizados por consulta |
| Snapshots com estado vivo | store/serialize devolviam referências | cópias profundas em `memory.saveSnapshot` e `Colony.serialize()` |
| “Espaço ocupado” em teste de construção | ninho ocupa tiles | varredura com `canPlace` |
| Teste de ciclo de vida instável | predadores matavam larvas | `world.maxPredators = 0` + morte forçada |
| Jogador “Fundador” fantasma | `createPlayerColony` adicionava membro sozinho | membro é adicionado na camada de rede |
| `spawn` de predador retornava `null` em alguns sorteios | o ponto do teste caía em água (bioma depende da semente) | helper `spawnNear` procura terra seca e fixa a posição pedida |

## 5. Scripts de medição

```bash
node scripts/sim.js --minutes=10 --bots=4        # simulação acelerada
node scripts/sim.js --minutes=5 --json           # saída JSON
node scripts/loadtest.js --players=60 --seconds=30
node scripts/migrate.js                          # aplica migrações no Supabase
```

Resultados e interpretação em [`LIMITES.md`](LIMITES.md).
