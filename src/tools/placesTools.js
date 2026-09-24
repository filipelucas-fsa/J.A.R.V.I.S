// Ferramenta de lugares: o agente pesquisa estabelecimentos no Google Places.
// Opt-in: só é registrada com TOOLS=...,places E GOOGLE_PLACES_API_KEY no .env —
// sem isso, a ferramenta não existe e o Jarvis funciona normalmente.
// A análise de presença digital fica com web_search/web_fetch (grátis), na sequência.
import { createGooglePlacesProvider, BUSINESS_STATUS_NAMES } from "../places/googlePlaces.js";

const MAX_RESULTS = 10;

export function createPlacesTools({ apiKey, fetchImpl, language, timeoutMs } = {}) {
  const provider = createGooglePlacesProvider({ apiKey, fetchImpl, language, timeoutMs });

  const findPlaces = {
    name: "find_places",
    description:
      "Pesquisa estabelecimentos (empresas, comércios, serviços) no Google Places e devolve uma lista com nome, categoria, endereço, telefone e site, quando disponíveis. " +
      "Inclua o tipo de negócio E a cidade/região na busca (ex.: 'barbearias em Feira de Santana'). " +
      "Cada busca é uma requisição paga da API do Google (cerca de US$ 0,04; 1.000 por mês são grátis): peça vários resultados de uma vez e evite repetir buscas parecidas. " +
      "Para avaliar a presença digital de cada estabelecimento depois, use web_search e web_fetch.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          maxLength: 400,
          description: "O que e onde buscar (ex.: 'escritórios de contabilidade em Feira de Santana').",
        },
        max_results: { type: "integer", minimum: 1, maximum: MAX_RESULTS, description: "Quantos estabelecimentos devolver (padrão: 5)." },
      },
      required: ["query"],
    },

    async execute({ query, max_results = 5 }, { signal } = {}) {
      const places = await provider.searchPlaces({ query, maxResults: max_results, signal });
      if (places.length === 0) {
        return `A busca por "${query}" não encontrou estabelecimentos. Tente outros termos ou uma região maior.`;
      }

      const lines = [`Estabelecimentos encontrados para "${query}" (Google Places):`];
      for (const [index, place] of places.entries()) {
        lines.push(
          `${index + 1}. ${place.name || "(sem nome)"}`,
          `   Categoria: ${place.category || "não informada"}`,
          `   Endereço: ${place.address || "não informado"}`,
          `   Telefone: ${place.phone || "não encontrado"}`,
          `   Website: ${place.website || "não encontrado"}`,
          ...(place.rating !== null ? [`   Avaliação: ${place.rating} (${place.reviews} avaliações)`] : []),
          ...(place.mapsUri ? [`   Mapa: ${place.mapsUri}`] : []),
          ...(place.status && place.status !== "OPERATIONAL"
            ? [`   Status: ${BUSINESS_STATUS_NAMES[place.status] ?? place.status}`]
            : []),
        );
      }
      lines.push(
        "Dica: 'Website não encontrado' é um forte indício de presença digital fraca. " +
          "Use web_search para checar redes sociais e web_fetch para ler o site antes de concluir qualquer análise."
      );
      return lines.join("\n");
    },
  };

  return [findPlaces];
}
