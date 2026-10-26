const http = require("http");
const WebSocket = require("ws");

const server = http.createServer((req, res) => {
res.writeHead(200, { "Content-Type": "text/plain" });
res.end("ELITE STRIKE X1 - Servidor online!");
});

const wss = new WebSocket.Server({ server });

const salas = new Map();

function enviar(sala, dados) {
for (const jogador of sala.jogadores) {
if (jogador.readyState === WebSocket.OPEN) {
jogador.send(JSON.stringify(dados));
}
}
}

wss.on("connection", (ws) => {
ws.on("message", (mensagem) => {
let dados;

try {
  dados = JSON.parse(mensagem.toString());
} catch {
  ws.send(JSON.stringify({ tipo: "erro", mensagem: "Mensagem inválida." }));
  return;
}

if (dados.tipo === "criar_sala") {
  let codigo;

  do {
    codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (salas.has(codigo));

  const sala = { jogadores: [ws] };
  salas.set(codigo, sala);

  ws.salaCodigo = codigo;
  ws.send(JSON.stringify({ tipo: "sala_criada", codigo }));
  return;
}

if (dados.tipo === "entrar_sala") {
  const codigo = String(dados.codigo || "").trim().toUpperCase();
  const sala = salas.get(codigo);

  if (!sala) {
    ws.send(JSON.stringify({ tipo: "erro", mensagem: "Sala não encontrada." }));
    return;
  }

  if (sala.jogadores.length >= 2) {
    ws.send(JSON.stringify({ tipo: "erro", mensagem: "Sala cheia." }));
    return;
  }

  sala.jogadores.push(ws);
  ws.salaCodigo = codigo;

  enviar(sala, { tipo: "jogador_conectado", jogadores: sala.jogadores.length });
  return;
}

if (dados.tipo === "estado_jogo") {
  const sala = salas.get(ws.salaCodigo);
  if (!sala) return;

  for (const jogador of sala.jogadores) {
    if (jogador !== ws && jogador.readyState === WebSocket.OPEN) {
      jogador.send(JSON.stringify({
        tipo: "estado_jogo",
        estado: dados.estado
      }));
    }
  }
}

});

ws.on("close", () => {
const codigo = ws.salaCodigo;
if (!codigo) return;

const sala = salas.get(codigo);
if (!sala) return;

sala.jogadores = sala.jogadores.filter((jogador) => jogador !== ws);

if (sala.jogadores.length === 0) {
  salas.delete(codigo);
} else {
  enviar(sala, { tipo: "jogador_desconectado" });
}

});
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
console.log("ELITE STRIKE X1 online na porta ${PORT}");
});