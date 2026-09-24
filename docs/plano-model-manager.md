# Plano: Model Manager (cadeia de modelos com fallback e cooldown)

> Status: **IMPLEMENTADO E VERIFICADO** (2026-09-23) · Fase 1 do roadmap de evolução do Jarvis.
> Resultado: 487 testes (478 pass, 0 fail, 9 skip de ambiente), smoke real com a API
> NVIDIA validando o caminho com e sem fallback. Sem `FALLBACK_MODELS` no `.env`,
> o comportamento do Jarvis é idêntico ao de antes.

Este documento registra a estratégia completa: diagnóstico, decisões, passos de
implementação, plano de testes e plano de rollback. Ele é a fonte de verdade da
Fase 1; o README.md fica com a documentação de uso.

---

## 1. Objetivo

Permitir que o Jarvis use uma **cadeia de modelos** (primário + reservas)
sem que o agente conheça detalhes de cada provedor:

```
Agent (sem mudanças)
   └─► ModelManager  (mesma interface ask() dos adaptadores)
         ├─► Modelo primário   (ex.: NVIDIA · GLM / Llama)
         ├─► Modelo reserva 1  (ex.: NVIDIA · outro modelo)
         └─► Modelo reserva 2  (ex.: Ollama local)
```

Futuro (fora desta fase): Anthropic/Claude na mesma cadeia, seleção por
capacidade, Google Places/Leads.

## 2. Diagnóstico da arquitetura atual (auditoria)

O projeto **já possui** boa parte da abstração necessária:

| Já existe | Onde | Estado |
|---|---|---|
| Registry de providers (`PROVIDERS`) | `src/ai/index.js` | ✔ NVIDIA, Anthropic, OpenAI, Ollama, openai-compatible |
| Interface unificada `ask(messages, {system, tools, signal})` | `src/ai/model.js`, `src/ai/openaiCompatible.js` | ✔ mesmo contrato, resposta no formato Anthropic |
| Tradução de formato (histórico/tools ↔ OpenAI) | `src/ai/openaiCompatible.js` | ✔ o agente não sabe qual provedor está em uso |
| Classificação de erros com `retryable` (429/5xx/rede = true; 401/402/403/404/400/413 = false) | `src/ai/errors.js`, `describeApiError`, `describeHttpError` | ✔ mensagens acionáveis |
| Retry com backoff + honra `retry-after` | dentro de cada adaptador | ✔ por tentativa |
| Timeout por tentativa | dentro de cada adaptador | ✔ |
| Agente desacoplado (duck-typing: só chama `model.ask`) | `src/agent/agent.js:129` | ✔ **não precisa mudar** |

O que **falta**: a camada de roteamento entre o agente e os adaptadores —
cadeia, fallback entre modelos, cooldown e seleção por capacidade. É exatamente
o que esta fase adiciona.

### Pontos de acoplamento e risco

| Ponto | Risco | Mitigação |
|---|---|---|
| `resolveModelConfig(env)` (1 modelo) | quebrar config atual | assinatura e comportamento **intocados**; novos recursos são funções novas |
| `model.label` (exibido no CLI/painel) | quebrar interface | com 1 modelo o label é **idêntico ao atual**; com cadeia ganha sufixo `(+N reserva)` |
| `runtime.js` valida visão do modelo p/ `TOOLS=computer` | cadeia sem visão quebra controle de tela | regra migra para a cadeia (ver §6.3) |
| Suíte de testes existente | regressões | suíte roda a cada passo; nada é removido |
| Latência pior caso | soma dos timeouts da cadeia | documentado; Ctrl+C continua abortando tudo (signal se propaga) |

## 3. Referências open source (conceitos, zero código copiado)

| Projeto | Licença | Conceitos aproveitados |
|---|---|---|
| OpenCode (anomalyco/opencode) | MIT | registry provider→models com capacidades declaradas; status por modelo; autenticação desacoplada; classificação de erro `isRetryable` |
| LiteLLM Router (BerriAI/litellm) | MIT | ordenação por prioridade; **cooldown** (`allowed_fails` → `cooldown_time`); fallbacks encadeados; honra `retry-after`; após cooldown o primário é retestado primeiro |

Nenhum arquivo desses projetos é incluído aqui; a implementação é própria,
minimalista e no estilo do código existente do Jarvis.

## 4. Especificação do ModelManager

### 4.1 Contrato

Novo arquivo `src/ai/manager.js`:

```js
new ModelManager({
  entries,              // [{ instance, config, disabled }] — instance = adaptador com ask()
  cooldownSeconds,      // padrão 60 (0 = desligado)
  cooldownMaxSeconds,   // padrão 900
  log,                  // callback (stderr no CLI; painel no modo voz)
  clock,               // { now() } injetável p/ testes (helpers/fakeClock)
})
```

Interface pública (o agente **não muda**):

- `ask(messages, { system, tools, signal })` → mesma resposta dos adaptadores.
- `label` — idêntico ao do modelo único quando a cadeia tem 1 modelo;
  `NVIDIA · x (+1 reserva)` quando tem mais.
- `capabilities` — do modelo primário (`{ vision, tools }`).
- `status()` — mapa por modelo: `active | cooldown | disabled`, tempo restante,
  último erro (base para o painel de voz mostrar a cadeia no futuro).
- `pick({ vision, tools })` — seleção por capacidade (extensibilidade p/ §8).

### 4.2 Semântica de fallback (por tipo de erro)

A classificação já existe (`ModelError.retryable` + `status`); o manager só decide:

| Erro | Fallback? | Motivo |
|---|---|---|
| 429 (limite de uso) | ✔ + cooldown | temporário; honra `retry-after` |
| 5xx / 529 (servidor) | ✔ + cooldown | temporário |
| Timeout | ✔ + cooldown | temporário |
| Falha de conexão | ✔ + cooldown | temporário |
| **404 (modelo não existe/sem acesso)** | ✔ **com aviso** (decisão do usuário) | problema é do modelo específico, não da config global |
| 400 / 413 (incompatibilidade, histórico grande) | ✘ falha rápida | trocar de modelo mascararia um bug de compat; mensagem atual já orienta a correção |
| 401 / 402 / 403 (chave, cobrança, permissão) | ✘ falha rápida | erro de configuração; usuário deve corrigir o `.env` |
| Abort do usuário (Ctrl+C) | ✘ propaga na hora | cancelamento nunca faz fallback |
| Erro inesperado (não é `ModelError`) | ✘ propaga | bug: não esconder |

**Todas as tentativas falharem** → `ModelError` agregado: mensagem do primeiro
modelo como corpo + resumo das falhas das reservas entre colchetes.
**Cadeia com 1 modelo** → o erro original é re-lançado **sem alteração** (o mesmo
objeto), garantindo compatibilidade byte-a-byte com o comportamento atual.

### 4.3 Cooldown

```
1ª falha elegível      → cooldown = retry-after do servidor OU MODEL_COOLDOWN_SECONDS (60s)
falha de novo (seguida) → dobra: 60 → 120 → 240 → 480 … (multiplicador limitado a 8×)
teto                   → MODEL_COOLDOWN_MAX_SECONDS (900s)
durante o cooldown     → requisições vão para o próximo modelo da cadeia
cooldown expirado      → o modelo volta ao TOPO da preferência (primário primeiro)
todos em cooldown      → melhor esforço: tenta o que volta mais cedo (não trava o Jarvis)
0 = desligado          → MODEL_COOLDOWN_SECONDS=0 desativa o descanso
sucesso                → zera cooldown e a contagem de falhas do modelo que respondeu
```

Sem alternância infinita: modelo em cooldown é pulado; falhas consecutivas
alongam o descanso exponencialmente.

### 4.4 Ciclo de vida de uma requisição

```
ask() ──► candidatos = entradas ativas, primário primeiro, pulando cooldown
   ├─ resposta OK ──► zera estado do modelo ──► devolve
   ├─ erro elegível ──► registra falha, aplica cooldown, log, próximo modelo
   ├─ erro de config/compat ──► falha imediata (mensagem atual preservada)
   └─ esgotou a cadeia ──► erro agregado (ou original, se 1 modelo)
```

## 5. Configuração (`.env`)

```bash
# Primário: EXATAMENTE como hoje (MODEL_PROVIDER, MODEL_NAME, NVIDIA_API_KEY…)
# Reservas (opcional):
FALLBACK_MODELS=nvidia:meta/llama-3.3-70b-instruct,nvidia:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning[+vision]
MODEL_COOLDOWN_SECONDS=60       # opcional (0 = desligado)
MODEL_COOLDOWN_MAX_SECONDS=900  # opcional (teto do descanso exponencial)
```

Formato de cada entrada (separadas por vírgula):

- `provider:modelo` — provider igual ao `MODEL_PROVIDER`; o id do modelo pode
  conter `/` (ex.: `meta/llama-3.3-70b-instruct`), só o **primeiro `:`** separa.
- `[tags]` opcionais no fim: `[+vision]`, `[-vision]`, `[+tools]`, `[-tools]`.
  Colchetes evitam ambiguidade com ids reais (nenhum id de modelo contém `[`).
- Cada provider usa a chave **já definida** no `.env` (`NVIDIA_API_KEY`,
  `ANTHROPIC_API_KEY`, `MODEL_API_KEY`…). Fallback de provider sem chave →
  `ConfigError` clara **na inicialização**, nunca no meio de uma tarefa.
- Fallbacks herdam os ajustes globais (`MODEL_TIMEOUT_SECONDS`,
  `MODEL_MAX_RETRIES`, `MODEL_MAX_TOKENS`, `MODEL_TEMPERATURE`, …).

Regras de sanidade (validadas na inicialização):

1. Provider desconhecido / formato inválido / tag inválida → `ConfigError`.
2. Entrada igual ao primário (ou duplicada) → ignorada.
3. Fallback do **mesmo provider** do primário usa o mesmo endereço
   (`baseURL`) — cobre NIM local e LM Studio. Provider diferente usa o
   endereço padrão dele; `openai-compatible` exige `MODEL_BASE_URL`.
4. Cadeia mista de ferramentas (primário com tools + reserva `[-tools]`) →
   `ConfigError`: a reserva nunca conseguiria continuar a tarefa no meio do
   loop de ferramentas (o histórico já contém blocos de ferramenta).
5. `MODEL_REASONING_BUDGET` só se aplica a providers no formato OpenAI; para
   outros é **ignorado** nas reservas (não trava a cadeia).

## 6. Regras por capacidade

### 6.1 Ferramentas
`MODEL_TOOLS=false` desliga ferramentas para todos (como hoje). Reservas
sempre aceitam as mesmas ferramentas do primário (regra 4 acima).

### 6.2 Visão
`capabilities.vision` por modelo (preset do provider, `MODEL_VISION` no
primário, `[+vision]` nas reservas). `pick({vision: true})` prepara a seleção
por tarefa (futura); não é usada pelo agente nesta fase.

### 6.3 `TOOLS=computer` (controle de tela)
O histórico contém screenshots — um modelo sem visão quebraria a tarefa.
Logo: com `computer` ativo, reservas sem visão ficam **desativadas com aviso**
no log. Nenhum modelo com visão → `ConfigError` (mensagem atual preservada).

## 7. Passos de implementação (com verificação em cada um)

| # | Passo | Arquivos | Verificação | Status |
|---|---|---|---|---|
| 1 | Documento de estratégia (este arquivo) | `docs/plano-model-manager.md` | — | ✔ |
| 2 | Campo aditivo `retryAfterMs` no 429 (necessário p/ cooldown honrar o servidor) | `src/ai/errors.js`, `src/ai/model.js`, `src/ai/openaiCompatible.js` | `npm test` verde (campo novo não altera mensagens) | ✔ 454 testes |
| 3 | `src/ai/index.js`: extrair helpers puros (sem mudar comportamento), + `resolveModelChain` / `parseFallbackModels` / `resolveFallbackModelConfig` / `createModelManager` | `src/ai/index.js` | `npm test` verde — `resolveModelConfig` continua igual | ✔ 454 testes |
| 4 | `src/ai/manager.js`: `ModelManager` + `isFallbackEligible` | novo | compila (import nos testes) | ✔ |
| 5 | `src/runtime.js`: montar a cadeia e o manager; regra de visão por cadeia | `src/runtime.js` | `npm test` verde | ✔ 454 testes |
| 6 | Documentação de uso | `.env.example`, `README.md` | revisão | ✔ |
| 7 | Testes novos | `tests/modelManager.test.js` (33 testes) | `npm test` verde (antigos + novos) | ✔ 487 testes, 0 fail |
| 8 | Smoke real (API NVIDIA): (A) sem fallback = igual a hoje; (B) primário inválido (404) → reserva `[+vision]` responde | nenhum (variável de ambiente temporária na sessão, sem editar o `.env`) | respostas corretas + log de fallback | ✔ |
| 9 | Atualizar status deste documento | `docs/plano-model-manager.md` | — | ✔ |

**Intencionalmente sem mudanças:** `src/agent/*`, `src/tools/*`,
`src/computer/*`, `src/voice/*`, `src/index.js`, `src/voiceMain.js` (o
`model.label` flui sozinho), todos os testes existentes, `package.json`.

### Estratégia de segurança
- **Aditivo primeiro**: nada do comportamento atual é removido; `resolveModelConfig`
  e `createModel` seguem exportados com a mesma assinatura.
- **Compatibilidade de 1 modelo**: sem `FALLBACK_MODELS`, o manager é um wrapper
  passivo — mesmo erro (o MESMO objeto), mesmo label, mesma latência.
- **Uma suíte de testes por passo**: qualquer regressão aparece no passo em que
  nasceu, não três passos depois.
- **Sem novas dependências**: implementação própria em JS puro.

## 8. Testes (tests/modelManager.test.js)

Cobertura planejada (checklist do usuário, itens automatizáveis):

1. primário responde; reserva não é chamada
2. 429 no primário → resposta da reserva + cooldown registrado
3. timeout/conexão/5xx → fallback
4. 404 → fallback com aviso (decisão do usuário)
5. 401 → falha imediata, reserva NÃO acionada, mesmo objeto de erro
6. abort (signal) → propaga sem fallback
7. cooldown pula o modelo; relógio avança → primário volta ao topo
8. cooldown exponencial (2ª falha seguida dobra)
9. `retry-after` do servidor tem prioridade sobre o cooldown padrão
10. todos falham → erro agregado menciona cada modelo
11. cadeia de 1 modelo → erro original preservado (identidade)
12. todos em cooldown → melhor esforço (o que volta primeiro)
13. entradas desativadas são puladas
14. `pick({vision})` filtra por capacidade
15. `status()` e `label` corretos (1 e N modelos)
16. `resolveModelChain`: parsing, tags, dedupe, erros de config claros
17. integração com o Agent real (prova que o agente não muda)
18. `MODEL_COOLDOWN_*` validados (0 permitido; max < min → erro)

Itens do checklist geral que exigem ambiente real (voz, mouse/teclado,
comandos) são cobertos pela suíte existente (`npm test`) permanecendo verde +
verificação manual do usuário. Smoke real (passo 8) valida o caminho NVIDIA.

## 9. Plano de rollback

Cada passo é pequeno e reversível. Rollback total = reverter os commits desta
fase (nenhuma migração de dados, nenhum formato novo de arquivo, nenhuma
dependência nova). O `.env` do usuário não precisa mudar; `FALLBACK_MODELS`
é opcional e desligado por padrão.

## 10. Decisões registradas (com o usuário)

1. **404 → fallback com aviso** (decisão do usuário, 2026-09-23): o problema é do
   modelo específico; a tarefa continua e o aviso aparece no log.
2. **Escopo desta fase = ModelManager** (Places/Leads ficam para a próxima
   sessão; a arquitetura já nasce preparada — `pick()` por capacidade).
3. **Formato `provider:modelo`** com tags `[+vision]` (variação segura do
   `+vision` aprovado: colchetes eliminam ambiguidade com ids reais).

## 11. Limitações conhecidas (aceitas nesta fase)

- Latência pior caso = soma dos timeouts da cadeia (abortável com Ctrl+C).
- `openai-compatible` como reserva usa o mesmo `MODEL_BASE_URL` do primário
  (um servidor OpenAI-compatível por `.env`).
- `MODEL_SYSTEM_MODE` é global (não por reserva).
- Cadeia mista de tools é rejeitada na inicialização (§5, regra 4).
- O painel de voz ainda não exibe `status()` da cadeia (só o label); a UI vem
  numa fase futura.

## 12. Próximas fases (roadmap, fora do escopo agora)

1. **Fase 2 — tools**: taxonomia já existente (`web_search`/`web_fetch` grátis;
   `computer` = navegador real por controle de tela). Só documentação.
2. **Fase 3 — Google Places/Leads**: camada desacoplada `src/places/` com
   interface `searchPlaces()` → `GooglePlacesProvider` (Places API New) +
   tool `find_places` no `TOOLS` (desligada por padrão; Google nunca
   obrigatório). Análise de presença digital com as tools de web existentes.
   Custos/limites verificados na documentação oficial na hora de implementar
   (Places exige faturamento ativo mesmo na franquia gratuita) + teto
   configurável de requisições.
3. **Fase 4 — multi-agente/multi-sessão**: base pronta (`pick()`, `status()`).
