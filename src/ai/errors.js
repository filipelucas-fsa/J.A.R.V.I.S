// Erro com mensagem já em linguagem clara para o usuário (usado por todos os provedores de IA).
// retryAfterMs: quando o servidor pede um tempo de espera (429 + retry-after), em milissegundos.
export class ModelError extends Error {
  constructor(message, { status, type, retryable = false, requestId, retryAfterMs, cause } = {}) {
    super(message, { cause });
    this.name = "ModelError";
    this.status = status;
    this.type = type;
    this.retryable = retryable;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
  }
}
