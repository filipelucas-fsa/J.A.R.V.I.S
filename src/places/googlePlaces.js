// Camada de lugares: busca de estabelecimentos no Google (Places API "New" — Text Search).
// Desacoplada de propósito: o agente só conhece searchPlaces(); trocar o Google por
// outra fonte no futuro não muda a ferramenta nem o resto do Jarvis.
//
// Custos (ver docs/plano-places-leads.md): a busca é cobrada POR REQUISIÇÃO (não por
// resultado); o field mask abaixo inclui telefone/site/avaliação → SKU "Text Search
// Enterprise + Atmosphere": 1.000 buscas grátis por mês, depois US$ 40 por 1.000.
// A API exige projeto Google Cloud com faturamento ativo.

const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const MAX_RESULTS = 10; // teto por busca (a API aceita até 20; 10 basta para leads)
const MAX_QUERY_CHARS = 400;

// O field mask escolhe os campos — e é ele que define o SKU cobrado.
const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.primaryTypeDisplayName",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
  "places.businessStatus",
].join(",");

// Nomes amigáveis para os status que o Google devolve.
export const BUSINESS_STATUS_NAMES = {
  OPERATIONAL: "funcionando",
  CLOSED_TEMPORARILY: "fechado temporariamente",
  CLOSED_PERMANENTLY: "fechado definitivamente",
};

// Devolve o modelo de lugar normalizado: campos ausentes viram "" (ou null p/ nota).
function normalizePlace(place) {
  return {
    name: place?.displayName?.text ?? "",
    category: place?.primaryTypeDisplayName?.text ?? "",
    address: place?.formattedAddress ?? "",
    phone: place?.nationalPhoneNumber ?? "",
    website: place?.websiteUri ?? "",
    rating: typeof place?.rating === "number" ? place.rating : null,
    reviews: typeof place?.userRatingCount === "number" ? place.userRatingCount : null,
    mapsUri: place?.googleMapsUri ?? "",
    status: place?.businessStatus ?? "",
  };
}

// Erros do Google: { error: { code, message, status } } — cada um com orientação própria.
function describePlacesError(json, status) {
  const detail = String(json?.error?.message ?? "").slice(0, 300);
  if (status === 400) return `A busca foi recusada pelo Google (400): ${detail}. Simplifique a busca e tente de novo.`;
  if (status === 403) {
    return `Chave do Google Places inválida ou sem permissão (403): confira GOOGLE_PLACES_API_KEY e se a "Places API (New)" está habilitada no seu projeto do Google Cloud. Detalhe: ${detail}`;
  }
  if (status === 429) {
    return `Cota do Google Places atingida (429): verifique limites e faturamento no console do Google Cloud. Detalhe: ${detail}`;
  }
  if (status >= 500) return `Erro no servidor do Google Places (${status}). Tente novamente em instantes. Detalhe: ${detail}`;
  return `Erro do Google Places (${status}): ${detail}`;
}

// fetchImpl é injetável (os testes usam servidor local); timeout por busca; signal = Ctrl+C.
export function createGooglePlacesProvider({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15_000, language } = {}) {
  if (!apiKey) {
    throw new Error("TOOLS=places exige GOOGLE_PLACES_API_KEY no .env (Places API \"New\" do Google). Veja docs/plano-places-leads.md para custos.");
  }

  async function searchPlaces({ query, maxResults = 5, signal } = {}) {
    const texto = String(query ?? "").trim();
    if (texto === "") throw new Error("A busca não pode ser vazia. Diga o que e onde procurar (ex.: 'barbearias em Feira de Santana').");
    if (texto.length > MAX_QUERY_CHARS) throw new Error(`A busca é longa demais (máximo ${MAX_QUERY_CHARS} caracteres).`);
    const count = Math.max(1, Math.min(Number(maxResults) || 5, MAX_RESULTS));

    const body = { textQuery: texto, maxResultCount: count };
    if (language) body.languageCode = language;

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response;
    try {
      response = await fetchImpl(TEXT_SEARCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error("A busca no Google Places foi cancelada pelo usuário.");
      if (timeoutSignal.aborted) throw new Error(`Tempo esgotado (${Math.round(timeoutMs / 1000)}s) ao consultar o Google Places. Tente de novo.`);
      throw new Error(`Não foi possível conectar ao Google Places: ${error?.cause?.code ?? error?.message ?? error}`);
    }

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("O Google Places respondeu algo que não é JSON. Tente novamente; se persistir, confira a região da chave no console do Google Cloud.");
    }

    if (!response.ok) throw new Error(describePlacesError(json, response.status));

    const places = Array.isArray(json.places) ? json.places : [];
    return places.map(normalizePlace);
  }

  return { searchPlaces, label: "Google Places" };
}
