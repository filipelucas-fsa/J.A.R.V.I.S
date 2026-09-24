# AI Computer Agent

Agente de IA que lê e edita arquivos, executa comandos e (opcionalmente) controla mouse e teclado, **sempre pedindo
permissão** para o que é perigoso. Funciona com **qualquer modelo** que ofereça a API da Anthropic ou uma API no formato
OpenAI (NVIDIA, OpenAI, Ollama, LM Studio, vLLM, Groq, OpenRouter...), e pode ser chamado **por voz** ("Jarvis...").

## Instalação

```
npm install
cp .env.example .env      # depois edite o .env
npm test                  # confere que tudo está funcionando (não gasta a sua API)
```

Requer Node 20.6 ou superior.

## Usando com a NVIDIA (passo a passo)

1. Gere uma chave em https://build.nvidia.com (começa com `nvapi-`).
2. No `.env`:
   ```
   MODEL_PROVIDER=nvidia
   NVIDIA_API_KEY=nvapi-...
   MODEL_NAME=meta/llama-3.1-70b-instruct
   ```
3. Teste a chave e veja os modelos disponíveis: `npm run models` (aceita filtro: `npm run models llama`).
4. Rode: `npm start "Leia meu package.json e diga quais dependências estão instaladas"`.
5. Modo voz: `npm run voice` e diga **"Jarvis, ..."**.

Cuidados com a NVIDIA:
- **Nem todo modelo aceita chamada de ferramentas.** Se aparecer erro 400 falando de *tools*, escolha outro modelo ou use
  `MODEL_TOOLS=false` (o agente só conversa, sem mexer em arquivos).
- Erro **404** costuma significar que o modelo não está habilitado na sua conta (ou o nome está errado).
- Para o controle de tela (`TOOLS=computer`) o modelo precisa aceitar imagens: `MODEL_VISION=true`.

## Cadeia de modelos (fallback automático)

Opcional: se o modelo principal falhar de forma **temporária** (429 limite de uso, timeout, erro do servidor,
404 modelo indisponível), o Jarvis tenta automaticamente os modelos reserva configurados em `FALLBACK_MODELS`:

```
FALLBACK_MODELS=nvidia:meta/llama-3.3-70b-instruct,nvidia:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning[+vision],ollama:llama3.1
```

- Formato de cada entrada: `provider:modelo` (separadas por vírgula). O primeiro `:` separa o provider — o id do
  modelo pode conter `/`, como `meta/llama-3.3-70b-instruct`.
- Tags opcionais entre colchetes: `[+vision]` (aceita imagens), `[-tools]` (não usa ferramentas).
- Cada provider usa a chave já definida no `.env` (`NVIDIA_API_KEY`, `ANTHROPIC_API_KEY`, …).
- Reserva do **mesmo provider** do principal usa o mesmo endereço (`MODEL_BASE_URL`) — serve para NIM local/LM Studio.
- O modelo que falha entra em **cooldown** (descanso de 60 s por padrão, dobra a cada falha seguida): durante o
  descanso as requisições vão para o próximo; depois ele volta ao topo da preferência. `MODEL_COOLDOWN_SECONDS=0` desliga.
- Erros de **chave/configuração** (401/402/403, 400 de compatibilidade) **não** trocam de modelo: falham na hora com
  a mensagem de sempre, para você corrigir o `.env` — trocar de modelo só esconderia o problema.
- Com `TOOLS=computer`, reservas sem visão ficam desativadas (screenshots no histórico exigem um modelo que "veja").
- Sem `FALLBACK_MODELS`, o comportamento é exatamente o de antes: um único modelo.

Detalhes técnicos e decisões: `docs/plano-model-manager.md`.

## Modo voz

`npm run voice` abre uma janelinha (o "painel") e fica escutando.

1. Diga a palavra-chave e a tarefa: **"Jarvis, liste os arquivos da pasta"**. O painel mostra o que você fala em tempo real.
2. **Após 10 s sem você falar**, a mensagem é enviada (ou clique em *Enviar agora*; *Esc* cancela).
3. Como você chamou por voz, o agente **responde em voz alta** (pt-BR). Se você digitar, ele só fala se ativar
   *Digitado: com voz*. O botão 🔊 liga/desliga a voz; **falar por cima interrompe** o agente.
4. Ações perigosas (escrever arquivo, comandos, mouse/teclado) aparecem em **AUTORIZAÇÃO NECESSÁRIA** e só valem com um
   **clique**: dizer "sim" em voz alta não autoriza nada.
5. A conversa tem memória; *↺* inicia uma nova.

Requisitos: **Chrome ou Edge** (o reconhecimento de voz usa o navegador). No Windows o Edge tem as vozes em pt-BR mais
naturais. **Privacidade:** nesses navegadores o áudio vai ao serviço de voz do fabricante enquanto o microfone está ligado
(botão 🎙️ desliga). Use fones de ouvido se o eco dos alto-falantes atrapalhar.

### Voz do agente
- **Padrão:** voz do navegador (grátis, nada a instalar).
- **Melhor qualidade (opcional):** um servidor **Kokoro** local (grátis). Suba o Kokoro-FastAPI (projeto `remsky/Kokoro-FastAPI`,
  porta 8880), ponha `TTS_PROVIDER=kokoro` no `.env` e use `npm run voices` para escolher a voz. Se o servidor cair, o painel
  volta sozinho para a voz do navegador.

## Segurança em resumo
- Arquivos ficam restritos ao `WORKSPACE_DIR`; `.env`, `.git`, `.ssh` e chaves são bloqueados.
- Escrever, editar, comandos, tela, mouse e teclado **sempre pedem permissão**; sem como perguntar, a ação é **negada**.
- Comandos de terminal **não** ficam restritos ao workspace: leia o comando antes de autorizar.
- O painel de voz só escuta em `127.0.0.1`, exige token secreto (impresso no terminal) e recusa outros sites.
- Log de tudo que o agente tenta fazer: `~/.ai-computer-agent/actions.jsonl` (texto digitado por teclado não é gravado).

## Problemas comuns
| Sintoma | O que fazer |
|---|---|
| `Chave de API inválida (401)` | Confira a chave e o `MODEL_PROVIDER` no `.env`. |
| `Modelo ou endereço não encontrado (404)` | `npm run models`; confira `MODEL_NAME` e `MODEL_BASE_URL` (termina em `/v1`). |
| Erro 400 sobre *tools* | Modelo sem ferramentas: troque de modelo ou `MODEL_TOOLS=false`. |
| Erro 400 sobre *system role* | `MODEL_SYSTEM_MODE=inline`. |
| `Limite de uso/taxa atingido (429)` | Com `FALLBACK_MODELS` o Jarvis tenta a reserva sozinho; sem reserva, espere um pouco. |
| `FALLBACK_MODELS: provider ... desconhecido` | Use um dos providers válidos: anthropic, nvidia, openai, ollama, openai-compatible. |
| Painel não abre | Instale Chrome/Edge ou defina `VOICE_BROWSER`; ou abra manualmente o endereço impresso no terminal. |
| "Permissão do microfone negada" | Permita o microfone para o painel nas configurações do navegador. |
| O agente não fala | Clique uma vez no painel (o navegador bloqueia som antes disso) e confira o botão 🔊. |
| Ele se interrompe sozinho | Use fones de ouvido ou `VOICE_BARGE_IN=wake`. |
| Não reconhece "Jarvis" | Adicione variações em `WAKE_WORDS` (ex.: `jarvis,jarves`). |
