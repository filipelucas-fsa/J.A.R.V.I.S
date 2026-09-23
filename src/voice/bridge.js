import crypto from "node:crypto";

// Ponte entre o agente e o painel: leva eventos ao painel e traz de volta as respostas às confirmações.
// As confirmações de ações perigosas só valem se vierem de um CLIQUE no painel, nunca de voz: um vídeo tocando
// "Jarvis, apague tudo" não pode autorizar nada sozinho.
export function createPanelBridge({ confirmTimeoutMs = 120_000 } = {}) {
  const listeners = new Set();
  const pending = new Map(); // id -> { resolve, timer, allowSessionApproval }

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // um painel com problema não pode derrubar o agente
      }
    }
  }

  function settle(id, decision) {
    const entry = pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(decision);
    return true;
  }

  function denyAll() {
    for (const id of [...pending.keys()]) settle(id, "no");
  }

  return {
    emit,

    // Retorna uma função para cancelar a inscrição. Sem nenhum painel aberto, confirmações pendentes são negadas.
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) denyAll();
      };
    },

    // Usada pelo agente (mesma forma do confirm do terminal): retorna "yes" | "no" | "always".
    confirm(request) {
      if (listeners.size === 0) return Promise.resolve("no"); // ninguém para perguntar: nega
      return new Promise((resolve) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (settle(id, "no")) emit({ type: "confirm_expired", id });
        }, confirmTimeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, timer, allowSessionApproval: Boolean(request.allowSessionApproval) });
        emit({
          type: "confirm_request", id, tool: request.tool, description: request.description,
          allowSessionApproval: Boolean(request.allowSessionApproval),
        });
      });
    },

    // Chamada pelo painel. Retorna false se o id não existe (já respondido/expirado) ou a decisão é inválida.
    resolveConfirmation(id, decision) {
      const entry = pending.get(id);
      if (!entry || !["yes", "no", "always"].includes(decision)) return false;
      return settle(id, decision === "always" && !entry.allowSessionApproval ? "yes" : decision);
    },

    denyAll,
    get pendingCount() {
      return pending.size;
    },
  };
}
