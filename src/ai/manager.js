// ModelManager: a camada entre o agente e os modelos. O agente continua chamando
// ask(messages, { system, tools, signal }) como se houvesse um único modelo; este
// arquivo decide QUAL modelo responde, faz fallback quando um falha de forma
// temporária e aplica "cooldown" (descanso) nos modelos que falharam.
//
// Regras de fallback (a classificação dos erros já vem pronta dos adaptadores,
// que usam ModelError com retryable/status):
//   - 429 / 5xx / timeout / conexão → próximo modelo + cooldown no que falhou
//   - 404 (modelo indisponível para a conta) → próximo modelo, com aviso
//   - 400 / 401 / 402 / 403 / 413 → falha na hora (configuração/compatibilidade:
//     trocar de modelo só esconderia o problema)
//   - cancelamento do usuário → propagado, nunca faz fallback
import { ModelError } from "./errors.js";

// Pode trocar de modelo por causa deste erro? (temporário/indisponibilidade = sim)
export function isFallbackEligible(error) {
  if (!(error instanceof ModelError)) return false; // erro inesperado: bug, não esconda
  if (error.retryable) return true; // 429, 5xx, timeout, conexão
  if (error.status === 404) return true; // problema deste modelo específico (não da config global)
  return false; // 400/401/402/403/413: configuração ou compatibilidade
}

const MAX_COOLDOWN_GROWTH = 8; // falhas seguidas dobram o descanso, até 8× o tempo base

export class ModelManager {
  // entries: [{ instance, config, disabled }] — instance: adaptador com ask() (Model/OpenAICompatibleModel)
  // clock: { now() } injetável (os testes usam o relógio controlável); log: registra trocas e cooldowns.
  constructor({ entries, cooldownSeconds = 60, cooldownMaxSeconds = 900, log = () => {}, clock } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("ModelManager precisa de pelo menos um modelo na cadeia.");
    }
    this.entries = entries.map((entry) => ({ disabled: false, ...entry, cooldownUntil: 0, consecutiveCooldownFails: 0, lastError: null }));
    this.cooldownSeconds = cooldownSeconds;
    this.cooldownMaxSeconds = cooldownMaxSeconds;
    this.log = log;
    this.clock = clock;

    const reserve = this.entries.length - 1;
    // Cadeia de 1 modelo: label idêntico ao do adaptador puro (nada muda para quem não usa fallback).
    this.label =
      reserve === 0 ? this.entries[0].instance.label : `${this.entries[0].instance.label} (+${reserve} ${reserve > 1 ? "reservas" : "reserva"})`;
    this.capabilities =
      this.entries[0].instance.capabilities ?? { vision: this.entries[0].config?.vision ?? false, tools: this.entries[0].config?.tools ?? true };
  }

  // Mesma interface dos adaptadores. Devolve a resposta do modelo que atendeu.
  async ask(messages, options = {}) {
    const candidates = this.#candidates();
    const failures = [];

    for (let i = 0; i < candidates.length; i++) {
      const entry = candidates[i];
      if (options.signal?.aborted) throw new ModelError("Requisição cancelada.");

      try {
        const response = await entry.instance.ask(messages, options);
        this.#succeed(entry);
        return response;
      } catch (error) {
        if (!(error instanceof ModelError)) throw error; // não era erro de API: propague o bug
        if (options.signal?.aborted) throw error; // usuário cancelou no meio: não tente outro modelo
        failures.push({ label: entry.instance.label, error });

        if (!isFallbackEligible(error)) {
          // erro de configuração/compatibilidade: falha na hora, com a mensagem original
          throw failures.length === 1 ? error : this.#aggregateError(failures);
        }
        this.#cooldown(entry, error);
        const next = i + 1 < candidates.length ? "tentando o próximo da cadeia" : "sem mais modelos na cadeia";
        this.log(`[modelo] ${entry.instance.label} falhou (${this.#reason(error)}); ${next}.`);
      }
    }

    // cadeia esgotada: com uma única tentativa devolve o erro original (compatibilidade total)
    throw failures.length === 1 ? failures[0].error : this.#aggregateError(failures);
  }

  // Ordem de tentativa: primário primeiro, pulando desativados e em cooldown.
  // Todos em cooldown? Melhor esforço: tenta o que volta mais cedo (nunca trava sem tentar).
  #candidates() {
    const active = this.entries.filter((entry) => !entry.disabled);
    if (active.length === 0) throw new ModelError("Nenhum modelo disponível na cadeia (todos desativados).");
    const now = this.#now();
    const ready = active.filter((entry) => entry.cooldownUntil <= now);
    if (ready.length > 0) return ready;
    return [...active].sort((a, b) => a.cooldownUntil - b.cooldownUntil);
  }

  #now() {
    return this.clock ? this.clock.now() : Date.now();
  }

  #succeed(entry) {
    entry.cooldownUntil = 0;
    entry.consecutiveCooldownFails = 0;
    entry.lastError = null;
  }

  // Falha temporária → descanso. Honra o retry-after do servidor (429); falhas seguidas
  // dobram o tempo (60s → 120s → 240s…), com teto em cooldownMaxSeconds. 0 = desligado.
  #cooldown(entry, error) {
    const maxMs = this.cooldownMaxSeconds * 1000;
    const baseMs = Math.min(error.retryAfterMs ?? this.cooldownSeconds * 1000, maxMs);
    const growth = Math.min(2 ** entry.consecutiveCooldownFails, MAX_COOLDOWN_GROWTH);
    const ms = Math.min(baseMs * growth, maxMs);
    entry.cooldownUntil = this.#now() + ms;
    entry.consecutiveCooldownFails += 1;
    entry.lastError = error;
  }

  #reason(error) {
    if (error.status === 429) return "limite de uso (429)";
    if (error.status === 404) return "modelo não disponível (404)";
    if (error.retryable) return "erro temporário";
    return `erro ${error.status ?? "desconhecido"}`;
  }

  // Erro final quando mais de um modelo foi tentado: o corpo é a falha do primeiro
  // (o modelo principal), as reservas entram como resumo entre colchetes.
  #aggregateError(failures) {
    const [first, ...rest] = failures;
    const summary = rest.map(({ label, error }) => `${label}: ${error.message}`).join("\n");
    const message =
      rest.length === 0 ? first.error.message : `${first.error.message}\n[Modelos reserva também falharam:\n${summary}\n]`;
    const last = failures.at(-1).error;
    return new ModelError(message, {
      status: first.error.status,
      type: first.error.type,
      retryable: last.retryable,
      requestId: first.error.requestId,
      cause: first.error,
    });
  }

  // Estado de cada modelo da cadeia (para exibição e diagnóstico).
  status() {
    const now = this.#now();
    return this.entries.map((entry, index) => ({
      position: index + 1,
      label: entry.instance.label,
      state: entry.disabled ? "disabled" : entry.cooldownUntil > now ? "cooldown" : "active",
      cooldownSecondsLeft: entry.disabled || entry.cooldownUntil <= now ? 0 : Math.ceil((entry.cooldownUntil - now) / 1000),
      lastError: entry.lastError?.message ?? null,
    }));
  }

  // Seleção por capacidade (preparação para futuras escolhas por tarefa, ex.: visão).
  // Devolve os adaptadores disponíveis (fora de cooldown e não desativados).
  pick({ vision, tools } = {}) {
    const now = this.#now();
    return this.entries
      .filter((entry) => !entry.disabled && entry.cooldownUntil <= now)
      .filter((entry) => vision === undefined || Boolean(entry.instance.capabilities?.vision) === vision)
      .filter((entry) => tools === undefined || Boolean(entry.instance.capabilities?.tools) === tools)
      .map((entry) => entry.instance);
  }
}
