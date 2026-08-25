/**
 * Registro e relay de salas.
 *
 * Salas são criadas explicitamente por alguém e vivem em memória. Cada uma
 * pertence a uma instância da Activity (o canal de voz), então canais
 * diferentes não enxergam as salas uns dos outros.
 *
 * Vários transmissores simultâneos por sala; N espectadores. Cada transmissor
 * recebe um "slot" numérico e carimba esse número no primeiro byte de todo
 * quadro, então o servidor repassa o buffer sem tocar nele e o espectador sabe
 * para qual decoder mandar.
 *
 * O servidor não decodifica nada. Ele guarda o decoderConfig de cada
 * transmissor e distingue keyframe de delta, porque quem começa a assistir
 * precisa de um keyframe: delta em decoder frio só dá erro.
 */
import crypto from 'node:crypto';

const MAX_BROADCASTERS = 4;
// Duas por pessoa: a tela e a câmera. O teto da sala continua valendo por cima,
// então duas pessoas com as duas fontes já lotam.
const MAX_POR_PESSOA = 2;

// Identidade de espectador na sinalização WebRTC. O transmissor precisa de um
// nome para endereçar cada conexão direta, e o id do usuário não serve: a mesma
// pessoa pode ter duas abas assistindo, e cada aba é uma conexão diferente.
let proximoPeerId = 1;

/** As fontes que uma transmissão pode ter. */
export const FONTES = new Set(['tela', 'camera']);
// Sala é objeto em memória criado por qualquer pessoa autenticada: sem teto,
// um laço de "criar sala" consome a RAM do processo.
const MAX_ROOMS_PER_INSTANCE = 20;

/**
 * Teto absoluto da fila de um espectador. Este é o freio de memória: sem ele,
 * um espectador que parou de vazar faz o processo inteiro crescer.
 */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

/**
 * Quanto atraso a fila de um espectador pode acumular antes de começarmos a
 * descartar. Este é o freio de latência, e é outro problema do de cima.
 *
 * Dois megabytes protegem a memória e não protegem o tempo: num stream de
 * 2,5 Mb/s eles são seis segundos e meio de vídeo esperando na fila de uma
 * pessoa. Como TCP entrega em ordem e não sabe largar quadro velho, essa
 * pessoa vê a tela parada e depois pulando — e o quadro em que a tela mudou
 * de página está atrás de todos os outros. Era o teto que estava alto, não a
 * rede que estava ruim.
 *
 * Meio segundo cobre a rajada de uma troca de cena e é menos do que se percebe
 * como atraso. Passando disso, descartar é o que traz a imagem de volta ao
 * presente — e o keyframe pedido logo em seguida é o que a recompõe.
 */
const ATRASO_RELAY_MS = 500;

// Piso do teto acima: em bitrate baixo, meio segundo daria alguns quilobytes e
// um keyframe sozinho estouraria a conta a cada vez.
const TETO_RELAY_MIN = 64 * 1024;

// Intervalo mínimo entre dois pedidos de keyframe para a mesma transmissão.
const KEYFRAME_ASK_EVERY_MS = 1000;
const MAX_NAME = 32;
const MAX_ROOM_NAME = 40;

// Sala vazia fecha, mas não no mesmo instante: recarregar a atividade
// desconecta e reconecta, e quem estivesse sozinho perderia a sala a cada F5.
// 12s cobre um reload com folga e some rápido o bastante para não deixar sala
// fantasma na lista.
const EMPTY_GRACE_MS = 12 * 1000;
// Quanto tempo a transmissão de alguém sobrevive à saída dessa pessoa da sala.
// Existe pelo mesmo motivo da carência acima: recarregar a atividade desconecta
// e reconecta, e sem ela um F5 derrubaria a transmissão de quem não saiu de
// lugar nenhum. Quinze segundos cobrem com folga o relogin do Discord, que o
// próprio arranque já considera demorado a partir de oito.
//
// A variável de ambiente existe para o teste não ficar quinze segundos parado.
// Em uso normal ninguém mexe nisto.
const SEM_PRESENCA_MS = Number(process.env.BROADCAST_ORPHAN_MS) || 15 * 1000;
const SWEEP_EVERY_MS = 4 * 1000;

// Freio de força bruta: sem isso uma senha curta cai em segundos, porque o
// endpoint responde tão rápido quanto a rede permite.
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60 * 1000;
const LOCKOUT_MS = 30 * 1000;

const SLOT_BYTE = 0;
const TYPE_BYTE = 1;
const KEYFRAME = 1;
const AUDIO = 3;

// ------------------------------------------------------------- anotações
//
// O servidor guarda os traços porque quem chega no meio precisa vê-los: o
// desenho é estado da transmissão, não um evento que passou. O laser não é
// guardado — ele se refaz sozinho no quadro seguinte.
//
// Todos os tetos existem pelo mesmo motivo do MAX_BUFFERED_BYTES: um cliente
// adulterado desenhando em laço encheria a RAM do processo e o JSON de sincronia
// de quem entrasse depois.
const MAX_TRACOS = 400;
const MAX_PONTOS_POR_TRACO = 3000;
const MAX_PONTOS_TOTAL = 24_000;
const MAX_PONTOS_POR_MSG = 64;

// Teto de eventos por segundo, por conexão. Laser a 25/s somado a uma caneta a
// 25/s dá 50 — 200 deixa folga de sobra para quem tem a mão rápida e ainda
// assim corta um laço.
const MAX_EVENTOS_POR_S = 200;

const EVENTOS = new Set(['p', 'po', 's', 'a', 'e', 'u', 'c', 'ca']);
const COR_VALIDA = /^#[0-9a-f]{6}$/i;
const GRADE = 4095;

const rooms = new Map();

// Contadores do payload de midia que realmente atravessa o relay. Eles nao
// incluem os poucos bytes de cabecalho TCP/TLS/WebSocket, mas refletem a parte
// que cresce com bitrate e quantidade de espectadores.
const appTraffic = trafficCounter();

function trafficCounter() {
  return {
    startedAt: Date.now(),
    receivedBytes: 0,
    transmittedBytes: 0,
    droppedBytes: 0,
    buckets: new Map(),
    lastPrunedSecond: 0,
  };
}

function recordTraffic(counter, direction, bytes) {
  if (!counter || !Number.isFinite(bytes) || bytes <= 0) return;
  const second = Math.floor(Date.now() / 1000);
  let bucket = counter.buckets.get(second);
  if (!bucket) {
    bucket = { receivedBytes: 0, transmittedBytes: 0, droppedBytes: 0 };
    counter.buckets.set(second, bucket);
  }

  counter[direction] += bytes;
  bucket[direction] += bytes;

  // Um stream pode entregar centenas de chunks por segundo. A limpeza roda no
  // maximo uma vez por segundo por contador, nunca uma vez por chunk.
  if (counter.lastPrunedSecond !== second) {
    counter.lastPrunedSecond = second;
    for (const key of counter.buckets.keys()) {
      if (key < second - 60) counter.buckets.delete(key);
    }
  }
}

function trafficSnapshot(counter, windowSeconds = 5) {
  if (!counter) {
    return {
      receivedBytes: 0,
      transmittedBytes: 0,
      droppedBytes: 0,
      receivedBytesPerSecond: 0,
      transmittedBytesPerSecond: 0,
    };
  }

  const now = Date.now();
  const currentSecond = Math.floor(now / 1000);
  const firstSecond = currentSecond - windowSeconds + 1;
  let receivedBytes = 0;
  let transmittedBytes = 0;
  let droppedBytes = 0;

  for (const [second, bucket] of counter.buckets) {
    if (second < firstSecond) continue;
    receivedBytes += bucket.receivedBytes;
    transmittedBytes += bucket.transmittedBytes;
    droppedBytes += bucket.droppedBytes;
  }

  const actualWindow = Math.max(1, Math.min(windowSeconds, (now - counter.startedAt) / 1000));
  return {
    receivedBytes: counter.receivedBytes,
    transmittedBytes: counter.transmittedBytes,
    droppedBytes: counter.droppedBytes,
    receivedBytesPerSecond: receivedBytes / actualWindow,
    transmittedBytesPerSecond: transmittedBytes / actualWindow,
    droppedBytesPerSecond: droppedBytes / actualWindow,
  };
}

/**
 * Acompanha quantos bytes por segundo esta transmissão está entregando.
 *
 * Serve para uma coisa só: traduzir "quanto pode esperar na fila" de bytes para
 * tempo. O `trafficSnapshot` já saberia responder, mas ele varre sessenta
 * baldes, e aqui a pergunta é feita a cada quadro — o balde do segundo corrente
 * é tudo o que esta conta precisa.
 */
function medirTaxa(entry, bytes) {
  const segundo = Math.floor(Date.now() / 1000);
  if (entry.taxaSegundo !== segundo) {
    // Média móvel: uma rajada não vira teto permanente, e um segundo magro não
    // derruba o teto em cima de quem estava bem.
    if (entry.taxaSegundo !== undefined) {
      entry.taxaBytes =
        entry.taxaBytes === undefined
          ? entry.taxaParcial
          : entry.taxaBytes * 0.6 + entry.taxaParcial * 0.4;
    }
    entry.taxaSegundo = segundo;
    entry.taxaParcial = 0;
  }
  entry.taxaParcial += bytes;
}

/** Quantos bytes podem esperar na fila de um espectador desta transmissão. */
function tetoDe(entry) {
  const porTempo = ((entry.taxaBytes ?? 0) * ATRASO_RELAY_MS) / 1000;
  return Math.min(MAX_BUFFERED_BYTES, Math.max(TETO_RELAY_MIN, porTempo));
}

// Uma pessoa pode ter duas transmissões ao mesmo tempo, então o uid sozinho não
// identifica mais uma delas. A chave composta mantém o acesso direto que o
// registro sempre teve, sem virar um Map de Maps.
const chaveDe = (uid, fonte) => `${uid}|${fonte}`;

/** As transmissões de uma pessoa, de uma fonte só quando `fonte` vem. */
export function broadcastersOf(room, userId, fonte = null) {
  return [...room.broadcasters.values()].filter(
    (e) => e.info.id === userId && (!fonte || e.fonte === fonte),
  );
}

const transmitindo = (room, userId) => broadcastersOf(room, userId).length > 0;

/**
 * A aba de captura, ligada desde que carrega e antes de qualquer transmissão.
 *
 * Existe porque a atividade precisa falar com ela justamente quando não há nada
 * no ar: mudar a qualidade, ou pedir a tela — que só nasce de um clique lá. A
 * conexão de transmissão não serve para isso, porque só é aberta depois que a
 * captura foi concedida.
 *
 * Não ocupa slot, não entra na contagem de pessoas e não segura a sala de pé:
 * uma aba esquecida aberta não pode manter viva uma sala que todo mundo já
 * deixou.
 */
export function attachControl(room, ws, userId) {
  ws.__controlOf = userId;
  room.controles.add(ws);
}

export function detachControl(room, ws) {
  room.controles.delete(ws);
}

/** Manda um recado para as abas de captura de uma pessoa. */
export function toControls(room, userId, obj) {
  let entregues = 0;
  for (const ws of room.controles) {
    if (ws.__controlOf !== userId) continue;
    if (sendJson(ws, obj)) entregues++;
  }
  return entregues;
}

// ------------------------------------------------------------------- senha

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return { salt, hash: crypto.scryptSync(password, salt, 32) };
}

function passwordMatches(room, password) {
  if (!room.password) return true;
  const { hash } = hashPassword(password, room.password.salt);
  return crypto.timingSafeEqual(hash, room.password.hash);
}

/** Retorna null se pode tentar, ou os segundos que faltam para liberar. */
function lockoutRemaining(room) {
  if (!room.lockedUntil) return null;
  const left = room.lockedUntil - Date.now();
  if (left <= 0) {
    room.lockedUntil = 0;
    room.attempts = [];
    return null;
  }
  return Math.ceil(left / 1000);
}

/**
 * @returns {{ok:true}|{ok:false, reason:'senha'|'bloqueado', seconds?:number}}
 */
export function checkPassword(room, password) {
  const locked = lockoutRemaining(room);
  if (locked !== null) return { ok: false, reason: 'bloqueado', seconds: locked };

  if (passwordMatches(room, password ?? '')) {
    room.attempts = [];
    return { ok: true };
  }

  const now = Date.now();
  room.attempts = room.attempts.filter((t) => now - t < ATTEMPT_WINDOW_MS);
  room.attempts.push(now);

  if (room.attempts.length >= MAX_ATTEMPTS) {
    room.lockedUntil = now + LOCKOUT_MS;
    return { ok: false, reason: 'bloqueado', seconds: Math.ceil(LOCKOUT_MS / 1000) };
  }
  return { ok: false, reason: 'senha' };
}

/** Só o dono mexe na senha. Passar vazio remove. */
export function setPassword(room, userId, password) {
  if (room.ownerId !== userId) return 'Só quem criou a sala pode mudar a senha.';

  if (!password) {
    room.password = null;
  } else {
    room.password = hashPassword(String(password));
  }
  room.attempts = [];
  room.lockedUntil = 0;
  broadcastState(room);
  return null;
}

// ------------------------------------------------------------------ registro

export function createRoom({
  instance,
  name,
  ownerId,
  ownerName,
  password,
  guildId = null,
  guildName = null,
  channelId = null,
}) {
  const abertas = [...rooms.values()].filter((r) => r.instance === instance).length;
  if (abertas >= MAX_ROOMS_PER_INSTANCE) {
    return { error: 'Limite de salas abertas atingido. Feche uma antes de criar outra.' };
  }

  const escolhido = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  // Nome é opcional: sem ele, um baseado em quem criou.
  const clean = (escolhido || `Sala de ${ownerName}`).slice(0, MAX_ROOM_NAME);

  const id = crypto.randomBytes(6).toString('base64url');

  const room = {
    id,
    instance,
    guildId,
    guildName,
    channelId,
    name: clean,
    ownerId,
    ownerName,
    password: password ? hashPassword(String(password)) : null,
    attempts: [],
    lockedUntil: 0,
    createdAt: Date.now(),
    emptySince: Date.now(),
    broadcasters: new Map(),
    slots: new Map(),
    viewers: new Set(),
    controles: new Set(),
    droppedChunks: 0,
    traffic: trafficCounter(),
    // O quadro branco da sala. Vive fora das transmissões de propósito: ele
    // existe quando não há tela nenhuma no ar, que é justamente quando as
    // pessoas mais precisam de um lugar para desenhar junto.
    quadro: novaAnn(),
  };

  rooms.set(id, room);
  return { room };
}

export const getRoom = (id) => rooms.get(id) ?? null;

/**
 * A sala fixa de uma call: id derivado do canal, criada na primeira entrada.
 *
 * Não tem dono nem senha — quem controla o acesso é a própria call, já que só
 * entra quem o Discord confirmou estar conectado ao canal.
 */
export function ensureCallRoom(instance, id, metadata = {}) {
  let room = rooms.get(id);
  if (room) {
    // A instância da Activity muda a cada relançamento no mesmo canal; o canal
    // é que é estável. Sem atualizar, a sala sumiria da lista após um relaunch.
    room.instance = instance;
    room.guildId = metadata.guildId ?? room.guildId ?? null;
    room.guildName = metadata.guildName ?? room.guildName ?? null;
    room.channelId = metadata.channelId ?? room.channelId ?? null;
    return room;
  }

  room = {
    id,
    instance,
    guildId: metadata.guildId ?? null,
    guildName: metadata.guildName ?? null,
    channelId: metadata.channelId ?? null,
    name: 'Sala da call',
    isCall: true,
    ownerId: null,
    ownerName: 'a call',
    password: null,
    attempts: [],
    lockedUntil: 0,
    createdAt: Date.now(),
    emptySince: Date.now(),
    broadcasters: new Map(),
    slots: new Map(),
    viewers: new Set(),
    controles: new Set(),
    droppedChunks: 0,
    traffic: trafficCounter(),
  };

  rooms.set(id, room);
  return room;
}

/**
 * Lista pública: nunca vaza hash de senha, só se ela existe.
 *
 * A sala automática da call fica de fora: dentro do Discord a atividade entra
 * nela direto, e no site ela nunca poderia ser aberta. Listá-la seria mostrar
 * uma porta que não abre.
 */
export function listRooms(instance) {
  return [...rooms.values()]
    .filter((r) => r.instance === instance && !r.isCall)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({
      id: r.id,
      name: r.name,
      owner: r.ownerName,
      isCall: Boolean(r.isCall),
      locked: Boolean(r.password),
      people: countPeople(r),
      streams: [...r.broadcasters.values()].filter((e) => e.streaming).length,
    }));
}

function countPeople(room) {
  const ids = new Set();
  for (const v of room.viewers) if (v.__info) ids.add(v.__info.id);
  for (const e of room.broadcasters.values()) ids.add(e.info.id);
  return ids.size;
}

/**
 * Fecha salas vazias há tempo demais.
 *
 * A carência existe porque recarregar a atividade desconecta e reconecta: sem
 * ela, quem estivesse sozinho perderia a sala a cada F5.
 */
/**
 * Encerra a transmissão de quem já não está mais na sala.
 *
 * A aba de captura tem conexão própria: fechar a atividade não a alcança, e a
 * tela continua indo para quem ficou — sem a pessoa estar vendo, e sem nada na
 * frente dela dizendo que ainda está no ar. Isso é vazamento de tela, não
 * detalhe de interface, então quem decide é o servidor, que é o único lado que
 * enxerga as duas conexões.
 *
 * O `stop-request` faz a aba encerrar por conta própria e dizer o motivo. O
 * `detachBroadcaster` vem junto e não depende dela: uma aba travada, ou que
 * perdeu o socket, não pode continuar segurando a tela no ar.
 */
function derrubarAbandonadas(room, now) {
  marcarSemDono(room, now);

  // Cópia da lista: encerrar tira o transmissor do registro, e não se altera o
  // que se está percorrendo.
  for (const entry of [...room.broadcasters.values()]) {
    if (entry.semDonoDesde === null || now - entry.semDonoDesde <= SEM_PRESENCA_MS) continue;

    sendJson(entry.ws, {
      type: 'stop-request',
      motivo: 'Você saiu da atividade, então a transmissão parou.',
    });
    console.log(`[room ${room.id}] ${entry.info.name} saiu da sala — ${entry.fonte} encerrada`);
    detachBroadcaster(room, entry.ws);

    // Pedir é o caminho educado; fechar é o que garante. `detachBroadcaster`
    // tira a transmissão do relay, mas quem ainda segura a tela é a aba — e uma
    // aba em segundo plano pode demorar a reagir à mensagem. Fechar o socket a
    // derruba pelo tratamento de queda que o próprio transmissor já tem, e é
    // isso que faz a captura parar de verdade em vez de só parar de ser
    // repassada.
    entry.ws.close();
  }
}

/**
 * Marca desde quando cada transmissão está sem o dono na sala.
 *
 * Chamada também quando uma conexão cai e quando outra entra, e não só pela
 * varredura: o relógio precisa começar no instante em que a pessoa sai, não na
 * passada seguinte. São até quatro segundos de diferença, e eles são de tela
 * exposta. Pela mesma razão, quem volta zera o relógio na hora — é o que faz um
 * F5 na atividade não custar a transmissão.
 */
function marcarSemDono(room, now = Date.now()) {
  if (!room.broadcasters.size) return;

  // Um Set, e não uma varredura dos espectadores por transmissão: com câmera e
  // tela no ar, a mesma sala tem várias entradas do mesmo dono.
  const presentes = new Set();
  for (const v of room.viewers) if (v.__info) presentes.add(v.__info.id);

  for (const entry of room.broadcasters.values()) {
    if (presentes.has(entry.info.id)) entry.semDonoDesde = null;
    else if (entry.semDonoDesde === null) entry.semDonoDesde = now;
  }
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    derrubarAbandonadas(room, now);

    const empty = room.viewers.size === 0 && room.broadcasters.size === 0;

    if (!empty) {
      room.emptySince = null;
      continue;
    }
    if (room.emptySince === null) {
      room.emptySince = now;
      continue;
    }
    if (now - room.emptySince > EMPTY_GRACE_MS) {
      // As abas de captura não seguram a sala de pé, mas continuam ligadas a
      // ela — e essa é a única conexão que sobrevive a este ponto, justamente
      // porque ficou de fora da conta de vazio. Sem fechar aqui, ela segue
      // aberta contra um objeto que ninguém mais alcança: não recebe mais nada,
      // e como não há `close`, a aba nem tenta reconectar.
      for (const ws of room.controles) {
        sendJson(ws, { type: 'room-gone' });
        ws.close();
      }
      room.controles.clear();

      rooms.delete(room.id);
      console.log(`[room ${room.id}] fechada por inatividade`);
    }
  }
}, SWEEP_EVERY_MS);
sweeper.unref?.();

// -------------------------------------------------------------------- envio

function send(ws, data) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(data);
  return true;
}

export function sendJson(ws, obj) {
  return send(ws, JSON.stringify(obj));
}

function toViewers(room, obj) {
  const msg = JSON.stringify(obj);
  for (const v of room.viewers) send(v, msg);
}

// -------------------------------------------------------------------- estado

// O avatar vai junto do nome: a lista de quem assiste mostra as fotos, e sem
// isto sobrava só a inicial colorida para quem tem foto no Discord.
function watchersOf(room, slot) {
  const byId = new Map();
  for (const v of room.viewers) {
    if (v.__watching?.has(slot) && v.__info) byId.set(v.__info.id, v.__info);
  }
  return [...byId.values()].map((info) => ({
    id: info.id,
    name: info.name,
    avatar: info.avatar ?? null,
  }));
}

function roomState(room) {
  // Uma pessoa pode ter a sala aberta em mais de uma aba; agrupamos por id
  // para não aparecer duplicada na lista.
  const byId = new Map();
  for (const v of room.viewers) {
    if (v.__info) byId.set(v.__info.id, v.__info);
  }

  const participants = [...byId.values()].map((info) => ({
    id: info.id,
    name: info.name,
    avatar: info.avatar ?? null,
    broadcasting: transmitindo(room, info.id),
  }));

  // Quem transmite pode ter fechado a aba da Activity: continua na lista,
  // senão o vídeo fica sem dono visível. O `vistos` importa agora que a mesma
  // pessoa pode ter duas transmissões — sem ele, apareceria duplicada.
  const vistos = new Set(byId.keys());
  for (const entry of room.broadcasters.values()) {
    if (vistos.has(entry.info.id)) continue;
    vistos.add(entry.info.id);
    participants.push({
      id: entry.info.id,
      name: entry.info.name,
      avatar: entry.info.avatar ?? null,
      broadcasting: true,
    });
  }

  participants.sort((a, b) => Number(b.broadcasting) - Number(a.broadcasting));

  // Quem tem aba de captura aberta. É o que permite à atividade saber se pode
  // falar com ela em vez de abrir outra — antes isso era deduzido do que estava
  // no ar, e uma aba ainda parada não aparecia em lugar nenhum.
  const abas = [...new Set([...room.controles].map((ws) => ws.__controlOf))];

  return {
    type: 'state',
    abas,
    room: { id: room.id, name: room.name, ownerId: room.ownerId, locked: Boolean(room.password) },
    broadcasting: room.broadcasters.size > 0,
    viewers: room.viewers.size,
    participants,
    streams: [...room.broadcasters.values()]
      .filter((e) => e.streaming)
      .map((e) => ({
        slot: e.slot,
        userId: e.info.id,
        fonte: e.fonte,
        watchers: watchersOf(room, e.slot),
      })),
  };
}

export function broadcastState(room) {
  const msg = JSON.stringify(roomState(room));
  for (const v of room.viewers) send(v, msg);
  for (const e of room.broadcasters.values()) send(e.ws, msg);
}

/**
 * Pede um ponto de partida novo ao transmissor, no máximo um por segundo.
 *
 * O limite não é economia: keyframe é o quadro mais caro que existe, e quem
 * pede é justamente quem já está com a conexão apertada. Sem o intervalo, dez
 * espectadores em apuros virariam dez keyframes seguidos — o remédio entupindo
 * o cano que ele deveria desentupir. Um serve todos, porque o transmissor manda
 * para a sala inteira.
 */
function requestKeyframe(entry, { urgente = false } = {}) {
  const agora = Date.now();
  // A pressa é para quem ficou sem nenhuma imagem, e não para quem está com a
  // conexão apertada: voltar da conexão direta para o relay deixa o
  // decodificador frio, e esperar o intervalo custaria segundos de tela parada.
  // O recado é barato — do outro lado ele só levanta uma bandeira, e levantá-la
  // duas vezes é o mesmo que levantá-la uma.
  if (!urgente && agora - (entry.lastKeyframeAsk ?? 0) < KEYFRAME_ASK_EVERY_MS) return;
  entry.lastKeyframeAsk = agora;
  sendJson(entry.ws, { type: 'need-keyframe' });
}

export function rename(room, ws, raw) {
  if (!ws.__info || typeof raw !== 'string') return;

  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (!name) return;

  ws.__info.name = name;
  // Todas as transmissões da pessoa, não "a" transmissão: quem divide tela e
  // câmera tem duas, e renomear só uma deixaria o grid com dois nomes.
  for (const entry of broadcastersOf(room, ws.__info.id)) entry.info.name = name;
  broadcastState(room);
}

// ---------------------------------------------------------------- transmissor

function freeSlot(room) {
  for (let i = 0; i < MAX_BROADCASTERS; i++) {
    if (!room.slots.has(i)) return i;
  }
  return null;
}

/** Retorna a entry criada, ou uma string com o motivo da recusa. */
export function attachBroadcaster(room, ws, info, fonte = 'tela') {
  const chave = chaveDe(info.id, fonte);

  // A recusa nomeia a fonte: "você já está transmitindo" era claro quando só
  // havia uma, mas com duas deixaria a pessoa sem saber qual delas repetiu.
  if (room.broadcasters.has(chave)) {
    return fonte === 'camera'
      ? 'Você já está transmitindo a câmera nesta sala.'
      : 'Você já está transmitindo a tela nesta sala.';
  }
  if (broadcastersOf(room, info.id).length >= MAX_POR_PESSOA) {
    return `Limite de ${MAX_POR_PESSOA} transmissões por pessoa atingido.`;
  }
  if (room.broadcasters.size >= MAX_BROADCASTERS) {
    return `Limite de ${MAX_BROADCASTERS} transmissões simultâneas atingido.`;
  }

  const slot = freeSlot(room);
  if (slot === null) return 'Sem espaço para mais transmissões.';

  const entry = {
    ws,
    info,
    fonte,
    chave,
    slot,
    streaming: false,
    // Desde quando quem transmite não está mais na sala. Null enquanto está.
    semDonoDesde: null,
    config: null,
    audioConfig: null,
    connectedAt: Date.now(),
    startedAt: null,
    traffic: trafficCounter(),
    droppedChunks: 0,
    // Taxa medida desta transmissão, em bytes por segundo, e o segundo que está
    // sendo somado agora. É o que traduz o teto de fila de bytes para tempo.
    taxaBytes: undefined,
    taxaSegundo: undefined,
    taxaParcial: 0,
    ann: novaAnn(),
    // undefined = nunca dito. Vira true/false no primeiro espectador, e é o que
    // impede o servidor de repetir o mesmo recado a cada entrada e saída.
    chunksLigados: undefined,
  };
  room.broadcasters.set(chave, entry);
  room.slots.set(slot, entry);
  ws.__entry = entry;
  room.emptySince = null;

  sendJson(ws, { type: 'slot', slot });
  broadcastState(room);
  return entry;
}

export function startStream(room, entry) {
  entry.streaming = true;
  entry.startedAt = Date.now();
  entry.config = null;
  entry.audioConfig = null;
  // Transmissão nova, taxa nova: uma câmera a 800 kb/s herdando o teto de uma
  // tela a 5 Mb/s daria dez segundos de fila antes de descartar o primeiro
  // quadro.
  entry.taxaBytes = undefined;
  entry.taxaSegundo = undefined;
  entry.taxaParcial = 0;
  // Tela nova, quadro limpo: traço feito sobre a tela anterior não tem mais
  // sobre o que estar.
  entry.ann = novaAnn();
  // Transmissão nova recomeça do zero: ninguém assiste até pedir.
  for (const v of room.viewers) {
    v.__primed?.delete(entry.slot);
    v.__afogado?.delete(entry.slot);
    v.__watching?.delete(entry.slot);
  }
  toViewers(room, {
    type: 'stream-start',
    slot: entry.slot,
    userId: entry.info.id,
    fonte: entry.fonte,
  });
  broadcastState(room);
}

/**
 * Config do áudio, guardada e repassada igual à do vídeo.
 *
 * Quem começa a assistir no meio precisa dela para montar o decodificador — e,
 * ao contrário do vídeo, aqui não existe keyframe para servir de ponto de
 * partida: sem a config, nenhum pacote de som é aproveitável.
 */
export function setAudioConfig(room, entry, config) {
  entry.audioConfig = config;
  for (const v of room.viewers) {
    if (v.__watching?.has(entry.slot)) {
      sendJson(v, { type: 'audio-config', slot: entry.slot, config });
    }
  }
}

export function setConfig(room, entry, config) {
  entry.config = config;
  // Config nova significa decoder recriado; ele volta a precisar de keyframe.
  // O afogamento sai junto: quem estava esperando drenar não pode ficar preso
  // numa espera pendurada num decodificador que nem existe mais.
  for (const v of room.viewers) {
    v.__primed?.delete(entry.slot);
    v.__afogado?.delete(entry.slot);
  }
  for (const v of room.viewers) {
    if (v.__watching?.has(entry.slot)) sendJson(v, { type: 'config', slot: entry.slot, config });
  }
}

/**
 * Tira o espectador do fluxo desta transmissão até a fila dele drenar.
 *
 * Ele perde o ponto de partida (o próximo delta seria indecifrável de qualquer
 * jeito) e entra na lista de quem espera drenar. Quem tira dela é o pushChunk,
 * e é lá que o keyframe é pedido — no instante em que ele consegue recebê-lo.
 */
function afogar(ws, entry) {
  ws.__primed?.delete(entry.slot);
  ws.__afogado?.add(entry.slot);
}

export function pushChunk(room, entry, chunk) {
  const bytes = Number(chunk?.byteLength ?? chunk?.length ?? 0);
  recordTraffic(appTraffic, 'receivedBytes', bytes);
  recordTraffic(room.traffic, 'receivedBytes', bytes);
  recordTraffic(entry.traffic, 'receivedBytes', bytes);

  if (chunk[SLOT_BYTE] !== entry.slot) return;

  medirTaxa(entry, bytes);
  const teto = tetoDe(entry);

  const tipo = chunk[TYPE_BYTE];
  const isKeyframe = tipo === KEYFRAME;
  const isAudio = tipo === AUDIO;
  let sentCopies = 0;
  let droppedCopies = 0;

  const descartar = () => {
    room.droppedChunks++;
    entry.droppedChunks++;
    droppedCopies++;
  };

  for (const v of room.viewers) {
    if (v.readyState !== v.OPEN) continue;

    // Assistir é opt-in: quem não pediu esta tela não recebe os bytes dela.
    if (!v.__watching.has(entry.slot)) continue;

    // Já está recebendo esta tela pela conexão direta. O relay some do caminho
    // dele sem que nada seja desligado: se o WebRTC cair, o slot sai deste
    // conjunto e os bytes voltam a fluir no mesmo instante.
    if (v.__rtc?.has(entry.slot)) continue;

    // Áudio não depende de keyframe — cada pacote Opus se decodifica sozinho —,
    // então não passa pelo controle de "já recebeu ponto de partida".
    if (isAudio) {
      if (v.bufferedAmount > teto) {
        descartar();
        continue;
      }
      v.send(chunk);
      sentCopies++;
      v.__mediaBytesOut = (v.__mediaBytesOut ?? 0) + bytes;
      continue;
    }

    // Afogado: a fila dele estourou e ele foi despreparado. Enquanto ela não
    // drenar, nada é mandado e nada é pedido — mandar o keyframe, que é o
    // quadro mais caro que existe, pelo cano que acabou de entupir é o que
    // fazia o ciclo se repetir a cada segundo em vez de acabar. O pedido sai
    // quando a fila cair pela metade, que é quando ele tem chance de chegar.
    if (v.__afogado?.has(entry.slot)) {
      if (v.bufferedAmount > teto / 2) {
        descartar();
        continue;
      }
      v.__afogado.delete(entry.slot);
      if (!isKeyframe) {
        requestKeyframe(entry);
        descartar();
        continue;
      }
      // Drenou e o que chegou já é keyframe: não há o que pedir, é este mesmo.
    }

    if (isKeyframe) {
      if (v.bufferedAmount > teto * 2) {
        descartar();
        afogar(v, entry);
        continue;
      }
      v.send(chunk);
      sentCopies++;
      v.__mediaBytesOut = (v.__mediaBytesOut ?? 0) + bytes;
      v.__primed.add(entry.slot);
      continue;
    }

    if (!v.__primed.has(entry.slot)) continue;

    if (v.bufferedAmount > teto) {
      descartar();

      // Um delta perdido quebra a cadeia de referência: daqui em diante o
      // decoder dele descarta tudo até chegar um keyframe. Continuar mandando
      // deltas seria despejar bytes indecifráveis numa conexão que já não vaza
      // — o buffer nunca drena, o descarte nunca para, e o vídeo fica parado
      // por segundos. Despreparar corta esse ciclo.
      afogar(v, entry);
      continue;
    }
    v.send(chunk);
    sentCopies++;
    v.__mediaBytesOut = (v.__mediaBytesOut ?? 0) + bytes;
  }

  const sentBytes = bytes * sentCopies;
  const droppedBytes = bytes * droppedCopies;
  for (const counter of [appTraffic, room.traffic, entry.traffic]) {
    recordTraffic(counter, 'transmittedBytes', sentBytes);
    recordTraffic(counter, 'droppedBytes', droppedBytes);
  }
}

export function stopStream(room, entry) {
  if (!entry.streaming) return;
  entry.streaming = false;
  entry.startedAt = null;
  entry.config = null;
  entry.audioConfig = null;
  entry.ann = novaAnn();
  for (const v of room.viewers) {
    v.__primed?.delete(entry.slot);
    v.__afogado?.delete(entry.slot);
    v.__watching?.delete(entry.slot);
    v.__rtc?.delete(entry.slot);
  }
  entry.chunksLigados = undefined;
  toViewers(room, { type: 'stream-stop', slot: entry.slot });
}

export function detachBroadcaster(room, ws) {
  const entry = ws.__entry;
  if (!entry || room.broadcasters.get(entry.chave) !== entry) return;

  stopStream(room, entry);
  room.broadcasters.delete(entry.chave);
  room.slots.delete(entry.slot);
  broadcastState(room);
}

// --------------------------------------------------------------- espectador

export function watch(room, ws, slot) {
  const entry = room.slots.get(slot);
  if (!entry || !entry.streaming) return;
  // Repetir o pedido não muda nada, mas custaria um broadcast de estado para a
  // sala inteira — um cliente em laço faria o servidor inundar todo mundo.
  if (ws.__watching.has(slot)) return;

  ws.__watching.add(slot);
  ws.__primed.delete(slot);
  ws.__afogado?.delete(slot);

  if (entry.config) sendJson(ws, { type: 'config', slot, config: entry.config });
  if (entry.audioConfig) {
    sendJson(ws, { type: 'audio-config', slot, config: entry.audioConfig });
  }
  // O que já está desenhado é estado da tela, não histórico: quem chega no meio
  // precisa ver a mesma seta que todo mundo está olhando.
  if (entry.ann.tracos.size) {
    sendJson(ws, { type: 'ann-sync', slot, tracos: snapshotAnn(entry.ann) });
  }
  requestKeyframe(entry);

  // Convida o transmissor a abrir uma conexão direta com este espectador. É só
  // um convite: enquanto ela não fecha — e ela pode nunca fechar — os quadros
  // continuam chegando pelo relay, que já começou acima.
  sendJson(entry.ws, { type: 'rtc-want', peer: ws.__peerId });

  atualizarChunks(room, entry);
  broadcastState(room);
}

export function unwatch(room, ws, slot) {
  // Só avisa a sala se algo mudou de fato; ver a nota em watch().
  if (!ws.__watching.delete(slot)) return;
  ws.__primed.delete(slot);
  ws.__afogado?.delete(slot);
  encerrarPeer(room, ws, slot);
  broadcastState(room);
}

// -------------------------------------------------------------- anotações

function novaAnn() {
  // Ordem de inserção é o que "desfazer" usa; Map garante isso por
  // especificação, então não há índice separado para manter em dia.
  return { tracos: new Map(), pontos: 0 };
}

/** Estado desenhado, no formato que a camada do cliente consome direto. */
function snapshotAnn(ann) {
  return [...ann.tracos.entries()].map(([id, t]) => ({
    id,
    uid: t.uid,
    name: t.name,
    color: t.color,
    width: t.width,
    pts: t.pts,
  }));
}

/**
 * Freio por conexão.
 *
 * Janela de um segundo, contador simples: não precisa ser justo, precisa ser
 * barato. O que ele impede é um cliente adulterado transformar cada evento seu
 * em N cópias saindo do relay.
 */
function permitirEvento(ws) {
  const segundo = Math.floor(Date.now() / 1000);
  if (ws.__annSegundo !== segundo) {
    ws.__annSegundo = segundo;
    ws.__annContagem = 0;
  }
  ws.__annContagem = (ws.__annContagem ?? 0) + 1;
  return ws.__annContagem <= MAX_EVENTOS_POR_S;
}

const inteiroNaGrade = (n) => Number.isFinite(n) && n >= 0 && n <= GRADE;

/** Devolve o evento saneado, ou null quando não dá para confiar nele. */
function validarEvento(ev) {
  if (!ev || typeof ev !== 'object' || !EVENTOS.has(ev.k)) return null;

  switch (ev.k) {
    case 'p': {
      const x = Math.round(ev.x);
      const y = Math.round(ev.y);
      if (!inteiroNaGrade(x) || !inteiroNaGrade(y)) return null;
      const c = COR_VALIDA.test(ev.c ?? '') ? ev.c : '#ff4d4f';
      return { k: 'p', x, y, c };
    }
    case 'po':
    case 'u':
    case 'c':
    case 'ca':
      return { k: ev.k };
    case 's': {
      const pts = validarPontos(ev.pts);
      if (!pts || !Number.isInteger(ev.id) || ev.id < 0 || ev.id > 1e9) return null;
      return {
        k: 's',
        id: ev.id,
        c: COR_VALIDA.test(ev.c ?? '') ? ev.c : '#ff4d4f',
        w: Math.min(64, Math.max(1, Math.round(ev.w) || 10)),
        pts,
      };
    }
    case 'a': {
      const pts = validarPontos(ev.pts);
      if (!pts || !pts.length || !Number.isInteger(ev.id)) return null;
      return { k: 'a', id: ev.id, pts };
    }
    case 'e':
      return Number.isInteger(ev.id) ? { k: 'e', id: ev.id } : null;
    default:
      return null;
  }
}

/** Pares x,y achatados num vetor só. Ímpar significa pacote quebrado. */
function validarPontos(pts) {
  if (!Array.isArray(pts) || pts.length % 2 !== 0) return null;
  if (pts.length > MAX_PONTOS_POR_MSG * 2) return null;

  const saida = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const n = Math.round(pts[i]);
    if (!inteiroNaGrade(n)) return null;
    saida[i] = n;
  }
  return saida;
}

/** Limpar a tela dos outros é do dono da transmissão e de quem criou a sala. */
function podeLimparTudo(room, entry, userId) {
  return entry.info.id === userId || room.ownerId === userId;
}

/**
 * Aplica o evento ao estado guardado.
 *
 * @returns {boolean} se ele deve ser repassado. Evento recusado por teto não
 * sai daqui: repassar o que o servidor não guardou deixaria quem já está na
 * sala com um traço que ninguém mais vai receber ao entrar.
 */
function registrarAnn(ann, info, ev) {
  const chave = `${info.id}:${ev.id}`;

  switch (ev.k) {
    // Laser não é guardado: ele se refaz sozinho no quadro seguinte.
    case 'p':
    case 'po':
    case 'e':
      return true;

    case 's': {
      if (ann.pontos + ev.pts.length / 2 > MAX_PONTOS_TOTAL) return false;
      ann.tracos.set(chave, {
        uid: info.id,
        name: info.name,
        color: ev.c,
        width: ev.w,
        pts: [...ev.pts],
      });
      ann.pontos += ev.pts.length / 2;
      podarTracos(ann);
      return true;
    }

    case 'a': {
      const traco = ann.tracos.get(chave);
      if (!traco) return false;
      if (traco.pts.length / 2 >= MAX_PONTOS_POR_TRACO) return false;
      if (ann.pontos + ev.pts.length / 2 > MAX_PONTOS_TOTAL) return false;
      traco.pts.push(...ev.pts);
      ann.pontos += ev.pts.length / 2;
      return true;
    }

    case 'u': {
      const ultimo = [...ann.tracos.entries()].filter(([, t]) => t.uid === info.id).pop();
      if (!ultimo) return false;
      ann.pontos -= ultimo[1].pts.length / 2;
      ann.tracos.delete(ultimo[0]);
      return true;
    }

    case 'c': {
      let mexeu = false;
      for (const [id, t] of ann.tracos) {
        if (t.uid !== info.id) continue;
        ann.pontos -= t.pts.length / 2;
        ann.tracos.delete(id);
        mexeu = true;
      }
      return mexeu;
    }

    case 'ca':
      // Esvaziar no lugar, e não trocar por um `novaAnn()`: quem chama guarda a
      // ann numa propriedade que este módulo não conhece mais.
      ann.tracos.clear();
      ann.pontos = 0;
      return true;

    default:
      return false;
  }
}

function podarTracos(ann) {
  while (ann.tracos.size > MAX_TRACOS) {
    const [id, t] = ann.tracos.entries().next().value;
    ann.pontos -= t.pts.length / 2;
    ann.tracos.delete(id);
  }
}

/**
 * Recebe uma anotação de um espectador e a repassa para a tela inteira.
 *
 * Vai também para o transmissor: é isso que fecha o laço da conversa — a
 * página de captura desenha por cima do próprio preview, então quem mostra a
 * tela vê a seta sem precisar voltar para o Discord.
 */
export function pushAnn(room, ws, slot, evBruto) {
  const info = ws.__info;
  if (!info) return;

  const entry = room.slots.get(slot);
  if (!entry?.streaming) return;

  // Desenhar numa tela que não se está assistindo é desenhar no escuro: a
  // posição normalizada não teria sobre o que ter sido escolhida.
  //
  // Menos para quem transmite aquela tela. Ele vê a imagem sem assistir a
  // própria transmissão — a captura já está na máquina dele —, e é justamente
  // ele quem mais precisa apontar: "esse botão aqui", enquanto mostra.
  if (!ws.__watching?.has(slot) && entry.info.id !== info.id) return;
  if (!permitirEvento(ws)) return;

  const ev = validarEvento(evBruto);
  if (!ev) return;
  if (ev.k === 'ca' && !podeLimparTudo(room, entry, info.id)) return;

  if (!registrarAnn(entry.ann, info, ev)) {
    avisarQuadroCheio(ws, entry.ann, ev);
    return;
  }

  const msg = JSON.stringify({ type: 'ann', slot, uid: info.id, name: info.name, ev });
  for (const v of room.viewers) {
    if (v.__watching?.has(slot)) send(v, msg);
  }
  send(entry.ws, msg);
}

// ------------------------------------------------------------ quadro branco

/**
 * O quadro da sala: o mesmo desenho, sem uma tela por baixo.
 *
 * É a mesma máquina das anotações — mesma validação, mesmos tetos, mesma grade
 * normalizada — com duas diferenças que decidem tudo:
 *
 * 1. **Não pertence a transmissão nenhuma.** As anotações moram no `entry`
 *    porque só existem sobre a tela de alguém, e somem com ela. O quadro é da
 *    sala: ele continua lá quando ninguém está mostrando nada, que é justamente
 *    quando ele serve para alguma coisa.
 * 2. **Vai para todo mundo, sem opt-in.** Assistir é opt-in porque quadro de
 *    vídeo custa megabits; um traço custa dezenas de bytes, e um quadro que só
 *    parte da sala vê não é um quadro, é um mal-entendido.
 *
 * A grade é a mesma 0..4095 nos dois eixos, e o cliente a desenha numa folha de
 * proporção fixa. É isso que faz o traço cair no mesmo lugar em quem está no
 * celular deitado e em quem está num monitor ultrawide — normalizar contra a
 * janela de cada um entortaria o desenho em todo mundo menos em quem desenhou.
 */
export function pushQuadro(room, ws, evBruto) {
  const info = ws.__info;
  if (!info) return;
  if (!permitirEvento(ws)) return;

  const ev = validarEvento(evBruto);
  if (!ev) return;
  // Apagar o desenho de todo mundo é de quem criou a sala. Cada um limpa o seu
  // com `c` e desfaz o último com `u`, que não pedem permissão nenhuma.
  if (ev.k === 'ca' && room.ownerId !== info.id) return;

  if (!registrarAnn(room.quadro, info, ev)) {
    avisarQuadroCheio(ws, room.quadro, ev);
    return;
  }

  const msg = JSON.stringify({ type: 'quadro', uid: info.id, name: info.name, ev });
  for (const v of room.viewers) send(v, msg);
}

/** O que já está desenhado, para quem acabou de chegar. */
export function quadroSync(room, ws) {
  if (!room.quadro.tracos.size) return;
  sendJson(ws, { type: 'quadro-sync', tracos: snapshotAnn(room.quadro) });
}

/** Apaga o quadro inteiro. Usado pelo painel; a sala usa o evento `ca`. */
export function limparQuadro(room) {
  const tinha = room.quadro.tracos.size;
  room.quadro.tracos.clear();
  room.quadro.pontos = 0;
  if (tinha) toViewers(room, { type: 'quadro-sync', tracos: [] });
  return tinha;
}

/** Quantos traços e pontos o quadro guarda. Para o painel. */
export const quadroResumo = (room) => ({
  tracos: room.quadro.tracos.size,
  pontos: room.quadro.pontos,
});

/**
 * Traço recusado por teto some da tela de quem desenhou sem explicação nenhuma.
 * O aviso é limitado a um a cada cinco segundos porque a recusa se repete a
 * cada movimento do mouse.
 */
function avisarQuadroCheio(ws, ann, ev) {
  if (ev.k !== 's' && ev.k !== 'a') return;
  if (ann.pontos < MAX_PONTOS_TOTAL * 0.9) return;

  const agora = Date.now();
  if (agora - (ws.__annAviso ?? 0) < 5000) return;
  ws.__annAviso = agora;
  sendJson(ws, {
    type: 'error',
    message: 'O quadro de desenhos está cheio. Apague algo para continuar desenhando.',
  });
}

// ------------------------------------------------------------------- WebRTC

/**
 * Sinalização: o servidor só carrega envelope, nunca abre.
 *
 * Offer, answer e candidato ICE viajam opacos entre o transmissor e cada
 * espectador. O relay já é o canal de todos com todos e já está autenticado —
 * abrir um segundo canal só para isso seria uma porta a mais para guardar.
 */
function viewerPorPeer(room, peerId) {
  for (const v of room.viewers) {
    if (v.__peerId === peerId) return v;
  }
  return null;
}

/** Do espectador para o transmissor daquele slot. */
export function rtcParaBroadcaster(room, ws, slot, payload) {
  const entry = room.slots.get(slot);
  if (!entry || !entry.streaming) return;
  sendJson(entry.ws, { type: 'rtc', peer: ws.__peerId, payload });
}

/** Do transmissor para um espectador nomeado. */
export function rtcParaViewer(room, entry, peerId, payload) {
  const v = viewerPorPeer(room, peerId);
  if (!v) return;
  sendJson(v, { type: 'rtc', slot: entry.slot, payload });
}

/**
 * O espectador avisa que a conexão direta assumiu — ou que caiu.
 *
 * É ele quem decide, e não o servidor, porque é ele que sabe se está de fato
 * vendo quadros. Fechar o relay por causa de um `connectionState` otimista
 * deixaria a tela preta com a conexão "conectada".
 */
export function rtcAtivo(room, ws, slot, ativo) {
  const entry = room.slots.get(slot);
  if (!entry || !ws.__watching?.has(slot)) return;

  if (ativo) ws.__rtc.add(slot);
  else {
    if (!ws.__rtc.delete(slot)) return;
    // Voltando ao relay, o decoder dele está frio: sem keyframe novo ele
    // descartaria tudo até o periódico, que é de segundos.
    ws.__primed.delete(slot);
    // A fila dele passou o tempo do WebRTC sem receber nada do relay: não há
    // afogamento a herdar, e mantê-lo adiaria o keyframe que traz a imagem.
    ws.__afogado?.delete(slot);
    requestKeyframe(entry, { urgente: true });
  }

  atualizarChunks(room, entry);
}

/** Desfaz a conexão direta de um espectador com um slot, dos dois lados. */
function encerrarPeer(room, ws, slot) {
  const entry = room.slots.get(slot);
  ws.__rtc?.delete(slot);
  if (!entry) return;
  sendJson(entry.ws, { type: 'rtc-bye', peer: ws.__peerId });
  atualizarChunks(room, entry);
}

/**
 * Liga e desliga o fluxo do relay na origem.
 *
 * Quando todo mundo que assiste está na conexão direta, os quadros que sobem
 * para o servidor não têm para onde ir. Continuar codificando e enviando seria
 * gastar a subida de quem transmite — justamente o recurso mais escasso — para
 * alimentar um caminho que ninguém está usando. Vale o contrário também: basta
 * um espectador sem WebRTC para o relay voltar inteiro.
 */
function atualizarChunks(room, entry) {
  let precisa = 0;
  for (const v of room.viewers) {
    if (v.__watching?.has(entry.slot) && !v.__rtc?.has(entry.slot)) precisa++;
  }

  const ligado = precisa > 0;
  if (entry.chunksLigados === ligado) return;
  entry.chunksLigados = ligado;
  sendJson(entry.ws, { type: 'chunks', on: ligado });
  // Religar o relay sem ponto de partida entregaria só deltas indecifráveis.
  if (ligado) requestKeyframe(entry, { urgente: true });
}

export function attachViewer(room, ws, info) {
  ws.__primed = new Set();
  // Slots cuja fila estourou e ainda não drenou. Enquanto o slot está aqui, o
  // relay não gasta um byte com ele — nem o keyframe que ele vai precisar.
  ws.__afogado = new Set();
  ws.__watching = new Set();
  // Slots que já chegam por WebRTC. Enquanto o slot está aqui, o relay não
  // manda os bytes dele para este espectador — seria o mesmo vídeo duas vezes.
  ws.__rtc = new Set();
  ws.__peerId ??= `p${proximoPeerId++}`;
  ws.__info = info;
  ws.__connectedAt = ws.__connectedAt ?? Date.now();
  ws.__mediaBytesOut = ws.__mediaBytesOut ?? 0;
  room.viewers.add(ws);
  room.emptySince = null;
  // Quem voltou zera o relógio do órfão na hora — é o que faz um F5 na
  // atividade não custar a transmissão.
  marcarSemDono(room);

  sendJson(ws, roomState(room));
  // O quadro é estado da sala, não histórico: quem chega no meio precisa ver o
  // mesmo desenho que todo mundo está olhando.
  quadroSync(room, ws);

  // Anuncia o que está no ar, sem começar a mandar quadros: assistir é opt-in.
  for (const entry of room.broadcasters.values()) {
    if (!entry.streaming) continue;
    sendJson(ws, {
      type: 'stream-start',
      slot: entry.slot,
      userId: entry.info.id,
      fonte: entry.fonte,
    });
  }

  broadcastState(room);
}

export function detachViewer(room, ws) {
  // Sai antes de avisar: o recount de `atualizarChunks` não pode contar quem
  // acabou de fechar a aba como alguém que ainda precisa dos quadros.
  room.viewers.delete(ws);
  for (const slot of ws.__watching ?? []) encerrarPeer(room, ws, slot);
  // Saiu agora: o relógio começa agora. Ver marcarSemDono.
  marcarSemDono(room);
  broadcastState(room);
}

export function stats() {
  return [...rooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    locked: Boolean(r.password),
    broadcasting: r.broadcasters.size,
    viewers: r.viewers.size,
    droppedChunks: r.droppedChunks,
  }));
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function usersOf(room) {
  const users = new Map();

  function add(info, role, ws, extra = {}) {
    if (!info?.id) return;
    let user = users.get(info.id);
    if (!user) {
      user = {
        id: info.id,
        name: info.name,
        avatar: info.avatar ?? null,
        roles: new Set(),
        connections: 0,
        connectedAt: Date.now(),
        pingSamples: [],
        watching: new Set(),
        mediaBytesOut: 0,
        bufferedBytes: 0,
      };
      users.set(info.id, user);
    }

    user.name = info.name || user.name;
    user.avatar = info.avatar ?? user.avatar;
    user.roles.add(role);
    user.connections++;
    user.connectedAt = Math.min(user.connectedAt, ws?.__connectedAt ?? Date.now());
    if (Number.isFinite(ws?.__rttMs)) user.pingSamples.push(ws.__rttMs);
    for (const slot of ws?.__watching ?? []) user.watching.add(slot);
    user.mediaBytesOut += ws?.__mediaBytesOut ?? 0;
    user.bufferedBytes += ws?.bufferedAmount ?? 0;
    if (extra.broadcasting) user.broadcasting = true;
  }

  for (const viewer of room.viewers) add(viewer.__info, 'viewer', viewer);
  for (const entry of room.broadcasters.values()) {
    add(entry.info, 'broadcaster', entry.ws, { broadcasting: entry.streaming });
  }

  return [...users.values()].map((user) => ({
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    roles: [...user.roles],
    connections: user.connections,
    connectedAt: user.connectedAt,
    pingMs: average(user.pingSamples),
    watching: [...user.watching],
    broadcasting: Boolean(user.broadcasting),
    mediaBytesOut: user.mediaBytesOut,
    bufferedBytes: user.bufferedBytes,
  }));
}

/** Estado detalhado usado exclusivamente pela API administrativa protegida. */
export function adminStats() {
  const roomList = [...rooms.values()].map((room) => {
    const users = usersOf(room);
    const streams = [...room.broadcasters.values()]
      .filter((entry) => entry.streaming)
      .map((entry) => ({
        slot: entry.slot,
        userId: entry.info.id,
        userName: entry.info.name,
        startedAt: entry.startedAt,
        codec: entry.config?.codec ?? null,
        width: entry.config?.codedWidth ?? null,
        height: entry.config?.codedHeight ?? null,
        audioCodec: entry.audioConfig?.codec ?? null,
        watchers: watchersOf(room, entry.slot).length,
        droppedChunks: entry.droppedChunks,
        bufferedBytes: entry.ws?.bufferedAmount ?? 0,
        pingMs: Number.isFinite(entry.ws?.__rttMs) ? entry.ws.__rttMs : null,
        traffic: trafficSnapshot(entry.traffic),
      }));

    return {
      id: room.id,
      name: room.name,
      instance: room.instance,
      guildId: room.guildId ?? null,
      guildName: room.guildName ?? null,
      channelId: room.channelId ?? null,
      isCall: Boolean(room.isCall),
      locked: Boolean(room.password),
      createdAt: room.createdAt,
      connections: room.viewers.size + room.broadcasters.size,
      viewers: room.viewers.size,
      broadcasters: room.broadcasters.size,
      droppedChunks: room.droppedChunks,
      traffic: trafficSnapshot(room.traffic),
      users,
      streams,
    };
  });

  return { rooms: roomList, traffic: trafficSnapshot(appTraffic), startedAt: appTraffic.startedAt };
}
