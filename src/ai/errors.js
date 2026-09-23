// Erro com mensagem já em linguagem clara para o usuário (usado por todos os provedores de IA).
export class ModelError extends Error {
  constructor(message, { status, type, retryable = false, requestId, cause } = {}) {
    super(message, { cause });
    this.name = "ModelError";
    this.status = status;
    this.type = type;
    this.retryable = retryable;
    this.requestId = requestId;
  }
}
