// ELITE STRIKE X1 - servidor multiplayer autoritativo (Node.js + ws)
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

// ===== CONFIGURAÇÃO (precisa bater com o cliente) =====
const CFG = {
  meta: 5,            // eliminações para vencer
  hp: 200,            // vida inicial (igual ao MAXHP do jogo)
  contagem: 3,        // segundos de contagem regressiva
  respawnMs: 3000,    // tempo para reaparecer
  protecaoMs: 2500,   // proteção após reaparecer
  reconexaoMs: 15000, // tempo de espera por reconexão durante a partida
  maxSalas: 300,
  spawns: [[-20, 0, Math.PI / 2], [20, 0, -Math.PI / 2], [0, -22, 0], [0, 22, Math.PI]],
};
// Mesmos valores do array W do jogo: d=dano, r=alcance, rate=cadência(s), pel=projéteis
const ARMAS = [
  { d: 22, r: 70, rate: 0.28, pel: 1 },
  { d: 20, r: 120, rate: 0.11, pel: 1 },
  { d: 13, r: 70, rate: 0.07, pel: 1 },
  { d: 11, r: 28, rate: 0.8, pel: 8 },
  { d: 100, r: 260, rate: 1.3, pel: 1 },
  { d: 17, r: 110, rate: 0.08, pel: 1 },
];
const CAB = 2; // multiplicador de headshot (ES_CFG.headMult)

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("ELITE STRIKE X1 - Servidor online! Salas: " + salas.size);
});
const wss = new WebSocket.Server({ server, maxPayload: 2048 });
const salas = new Map();
const ALFA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const num = (v, a, b, d = 0) => (typeof v === "number" && isFinite(v) ? Math.min(b, Math.max(a, v)) : d);
const nome = (v) => String(v || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 14) || "Jogador";
const env = (ws, o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
const todos = (s, o) => s.j.forEach((p) => p && env(p.ws, o));
const erro = (ws, codigo, mensagem) => env(ws, { t: "erro", codigo, mensagem });

function novoCodigo() {
  let c;
  do { c = Array.from({ length: 5 }, () => ALFA[crypto.randomInt(ALFA.length)]).join(""); } while (salas.has(c));
  return c;
}
function novoJogador(ws, n) {
  return { ws, nome: n, token: crypto.randomBytes(8).toString("hex"), pronto: false, on: true,
    hp: CFG.hp, kills: 0, dead: false, protAte: 0, x: 0, y: 0, z: 0, yaw: 0, ult: 0, ultTiro: 0, ultId: 0, grace: null };
}
const pub = (s) => s.j.map((p, i) => p && { slot: i, nome: p.nome, pronto: p.pronto, on: p.on });
function lobby(s) { todos(s, { t: "lobby", codigo: s.codigo, fase: s.fase, jogadores: pub(s) }); }
function limpar(s) { clearTimeout(s.tc); s.j.forEach((p) => p && (clearTimeout(p.rt), clearTimeout(p.grace))); }
function remover(s) { limpar(s); salas.delete(s.codigo); }
const placar = (s) => s.j.map((p) => (p ? p.kills : 0));

function iniciarContagem(s) {
  if (s.fase !== "lobby" || s.j.some((p) => !p || !p.on || !p.pronto)) return;
  s.fase = "contagem";
  let n = CFG.contagem;
  const passo = () => {
    if (s.fase !== "contagem") return;
    if (n > 0) { todos(s, { t: "contagem", n }); n--; s.tc = setTimeout(passo, 1000); return; }
    try { comecar(s); } catch (e) { s.fase = "lobby"; s.j.forEach((p) => p && (p.pronto = false)); todos(s, { t: "erro", codigo: "inicio", mensagem: "Erro ao iniciar a partida." }); lobby(s); }
  };
  lobby(s); passo();
}
function comecar(s) {
  s.fase = "jogo";
  s.seed = crypto.randomInt(1, 2 ** 31 - 1);
  s.j.forEach((p, i) => {
    const sp = CFG.spawns[i];
    Object.assign(p, { hp: CFG.hp, kills: 0, dead: false, protAte: Date.now() + 2000, x: sp[0], y: 0, z: sp[1], yaw: sp[2], ultId: 0, ultTiro: 0 });
  });
  todos(s, { t: "inicio", seed: s.seed, meta: CFG.meta, hp: CFG.hp, spawns: CFG.spawns.slice(0, 2), jogadores: pub(s) });
}
function fim(s, vencedor, motivo) {
  if (s.fase !== "jogo") return;
  s.fase = "fim"; clearTimeout(s.tc);
  s.j.forEach((p) => p && (clearTimeout(p.rt), clearTimeout(p.grace), (p.pronto = false)));
  todos(s, { t: "fim", vencedor, motivo, placar: placar(s), jogadores: pub(s) });
}
function matar(s, alvo, autor) {
  const a = s.j[alvo], k = s.j[autor];
  a.dead = true; a.hp = 0; k.kills++;
  todos(s, { t: "morte", alvo, autor, placar: placar(s) });
  if (k.kills >= CFG.meta) return fim(s, autor, "meta");
  a.rt = setTimeout(() => {
    if (s.fase !== "jogo") return;
    const o = s.j[autor];
    let melhor = 0, d = -1;
    CFG.spawns.forEach((sp, i) => { const dd = Math.hypot(sp[0] - o.x, sp[1] - o.z); if (dd > d) { d = dd; melhor = i; } });
    const sp = CFG.spawns[melhor];
    Object.assign(a, { hp: CFG.hp, dead: false, x: sp[0], z: sp[1], y: 0, yaw: sp[2], protAte: Date.now() + CFG.protecaoMs });
    todos(s, { t: "respawn", slot: alvo, x: sp[0], z: sp[1], yaw: sp[2], hp: a.hp });
  }, CFG.respawnMs);
}

function aoReceberEstado(s, i, p, d) {
  if (s.fase !== "jogo" || p.dead) return;
  const agora = Date.now(), dt = Math.min(1, Math.max(0.02, (agora - (p.ult || agora - 50)) / 1000));
  p.ult = agora;
  let x = num(d.x, -148, 148, p.x), z = num(d.z, -148, 148, p.z);
  const dist = Math.hypot(x - p.x, z - p.z), max = 13 * dt + 1.2; // anti-teleporte/speedhack
  if (dist > max) { x = p.x + ((x - p.x) / dist) * max; z = p.z + ((z - p.z) / dist) * max; }
  p.x = x; p.z = z; p.y = num(d.y, -2, 60, p.y); p.yaw = num(d.yaw, -50, 50, p.yaw);
  const o = s.j[1 - i];
  if (o) env(o.ws, { t: "estado", s: i, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(3),
    pt: +num(d.pt, -1.5, 1.5).toFixed(2), f: num(d.f, 0, 31) | 0, w: num(d.w, 0, 5) | 0 });
}
function aoReceberTiro(s, i, p, d) {
  if (s.fase !== "jogo" || p.dead) return;
  const o = s.j[1 - i], wi = num(d.w, 0, 5) | 0, w = ARMAS[wi];
  if (!w || !o) return;
  const agora = Date.now(), id = d.id | 0;
  if (id <= p.ultId) return;                          // duplicado / repetido
  if (agora - p.ultTiro < w.rate * 1000 * 0.7) return; // cadência
  p.ultId = id; p.ultTiro = agora;
  env(o.ws, { t: "tiro", s: i, w: wi, dx: +num(d.dx, -1, 1).toFixed(3), dy: +num(d.dy, -1, 1).toFixed(3), dz: +num(d.dz, -1, 1).toFixed(3) });
  let n = num(d.n, 0, w.pel) | 0, h = num(d.h, 0, n) | 0;
  if (!n || o.dead || agora < o.protAte || agora < p.protAte) return;
  if (Math.hypot(o.x - p.x, o.z - p.z) > w.r + 6) return; // fora do alcance
  const dano = w.d * (n - h) + w.d * CAB * h;
  o.hp = Math.max(0, o.hp - dano);
  todos(s, { t: "dano", alvo: 1 - i, autor: i, hp: o.hp, dano, cab: h > 0 });
  if (o.hp <= 0) matar(s, 1 - i, i);
}
function sair(ws, aviso) {
  const s = ws.sala; if (!s) return;
  const i = ws.slot, p = s.j[i];
  ws.sala = null;
  if (!p || p.ws !== ws) return;
  if (s.fase === "jogo") { // espera reconexão
    p.on = false; p.ws = null;
    env(s.j[1 - i] && s.j[1 - i].ws, { t: "oponente_caiu", segundos: CFG.reconexaoMs / 1000 });
    if (aviso) return fim(s, 1 - i, "abandono");
    p.grace = setTimeout(() => fim(s, 1 - i, "desconexao"), CFG.reconexaoMs);
    return;
  }
  s.j[i] = null;
  if (s.fase === "contagem") { s.fase = "lobby"; clearTimeout(s.tc); }
  if (s.fase === "fim") s.fase = "lobby";
  if (!s.j[0] && !s.j[1]) return remover(s);
  s.j.forEach((q) => q && (q.pronto = false));
  env(s.j[0] ? s.j[0].ws : s.j[1].ws, { t: "oponente_saiu" });
  lobby(s);
}

wss.on("connection", (ws) => {
  ws.vivo = true; ws.tokens = 120; ws.ult = Date.now(); ws.abusos = 0;
  ws.on("pong", () => (ws.vivo = true));
  ws.on("message", (raw) => {
    const agora = Date.now();
    ws.tokens = Math.min(120, ws.tokens + ((agora - ws.ult) / 1000) * 80); ws.ult = agora;
    if (--ws.tokens < 0) { if (++ws.abusos > 20) ws.close(1008, "excesso"); return; }
    let d;
    try { d = JSON.parse(raw.toString()); } catch { return erro(ws, "invalida", "Mensagem inválida."); }
    if (!d || typeof d !== "object" || typeof d.t !== "string") return erro(ws, "invalida", "Mensagem inválida.");
    const s = ws.sala, p = s && s.j[ws.slot];
    switch (d.t) {
      case "ping": return env(ws, { t: "pong" });
      case "criar": {
        if (ws.sala) return erro(ws, "ja_em_sala", "Você já está em uma sala.");
        if (salas.size >= CFG.maxSalas) return erro(ws, "servidor_cheio", "Servidor lotado. Tente mais tarde.");
        const codigo = novoCodigo(), sala = { codigo, j: [null, null], fase: "lobby", criada: agora };
        const jog = novoJogador(ws, nome(d.nome)); sala.j[0] = jog; salas.set(codigo, sala);
        ws.sala = sala; ws.slot = 0;
        env(ws, { t: "sala_criada", codigo, slot: 0, token: jog.token });
        return lobby(sala);
      }
      case "entrar": {
        if (ws.sala) return erro(ws, "ja_em_sala", "Você já está em uma sala.");
        const codigo = String(d.codigo || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{5}$/.test(codigo)) return erro(ws, "codigo_invalido", "Código inválido. Use 5 letras/números.");
        const sala = salas.get(codigo);
        if (!sala) return erro(ws, "sala_inexistente", "Sala não encontrada.");
        const livre = sala.j.findIndex((q) => !q);
        if (livre < 0 || sala.fase !== "lobby") return erro(ws, "sala_cheia", sala.fase === "lobby" ? "Sala cheia." : "A partida já começou.");
        const jog = novoJogador(ws, nome(d.nome)); sala.j[livre] = jog; ws.sala = sala; ws.slot = livre;
        env(ws, { t: "sala_entrou", codigo, slot: livre, token: jog.token });
        return lobby(sala);
      }
      case "reconectar": {
        const sala = salas.get(String(d.codigo || "").toUpperCase());
        const i = sala ? sala.j.findIndex((q) => q && q.token === d.token && !q.on) : -1;
        if (i < 0 || sala.fase !== "jogo") return erro(ws, "reconexao_falhou", "Não foi possível voltar para a partida.");
        const q = sala.j[i]; clearTimeout(q.grace); q.ws = ws; q.on = true; ws.sala = sala; ws.slot = i;
        env(ws, { t: "retomar", slot: i, seed: sala.seed, meta: CFG.meta, placar: placar(sala),
          eu: { hp: q.hp, dead: q.dead }, op: { hp: sala.j[1 - i].hp, dead: sala.j[1 - i].dead }, jogadores: pub(sala) });
        return env(sala.j[1 - i] && sala.j[1 - i].ws, { t: "oponente_voltou" });
      }
      case "pronto": if (!s || !p || s.fase !== "lobby") return; p.pronto = !!d.v; lobby(s); return iniciarContagem(s);
      case "revanche": if (!s || !p || s.fase !== "fim") return; p.pronto = true;
        if (s.j.every((q) => q && q.on && q.pronto)) { s.fase = "lobby"; return iniciarContagem(s); }
        return todos(s, { t: "lobby", codigo: s.codigo, fase: "fim", jogadores: pub(s) });
      case "estado": return p && aoReceberEstado(s, ws.slot, p, d);
      case "tiro": return p && aoReceberTiro(s, ws.slot, p, d);
      case "sair": return sair(ws, true);
      default: return erro(ws, "invalida", "Mensagem desconhecida.");
    }
  });
  ws.on("close", () => sair(ws, false));
  ws.on("error", () => {});
});

setInterval(() => { // batimento: derruba conexões mortas e limpa salas paradas
  wss.clients.forEach((ws) => { if (!ws.vivo) return ws.terminate(); ws.vivo = false; try { ws.ping(); } catch {} });
  const agora = Date.now();
  salas.forEach((s) => { if (agora - s.criada > 3 * 3600e3 || (!s.j[0] && !s.j[1])) remover(s); });
}, 20000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`ELITE STRIKE X1 online na porta ${PORT}`));