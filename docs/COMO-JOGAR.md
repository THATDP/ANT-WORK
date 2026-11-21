# Como jogar ANT LIFE

Você é uma formiga operária num mundo compartilhado. Seu objetivo imediato é sobreviver; o objetivo de longo prazo é fazer sua colônia crescer sem quebrar o ecossistema (ou a paciência das vizinhas).

## 1. Primeiros passos

1. Abra o jogo e escolha um nome de 2 a 20 letras.
2. Ao entrar, você nasce perto de um ninho ativo. Se ainda não tem colônia, o painel **sua colônia** aparece.
3. Você pode **fundar** uma colônia (após ~3 segundos de exploração) ou **entrar** numa colônia de jogadores existente. Também pode explorar sozinho — sem colônia você coleta, mas não entrega nem constrói.
4. Fundando, o ninho nasce onde você está (se estiver sobre água, o servidor procura o ponto seco mais próximo) e você é o **fundador**.

## 2. O laço principal

| Passo | Como |
| --- | --- |
| Encontrar recurso | Siga as trilhas de feromônio das operárias, os pontos no minimapa e as dicas da HUD. |
| Coletar | Aproxime-se (até ~46 px) e pressione `E`. Cada coleta enche 1 unidade da sua carga (capacidade 8). |
| Entregar | Volte ao ninho (ou a um depósito) e pressione `F`. O estoque é **da colônia**, não seu. |
| Comer/beber | `R` consome do estoque quando você está com fome ou sede. |
| Construir | `B` abre o catálogo, escolha a obra e clique num tile válido. `Esc` cancela. |
| Ajudar uma obra | Fique perto de uma estrutura em construção e pressione `E` (ou clique nela). |
| Reparar | Estruturas danificadas também aceitam `E` quando estão abaixo de 90% de vida. |
| Defender | `Espaço` ataca o predador mais próximo; guerreiras da colônia respondem ao alarme. |

> Você **não** pode coletar dois tipos ao mesmo tempo: entregue o que carrega antes de trocar de recurso.

## 3. Recursos e para que servem

| Recurso | Serve para |
| --- | --- |
| Folhas | Comida básica, custo de berçário e fungicultura. |
| Sementes | Comida densa, custo de sala de alimentação. |
| Frutas | Comida + água, custo de câmara da rainha. |
| Insetos | Melhor comida, custo de área de defesa. |
| Água | Sede da colônia e dos jogadores; custo de jardim de fungos. |
| Materiais | Todas as construções e reparos. |
| Esporos raros | Torre de vigia e câmara da rainha. |

O estoque tem **capacidade limitada** (400 + 250 por depósito + 30 por câmara). Quando enche, o excedente é perdido — construa depósitos antes de acumular.

## 4. A colônia

- **Rainha** — bota ovos quando há comida, moral e espaço. Se morrer, a colônia perde moral e só recupera com uma **Câmara da Rainha** e uma larva madura.
- **Moral** — sobe com comida abundante e estruturas concluídas, cai com fome, sede, mortes e derrotas. Moral baixa trava a postura de ovos.
- **Ovos → larvas → adultas** — larvas precisam de cuidado (operárias “Cuidando”) e berçários aceleram o desenvolvimento.
- **Cargos** — fundador, oficial e membro. Permissões padrão:
  - fundador: construir, demolir, retirar estoque, gerenciar cargos, expulsar, guerra;
  - oficial: construir, demolir, retirar estoque, expulsar, guerra;
  - membro: apenas construir (e ajudar obras).
- **Anti-griefing** — ninguém demole obra alheia sem permissão; não se constrói no território de outra colônia (raio de 460 px do ninho) nem a mais de 6 setores do próprio ninho.

## 5. Construções

| Obra | Tamanho | Custo | Efeito |
| --- | --- | --- | --- |
| Túnel | 1×1 | 4 materiais | Liga câmaras; acelera transporte interno. |
| Câmara | 2×2 | 14 materiais | +30 de capacidade e espaço de colônia. |
| Depósito | 2×2 | 18 materiais | +250 de capacidade de estoque. |
| Berçário | 2×2 | 22 materiais + 10 folhas | Acelera larvas e aumenta o teto de ovos. |
| Sala de Alimentação | 2×2 | 12 materiais + 8 sementes | Reduz fome perto dela; melhora moral. |
| Área de Defesa | 2×2 | 26 materiais + 6 insetos | Reforça defesa e moral das guerreiras. |
| Entrada Alternativa | 1×1 | 10 materiais | Segunda boca de colônia; rota de fuga. |
| Torre de Vigia | 1×1 | 16 materiais + 1 esporo | Amplia a detecção de ameaças. |
| Jardim de Fungos | 2×2 | 20 materiais + 12 água | Produz comida lentamente. |
| Câmara da Rainha | 3×3 | 40 materiais + 20 frutas + 2 esporos | Aumenta a postura e permite coroar nova rainha. |

Obras nascem a 0% e ficam funcionais a 100%. Até 3 formigas (IA) colaboram por canteiro; você contribui mais rápido. Demolir devolve 40% do custo — e exige permissão.

## 6. Biomas e clima

- **Floresta** — muita folha e madeira, predadores à espreita.
- **Jardim** — equilibrado, bom para começar.
- **Campo** — rápido de atravessar, recursos espalhados.
- **Rochosa** — materiais, mas lenta e perigosa.
- **Solo úmido** — água e insetos.
- **Água** — intransponível; contorne ou use uma entrada alternativa.
- **Subterrâneo** — materiais e esporos, pouca comida.
- **Área contaminada** — esporos raros; machuca lentamente quem fica.

**Chuva e tempestade** enchem os nós de água e deixam o solo escorregadio. **Calor** seca os recursos e acelera a sede. **Neblina** reduz a visão. À noite os predadores ficam mais ousados e as colônias mais vulneráveis.

## 7. Predadores

| Predador | Comportamento |
| --- | --- |
| Besouro | Lento e resistente; ataca quem carrega recurso. |
| Aranha | Emboscada perto de trilhas; recua com pouca vida. |
| Vespa | Rápida, ataca formigas isoladas e larvas. |
| Cupim | Rói estruturas e túneis. |
| Lagarto | Grande, invade a colônia em busca de larvas. |
| Formiga-leão | Fica à espreita em solo arenoso e puxa quem passa. |

Predadores avaliam risco: uma guerreira sozinha raramente é suficiente; um grupo costuma afastá-los. A HUD mostra distância e direção das ameaças num raio de ~760 px.

## 8. Multiplayer

- **Chat global** (`Enter`, aba “mundo”) e **chat da colônia** (aba “colônia”).
- **Lista de jogadores** (`Tab`) mostra quem está perto, colônia e distância.
- **Reconexão** — se a conexão cair, o cliente tenta voltar por até 12 tentativas; o servidor guarda sua sessão por 90 s. Ao voltar com o mesmo token você mantém colônia, posição e progresso.
- **Trocar de colônia** — configurações → “trocar de colônia”. Sair não apaga o que você construiu: as obras e o estoque pertencem à colônia.

## 9. Dicas honestas

- Não entre em área contaminada com pouca vida.
- Depósitos perto das trilhas reduzem perdas quando o estoque enche.
- Berçário + sala de alimentação + depósito é a base de uma colônia estável.
- Se a moral cair, o problema costuma ser comida ou água, não combate.
- Guerreiras não resolvem tudo: uma torre de vigia avisa antes.
- O mapa grande (`M`) mostra colônias selvagens — observar antes de se aproximar é gratuito.

## 10. Problemas comuns

| Situação | O que fazer |
| --- | --- |
| “Recursos insuficientes” | O custo sai do **estoque da colônia**; entregue recursos no ninho. |
| “Longe do ninho” | Você só constrói até 6 setores (~4.600 px) do seu ninho. |
| “Respeite o território” | Há outra colônia a menos de 460 px do local escolhido. |
| “Aguarde um instante” | O servidor limita ações por segundo (anti-spam). |
| Sem recursos por perto | Siga as trilhas de feromônio ou afaste-se do ninho; nós esgotados voltam após 30 s (água) a 4 min (outros). |
| “Obra já reservada” | Outra pessoa começou naquele tile; escolha outro. |
