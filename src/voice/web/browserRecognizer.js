// Adaptador do reconhecimento de voz do navegador (Web Speech API, disponível no Chrome e no Edge).
// ATENÇÃO à privacidade: nesses navegadores o áudio é enviado ao serviço de voz do fabricante (Google/Microsoft)
// enquanto o microfone está ligado. O botão de mudo do painel desliga isso.
//
// Mantém o reconhecimento sempre ativo: o navegador encerra a sessão sozinho de tempos em tempos,
// então reiniciamos (com espera crescente se ficar reiniciando rápido demais).
export function createBrowserRecognizer({
  SpeechRecognitionCtor, lang = "pt-BR", onResults, onSessionEnd, onFatal, onNotice = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), now = () => Date.now(),
}) {
  let recognition = null;
  let wanted = false;
  let restartTimer = null;
  let shortSessions = 0;
  let startedAt = 0;

  function begin() {
    restartTimer = null;
    if (recognition || !wanted) return;
    const current = new SpeechRecognitionCtor();
    recognition = current;
    current.lang = lang;
    current.continuous = true;
    current.interimResults = true;
    current.maxAlternatives = 1;

    current.onresult = (event) => {
      onResults(Array.from(event.results, (result) => ({ text: result[0]?.transcript ?? "", isFinal: Boolean(result.isFinal) })));
    };
    current.onerror = (event) => {
      switch (event.error) {
        case "not-allowed":
        case "service-not-allowed":
          wanted = false;
          onFatal("Permissão do microfone negada. Permita o microfone para este endereço nas configurações do navegador e recarregue.");
          break;
        case "audio-capture":
          wanted = false;
          onFatal("Nenhum microfone foi encontrado ou ele está em uso por outro programa.");
          break;
        case "language-not-supported":
          wanted = false;
          onFatal(`O navegador não suporta o idioma '${lang}' no reconhecimento de voz (VOICE_LANG).`);
          break;
        case "network":
          onNotice("Sem conexão com o serviço de reconhecimento de voz do navegador. Tentando de novo…");
          break;
        default:
          break; // "no-speech" e "aborted" são normais: o onend cuida do reinício
      }
    };
    current.onend = () => {
      if (recognition === current) recognition = null;
      onSessionEnd();
      if (!wanted) return;
      shortSessions = now() - startedAt < 1000 ? shortSessions + 1 : 0;
      const delay = Math.min(300 * 2 ** Math.min(shortSessions, 4), 5000);
      restartTimer = setTimer(begin, delay);
    };

    startedAt = now();
    try {
      current.start();
    } catch (error) {
      recognition = null;
      if (!/already started/i.test(String(error?.message))) {
        wanted = false;
        onFatal(`Não foi possível iniciar o reconhecimento de voz: ${error?.message ?? error}`);
      }
    }
  }

  return {
    start() {
      wanted = true;
      begin();
    },
    stop() {
      wanted = false;
      if (restartTimer !== null) clearTimer(restartTimer);
      restartTimer = null;
      try {
        recognition?.abort?.();
      } catch {
        // já parado
      }
    },
    // Encerra a sessão atual (o onend reinicia sozinho): descarta o eco que ficou acumulado nela.
    restart() {
      if (!wanted) return;
      try {
        recognition?.abort?.();
      } catch {
        // já parado
      }
    },
    get running() {
      return wanted;
    },
  };
}
