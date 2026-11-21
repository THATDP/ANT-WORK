# Deploy: Supabase + Render + GitHub Pages

O cliente é estático (HTML + JS + WASM/WebGL) e pode ir para o GitHub Pages. O servidor autoritativo é Node.js e **não roda no Pages** — ele vai para o Render. O Supabase guarda o mundo.

```
GitHub Pages (frontend) ──wss──▶ Render (backend) ──SQL──▶ Supabase (Postgres)
   VITE_SERVER_URL                CORS_ORIGIN                DATABASE_URL
```

Tempo estimado: 15–20 minutos. Custo: tudo funciona no plano gratuito, mas para ~50 jogadores o backend precisa do plano Starter do Render (512 MB é apertado).

---

## 1. Supabase (banco)

1. Crie um projeto em [supabase.com](https://supabase.com) (região São Paulo se o público for brasileiro).
2. Guarde a senha do banco que o Supabase gera.
3. Em **Project Settings → Database → Connection string → URI**, copie a string do **pooler**:
   - porta **6543** (transaction mode) para o backend no Render;
   - se aparecer erro de *prepared statement* ou “too many connections”, use a porta **5432** (session mode) ou o host direto.
4. Ajuste a URL:
   ```
   postgresql://postgres.SEU_PROJETO:SENHA@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
   ```
   A senha deve ser URL-encoded (`@` → `%40`, `#` → `%23`, etc.).
5. Aplique a migração. Duas formas:

   **a) Pelo backend (recomendado neste repositório):**

   ```bash
   cd ANT-WORK
   npm install
   DATABASE_URL="postgresql://…" npm run migrate
   ```

   O backend também migra sozinho no boot, a menos que você defina `AUTO_MIGRATE=false`. O script lê `database/migrations/*.sql` em ordem, aplica em transação e registra em `schema_migrations`.

   **b) Pelo SQL Editor do Supabase:**

   Copie o conteúdo de [`database/migrations/0001_init.sql`](../database/migrations/0001_init.sql) e execute.

6. Confira em **Table Editor**: devem existir `worlds`, `colonies`, `colony_members`, `structures`, `world_chunks`, `world_events`, `world_snapshots`, `players` e `schema_migrations`.
7. Não desative RLS. O backend usa `DATABASE_URL` (role do banco) e ignora RLS; a chave anon não precisa de acesso.

> **Aviso de honestidade:** `backend/scripts/migrate.js` foi escrito para este deploy mas **não foi executado contra um Postgres real** neste ambiente de desenvolvimento (não havia `DATABASE_URL`). O SQL da migração foi validado linha a linha e o backend também aplica as migrações no boot, mas o primeiro `npm run migrate` em produção é o teste definitivo. Se ele falhar, use o SQL Editor (opção b) e reporte o erro.

---

## 2. Render (backend)

O repositório já traz [`render.yaml`](../render.yaml).

1. Crie uma conta no [render.com](https://render.com) e conecte o GitHub.
2. **New → Blueprint** → escolha o repositório `ANT-WORK` → **Apply**.
3. O Render cria o serviço `ant-life-backend` com:
   - ambiente **Node** e região **Virginia** (a mais próxima do Brasil na Render; troque se seu público estiver em outro continente);
   - plano **Starter** (troque para Free se quiser testar; veja avisos abaixo);
   - build `npm ci`, start `npm --workspace backend run start`;
   - health check em `/health`.
4. Preencha as variáveis marcadas como obrigatórias (`sync: false`):

   | Variável | Valor | Obrigatória |
   | --- | --- | --- |
   | `DATABASE_URL` | string do Supabase (passo 1) | sim |
   | `CORS_ORIGIN` | `https://SEU-USUARIO.github.io` (origem do Pages, **sem** barra no final e **sem** caminho) | sim |
   | `WORLD_SEED` | número inteiro (padrão `20261121`) | não |
   | `WORLD_ID` | `ant-life-1` | não |
   | `AI_COLONIES` | quantidade de colônias selvagens (padrão `2`) | não |
   | `PERSIST` | `auto` (usa Postgres se `DATABASE_URL` existir) | não |
   | `ADMIN_TOKEN` | gerado automaticamente pelo Render | não |
   | `AUTO_MIGRATE` | deixe vazio ou `true`; `false` só depois de migrar pelo CI | não |
   | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | opcionais; o backend usa `DATABASE_URL` para o jogo | não |

   `PORT` **não** deve ser definida: o Render injeta a porta e o servidor a respeita.

5. Aguarde o deploy. A primeira subida baixa dependências e aplica migrações (~2–4 min).
6. Teste:

   ```bash
   curl -s https://SEU-SERVICO.onrender.com/health
   # {"ok":true,...}
   ```

   Se vier `503`, veja os logs: normalmente é `DATABASE_URL` inválida ou migração falhando.

7. Copie a URL do serviço (`https://SEU-SERVICO.onrender.com`). Ela será usada no frontend.

### Free vs Starter

| Plano | Memória | Para quê |
| --- | --- | --- |
| Free | 512 MB | demonstração, poucos jogadores; **dorme após ~15 min** sem acesso (primeiro acesso demora 30–60 s) |
| Starter | 1 GB | recomendado; comporta ~50–60 jogadores e não dorme |

O teste de carga de 60 clientes usou **350 MB de RSS**; com folga de heap, 512 MB é o mínimo absoluto. Para 100+ jogadores, use Standard e leia [`LIMITES.md`](LIMITES.md).

---

## 3. GitHub Pages (frontend)

O workflow [`deploy-pages.yml`](../.github/workflows/deploy-pages.yml) compila com `VITE_BASE=/<nome-do-repositorio>/` e publica `frontend/dist`.

1. No GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Crie a variável de repositório **Settings → Secrets and variables → Actions → Variables**:
   - Nome: `VITE_SERVER_URL`
   - Valor: `https://SEU-SERVICO.onrender.com`
   - Pode ser uma variável (não precisa ser secreta).
3. Rode o workflow: **Actions → “Publicar frontend no GitHub Pages” → Run workflow** (ou faça push na `main`).
4. Ao terminar, abra `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.
5. Volte ao Render e confirme `CORS_ORIGIN`. Se o jogo mostrar “conexão recusada” no console com erro de CORS, o valor está diferente da origem real (inclua `https://` e o domínio exato; para domínio próprio, adicione também o domínio).

O workflow avisa no log quando `VITE_SERVER_URL` está vazia. Nesse caso o site abre, mas tenta conectar no próprio Pages e falha — é o sintoma clássico de variável não configurada.

### Build local equivalente

```bash
cd ANT-WORK
VITE_BASE=/ant-work/ VITE_SERVER_URL=https://seu-servico.onrender.com npm run build
npx vite preview --host 0.0.0.0
```

---

## 4. Checklist pós-deploy

- [ ] `GET /health` retorna `ok: true` e `store.mode: "postgres"`.
- [ ] `GET /api/colonies` lista colônias (vazio em mundo novo é normal).
- [ ] Abrir o Pages carrega o menu sem erro no console.
- [ ] Entrar no jogo cria jogador e mostra o ninho.
- [ ] Coletar (`E`), entregar (`F`) e fundar colônia funcionam.
- [ ] Construir uma obra debita material e progride.
- [ ] Recarregar a página reconecta e mantém a colônia.
- [ ] Reiniciar o serviço no Render mantém colônias e construções.
- [ ] Logs do Render sem erros repetidos de migração/CORS.

---

## 5. CI

`.github/workflows/ci.yml` roda em push e pull request:

1. `npm ci` com cache;
2. `npm test` (55 testes);
3. `npm run build` com `VITE_BASE=/` (conferir que o build quebra se o frontend usar API inexistente);
4. upload de `frontend/dist`.

Se o CI falhar por flake de rede, rode novamente: os testes de socket usam portas aleatórias e podem colidir. Não desative testes para “passar”.

---

## 6. Problemas comuns

| Sintoma | Causa provável | Correção |
| --- | --- | --- |
| Página em branco no Pages | base errada (assets em `/`) | conferir `VITE_BASE` com o nome do repositório e barras nas duas pontas |
| `Mixed Content` / conexão bloqueada | site em HTTPS tentando HTTP | `VITE_SERVER_URL` precisa ser `https://` (o Render fornece TLS) |
| CORS no console | `CORS_ORIGIN` diferente da origem | ajustar no Render e reiniciar |
| WebSocket falha, jogo funciona com atraso | proxy/rede bloqueando `wss` | o cliente cai para polling automaticamente; verifique o Render |
| Backend “dormindo” | plano Free | primeira requisição acorda; use Starter para produção |
| 503 no `/health` | banco inacessível | revisar `DATABASE_URL`, senha URL-encoded, porta do pooler |
| `too many connections` | pooler em session mode | usar porta 6543 (transaction) |
| Mundo reiniciou do zero | mundo salvo em memória | `PERSIST=file/auto` e `DATABASE_URL` definidos |
| `.env` commitado | descuido | remover do Git e **rotacionar** as chaves |

---

## 7. Atualizações e rollback

- **Nova versão**: push na `main` → Render faz deploy automático; Pages roda no push do workflow (ajuste o gatilho se preferir manual).
- **Rollback**: no Render, **Deploys → Rollback** para o deploy anterior; no Pages, rode o workflow de um commit anterior.
- **Banco**: migrações são aditivas (`if not exists`). Antes de mudanças destrutivas, gere `pg_dump` (veja [`BANCO.md`](BANCO.md)).
- **Domínio próprio**: adicione o domínio no Render (HTTPS automático) e no Pages; inclua as duas origens em `CORS_ORIGIN` separadas por vírgula.

## 8. Custos aproximados

| Serviço | Plano | Custo |
| --- | --- | --- |
| GitHub Pages | público | grátis |
| GitHub Actions | minutos incluídos | grátis no uso normal |
| Render | Starter | ~US$ 7/mês (Free: US$ 0, com hibernação) |
| Supabase | Free | grátis até 500 MB; o mundo ocupa poucos MB por milhar de setores alterados |

O tráfego é o item a monitorar: ~37 KB/s por jogador (≈2,2 MB/min). Veja a tabela completa em [`LIMITES.md`](LIMITES.md).
