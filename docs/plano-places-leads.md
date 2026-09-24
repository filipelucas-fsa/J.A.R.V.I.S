# Plano: Google Places / Descoberta de Leads (Fase 3)

> Status: **IMPLEMENTADO E VERIFICADO** (2026-09-23) · Fase 3 do roadmap (`docs/plano-model-manager.md` §12).
> Resultado: 499 testes (490 pass, 0 fail), suíte +12 testes novos com servidor mock do Google
> (nenhum custo, nenhuma chave real). Regra de ouro mantida: **o Google é opcional** — sem
> `GOOGLE_PLACES_API_KEY` e sem `places` em `TOOLS`, nada muda no Jarvis.

## 1. Objetivo

Preparar o Jarvis para encontrar e analisar estabelecimentos (futuros leads):

```
JARVIS
  └─► LEAD/LOCATION TOOL (find_places)   ← a ferramenta que o modelo chama
        └─► CAMADA PLACES (src/places/)    ← interface searchPlaces()
              └─► GooglePlacesProvider      ← implementação: Places API (New)
                    (outra fonte no futuro NÃO muda o resto)
```

Fluxo completo de lead (o modelo já consegue sozinho com as ferramentas atuais):

```
"Jarvis, encontre barbearias sem site em Feira de Santana"
  └─► find_places (Google Places)  → lista com telefone/website
        └─► web_search / web_fetch  → presença digital (site, redes, reviews)
              └─► o modelo organiza: nome, contato, presença (fraca/moderada/forte),
                  oportunidade (site, sistema, automação)
```

Nada de envio automático de mensagens: qualquer ação de contato futura exige
confirmação explícita do usuário (fora do escopo desta fase).

## 2. Custos e limites (verificados em developers.google.com — tabela de 2026-09-17)

A Places API (New) cobra **por requisição** (não por resultado) e o **field mask
define o SKU**:

| SKU | Campos | Franquia grátis/mês | Depois (US$/1.000) |
|---|---|---|---|
| Text Search Essentials (IDs only) | só id | ilimitada | — |
| Text Search Pro | nome, endereço, categoria | 5.000 | $32 |
| Text Search Enterprise | + telefone, website | 1.000 | $35 |
| **Text Search Enterprise + Atmosphere** | + avaliação, nº de reviews | **1.000** | **$40** |

**Nossa busca usa o último** (telefone, site e avaliação são o coração da
qualificação de lead): **US$ 0,04 por busca após a franquia de 1.000/mês**.
Uma busca devolvendo 10 resultados custa o mesmo que 1 resultado — melhor
pedir mais por requisição do que repetir buscas.

Exigências do Google (independem do código):
- projeto no Google Cloud com **faturamento ativo** (mesmo para a franquia);
- habilitar a **Places API (New)** e gerar chave de API;
- recomendação: restringir a chave a essa API no console.

Proteções implementadas no Jarvis:
- ferramenta **opt-in**: só existe com `TOOLS=...,places` E `GOOGLE_PLACES_API_KEY`;
- teto de 10 resultados por busca (`maxResultCount` máximo da API é 20);
- a descrição da ferramenta avisa o modelo de que cada busca é paga, para agrupar
  buscas em vez de disparar várias parecidas;
- sem a chave: erro claro **na inicialização** (`ConfigError`), nunca no meio da tarefa.

## 3. Design

### 3.1 Interface da camada (`src/places/googlePlaces.js`)

```js
const provider = createGooglePlacesProvider({ apiKey, fetchImpl, timeoutMs, language });
const places = await provider.searchPlaces({ query, maxResults, signal });
// → [{ name, category, address, phone, website, rating, reviews, mapsUri, status }]
```

- `POST https://places.googleapis.com/v1/places:searchText` (Text Search New).
- Headers: `X-Goog-Api-Key` (nunca em URL/JSON) e `X-Goog-FieldMask`.
- Validação: query 1-400 caracteres; `maxResults` limitado a 10.
- Erros com mensagem acionável: 403 = chave inválida/sem permissão,
  429 = cota/faturamento, 5xx = temporário, JSON inválido = problema de rede.
- `fetchImpl` injetável (testes) e `signal` respeitado (Ctrl+C cancela a busca).
- A chave **nunca** aparece em mensagens de erro ou logs.

### 3.2 Ferramenta (`src/tools/placesTools.js`)

`find_places` — entrada: `query` (o quê + onde), `max_results` (1-10, padrão 5).
Saída em texto estruturado por estabelecimento, com `Website: não encontrado` e
`Telefone: não encontrado` explícitos (sinais de lead) + dica para usar
`web_search`/`web_fetch` na sequência. Sem confirmação (é uma busca, como
`web_search` — sem risco ao computador).

### 3.3 Registro (`src/tools/index.js` + `src/runtime.js`)

`places` entra em `TOOL_NAMES`; `DEFAULT_TOOLS` **não muda**. O runtime injeta a
fábrica `createPlacesTools({apiKey: env.GOOGLE_PLACES_API_KEY, language: env.PLACES_LANGUAGE})`
no `buildToolRegistry` (mesmo padrão do `createDriver`). Sem a chave e com
`places` ativo → `ConfigError` clara na inicialização.

## 4. Passos (com verificação em cada um)

| # | Passo | Arquivos | Verificação | Status |
|---|---|---|---|---|
| 1 | Estratégia (este documento) | `docs/plano-places-leads.md` | — | ✔ |
| 2 | Provider desacoplado | `src/places/googlePlaces.js` (novo) | testes unitários com servidor mock | ✔ |
| 3 | Ferramenta + registro | `src/tools/placesTools.js` (novo), `src/tools/index.js`, `src/runtime.js` | `npm test` verde (defaults intactos) | ✔ |
| 4 | Config + docs | `.env.example`, `README.md` | revisão | ✔ |
| 5 | Testes | `tests/places.test.js` (12 testes) | `npm test` completo verde | ✔ 499 testes, 0 fail |
| 6 | Atualizar status | este documento | — | ✔ |

Smoke real exige chave do Google com faturamento: fica como verificação opcional
do usuário (guia no README).

## 5. Testes planejados

1. provider: requisição correta (headers `X-Goog-Api-Key`/field mask, body `textQuery`/`maxResultCount`/`languageCode`)
2. provider: normalização com campos ausentes (phone/website `""`, rating `null`)
3. provider: query vazia/longa demais → erro claro
4. provider: `maxResults` limitado a 10
5. provider: 403/429/500/JSON inválido → mensagens acionáveis sem vazar a chave
6. ferramenta: lista formatada com "não encontrado"; busca vazia → mensagem
7. registro: `TOOLS=places` com chave → `find_places` registrada; sem a fábrica → erro claro
8. runtime: end-to-end da config (enabled + registry); sem chave → `ConfigError`
9. `parseToolNames` aceita `places`; `DEFAULT_TOOLS` continua sem `places`

## 6. Limitações conhecidas (aceitas nesta fase)

- Uma fonte (Google Places); a interface já permite outras (ex.: OpenStreetMap
  Overpass, grátis, no futuro).
- Sem paginação (`pageToken`) e sem `locationBias` — a localização vai no texto
  da busca ("barbearias em Feira de Santana"), que o Text Search resolve bem.
- Sem cache de buscas (cada chamada é paga) — futuro: cache local por query.
- Sem sistema de "qualificação de leads" persistente (lista/arquivo) — o modelo
  organiza na conversa; estrutura de dados vem numa fase futura, se fizer sentido.

## 7. Rollback

Remover `places` de `TOOLS` desliga tudo. Rollback total = reverter os commits
desta fase (nenhuma migração, nenhuma dependência nova, nenhuma mudança em
arquivo existente de comportamento atual).
