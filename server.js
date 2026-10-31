// ELITE STRIKE X1 — servidor multiplayer + pesquisa de ID + sistema de amigos
// Node.js 18+ | Dependência: ws (^8.18.0)
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const CFG = {
  meta: 5, hp: 200, contagem: 3, respawnMs: 3000, protecaoMs: 2500,
  reconexaoMs: 15000, maxSalas: 300,
  spawns: [[-20, 0, Math.PI / 2], [20, 0, -Math.PI / 2], [0, -22, 0], [0, 22, Math.PI]],
};
const ARMAS = [
  { d: 22, r: 70, rate: 0.28, pel: 1 }, { d: 20, r: 120, rate: 0.11, pel: 1 },
  { d: 13, r: 70, rate: 0.07, pel: 1 }, { d: 11, r: 28, rate: 0.8, pel: 8 },
  { d: 100, r: 260, rate: 1.3, pel: 1 }, { d: 17, r: 110, rate: 0.08, pel: 1 },
];
const CAB = 2;
const salas = new Map();
// Atenção: perfis e amizades ficam em memória e somem quando o processo reinicia.
// Para contas permanentes, será necessário banco de dados e autenticação.
const perfis = new Map();

// ===== BR ONLINE - FILA GLOBAL DE 10 SEGUNDOS (isolada das salas X1) =====
const brSalas = new Map();
let brSeq = 0;
const BR_MAX_HUMANOS = 50;
const BR_TOTAL_JOGADORES = 50;
const BR_ESPERA_MS = 10000;
const BR_ARMAS = [
  { d: 22, r: 70, rate: 0.28 }, { d: 25, r: 120, rate: 0.13 },
  { d: 14, r: 75, rate: 0.075 }, { d: 11, r: 30, rate: 0.8 },
  { d: 100, r: 260, rate: 1.3 }, { d: 48, r: 190, rate: 0.48 },
  { d: 22, r: 125, rate: 0.12 },
];
function brPublico(s) {
  return s.jogadores.map(p => ({ slot:p.slot, nome:p.nome, x:p.x, y:p.y, z:p.z,
    yaw:p.yaw, hp:p.hp, dead:p.dead, mvd:p.mvd, weapon:p.weapon }));
}
function brFilaAvisar(s) {
  const restante = Math.max(0, Math.ceil((s.inicioEm - Date.now()) / 1000));
  s.jogadores.forEach(p => env(p.ws, { t:'br_fila', fase:s.fase, restante,
    jogadores:s.jogadores.length, max:BR_MAX_HUMANOS }));
}
function brIniciar(s) {
  if (!s || s.fase !== 'fila' || !s.jogadores.length) return;
  s.fase = 'jogo'; clearInterval(s.tick); s.seed = crypto.randomInt(1, 2 ** 31 - 1);
  s.jogadores.forEach((p,i) => {
    const sp = CFG.spawns[i % CFG.spawns.length];
    Object.assign(p, { x:sp[0], y:0, z:sp[1], yaw:sp[2], hp:200, dead:false, mvd:false, weapon:0, lastState:Date.now(), lastShot:0 });
  });
  const jogadores = brPublico(s);
  s.jogadores.forEach(p => env(p.ws, { t:'br_inicio', sala:s.id, slot:p.slot,
    seed:s.seed, bots:Math.max(0,BR_TOTAL_JOGADORES-s.jogadores.length),
    total:BR_TOTAL_JOGADORES, jogadores }));
}
function brNovaFila() {
  const id = 'BR' + (++brSeq).toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  const s = { id, fase:'fila', jogadores:[], criada:Date.now(), inicioEm:Date.now()+BR_ESPERA_MS, timer:null };
  brSalas.set(id,s);
  s.timer = setTimeout(() => brIniciar(s), BR_ESPERA_MS);
  s.tick = setInterval(() => { if (s.fase === 'fila') brFilaAvisar(s); else clearInterval(s.tick); }, 1000);
  return s;
}
function brEntrar(ws, d) {
  if (ws.sala || ws.brSala) return erro(ws,'br_ja_em_sala','Você já está em uma partida.');
  let s = [...brSalas.values()].reverse().find(q => q.fase==='fila' && q.jogadores.length<BR_MAX_HUMANOS);
  if (!s) s = brNovaFila();
  const slot = s.jogadores.length;
  const p = { ws, slot, nome:nome(d.nome), x:0,y:0,z:0,yaw:0,hp:200,dead:false,mvd:false,weapon:0,lastState:Date.now(),lastShot:0,kills:0 };
  s.jogadores.push(p); ws.brSala=s; ws.brSlot=slot;
  brFilaAvisar(s);
}
function brSair(ws, notify=true) {
  const s=ws.brSala; if(!s)return;
  const slot=ws.brSlot; ws.brSala=null; ws.brSlot=-1;
  const i=s.jogadores.findIndex(p=>p && p.ws===ws);
  if(i<0)return;
  const [p]=s.jogadores.splice(i,1);
  if(s.fase==='fila') {
    s.jogadores.forEach((q,index)=>{q.slot=index;q.ws.brSlot=index});
    if(!s.jogadores.length){clearTimeout(s.timer);clearInterval(s.tick);brSalas.delete(s.id)}
    else brFilaAvisar(s);
  } else {
    s.jogadores.forEach(q=>env(q.ws,{t:'br_saiu',slot:p.slot,nome:p.nome}));
    if(!s.jogadores.length)brSalas.delete(s.id);
  }
  if(notify)env(ws,{t:'br_saiu_ok'});
}
function brEstado(ws,d) {
  const s=ws.brSala, p=s&&s.jogadores.find(q=>q.slot===ws.brSlot&&q.ws===ws);
  if(!s||s.fase!=='jogo'||!p)return;
  if(d.dead){p.dead=true;p.hp=0;s.jogadores.forEach(q=>{if(q!==p)env(q.ws,{t:'br_estado',slot:p.slot,nome:p.nome,x:p.x,y:p.y,z:p.z,yaw:p.yaw,hp:0,dead:true,mvd:false,weapon:p.weapon})});return;}
  if(p.dead)return;
  const now=Date.now(),dt=Math.min(.5,Math.max(.02,(now-p.lastState)/1000));p.lastState=now;
  let x=num(d.x,-148,148,p.x),z=num(d.z,-148,148,p.z);
  const dist=Math.hypot(x-p.x,z-p.z),max=15*dt+1.5;
  if(dist>max){x=p.x+(x-p.x)/dist*max;z=p.z+(z-p.z)/dist*max}
  Object.assign(p,{x,z,y:num(d.y,-2,80,p.y),yaw:num(d.yaw,-50,50,p.yaw),mvd:!!d.mvd,weapon:num(d.weapon,0,6,0)|0});
  const out={t:'br_estado',slot:p.slot,nome:p.nome,x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2),yaw:+p.yaw.toFixed(3),hp:p.hp,dead:p.dead,mvd:p.mvd,weapon:p.weapon};
  s.jogadores.forEach(q=>{if(q!==p)env(q.ws,out)});
}
function brAcertou(ws,d) {
  const s=ws.brSala,p=s&&s.jogadores.find(q=>q.slot===ws.brSlot&&q.ws===ws);
  const alvo=s&&s.jogadores.find(q=>q.slot===(d.alvo|0));
  if(!s||s.fase!=='jogo'||!p||!alvo||p===alvo||p.dead||alvo.dead)return;
  const wi=num(d.arma,0,6,0)|0,w=BR_ARMAS[wi];if(!w)return;
  const now=Date.now();if(now-p.lastShot<w.rate*1000*.65)return;
  if(Math.hypot(alvo.x-p.x,alvo.z-p.z)>w.r+7)return;
  p.lastShot=now;
  const dano=w.d*(d.cab?2:1);alvo.hp=Math.max(0,alvo.hp-dano);
  if(alvo.hp<=0){alvo.dead=true;p.kills++}
  const out={t:'br_dano',alvo:alvo.slot,autor:p.slot,dano,hp:alvo.hp,morto:alvo.dead,morte:alvo.dead};
  s.jogadores.forEach(q=>env(q.ws,out));
  if(s.jogadores.every(q=>q.dead)){
    s.fase='fim';s.jogadores.forEach(q=>env(q.ws,{t:'br_fim',mensagem:'Todos os jogadores humanos foram eliminados.'}));
  }
}

const ALFA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const num = (v, a, b, d = 0) => typeof v === 'number' && Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d;
const nome = v => String(v || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Jogador';
const env = (ws, o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
const erro = (ws, codigo, mensagem) => env(ws, { t: 'erro', codigo, mensagem });
const listaAmigos = p => ({
  t: 'amizade_lista',
  amigos: p.amigos.map(id => ({ id, nome: perfis.get(id)?.nome || 'Jogador' })),
  solicitacoes: p.pedidos.map(id => ({ id, nome: perfis.get(id)?.nome || 'Jogador' })),
});
function novoCodigo() {
  let c; do { c = Array.from({ length: 5 }, () => ALFA[crypto.randomInt(ALFA.length)]).join(''); } while (salas.has(c));
  return c;
}
function novoJogador(ws, n) {
  return { ws, nome: n, token: crypto.randomBytes(8).toString('hex'), pronto: false, on: true,
    hp: CFG.hp, kills: 0, dead: false, protAte: 0, x: 0, y: 0, z: 0, yaw: 0, ult: 0, ultTiro: 0, ultId: 0, grace: null, rt: null };
}
const pub = s => s.j.map((p, i) => p && ({ slot: i, nome: p.nome, pronto: p.pronto, on: p.on }));
const todos = (s, o) => s.j.forEach(p => p && env(p.ws, o));
function lobby(s) { todos(s, { t: 'lobby', codigo: s.codigo, fase: s.fase, jogadores: pub(s) }); }
function limpar(s) { clearTimeout(s.tc); s.j.forEach(p => p && (clearTimeout(p.rt), clearTimeout(p.grace))); }
function remover(s) { limpar(s); salas.delete(s.codigo); }
const placar = s => s.j.map(p => p ? p.kills : 0);
function iniciarContagem(s) {
  if (s.fase !== 'lobby' || s.j.some(p => !p || !p.on || !p.pronto)) return;
  s.fase = 'contagem'; let n = CFG.contagem;
  const passo = () => {
    if (s.fase !== 'contagem') return;
    if (n > 0) { todos(s, { t: 'contagem', n }); n--; s.tc = setTimeout(passo, 1000); return; }
    try { comecar(s); } catch (e) { console.error(e); s.fase = 'lobby'; s.j.forEach(p => p && (p.pronto = false)); todos(s, { t: 'erro', codigo: 'inicio', mensagem: 'Erro ao iniciar a partida.' }); lobby(s); }
  };
  lobby(s); passo();
}
function comecar(s) {
  s.fase = 'jogo'; clearInterval(s.tick); s.seed = crypto.randomInt(1, 2 ** 31 - 1);
  s.j.forEach((p, i) => { const sp = CFG.spawns[i]; Object.assign(p, { hp: CFG.hp, kills: 0, dead: false, protAte: Date.now() + 2000, x: sp[0], y: 0, z: sp[1], yaw: sp[2], ultId: 0, ultTiro: 0 }); });
  todos(s, { t: 'inicio', seed: s.seed, meta: CFG.meta, hp: CFG.hp, spawns: CFG.spawns.slice(0, 2), jogadores: pub(s) });
}
function fim(s, vencedor, motivo) {
  if (s.fase !== 'jogo') return; s.fase = 'fim'; clearTimeout(s.tc);
  s.j.forEach(p => p && (clearTimeout(p.rt), clearTimeout(p.grace), (p.pronto = false)));
  todos(s, { t: 'fim', vencedor, motivo, placar: placar(s), jogadores: pub(s) });
}
function matar(s, alvo, autor) {
  const a = s.j[alvo], k = s.j[autor]; if (!a || !k) return;
  a.dead = true; a.hp = 0; k.kills++; todos(s, { t: 'morte', alvo, autor, placar: placar(s) });
  if (k.kills >= CFG.meta) return fim(s, autor, 'meta');
  a.rt = setTimeout(() => {
    if (s.fase !== 'jogo') return; const o = s.j[autor]; if (!o) return;
    let melhor = 0, d = -1;
    CFG.spawns.forEach((sp, i) => { const dd = Math.hypot(sp[0] - o.x, sp[1] - o.z); if (dd > d) { d = dd; melhor = i; } });
    const sp = CFG.spawns[melhor]; Object.assign(a, { hp: CFG.hp, dead: false, x: sp[0], z: sp[1], y: 0, yaw: sp[2], protAte: Date.now() + CFG.protecaoMs });
    todos(s, { t: 'respawn', slot: alvo, x: sp[0], z: sp[1], yaw: sp[2], hp: a.hp });
  }, CFG.respawnMs);
}
function aoReceberEstado(s, i, p, d) {
  if (!s || s.fase !== 'jogo' || p.dead) return;
  const agora = Date.now(), dt = Math.min(1, Math.max(0.02, (agora - (p.ult || agora - 50)) / 1000)); p.ult = agora;
  let x = num(d.x, -148, 148, p.x), z = num(d.z, -148, 148, p.z);
  const dist = Math.hypot(x - p.x, z - p.z), max = 13 * dt + 1.2;
  if (dist > max) { x = p.x + ((x - p.x) / dist) * max; z = p.z + ((z - p.z) / dist) * max; }
  p.x = x; p.z = z; p.y = num(d.y, -2, 60, p.y); p.yaw = num(d.yaw, -50, 50, p.yaw);
  const o = s.j[1 - i]; if (o) env(o.ws, { t: 'estado', s: i, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(3), pt: +num(d.pt, -1.5, 1.5).toFixed(2), f: num(d.f, 0, 31) | 0, w: num(d.w, 0, 5) | 0 });
}
function aoReceberTiro(s, i, p, d) {
  if (!s || s.fase !== 'jogo' || p.dead) return;
  const o = s.j[1 - i], wi = num(d.w, 0, 5) | 0, w = ARMAS[wi]; if (!w || !o) return;
  const agora = Date.now(), id = d.id | 0; if (id <= p.ultId || agora - p.ultTiro < w.rate * 1000 * 0.7) return;
  p.ultId = id; p.ultTiro = agora;
  env(o.ws, { t: 'tiro', s: i, w: wi, dx: +num(d.dx, -1, 1).toFixed(3), dy: +num(d.dy, -1, 1).toFixed(3), dz: +num(d.dz, -1, 1).toFixed(3) });
  const n = num(d.n, 0, w.pel) | 0, h = num(d.h, 0, n) | 0;
  if (!n || o.dead || agora < o.protAte || agora < p.protAte || Math.hypot(o.x - p.x, o.z - p.z) > w.r + 6) return;
  const dano = w.d * (n - h) + w.d * CAB * h; o.hp = Math.max(0, o.hp - dano);
  todos(s, { t: 'dano', alvo: 1 - i, autor: i, hp: o.hp, dano, cab: h > 0 }); if (o.hp <= 0) matar(s, 1 - i, i);
}
function sair(ws, aviso) {
  const s = ws.sala; if (!s) return; const i = ws.slot, p = s.j[i]; ws.sala = null;
  if (!p || p.ws !== ws) return;
  if (s.fase === 'jogo') {
    p.on = false; p.ws = null; env(s.j[1 - i] && s.j[1 - i].ws, { t: 'oponente_caiu', segundos: CFG.reconexaoMs / 1000 });
    if (aviso) return fim(s, 1 - i, 'abandono'); p.grace = setTimeout(() => fim(s, 1 - i, 'desconexao'), CFG.reconexaoMs); return;
  }
  s.j[i] = null; if (s.fase === 'contagem') { s.fase = 'lobby'; clearTimeout(s.tc); } if (s.fase === 'fim') s.fase = 'lobby';
  if (!s.j[0] && !s.j[1]) return remover(s); s.j.forEach(q => q && (q.pronto = false));
  env(s.j[0] ? s.j[0].ws : s.j[1].ws, { t: 'oponente_saiu' }); lobby(s);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`ELITE STRIKE X1 - Servidor online! Salas X1: ${salas.size} | Salas BR: ${brSalas.size} | Perfis nesta sessão: ${perfis.size}`);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
});
const wss = new WebSocket.Server({ server, maxPayload: 2048 });

wss.on('connection', ws => {
  ws.vivo = true; ws.tokens = 120; ws.ult = Date.now(); ws.abusos = 0;
  ws.on('pong', () => { ws.vivo = true; });
  ws.on('message', raw => {
    const agora = Date.now(); ws.tokens = Math.min(120, ws.tokens + ((agora - ws.ult) / 1000) * 80); ws.ult = agora;
    if (--ws.tokens < 0) { if (++ws.abusos > 20) ws.close(1008, 'excesso'); return; }
    let d; try { d = JSON.parse(raw.toString()); } catch { return erro(ws, 'invalida', 'Mensagem inválida.'); }
    if (!d || typeof d !== 'object' || typeof d.t !== 'string') return erro(ws, 'invalida', 'Mensagem inválida.');
    const s = ws.sala, p = s && s.j[ws.slot];
    switch (d.t) {
      case 'ping': return env(ws, { t: 'pong' });
      // PERFIL E AMIGOS
      case 'perfil_registrar': {
        const id = String(d.id || ''); if (!/^\d{8}$/.test(id)) return erro(ws, 'id_invalido', 'ID deve ter 8 números.');
        let perfil = perfis.get(id);
        if (!perfil) perfil = { id, nome: nome(d.nome), ws: null, amigos: [], pedidos: [] };
        // Um ID só pode estar ligado a uma conexão ativa por vez.
        if (perfil.ws && perfil.ws !== ws && perfil.ws.readyState === WebSocket.OPEN) {
          // Mantém a conexão mais recente como a sessão ativa para esse ID.
          perfil.ws.perfilId = null;
        }
        perfil.nome = nome(d.nome); perfil.ws = ws; perfis.set(id, perfil); ws.perfilId = id;
        env(ws, { t: 'perfil_ok', id }); env(ws, listaAmigos(perfil)); return;
      }
      case 'perfil_buscar': {
        const id = String(d.id || ''); if (!/^\d{8}$/.test(id)) return erro(ws, 'id_invalido', 'Digite um ID de 8 números.');
        const f = perfis.get(id); return env(ws, { t: 'perfil_resultado', perfil: f ? { id: f.id, nome: f.nome, online: !!(f.ws && f.ws.readyState === WebSocket.OPEN) } : null });
      }
      case 'amizade_pedir': {
        const de = perfis.get(ws.perfilId), paraId = String(d.para || ''), para = perfis.get(paraId);
        if (!de || de.ws !== ws) return erro(ws, 'perfil_ausente', 'Abra Amigos para registrar seu perfil primeiro.');
        if (!/^\d{8}$/.test(paraId) || !para) return erro(ws, 'jogador_nao_encontrado', 'Jogador não encontrado. Ele precisa abrir Amigos para se registrar.');
        if (de.id === paraId) return erro(ws, 'proprio_id', 'Não pode adicionar seu próprio ID.');
        if (de.amigos.includes(paraId)) return erro(ws, 'ja_amigos', 'Vocês já são amigos.');
        if (para.pedidos.includes(de.id)) return env(ws, { t: 'amizade_enviada', mensagem: 'Sua solicitação já foi enviada.' });
        if (para.pedidos.includes(de.id) === false) para.pedidos.push(de.id);
        if (para.ws && para.ws.readyState === WebSocket.OPEN) env(para.ws, { t: 'amizade_recebida', de: { id: de.id, nome: de.nome } });
        return env(ws, { t: 'amizade_enviada', mensagem: 'Solicitação enviada para ' + para.nome + '.' });
      }
      case 'amizade_aceitar': {
        const eu = perfis.get(ws.perfilId), id = String(d.id || ''), outro = perfis.get(id);
        if (!eu || eu.ws !== ws || !outro || !eu.pedidos.includes(id)) return erro(ws, 'pedido_ausente', 'Solicitação não encontrada.');
        eu.pedidos = eu.pedidos.filter(x => x !== id); if (!eu.amigos.includes(id)) eu.amigos.push(id); if (!outro.amigos.includes(eu.id)) outro.amigos.push(eu.id);
        env(eu.ws, listaAmigos(eu)); if (outro.ws) env(outro.ws, listaAmigos(outro)); return;
      }
      case 'amizade_remover': {
        const eu = perfis.get(ws.perfilId), id = String(d.id || ''), outro = perfis.get(id); if (!eu || eu.ws !== ws) return;
        eu.amigos = eu.amigos.filter(x => x !== id); if (outro) outro.amigos = outro.amigos.filter(x => x !== eu.id);
        env(ws, listaAmigos(eu)); if (outro && outro.ws) env(outro.ws, listaAmigos(outro)); return;
      }
      // BATTLE ROYALE ONLINE (fila e salas separadas do X1)
      case 'br_entrar': return brEntrar(ws, d);
      case 'br_estado': return brEstado(ws, d);
      case 'br_acertou': return brAcertou(ws, d);
      case 'br_cancelar': return brSair(ws, true);
      case 'br_sair': return brSair(ws, true);
      // MULTIPLAYER X1
      case 'criar': {
        if (ws.sala) return erro(ws, 'ja_em_sala', 'Você já está em uma sala.');
        if (salas.size >= CFG.maxSalas) return erro(ws, 'servidor_cheio', 'Servidor lotado. Tente mais tarde.');
        const codigo = novoCodigo(), sala = { codigo, j: [null, null], fase: 'lobby', criada: agora };
        const jog = novoJogador(ws, nome(d.nome)); sala.j[0] = jog; salas.set(codigo, sala); ws.sala = sala; ws.slot = 0;
        env(ws, { t: 'sala_criada', codigo, slot: 0, token: jog.token }); return lobby(sala);
      }
      case 'entrar': {
        if (ws.sala) return erro(ws, 'ja_em_sala', 'Você já está em uma sala.');
        const codigo = String(d.codigo || '').trim().toUpperCase(); if (!/^[A-Z0-9]{5}$/.test(codigo)) return erro(ws, 'codigo_invalido', 'Código inválido. Use 5 letras/números.');
        const sala = salas.get(codigo); if (!sala) return erro(ws, 'sala_inexistente', 'Sala não encontrada.');
        const livre = sala.j.findIndex(q => !q); if (livre < 0 || sala.fase !== 'lobby') return erro(ws, 'sala_cheia', sala.fase === 'lobby' ? 'Sala cheia.' : 'A partida já começou.');
        const jog = novoJogador(ws, nome(d.nome)); sala.j[livre] = jog; ws.sala = sala; ws.slot = livre;
        env(ws, { t: 'sala_entrou', codigo, slot: livre, token: jog.token }); return lobby(sala);
      }
      case 'reconectar': {
        const sala = salas.get(String(d.codigo || '').toUpperCase()); const i = sala ? sala.j.findIndex(q => q && q.token === d.token && !q.on) : -1;
        if (i < 0 || sala.fase !== 'jogo') return erro(ws, 'reconexao_falhou', 'Não foi possível voltar para a partida.');
        const q = sala.j[i]; clearTimeout(q.grace); q.ws = ws; q.on = true; ws.sala = sala; ws.slot = i;
        env(ws, { t: 'retomar', slot: i, seed: sala.seed, meta: CFG.meta, placar: placar(sala), eu: { hp: q.hp, dead: q.dead }, op: { hp: sala.j[1 - i].hp, dead: sala.j[1 - i].dead }, jogadores: pub(sala) });
        return env(sala.j[1 - i] && sala.j[1 - i].ws, { t: 'oponente_voltou' });
      }
      case 'pronto': if (!s || !p || s.fase !== 'lobby') return; p.pronto = !!d.v; lobby(s); return iniciarContagem(s);
      case 'revanche': if (!s || !p || s.fase !== 'fim') return; p.pronto = true; if (s.j.every(q => q && q.on && q.pronto)) { s.fase = 'lobby'; return iniciarContagem(s); } return todos(s, { t: 'lobby', codigo: s.codigo, fase: 'fim', jogadores: pub(s) });
      case 'estado': return p && aoReceberEstado(s, ws.slot, p, d);
      case 'tiro': return p && aoReceberTiro(s, ws.slot, p, d);
      case 'sair': return sair(ws, true);
      default: return erro(ws, 'invalida', 'Mensagem desconhecida.');
    }
  });
  ws.on('close', () => {
    if (ws.perfilId && perfis.has(ws.perfilId)) { const perfil = perfis.get(ws.perfilId); if (perfil.ws === ws) perfil.ws = null; }
    brSair(ws, false);
    sair(ws, false);
  });
  ws.on('error', () => {});
});
setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.vivo) return ws.terminate(); ws.vivo = false; try { ws.ping(); } catch {} });
  const agora = Date.now(); salas.forEach(s => { if (agora - s.criada > 3 * 3600e3 || (!s.j[0] && !s.j[1])) remover(s); });
  brSalas.forEach(s => { if (s.fase === 'fila') brFilaAvisar(s); else if (!s.jogadores.length) brSalas.delete(s.id); });
}, 20000);
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`ELITE STRIKE X1 + BR online na porta ${PORT}`));