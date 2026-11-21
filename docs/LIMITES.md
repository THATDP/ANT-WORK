# Limites medidos (e o que eles significam)

Este documento existe para não prometer o que não foi testado. Todos os números abaixo saíram de execuções reais neste ambiente, com os scripts do próprio repositório. Não são estimativas.

## Ambiente de medição

| Item | Valor |
| --- | --- |
| CPU | 2 vCPU Intel Xeon @ 2,60 GHz (container compartilhado) |
| Memória | 3,9 GB |
| Node.js | v22.22.3 |
| npm | 10.9.8 |
| Mundo | seed `20261121`, 48 × 48 setores (36.864 px) |
| Data | 21/11/2026 |

O ambiente é compartilhado: números variam entre execuções (especialmente os picos e a latência dos clientes sintéticos, que rodam no **mesmo processo** do servidor).

## 1. Simulação pura (sem rede)

`node backend/scripts/sim.js --minutes=10 --bots=4`

| Métrica | Valor |
| --- | --- |
| Tempo de parede | 2,88 s para 6.000 ticks (≈2.084 ticks/s reais) |
| Tick médio | **0,46 ms** |
| Tick p95 / p99 / máximo | 1,00 / 2,08 / 12,3 ms |
| Formigas vivas | 189 (145 detalhadas) |
| Predadores | 67 |
| Colônias / estruturas | 7 / 55 |
| Memória RSS | 82 MB |

`node backend/scripts/sim.js --minutes=60 --bots=0 --colonies=4` (envelhecimento de 1 hora simulada)

| Métrica | Valor |
| --- | --- |
| Tick médio | **0,037 ms** |
| Tick p95 / p99 / máximo | 0,084 / 0,214 / 9,3 ms |
| Formigas vivas | 260 (todas em LOD abstrato) |
| Estruturas | 111 |
| Moral das colônias | 98–100 |
| Memória RSS | 77 MB |

**Leitura:** um mundo com centenas de formigas e ~100 estruturas custa menos de 0,5 ms por tick (o orçamento é 100 ms). A simulação não é o gargalo.

## 2. Carga de rede (clientes Socket.IO reais)

`node backend/scripts/loadtest.js --players=N --seconds=S`

Cada cliente de carga entra, anda, coleta, entrega, constrói, conversa e envia ping. Um deles cai e reconecta com token no meio do teste.

| Jogadores | Tick médio | Tick pico | CPU | Snapshots/s | Payload médio | Banda/cliente | Banda total | RTT p50 / p95 | RSS | Reconexão |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (medido à parte) | — | — | — | 10 | 656 B | ~6,7 KB/s | 0,01 MB/s | — | — | — |
| 25 | 1,55 ms | 13,2 ms | 29% | 269 | 1,60 KB | 21,3 KB/s | 0,41 MB/s | 4 / 25 ms | 168 MB | ok |
| 60 | 1,60 ms | 18,0 ms | 57% | 671 | 2,59 KB | 36,6 KB/s | 1,65 MB/s | 8 / 37 ms | 350 MB | ok |
| 100 | 2,53 ms | 59,7 ms | 88% | 711 | 3,95 KB | 40,3 KB/s | 2,68 MB/s | 125 / 1.369 ms | 369 MB | ok |

Observações honestas:

- Os valores de 1 jogador são de um cliente parado num ninho ativo: **656 B por snapshot** (mínimo 111 B, máximo 1.402 B quando chegam setores/estruturas novos).
- Com muitos jogadores juntos, os snapshots crescem porque cada um recebe as formigas, predadores e estruturas do seu AOI. Por isso o payload médio passa de 1,5 KB para ~4 KB.
- A latência de 100 jogadores está contaminada: os 100 clientes sintéticos disputam a mesma CPU do servidor. Em produção, clientes reais estão em máquinas separadas.
- O servidor degrada de propósito: acima de 60 jogadores, os snapshots são espaçados (2×) e acima de 100 (3×) antes de qualquer colapso.

## 3. Capacidade recomendada

Com base nas execuções acima, **neste hardware**:

| Cenário | Jogadores simultâneos | Observação |
| --- | --- | --- |
| Confortável | **até 40** | CPU abaixo de ~45%, tick < 2 ms, latência local estável |
| Recomendado no limite | **50–60** | CPU ~60%, picos de 18 ms, banda ~1,7 MB/s; precisa de plano com ≥ 1 GB |
| Teto testado | **100** | CPU ~88%, picos de 60 ms e RTT degradado; não recomendado como meta |
| Acima disso | não testado | exigiria múltiplos processos/instâncias e roteamento por mundo |

Para o Render:

- **Plano free (512 MB)**: suficiente para desenvolvimento e até ~30–40 jogadores; risco de OOM com 60+ (o teste de 60 chegou a 350 MB de RSS).
- **Starter (1 GB)**: recomendado para 50–60 jogadores; foi o plano configurado em `render.yaml`.
- **Standard (2 GB+)**: necessário se você aumentar `MAX_DETAILED_ANTS`/`MAX_ANTS` ou rodar múltiplos mundos.

A banda é o limite mais provável antes da CPU: ~37 KB/s por cliente = ~2,2 MB/min por jogador. Um provedor com franquia de tráfego deve ser dimensionado por isso.

## 4. O que estes testes provam

- 55 testes automatizados passam, incluindo concorrência e autorização:
  - 5 sockets construindo no mesmo tile → **1 estrutura**, material debitado uma vez;
  - duas pessoas coletando o mesmo nó de 1 unidade → total carregado = 1;
  - jogador sem permissão não demole, não constrói em água, não constrói longe do ninho, não invade território alheio, respeita o limite de estruturas;
  - reconexão com token preserva sessão e colônia;
  - reinício do backend restaura mundo, colônias, estruturas e população;
  - carregamento por setor e contagem de entidades sob carga.
- Snapshots por AOI não incluem formigas de IA fora do raio (teste de rede).
- O tick se mantém abaixo de 3 ms mesmo com 100 clientes e ~400 formigas detalhadas.

## 5. O que estes testes **não** provam

- Latência de internet real (aqui os clientes rodam em loopback).
- Estabilidade em execuções de 24 h+ (a maior simulação foi de 1 h acelerada).
- Desempenho de GPU em celulares antigos (o cliente é Phaser/WebGL; não foi medido em dispositivo físico).
- Comportamento sob ataque (DDoS, floods de Socket.IO além dos rate limits).
- Latência do Supabase em produção (o armazenamento usado nos testes foi memória/arquivo).
- Múltiplos mundos por processo (o desenho é 1 processo = 1 mundo).

## 6. Onde está o custo

1. **Serialização e envio de snapshots** — domina a CPU sob carga (JSON + muitos objetos por jogador).
2. **Memória por conexão** — buffers do Socket.IO + mapas de entidades já enviadas.
3. **Tick da IA** — barato graças ao LOD; cresce com `MAX_DETAILED_ANTS` e com jogadores espalhados.
4. **Persistência** — assíncrona; impacta o boot e o uso de memória, não o tick.

Alavancas para escalar mais, em ordem de custo/benefício:

1. Compactar snapshots em binário (`ArrayBuffer`/`msgpack`) em vez de JSON.
2. Reduzir a frequência de snapshots “full” e usar deltas de estruturas por revisão.
3. Limitar o AOI a 3 × 3 setores perto de aglomerações.
4. Separar o processo de simulação do processo de rede (workers).
5. Um processo por mundo + roteamento sticky por `WORLD_ID`.

## 7. Como reproduzir

```bash
# simulação acelerada
node backend/scripts/sim.js --minutes=10 --bots=4
node backend/scripts/sim.js --minutes=60 --bots=0 --colonies=4 --json

# carga com clientes reais
node backend/scripts/loadtest.js --players=25 --seconds=30
node backend/scripts/loadtest.js --players=60 --seconds=30
node backend/scripts/loadtest.js --players=100 --seconds=15

# testes
cd backend && node --test --test-concurrency=1 test/*.test.js

# métricas do servidor em execução
curl -s localhost:8080/health | jq
curl -s localhost:8080/metrics | grep ant_life
```

Os scripts usam sementes fixas e mundo em memória; não tocam no seu banco de produção.
