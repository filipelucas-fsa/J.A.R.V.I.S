// Servidor que imita o formato do Kokoro-FastAPI / OpenAI para voz: POST /v1/audio/speech e GET /v1/audio/voices.
import http from "node:http";

export async function startMockKokoro({ audio = Buffer.from("MP3-FAKE-AUDIO"), voices = ["pf_dora", "pm_alex", "pm_santa", "af_bella"], apiKey = null, status = 200, errorBody, hang = false, destroy = false, voicesShape = "objects" } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined });
      if (hang) return;
      if (destroy) return req.socket.destroy();
      if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid key" } }));
      }
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody ?? { detail: "erro simulado" }));
      }
      if (req.method === "GET" && req.url === "/v1/audio/voices") {
        const list = voicesShape === "strings" ? voices : voicesShape === "array" ? voices.map((id) => ({ id })) : { voices: voices.map((id) => ({ id })) };
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(voicesShape === "strings" ? { voices: list } : list));
      }
      if (req.method === "POST" && req.url === "/v1/audio/speech") {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        return res.end(audio);
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not Found" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
