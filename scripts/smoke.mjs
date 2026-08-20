/**
 * Smoke test do servidor: API de salas + relay, sem precisar de browser.
 *
 * Cobre o que mais quebra nesse desenho:
 *  - senha, tentativas e permissão de dono;
 *  - máquina de estados do keyframe (delta em decoder frio é erro);
 *  - assistir é opt-in, e o servidor não envia a quem não pediu;
 *  - vários transmissores simultâneos sem misturar os streams;
 *  - isolamento entre salas e entre instâncias.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

import { LOCAL_PADRAO, LOCAL_WS_PADRAO } from '../shared/porta.js';

const BASE = process.env.SMOKE_BASE || LOCAL_PADRAO;
const WSB = process.env.SMOKE_WS || LOCAL_WS_PADRAO;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FALHOU'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

async function api(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Instância própria por execução: sem isso os testes cairiam no lobby público
// do site e as salas de teste apareceriam para usuários de verdade.
const TEST_INSTANCE = `teste-${Date.now().toString(36)}`;

// Instancias derivadas da execucao, nunca fixas: salas vazias so fecham depois
// de uma carencia, e com nome fixo duas rodadas seguidas enxergavam as salas
// uma da outra — o teste falhava sem nada estar quebrado.
const CANAL_A = `${TEST_INSTANCE}-a`;
const CANAL_B = `${TEST_INSTANCE}-b`;

const identity = async (instance, name) =>
  (await api('/api/session-dev', { instance_id: instance ?? TEST_INSTANCE, name })).body;

/** Quadro no formato do protocolo: [1B slot][1B tipo][8B ts][8B envio][payload] */
function frame(slot, isKeyframe, payload) {
  return pacote(slot, isKeyframe ? 1 : 2, payload);
}

/** Pacote de audio: tipo 3, sem a maquina de estados do keyframe. */
const audioPacote = (slot, payload) => pacote(slot, 3, payload);

function pacote(slot, tipo, payload) {
  const data = Buffer.from(payload);
  const buf = Buffer.alloc(18 + data.length);
  buf.writeUInt8(slot, 0);
  buf.writeUInt8(tipo, 1);
  buf.writeDoubleBE(0, 2);
  buf.writeDoubleBE(Date.now(), 10);
  data.copy(buf, 18);
  return buf;
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.recv = { json: [], bin: [] };
    ws.on('message', (data, isBinary) => {
      if (isBinary) ws.recv.bin.push(Buffer.from(data));
      else ws.recv.json.push(JSON.parse(data.toString()));
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const openViewer = (t) => open(`${WSB}/ws?t=${encodeURIComponent(t.viewerToken)}`);
const openCaster = (t) =>
  open(`${WSB}/ws?t=${encodeURIComponent(new URL(t.shareUrl).searchParams.get('t'))}`);
const lastState = (ws) => [...ws.recv.json].reverse().find((m) => m.type === 'state');
// So video: audio anda pelo mesmo slot e contaria junto, embaralhando o que
// estas checagens medem.
const binsOfSlot = (ws, slot) => ws.recv.bin.filter((b) => b[0] === slot && b[1] !== 3);

const run = async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check('health responde', health.ok === true);

  // ============================================================== API de salas
  const alice = await identity(CANAL_A, 'Alice');
  const bob = await identity(CANAL_A, 'Bob');
  check('identidade assinada emitida', Boolean(alice.identity));

  const g1 = (await api('/api/session-guest', { name: '' })).body;
  const g2 = (await api('/api/session-guest', { name: 'Fulano' })).body;
  check('convidado sem nome ganha um', g1.user.name.startsWith('Convidado'));
  check('convidado escolhe o nome', g2.user.name === 'Fulano');
  check('convidados tem ids diferentes', g1.user.id !== g2.user.id);
  check('convidado cai no lobby publico', g1.instance === 'web');

  const semNome = await api('/api/rooms/create', { identity: alice.identity, name: '   ' });
  check('sala sem nome e aceita', semNome.status === 200);

  const semAuth = await api('/api/rooms/create', { identity: 'forjado', name: 'X' });
  check('identidade invalida e recusada', semAuth.status === 401);

  const aberta = (await api('/api/rooms/create', { identity: alice.identity, name: 'Sala Aberta' }))
    .body;
  const trancada = (
    await api('/api/rooms/create', {
      identity: alice.identity,
      name: 'Sala Trancada',
      password: 'segredo',
    })
  ).body;

  check('criar sala devolve tokens', Boolean(aberta.viewerToken && aberta.shareUrl));

  const lista = (await api('/api/rooms/list', { identity: bob.identity })).body.rooms;
  check(
    'sala sem nome herda o nome de quem criou',
    lista.some((r) => r.name === 'Sala de Alice'),
    lista.map((r) => r.name).join(', '),
  );
  check('lista mostra todas as salas', lista.length === 3);
  check(
    'lista marca qual tem senha, sem vazar o hash',
    lista.find((r) => r.name === 'Sala Trancada').locked === true &&
      lista.every((r) => !('password' in r)),
  );
  check(
    'lista informa o dono',
    lista.every((r) => r.owner === 'Alice'),
  );

  const semLogin = await api('/api/rooms/list', {});
  check('lobby publico responde sem login', semLogin.status === 200);
  check(
    'salas de teste nao vazam para o lobby publico',
    !semLogin.body.rooms.some((r) => r.name === 'Sala Aberta'),
  );

  // --------------------------------------------------------- sala da call
  // Sem o bot configurado nao ha confirmacao de canal: a sala vira a da
  // instancia da Activity. Precisa abrir, e precisa ser a mesma para quem
  // esta na mesma instancia — e so para eles.
  const semCall = await api('/api/rooms/call', { identity: bob.identity });
  check('sem o bot, a atividade ainda abre uma sala', semCall.status === 200);

  const semCallDeNovo = await api('/api/rooms/call', { identity: alice.identity });
  check(
    'mesma instancia cai na mesma sala',
    semCallDeNovo.body.roomId === semCall.body.roomId,
    semCall.body.roomId,
  );

  const outraInstancia = await identity(CANAL_B, 'Zeca');
  const salaDeOutroCanal = await api('/api/rooms/call', { identity: outraInstancia.identity });
  check(
    'outra instancia cai em sala diferente',
    salaDeOutroCanal.body.roomId !== semCall.body.roomId,
  );

  const forasteiro = await api('/api/rooms/join', {
    identity: outraInstancia.identity,
    roomId: semCall.body.roomId,
  });
  check('quem e de outra instancia nao entra na sala dela', forasteiro.status === 403);

  const naCall = (
    await api('/api/session-dev', { instance_id: TEST_INSTANCE, name: 'Vera', call: 'canal-9' })
  ).body;
  const outraCall = (
    await api('/api/session-dev', { instance_id: TEST_INSTANCE, name: 'Ugo', call: 'canal-8' })
  ).body;

  const callRoom = await api('/api/rooms/call', { identity: naCall.identity });
  check('quem esta na call entra direto', callRoom.status === 200);

  const mesmaSala = await api('/api/rooms/call', { identity: naCall.identity });
  check('a sala da call e sempre a mesma', mesmaSala.body.roomId === callRoom.body.roomId);

  const invasor = await api('/api/rooms/join', {
    identity: outraCall.identity,
    roomId: callRoom.body.roomId,
  });
  check('quem esta em outra call nao entra', invasor.status === 403);

  const semCallNaLista = await api('/api/rooms/join', {
    identity: bob.identity,
    roomId: callRoom.body.roomId,
  });
  check('sem call confirmada nao entra pela lista', semCallNaLista.status === 403);

  // -------------------------------------------------------------- senha
  const semSenha = await api('/api/rooms/join', {
    identity: bob.identity,
    roomId: trancada.roomId,
  });
  check('entrar sem senha e recusado', semSenha.status === 403);

  const senhaErrada = await api('/api/rooms/join', {
    identity: bob.identity,
    roomId: trancada.roomId,
    password: 'errada',
  });
  check('senha errada e recusada', senhaErrada.status === 403);

  const senhaCerta = await api('/api/rooms/join', {
    identity: bob.identity,
    roomId: trancada.roomId,
    password: 'segredo',
  });
  check(
    'senha certa devolve tokens',
    senhaCerta.status === 200 && Boolean(senhaCerta.body.viewerToken),
  );

  const salaAberta = await api('/api/rooms/join', {
    identity: bob.identity,
    roomId: aberta.roomId,
  });
  check('sala sem senha entra direto', salaAberta.status === 200);

  const inexistente = await api('/api/rooms/join', { identity: bob.identity, roomId: 'naoexiste' });
  check('sala inexistente devolve 404', inexistente.status === 404);

  // -------------------------------------------------------- forca bruta
  const cofre = (
    await api('/api/rooms/create', { identity: alice.identity, name: 'Cofre', password: 'x' })
  ).body;

  let bloqueado = null;
  for (let i = 0; i < 6; i++) {
    const r = await api('/api/rooms/join', {
      identity: bob.identity,
      roomId: cofre.roomId,
      password: 'chute',
    });
    if (r.status === 429) bloqueado = r;
  }
  check('tentativas repetidas bloqueiam', bloqueado !== null, bloqueado?.body?.error ?? '');

  const certaMasBloqueado = await api('/api/rooms/join', {
    identity: bob.identity,
    roomId: cofre.roomId,
    password: 'x',
  });
  check('bloqueio vale ate para a senha certa', certaMasBloqueado.status === 429);

  // ------------------------------------------------------- dono da senha
  const naoDono = await api('/api/rooms/password', {
    identity: bob.identity,
    roomId: aberta.roomId,
    password: 'nova',
  });
  check('quem nao criou nao muda a senha', naoDono.status === 403);

  const dono = await api('/api/rooms/password', {
    identity: alice.identity,
    roomId: aberta.roomId,
    password: 'nova',
  });
  check('dono adiciona senha depois de criar', dono.status === 200 && dono.body.locked === true);

  const agoraPrecisa = await api('/api/rooms/join', {
    identity: bob.identity,
    roomId: aberta.roomId,
  });
  check('sala antes aberta agora exige senha', agoraPrecisa.status === 403);

  const removida = await api('/api/rooms/password', {
    identity: alice.identity,
    roomId: aberta.roomId,
    password: '',
  });
  check('dono remove a senha', removida.status === 200 && removida.body.locked === false);

  const voltouAberta = await api('/api/rooms/join', {
    identity: bob.identity,
    roomId: aberta.roomId,
  });
  check('sem senha entra direto de novo', voltouAberta.status === 200);

  // ===================================================================== relay
  const sala = (await api('/api/rooms/create', { identity: alice.identity, name: 'Relay' })).body;
  const bobNaSala = (await api('/api/rooms/join', { identity: bob.identity, roomId: sala.roomId }))
    .body;

  const semSalaWs = await open(`${WSB}/ws?t=${encodeURIComponent(alice.identity)}`).catch(
    () => null,
  );
  check('token de identidade nao abre WebSocket', semSalaWs === null);

  const viewer = await openViewer(sala);
  await sleep(100);
  check(
    'viewer recebe state ao entrar',
    viewer.recv.json.some((m) => m.type === 'state'),
  );
  check('state identifica a sala e o dono', lastState(viewer).room?.ownerId === alice.user.id);

  const c1 = await openCaster(sala);
  await sleep(120);
  const slot1 = c1.recv.json.find((m) => m.type === 'slot')?.slot;
  check('servidor atribui slot ao transmissor', slot1 === 0);

  c1.send(JSON.stringify({ type: 'start' }));
  c1.send(
    JSON.stringify({
      type: 'config',
      config: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 },
    }),
  );
  await sleep(120);

  c1.send(frame(slot1, true, 'KEY-ANTES'));
  await sleep(80);
  check('sem pedir para assistir, nada e enviado', binsOfSlot(viewer, slot1).length === 0);

  viewer.send(JSON.stringify({ type: 'watch', slot: slot1 }));
  await sleep(120);
  check(
    'watch entrega o config guardado',
    viewer.recv.json.some((m) => m.type === 'config' && m.slot === slot1),
  );

  c1.send(frame(slot1, false, 'DELTA-CEDO'));
  await sleep(80);
  check('delta antes de keyframe e barrado', binsOfSlot(viewer, slot1).length === 0);

  c1.send(frame(slot1, true, 'KEY-1'));
  await sleep(80);
  check('keyframe destrava o viewer', binsOfSlot(viewer, slot1).length === 1);

  // ------------------------------------------------------------------ audio
  // Som nao depende de keyframe: cada pacote Opus se decodifica sozinho. Se ele
  // passasse pelo mesmo bloqueio do video, quem entra no meio ficaria mudo ate
  // o proximo keyframe — mas o opt-in continua valendo igual.
  const semKey = await openViewer(sala);
  await sleep(120);
  semKey.send(JSON.stringify({ type: 'watch', slot: slot1 }));
  await sleep(120);
  semKey.recv.bin.length = 0;

  c1.send(audioPacote(slot1, 'SOM-SEM-KEYFRAME'));
  await sleep(120);
  check(
    'audio chega mesmo sem keyframe antes',
    semKey.recv.bin.some((b) => b[1] === 3 && b.subarray(18).toString() === 'SOM-SEM-KEYFRAME'),
  );

  semKey.send(JSON.stringify({ type: 'unwatch', slot: slot1 }));
  await sleep(120);
  semKey.recv.bin.length = 0;
  c1.send(audioPacote(slot1, 'SOM-POS-UNWATCH'));
  await sleep(120);
  check('audio para junto com o unwatch', semKey.recv.bin.length === 0);
  semKey.close();
  await sleep(80);

  // ------------------------------------------------- segundo transmissor
  const c2 = await openCaster(bobNaSala);
  await sleep(120);
  const slot2 = c2.recv.json.find((m) => m.type === 'slot')?.slot;
  check('segundo transmissor recebe slot diferente', slot2 === 1);

  c2.send(JSON.stringify({ type: 'start' }));
  c2.send(
    JSON.stringify({ type: 'config', config: { codec: 'vp8', codedWidth: 640, codedHeight: 480 } }),
  );
  await sleep(120);
  viewer.send(JSON.stringify({ type: 'watch', slot: slot2 }));
  await sleep(100);
  c2.send(frame(slot2, true, 'KEY-2'));
  await sleep(100);

  check('viewer recebe quadros do segundo slot', binsOfSlot(viewer, slot2).length === 1);
  check('streams nao se misturam', binsOfSlot(viewer, slot1).length === 1);

  c2.send(frame(slot1, true, 'FORJADO'));
  await sleep(80);
  check(
    'quadro com slot de outro transmissor e descartado',
    binsOfSlot(viewer, slot1).length === 1,
  );

  check(
    'state informa quem assiste cada stream',
    lastState(viewer).streams.every((s) => Array.isArray(s.watchers)),
  );

  // -------------------------------------------------- parar de assistir
  viewer.send(JSON.stringify({ type: 'unwatch', slot: slot1 }));
  await sleep(100);
  c1.send(frame(slot1, true, 'KEY-POS-UNWATCH'));
  await sleep(80);
  check('unwatch corta o envio daquele slot', binsOfSlot(viewer, slot1).length === 1);
  check('o outro slot continua chegando', binsOfSlot(viewer, slot2).length === 1);

  // -------------------------------------------------------------- apelido
  viewer.send(JSON.stringify({ type: 'rename', name: '  Alice   Renomeada  ' }));
  await sleep(120);
  check(
    'rename normaliza espacos e propaga',
    lastState(viewer).participants.some((p) => p.name === 'Alice Renomeada'),
  );

  viewer.send(JSON.stringify({ type: 'rename', name: 'x'.repeat(80) }));
  await sleep(100);
  check(
    'rename e limitado a 32 caracteres',
    lastState(viewer).participants.some((p) => p.name.length === 32),
  );

  // ----------------------------------------------------- isolamento de sala
  const outraSala = (await api('/api/rooms/create', { identity: bob.identity, name: 'Outra' }))
    .body;
  const outroViewer = await openViewer(outraSala);
  await sleep(120);
  check('sala diferente nao vaza binarios', outroViewer.recv.bin.length === 0);

  // ------------------------------------------------------------ anotacoes
  // Laser e caneta de quem assiste. O que precisa valer: so chega a quem
  // assiste aquela tela, o desenho fica guardado para quem entra depois, e
  // apagar a tela dos outros e do dono da transmissao ou de quem criou a sala.
  // Carla nao criou a sala nem transmite nada: e por ela que se testa o que um
  // espectador comum pode. Os tokens de `sala` sao da Alice, que e a dona —
  // anotar por eles concederia permissao sem ninguem perceber.
  const carla = await identity(CANAL_A, 'Carla');
  const carlaNaSala = (
    await api('/api/rooms/join', { identity: carla.identity, roomId: sala.roomId })
  ).body;

  const anotador = await openViewer(carlaNaSala);
  await sleep(120);
  anotador.send(JSON.stringify({ type: 'watch', slot: slot2 }));
  await sleep(120);

  const anns = (ws, slot) => ws.recv.json.filter((m) => m.type === 'ann' && m.slot === slot);
  // Alice ja pediu para assistir o slot2 la em cima; e por ela que se confere
  // o que sai do relay.
  const espectadorDeSlot2 = viewer;

  viewer.recv.json.length = 0;
  anotador.send(
    JSON.stringify({ type: 'ann', slot: slot2, ev: { k: 'p', x: 100, y: 200, c: '#ff4d4f' } }),
  );
  await sleep(120);
  check('laser chega a quem assiste a mesma tela', anns(viewer, slot2).length === 1);
  check(
    'laser chega tambem a quem transmite',
    c2.recv.json.some((m) => m.type === 'ann' && m.ev.k === 'p'),
  );

  outroViewer.recv.json.length = 0;
  anotador.send(JSON.stringify({ type: 'ann', slot: slot2, ev: { k: 'p', x: 1, y: 1 } }));
  await sleep(100);
  check('anotacao nao vaza para outra sala', anns(outroViewer, slot2).length === 0);

  // Quem nao pediu para assistir nao desenha: a coordenada normalizada nao
  // teria sobre o que ter sido escolhida.
  viewer.recv.json.length = 0;
  outroViewer.send(JSON.stringify({ type: 'ann', slot: slot2, ev: { k: 'p', x: 5, y: 5 } }));
  await sleep(100);
  check('quem nao assiste nao anota', anns(viewer, slot2).length === 0);

  // Assistir uma tela nao da direito de desenhar em outra: a coordenada
  // normalizada nao teria sobre o que ter sido escolhida.
  viewer.recv.json.length = 0;
  anotador.send(JSON.stringify({ type: 'ann', slot: slot1, ev: { k: 'p', x: 7, y: 7 } }));
  await sleep(120);
  check('assistir uma tela nao autoriza desenhar em outra', anns(viewer, slot1).length === 0);

  // Quem transmite e a excecao: ele ve a propria tela pela captura, sem
  // assistir a si mesmo, e precisa poder apontar nela enquanto mostra.
  const dono2 = await openViewer(bobNaSala);
  await sleep(120);
  espectadorDeSlot2.recv.json.length = 0;
  dono2.send(JSON.stringify({ type: 'ann', slot: slot2, ev: { k: 'p', x: 30, y: 30 } }));
  await sleep(150);
  check(
    'quem transmite desenha na propria tela sem assisti-la',
    anns(espectadorDeSlot2, slot2).length === 1,
  );

  dono2.send(JSON.stringify({ type: 'ann', slot: slot1, ev: { k: 'p', x: 9, y: 9 } }));
  await sleep(120);
  check(
    'mas so na dele: a tela do outro continua exigindo assistir',
    anns(viewer, slot1).length === 0,
  );
  dono2.close();

  viewer.recv.json.length = 0;
  anotador.send(
    JSON.stringify({
      type: 'ann',
      slot: slot2,
      ev: { k: 's', id: 1, c: '#38bdf8', w: 10, pts: [10, 10, 20, 20] },
    }),
  );
  anotador.send(JSON.stringify({ type: 'ann', slot: slot2, ev: { k: 'a', id: 1, pts: [30, 30] } }));
  await sleep(120);
  check('traco e repassado', anns(viewer, slot2).length === 2);

  const novato = await openViewer(sala);
  await sleep(120);
  novato.send(JSON.stringify({ type: 'watch', slot: slot2 }));
  await sleep(150);
  const sync = novato.recv.json.find((m) => m.type === 'ann-sync' && m.slot === slot2);
  check('quem entra no meio recebe o que ja esta desenhado', Boolean(sync));
  check(
    'o traco sincronizado vem inteiro',
    sync?.tracos?.[0]?.pts?.length === 6,
    JSON.stringify(sync?.tracos?.[0]?.pts),
  );

  // Coordenada fora da grade e evento desconhecido nao podem virar estado.
  viewer.recv.json.length = 0;
  anotador.send(JSON.stringify({ type: 'ann', slot: slot2, ev: { k: 'p', x: 99999, y: 0 } }));
  anotador.send(JSON.stringify({ type: 'ann', slot: slot2, ev: { k: 'zzz' } }));
  anotador.send(JSON.stringify({ type: 'ann', slot: slot2, ev: { k: 's', id: 2, pts: [1] } }));
  await sleep(120);
  check('anotacao malformada e descartada', anns(viewer, slot2).length === 0);

  // Limpar a tela dos outros: so o dono da transmissao e quem criou a sala.
  viewer.recv.json.length = 0;
  anotador.send(JSON.stringify({ type: 'ann', slot: slot2, ev: { k: 'ca' } }));
  await sleep(120);
  check(
    'quem so assiste nao limpa o desenho dos outros',
    !anns(viewer, slot2).some((m) => m.ev.k === 'ca'),
  );

  const depoisDoNao = await openViewer(sala);
  await sleep(100);
  depoisDoNao.send(JSON.stringify({ type: 'watch', slot: slot2 }));
  await sleep(150);
  check(
    'o desenho continua la depois da tentativa recusada',
    depoisDoNao.recv.json.some((m) => m.type === 'ann-sync' && m.tracos.length === 1),
  );

  // O viewer aqui e a Alice, dona da sala.
  viewer.recv.json.length = 0;
  viewer.send(JSON.stringify({ type: 'watch', slot: slot2 }));
  await sleep(100);
  viewer.send(JSON.stringify({ type: 'ann', slot: slot2, ev: { k: 'ca' } }));
  await sleep(150);
  check(
    'quem criou a sala limpa a tela de todo mundo',
    anns(viewer, slot2).some((m) => m.ev.k === 'ca'),
  );

  const depoisDaLimpeza = await openViewer(sala);
  await sleep(100);
  depoisDaLimpeza.send(JSON.stringify({ type: 'watch', slot: slot2 }));
  await sleep(150);
  check(
    'depois de limpar, quem entra nao recebe traco nenhum',
    !depoisDaLimpeza.recv.json.some((m) => m.type === 'ann-sync'),
  );

  [anotador, novato, depoisDoNao, depoisDaLimpeza].forEach((w) => w.close());
  await sleep(100);

  // ------------------------------------------------- parar de transmitir
  // Sair da sala precisa encerrar tambem a captura que roda na aba externa:
  // ela tem conexao propria, entao o unico caminho e o servidor avisa-la.
  c1.recv.json.length = 0;
  viewer.send(JSON.stringify({ type: 'stop-broadcast' }));
  await sleep(150);
  check(
    'stop-broadcast chega a aba de captura de quem pediu',
    c1.recv.json.some((m) => m.type === 'stop-request'),
  );

  // Cada um encerra so a sua: o servidor procura o transmissor pelo uid do
  // token de quem pediu, nunca por um id vindo da mensagem.
  c2.recv.json.length = 0;
  const bobViewer = await openViewer(outraSala);
  bobViewer.send(JSON.stringify({ type: 'stop-broadcast' }));
  await sleep(150);
  check(
    'stop-broadcast nao derruba a transmissao de outra pessoa',
    !c2.recv.json.some((m) => m.type === 'stop-request'),
  );

  // --------------------------------------------- transmissao sem dono na sala
  // A aba de captura tem conexao propria e nao sabe nada do Discord: fechar a
  // atividade ou sair da call nao chega ate ela. Quem percebe e o servidor.
  //
  // Servidor proprio, com a carencia em dois segundos: o valor de verdade sao
  // quinze, e esperar quinze parado num teste nao paga o que ele verifica.
  await testarOrfao();

  // ------------------------------------------------------ espelho do avatar
  const avatarOk = await fetch(`${BASE}/api/avatar/123456789012345678/${'a'.repeat(32)}`);
  check(
    'avatar com formato valido chega ao proxy',
    avatarOk.status === 404 || avatarOk.status === 502,
    avatarOk.status === 404 ? 'hash inexistente responde 404' : 'CDN indisponivel responde 502',
  );

  for (const rota of [
    '/api/avatar/nao-e-id/' + 'a'.repeat(32),
    '/api/avatar/123456789012345678/nao-e-hash',
    '/api/avatar/123456789012345678/' + 'z'.repeat(32),
  ]) {
    const r = await fetch(`${BASE}${rota}`);
    check(`avatar recusa ${rota.split('/').pop().slice(0, 12)}`, r.status === 400);
  }

  [viewer, c1, c2, outroViewer, bobViewer].forEach((w) => w.close());
  await sleep(120);

  console.log(failures ? `\n${failures} verificacao(oes) falharam` : '\nTudo passou');
  process.exit(failures ? 1 : 0);
};

/**
 * Sobe um servidor so para este caso, com a carencia encurtada.
 *
 * O teste precisa de um servidor configurado de um jeito que nao serve para o
 * resto — e derrubar a transmissao de quem esta usando o servidor de verdade,
 * so para conferir isto, seria pior do que nao conferir.
 */
async function testarOrfao() {
  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;

  const servidor = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(porta),
      NODE_ENV: 'development',
      SESSION_SECRET: 'orfao-smoke-secret-com-entropia-suficiente-para-teste',
      DISCORD_ADMIN_ID: '',
      BROADCAST_ORPHAN_MS: '2000',
    },
  });

  try {
    await esperarNoAr(`${base}/api/health`);

    const post = async (rota, corpo) =>
      (
        await fetch(base + rota, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(corpo),
        })
      ).json();

    const dono = await post('/api/session-guest', { name: 'Dono' });
    const sala = await post('/api/rooms/create', { identity: dono.identity, name: 'Orfa' });
    const wsBase = `ws://127.0.0.1:${porta}`;

    const atividade = await open(`${wsBase}/ws?t=${encodeURIComponent(sala.viewerToken)}`);
    const captura = await open(
      `${wsBase}/ws?t=${encodeURIComponent(new URL(sala.shareUrl).searchParams.get('t'))}`,
    );
    await sleep(200);

    captura.send(JSON.stringify({ type: 'start' }));
    await sleep(150);

    // Com a atividade aberta, a transmissao fica: a varredura roda a cada
    // quatro segundos e nao pode encerrar quem esta na sala.
    captura.recv.json.length = 0;
    await sleep(5000);
    check(
      'com a atividade aberta, a transmissao continua',
      !captura.recv.json.some((m) => m.type === 'stop-request') &&
        captura.readyState === WebSocket.OPEN,
    );

    // Fecha so a atividade — a aba de captura continua aberta, que e o caso
    // real de quem sai do canal de voz e esquece a aba.
    atividade.close();
    await sleep(200);
    captura.recv.json.length = 0;

    let fechou = false;
    captura.on('close', () => (fechou = true));

    await sleep(7000);
    check(
      'sem ninguem do dono na sala, a captura recebe o pedido de parar',
      captura.recv.json.some((m) => m.type === 'stop-request'),
      JSON.stringify(captura.recv.json.map((m) => m.type)),
    );
    check(
      'o pedido explica por que a transmissao caiu sozinha',
      captura.recv.json.some((m) => m.type === 'stop-request' && /saiu/i.test(m.motivo ?? '')),
      JSON.stringify(captura.recv.json.find((m) => m.type === 'stop-request')),
    );
    check('e o socket da captura e fechado, garantindo o fim', fechou);

    // Entrar de novo depois disso precisa continuar funcionando: a sala nao
    // pode ter ficado com um slot preso pelo transmissor que saiu.
    const voltou = await post('/api/rooms/join', { identity: dono.identity, roomId: sala.roomId });
    check('a sala continua utilizavel depois da limpeza', Boolean(voltou.viewerToken));
  } finally {
    servidor.kill();
  }
}

function portaLivre() {
  return new Promise((resolve, reject) => {
    const sonda = createServer();
    sonda.once('error', reject);
    sonda.listen(0, '127.0.0.1', () => {
      const { port } = sonda.address();
      sonda.close((erro) => (erro ? reject(erro) : resolve(port)));
    });
  });
}

async function esperarNoAr(url, limiteMs = 10_000) {
  const prazo = Date.now() + limiteMs;
  while (Date.now() < prazo) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // ainda subindo
    }
    await sleep(100);
  }
  throw new Error('servidor de teste nao subiu a tempo');
}

run().catch((e) => {
  console.error('erro no teste:', e);
  process.exit(1);
});
