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
// Sala é objeto em memória criado por qualquer pessoa autenticada: sem teto,
// um laço de "criar sala" consome a RAM do processo.
const MAX_ROOMS_PER_INSTANCE = 20;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_NAME = 32;
const MAX_ROOM_NAME = 40;

// Sala vazia fecha, mas não no mesmo instante: recarregar a atividade
// desconecta e reconecta, e quem estivesse sozinho perderia a sala a cada F5.
// 12s cobre um reload com folga e some rápido o bastante para não deixar sala
// fantasma na lista.
const EMPTY_GRACE_MS = 12 * 1000;
const SWEEP_EVERY_MS = 4 * 1000;

/**
 * Quanto tempo uma transmissão sobrevive sem o dono na sala.
 *
 * A captura roda numa aba do navegador com conexão própria, que não sabe nada
 * do Discord: fechar a atividade, sair da call ou fechar o Discord inteiro não
 * chega até ela, e a tela continuava indo para uma sala que a pessoa já tinha
 * deixado. Quem percebe é o servidor, que vê o socket da atividade cair e
 * ninguém daquele dono voltar.
 *
 * A carência existe pelo mesmo motivo da EMPTY_GRACE_MS: recarregar a atividade
 * desconecta e reconecta, e sem ela um F5 derrubaria a transmissão. Quinze
 * segundos cobrem com folga o relogin do Discord, que o próprio arranque já
 * considera demorado a partir de oito.
 *
 * A variável de ambiente existe para o teste não ficar quinze segundos parado.
 * Em uso normal ninguém mexe nisto.
 */
const ORFAO_GRACE_MS = Number(process.env.BROADCAST_ORPHAN_MS) || 15 * 1000;

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

  const escolhido = String(name ?? '').replace(/\s+/g, ' ').trim();
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
    droppedChunks: 0,
    traffic: trafficCounter(),
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
  for (const uid of room.broadcasters.keys()) ids.add(uid);
  return ids.size;
}

/**
 * Fecha salas vazias há tempo demais.
 *
 * A carência existe porque recarregar a atividade desconecta e reconecta: sem
 * ela, quem estivesse sozinho perderia a sala a cada F5.
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    encerrarOrfaos(room, now);

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
      rooms.delete(room.id);
      console.log(`[room ${room.id}] fechada por inatividade`);
    }
  }
}, SWEEP_EVERY_MS);
sweeper.unref?.();

/**
 * Encerra a transmissão de quem não está mais na sala.
 *
 * "Estar na sala" é ter pelo menos uma conexão de espectador — é ela que a
 * atividade abre, e é ela que morre quando a pessoa fecha a atividade, sai do
 * canal de voz ou fecha o Discord. A aba de captura sozinha não conta: ela é
 * uma janela do navegador que não faz ideia de nada disso, e era exatamente por
 * isso que a tela continuava no ar.
 *
 * Fechar o socket não é rispidez: a mensagem é o caminho educado, mas uma aba
 * em segundo plano pode demorar a reagir a ela, e o fechamento derruba a
 * captura pelo tratamento de queda que o transmissor já tem. Entre insistir e
 * deixar a tela de alguém exposta, fecha-se.
 */
function encerrarOrfaos(room, now) {
  marcarOrfaos(room, now);

  // Cópia da lista: encerrar tira o transmissor do registro, e não se altera o
  // que se está percorrendo.
  for (const entry of [...room.broadcasters.values()]) {
    if (!entry.orfaoDesde || now - entry.orfaoDesde < ORFAO_GRACE_MS) continue;

    console.log(`[room ${room.id}] transmissao de ${entry.info.name} encerrada: saiu da sala`);
    sendJson(entry.ws, {
      type: 'stop-request',
      reason: 'Você saiu da sala, então a transmissão foi encerrada. A captura parou.',
    });
    // Antes de fechar: sai do registro na hora, senão a próxima passada da
    // varredura o encontraria de novo enquanto o socket ainda se despede.
    detachBroadcaster(room, entry.ws);
    entry.ws.close();
  }
}

/**
 * Marca desde quando cada transmissão está sem o dono na sala.
 *
 * Chamada quando uma conexão cai e quando outra entra, além da varredura: o
 * relógio precisa começar no instante em que a pessoa sai, não na próxima
 * passada. São quatro segundos de diferença, e eles são de tela exposta.
 */
function marcarOrfaos(room, now = Date.now()) {
  if (!room.broadcasters.size) return;

  const presentes = new Set();
  for (const v of room.viewers) if (v.__info) presentes.add(v.__info.id);

  for (const entry of room.broadcasters.values()) {
    if (presentes.has(entry.info.id)) entry.orfaoDesde = null;
    else if (!entry.orfaoDesde) entry.orfaoDesde = now;
  }
}

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
    broadcasting: room.broadcasters.has(info.id),
  }));

  // Quem transmite pode ter fechado a aba da Activity: continua na lista,
  // senão o vídeo fica sem dono visível.
  for (const [uid, entry] of room.broadcasters) {
    if (byId.has(uid)) continue;
    participants.push({
      id: uid,
      name: entry.info.name,
      avatar: entry.info.avatar ?? null,
      broadcasting: true,
    });
  }

  participants.sort((a, b) => Number(b.broadcasting) - Number(a.broadcasting));

  return {
    type: 'state',
    room: { id: room.id, name: room.name, ownerId: room.ownerId, locked: Boolean(room.password) },
    broadcasting: room.broadcasters.size > 0,
    viewers: room.viewers.size,
    participants,
    streams: [...room.broadcasters.values()]
      .filter((e) => e.streaming)
      .map((e) => ({ slot: e.slot, userId: e.info.id, watchers: watchersOf(room, e.slot) })),
  };
}

export function broadcastState(room) {
  const msg = JSON.stringify(roomState(room));
  for (const v of room.viewers) send(v, msg);
  for (const e of room.broadcasters.values()) send(e.ws, msg);
}

function requestKeyframe(entry) {
  sendJson(entry.ws, { type: 'need-keyframe' });
}

export function rename(room, ws, raw) {
  if (!ws.__info || typeof raw !== 'string') return;

  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (!name) return;

  ws.__info.name = name;
  const entry = room.broadcasters.get(ws.__info.id);
  if (entry) entry.info.name = name;
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
export function attachBroadcaster(room, ws, info) {
  if (room.broadcasters.has(info.id)) return 'Você já está transmitindo nesta sala.';
  if (room.broadcasters.size >= MAX_BROADCASTERS) {
    return `Limite de ${MAX_BROADCASTERS} transmissões simultâneas atingido.`;
  }

  const slot = freeSlot(room);
  if (slot === null) return 'Sem espaço para mais transmissões.';

  const entry = {
    ws,
    info,
    slot,
    streaming: false,
    config: null,
    audioConfig: null,
    connectedAt: Date.now(),
    startedAt: null,
    traffic: trafficCounter(),
    droppedChunks: 0,
    ann: novaAnn(),
    // Desde quando não há ninguém deste dono na sala. Ver encerrarOrfaos.
    orfaoDesde: null,
  };
  room.broadcasters.set(info.id, entry);
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
  // Tela nova, quadro limpo: traço feito sobre a tela anterior não tem mais
  // sobre o que estar.
  entry.ann = novaAnn();
  // Transmissão nova recomeça do zero: ninguém assiste até pedir.
  for (const v of room.viewers) {
    v.__primed?.delete(entry.slot);
    v.__watching?.delete(entry.slot);
  }
  toViewers(room, { type: 'stream-start', slot: entry.slot, userId: entry.info.id });
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
  for (const v of room.viewers) v.__primed?.delete(entry.slot);
  for (const v of room.viewers) {
    if (v.__watching?.has(entry.slot)) sendJson(v, { type: 'config', slot: entry.slot, config });
  }
}

export function pushChunk(room, entry, chunk) {
  const bytes = Number(chunk?.byteLength ?? chunk?.length ?? 0);
  recordTraffic(appTraffic, 'receivedBytes', bytes);
  recordTraffic(room.traffic, 'receivedBytes', bytes);
  recordTraffic(entry.traffic, 'receivedBytes', bytes);

  if (chunk[SLOT_BYTE] !== entry.slot) return;

  const tipo = chunk[TYPE_BYTE];
  const isKeyframe = tipo === KEYFRAME;
  const isAudio = tipo === AUDIO;
  let sentCopies = 0;
  let droppedCopies = 0;

  for (const v of room.viewers) {
    if (v.readyState !== v.OPEN) continue;

    // Assistir é opt-in: quem não pediu esta tela não recebe os bytes dela.
    if (!v.__watching.has(entry.slot)) continue;

    // Áudio não depende de keyframe — cada pacote Opus se decodifica sozinho —,
    // então não passa pelo controle de "já recebeu ponto de partida".
    if (isAudio) {
      if (v.bufferedAmount > MAX_BUFFERED_BYTES) {
        room.droppedChunks++;
        entry.droppedChunks++;
        droppedCopies++;
        continue;
      }
      v.send(chunk);
      sentCopies++;
      v.__mediaBytesOut = (v.__mediaBytesOut ?? 0) + bytes;
      continue;
    }

    if (isKeyframe) {
      if (v.bufferedAmount > MAX_BUFFERED_BYTES * 2) {
        room.droppedChunks++;
        entry.droppedChunks++;
        droppedCopies++;
        continue;
      }
      v.send(chunk);
      sentCopies++;
      v.__mediaBytesOut = (v.__mediaBytesOut ?? 0) + bytes;
      v.__primed.add(entry.slot);
      continue;
    }

    if (!v.__primed.has(entry.slot)) continue;

    if (v.bufferedAmount > MAX_BUFFERED_BYTES) {
      room.droppedChunks++;
      entry.droppedChunks++;
      droppedCopies++;
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
    v.__watching?.delete(entry.slot);
  }
  toViewers(room, { type: 'stream-stop', slot: entry.slot });
}

export function detachBroadcaster(room, ws) {
  const entry = ws.__entry;
  if (!entry || room.broadcasters.get(entry.info.id) !== entry) return;

  stopStream(room, entry);
  room.broadcasters.delete(entry.info.id);
  room.slots.delete(entry.slot);
  broadcastState(room);
}

export function broadcasterOf(room, userId) {
  return room.broadcasters.get(userId) ?? null;
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

  if (entry.config) sendJson(ws, { type: 'config', slot, config: entry.config });
  if (entry.audioConfig) {
    sendJson(ws, { type: 'audio-config', slot, config: entry.audioConfig });
  }
  // O que já está desenhado é estado da tela, não histórico: quem chega no meio
  // precisa ver a mesma seta que todo mundo está olhando.
  if (entry.ann.tracos.size) {
    sendJson(ws, { type: 'ann-sync', slot, tracos: snapshotAnn(entry) });
  }
  requestKeyframe(entry);
  broadcastState(room);
}

export function unwatch(room, ws, slot) {
  // Só avisa a sala se algo mudou de fato; ver a nota em watch().
  if (!ws.__watching.delete(slot)) return;
  ws.__primed.delete(slot);
  broadcastState(room);
}

// -------------------------------------------------------------- anotações

function novaAnn() {
  // Ordem de inserção é o que "desfazer" usa; Map garante isso por
  // especificação, então não há índice separado para manter em dia.
  return { tracos: new Map(), pontos: 0 };
}

/** Estado desenhado, no formato que a camada do cliente consome direto. */
function snapshotAnn(entry) {
  return [...entry.ann.tracos.entries()].map(([id, t]) => ({
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
function registrarAnn(entry, info, ev) {
  const ann = entry.ann;
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
      entry.ann = novaAnn();
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

  if (!registrarAnn(entry, info, ev)) {
    avisarQuadroCheio(ws, entry, ev);
    return;
  }

  const msg = JSON.stringify({ type: 'ann', slot, uid: info.id, name: info.name, ev });
  for (const v of room.viewers) {
    if (v.__watching?.has(slot)) send(v, msg);
  }
  send(entry.ws, msg);
}

/**
 * Traço recusado por teto some da tela de quem desenhou sem explicação nenhuma.
 * O aviso é limitado a um a cada cinco segundos porque a recusa se repete a
 * cada movimento do mouse.
 */
function avisarQuadroCheio(ws, entry, ev) {
  if (ev.k !== 's' && ev.k !== 'a') return;
  if (entry.ann.pontos < MAX_PONTOS_TOTAL * 0.9) return;

  const agora = Date.now();
  if (agora - (ws.__annAviso ?? 0) < 5000) return;
  ws.__annAviso = agora;
  sendJson(ws, {
    type: 'error',
    message: 'O quadro de desenhos está cheio. Apague algo para continuar desenhando.',
  });
}

export function attachViewer(room, ws, info) {
  ws.__primed = new Set();
  ws.__watching = new Set();
  ws.__info = info;
  ws.__connectedAt = ws.__connectedAt ?? Date.now();
  ws.__mediaBytesOut = ws.__mediaBytesOut ?? 0;
  room.viewers.add(ws);
  room.emptySince = null;
  // Quem voltou zera o relógio do órfão na hora — é o que faz um F5 na
  // atividade não custar a transmissão.
  marcarOrfaos(room);

  sendJson(ws, roomState(room));

  // Anuncia o que está no ar, sem começar a mandar quadros: assistir é opt-in.
  for (const entry of room.broadcasters.values()) {
    if (!entry.streaming) continue;
    sendJson(ws, { type: 'stream-start', slot: entry.slot, userId: entry.info.id });
  }

  broadcastState(room);
}

export function detachViewer(room, ws) {
  room.viewers.delete(ws);
  // Saiu agora: o relógio começa agora. Ver marcarOrfaos.
  marcarOrfaos(room);
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
