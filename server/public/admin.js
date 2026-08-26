/**
 * Painel administrativo.
 *
 * A tela responde quatro perguntas, nesta ordem: está funcionando, quem está
 * usando agora, o que está estranho, e o que dá para fazer a respeito sem subir
 * um deploy. A gramática é a do Discord de propósito — sala é canal, quem está
 * dentro é membro, servidor é o ícone da esquerda —, porque quem administra
 * isto passa o dia lá dentro e não deveria ter de aprender outra.
 *
 * Duas regras valem para o arquivo inteiro:
 *
 * - **textContent, nunca innerHTML, em tudo que veio do servidor.** Nome de
 *   usuário e de guild são texto que outra pessoa escolhe; montar isso com
 *   innerHTML é entregar o painel a quem trocar o apelido por uma tag.
 * - **Número que fica igual o tempo todo ensina a não olhar para ele.** O que
 *   é normal em zero só aparece quando deixa de ser zero.
 */

const $ = (id) => document.getElementById(id);

/** Últimas leituras de banda, para o gráfico. */
const historico = [];
const HISTORICO_MAX = 60;

let timer = null;
let carregando = false;

/** A última resposta inteira, como veio. É dela que sai o JSON cru. */
let ultimo = null;
/** A mesma resposta depois do filtro de servidor. É dela que sai a tela. */
let visao = null;

/** Salas abertas na lista. Guardado por id para sobreviver ao re-render. */
const salasAbertas = new Set();

let abaAtual = 'visao';
let salaAtual = null;
let filtroGuild = '';
let membrosVisiveis = true;

// ------------------------------------------------------------------ formato

function text(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function formatBytes(value, decimals = 1) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(value)) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? decimals : 0)} ${units[index]}`;
}

function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond)) return '—';
  const bits = bytesPerSecond * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;
  return `${bits.toFixed(0)} b/s`;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)}%` : '—';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}min`;
  if (minutes) return `${minutes}min`;
  return `${total}s`;
}

const desde = (ms) => (Number.isFinite(ms) ? formatDuration((Date.now() - ms) / 1000) : '—');

/** Plural sem gambiarra de string: "1 sala" e "3 salas". */
function count(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural}`;
}

const el = (tag, className, texto) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (texto !== undefined) node.textContent = texto;
  return node;
};

/** Ícone inline. O `d` é sempre constante deste arquivo, nunca do servidor. */
function icone(d, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  for (const parte of [].concat(d)) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', parte);
    svg.append(path);
  }
  return svg;
}

const ICONE = {
  tela: ['M3 5.5h18v11H3zM8 20.5h8'],
  seta: ['M9 5l7 7-7 7'],
  alto: ['M11 5 6 9H3v6h3l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7'],
  cadeado: ['M7 11V8a5 5 0 0 1 10 0v3', 'M5 11h14v9H5z'],
};

/**
 * As iniciais de quem não tem foto.
 *
 * Uma bolinha vazia no meio de uma fileira de avatares parece falha de
 * carregamento; com a letra dentro, parece o que é — alguém sem foto.
 */
function iniciais(nome) {
  const partes = String(nome ?? '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

/** O avatar de alguém: a foto do Discord, ou as iniciais no lugar dela. */
function avatar(pessoa) {
  if (pessoa?.avatar && pessoa?.id) {
    const img = document.createElement('img');
    img.className = 'av';
    img.src = `/api/avatar/${pessoa.id}/${pessoa.avatar}`;
    img.alt = '';
    img.loading = 'lazy';
    // A CDN pode devolver 404 para um hash trocado no meio da sessão. Sem isto
    // sobra o ícone de imagem quebrada, que parece defeito do painel.
    img.addEventListener('error', () => img.replaceWith(el('span', 'av', iniciais(pessoa.name))));
    return img;
  }
  return el('span', 'av', iniciais(pessoa?.name));
}

/** O avatar com o pontinho de estado, como na lista de membros do Discord. */
function avatarComPonto(pessoa) {
  const caixa = el('span', 'av-caixa');
  caixa.append(avatar(pessoa));
  const ponto = el('i', `ponto ${pessoa.broadcasting ? 'live' : 'ok'}`);
  caixa.append(ponto);
  return caixa;
}

// -------------------------------------------------------------------- avisos

function toast(mensagem, tom = '') {
  const node = el('div', `toast ${tom}`.trim(), mensagem);
  $('toasts').append(node);
  setTimeout(() => node.remove(), 4200);
}

/**
 * Confirma antes de mexer em quem está dentro.
 *
 * Um dialog só, reaproveitado: cada ação escreve o texto e recebe a resposta
 * numa promessa. Sem `confirm()` nativo porque ele bloqueia o laço de
 * atualização inteiro — o painel congelaria enquanto a caixa estivesse aberta.
 */
function confirmar(titulo, texto) {
  return new Promise((resolve) => {
    text('confirmTitulo', titulo);
    text('confirmTexto', texto);
    $('confirmModal').hidden = false;

    const fechar = (resposta) => {
      $('confirmModal').hidden = true;
      $('confirmSim').removeEventListener('click', sim);
      $('confirmNao').removeEventListener('click', nao);
      resolve(resposta);
    };
    const sim = () => fechar(true);
    const nao = () => fechar(false);

    $('confirmSim').addEventListener('click', sim);
    $('confirmNao').addEventListener('click', nao);
  });
}

/**
 * Copia, e diz que copiou.
 *
 * `navigator.clipboard` não existe fora de https — e um painel aberto por
 * `http://ip-da-maquina:31415` é exatamente esse caso. Sem o caminho de
 * reserva, os botões de copiar não fariam nada justamente ali.
 */
async function copiar(texto, recado = 'Copiado') {
  try {
    await navigator.clipboard.writeText(texto);
    toast(recado, 'bom');
    return;
  } catch {
    // Cai para o modo antigo, abaixo.
  }

  try {
    const campo = document.createElement('textarea');
    campo.value = texto;
    campo.setAttribute('readonly', '');
    campo.style.position = 'fixed';
    campo.style.opacity = '0';
    document.body.append(campo);
    campo.select();
    document.execCommand('copy');
    campo.remove();
    toast(recado, 'bom');
  } catch {
    toast('Não deu para copiar.', 'ruim');
  }
}

/** Salva um texto como arquivo, sem servidor no meio. */
function baixar(nome, conteudo, tipo = 'application/json') {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const link = document.createElement('a');
  link.href = url;
  link.download = nome;
  link.click();
  URL.revokeObjectURL(url);
}

/** O carimbo de hora que entra em nome de arquivo. */
function carimbo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// -------------------------------------------------------------------- ciclo

/**
 * O ciclo só corre com a aba à vista.
 *
 * Cada volta varre todas as salas, pessoas e transmissões do servidor. Sem
 * pausar, uma aba esquecida aberta de um dia para o outro pede isso mais de
 * quarenta mil vezes sem ninguém olhando.
 */
function startPolling() {
  if (timer) return;
  timer = setInterval(tick, 2000);
}

function stopPolling() {
  clearInterval(timer);
  timer = null;
}

function tick() {
  loadMetrics();
  loadLogs();
}

function setLive(ok, mensagem) {
  $('adminPonto').className = `ponto ${ok ? 'ok' : 'warn'}`;
  text('adminEstado', mensagem);
}

async function loadMetrics() {
  if (carregando) return;
  carregando = true;
  try {
    const response = await fetch('/api/admin/metrics', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    // A sessão dura 8 horas. Quando vence no meio do uso, recarregar devolve
    // a tela de entrada em vez de deixar o painel piscando erro.
    if (response.status === 401) {
      stopPolling();
      location.reload();
      return;
    }

    if (!response.ok) throw new Error(`servidor respondeu ${response.status}`);

    render(await response.json());
    setLive(true, 'ao vivo');
    $('errorBanner').hidden = true;
  } catch (error) {
    setLive(false, 'sem conexão');
    $('errorBanner').textContent = `Não foi possível atualizar: ${error.message}`;
    $('errorBanner').hidden = false;
  } finally {
    carregando = false;
  }
}

// ------------------------------------------------------------------ filtro

/**
 * O painel visto de dentro de um servidor do Discord.
 *
 * Clicar num ícone da esquerda passa a mostrar só o que é dele. As contas de
 * gente, sala e transmissão são refeitas a partir das salas que sobraram —
 * caso contrário o cabeçalho continuaria contando o servidor inteiro enquanto
 * a lista mostra um pedaço, que é a forma mais rápida de tirar conclusão
 * errada.
 *
 * CPU, memória e disco não entram no filtro: são da máquina, e a máquina é uma
 * só. Dizer isso na tela custa uma linha e evita a pergunta.
 */
function aplicarFiltro(data) {
  if (!filtroGuild) return data;

  const rooms = data.rooms.filter((room) => room.guildId === filtroGuild);
  const ids = new Set(rooms.map((room) => room.id));
  const users = data.users.filter((user) => user.rooms.some((id) => ids.has(id)));
  const streams = data.streams.filter((stream) => ids.has(stream.roomId));

  const traffic = rooms.reduce(
    (soma, room) => {
      for (const chave of Object.keys(soma)) soma[chave] += room.traffic[chave] ?? 0;
      return soma;
    },
    {
      receivedBytes: 0,
      transmittedBytes: 0,
      droppedBytes: 0,
      receivedBytesPerSecond: 0,
      transmittedBytesPerSecond: 0,
      droppedBytesPerSecond: 0,
    },
  );

  const pings = users.map((user) => user.pingMs).filter(Number.isFinite);
  const media = pings.length ? pings.reduce((a, b) => a + b, 0) / pings.length : null;

  return {
    ...data,
    rooms,
    users,
    streams,
    traffic,
    summary: {
      ...data.summary,
      users: users.length,
      rooms: rooms.length,
      streams: streams.length,
      connections: rooms.reduce((soma, room) => soma + room.connections, 0),
      activeWatchers: streams.reduce((soma, stream) => soma + stream.watchers, 0),
      pingAverageMs: media,
      pingP95Ms: null,
    },
    clientes: {
      ...data.clientes,
      espectadores: (data.clientes?.espectadores ?? []).filter((c) => ids.has(c.sala)),
    },
  };
}

// ------------------------------------------------------------------ desenho

function render(data) {
  ultimo = data;
  visao = aplicarFiltro(data);

  const { summary, traffic } = visao;

  text('statPeople', String(summary.users));
  text(
    'statPeopleSub',
    summary.rooms ? count(summary.rooms, 'sala', 'salas') : 'nenhuma sala aberta',
  );

  text('statStreams', String(summary.streams));
  text('statStreamsSub', count(summary.activeWatchers, 'assistindo', 'assistindo'));

  text(
    'statBandwidth',
    formatRate(traffic.receivedBytesPerSecond + traffic.transmittedBytesPerSecond),
  );
  text(
    'statBandwidthSub',
    `↓ ${formatRate(traffic.receivedBytesPerSecond)} · ↑ ${formatRate(traffic.transmittedBytesPerSecond)}`,
  );

  // Quadro que o servidor deixou de mandar porque a fila daquele espectador
  // estourou. É o único sinal na tela de que alguém não está aguentando
  // receber — sem ele, imagem travando não tem onde ser diagnosticada.
  const descartado = traffic.droppedBytesPerSecond;
  $('statDropped').hidden = !(descartado > 0);
  if (descartado > 0) text('statDropped', `${formatRate(descartado)} descartado`);

  text('statPing', formatMs(summary.pingAverageMs));
  text(
    'statPingSub',
    Number.isFinite(summary.pingP95Ms) ? `p95 ${formatMs(summary.pingP95Ms)}` : ' ',
  );

  text('navSalas', String(visao.rooms.length));
  text('navPessoas', String(visao.users.length));
  text(
    'servidorSub',
    `${count(visao.users.length, 'pessoa', 'pessoas')} · ${count(visao.streams.length, 'no ar', 'no ar')}`,
  );

  renderRail(data);
  renderCanaisDeSala(visao);
  renderMembros(visao);
  renderSalas(visao);
  renderSalaDetalhe(visao);
  renderPeople(visao);
  renderRecursos(data.system);
  renderAmbiente(data);
  renderSinais(visao);
  renderClientes(visao);
  renderAjustes(data);
  renderJson();
  atualizarBarra();

  historico.push({
    inbound: traffic.receivedBytesPerSecond,
    outbound: traffic.transmittedBytesPerSecond,
    dropped: traffic.droppedBytesPerSecond,
  });
  if (historico.length > HISTORICO_MAX) historico.shift();
  if (abaAtual === 'visao') drawChart();
}

// ------------------------------------------------------- barra de servidores

/**
 * Um ícone por servidor do Discord que tem sala aqui.
 *
 * O pontinho vermelho no canto é o que faz esta coluna valer a olhada: ele diz
 * onde tem tela no ar sem ninguém precisar entrar em cada um.
 */
function renderRail(data) {
  $('railTudo').classList.toggle('ativo', !filtroGuild);
  // Sem nenhum servidor do Discord por aqui, os dois separadores ficariam
  // colados um no outro com nada entre eles.
  $('railGuilds').previousElementSibling.hidden = data.guilds.length === 0;

  $('railGuilds').replaceChildren(
    ...data.guilds.map((guild) => {
      const nome = guild.name || guild.id;
      const item = el('button', `rail-item${filtroGuild === guild.id ? ' ativo' : ''}`);
      item.title = `${nome} · ${count(guild.rooms, 'sala', 'salas')} · ${count(guild.users, 'pessoa', 'pessoas')}`;
      item.append(el('i', 'rail-pino'));
      item.append(el('span', 'rail-mark', iniciais(nome)));
      if (guild.streams > 0) item.append(el('i', 'rail-live'));
      item.addEventListener('click', () => {
        filtroGuild = filtroGuild === guild.id ? '' : guild.id;
        // Sair de um servidor com uma sala dele aberta deixaria a tela numa
        // sala que a lista não mostra mais.
        if (filtroGuild && salaAtual) mostrarAba('visao');
        render(ultimo);
      });
      return item;
    }),
  );

  const guild = data.guilds.find((g) => g.id === filtroGuild);
  $('filtroChip').hidden = !guild;
  if (guild) text('filtroNome', guild.name || guild.id);
  text('servidorNome', guild ? guild.name || guild.id : 'Sala de Tela');
}

// --------------------------------------------------------- canais das salas

/**
 * Cada sala é um canal, e quem está dentro aparece embaixo dela.
 *
 * É a leitura do canal de voz do Discord, e ela responde de graça a pergunta
 * que mais se faz aqui: onde está a gente agora. Antes disso, era abrir a aba
 * de salas e expandir uma por uma.
 */
function renderCanaisDeSala(data) {
  $('semSalas').hidden = data.rooms.length > 0;

  $('canaisSalas').replaceChildren(
    ...data.rooms.map((room) => {
      const caixa = el('div');

      const canal = el('button', `canal${salaAtual === room.id ? ' ativo' : ''}`);
      canal.append(icone(room.isCall ? ICONE.alto : ICONE.tela));
      canal.append(el('span', null, room.name));
      if (room.streams.length) {
        canal.append(el('em', 'conta live', `${room.streams.length} no ar`));
      } else if (room.users.length) {
        canal.append(el('em', 'conta', String(room.users.length)));
      }
      canal.title = room.id;
      canal.addEventListener('click', () => abrirSala(room.id));
      caixa.append(canal);

      if (room.users.length) {
        const gente = el('div', 'canal-gente');
        for (const user of room.users.slice(0, 6)) gente.append(avatar(user));
        if (room.users.length > 6) {
          gente.append(el('span', 'av', `+${room.users.length - 6}`));
        }
        caixa.append(gente);
      }

      return caixa;
    }),
  );
}

// ---------------------------------------------------------------- membros

/**
 * Quem está online, agrupado pelo que está fazendo.
 *
 * Os três grupos são a resposta de "com quem eu falo primeiro": quem transmite
 * é quem consegue mexer na origem do problema, quem assiste é quem está vendo
 * o sintoma, e o resto está no lobby.
 */
function renderMembros(data) {
  const nomesDeSala = new Map(data.rooms.map((room) => [room.id, room.name]));
  const assistindo = new Set(
    data.rooms.flatMap((room) =>
      room.streams.flatMap((s) => s.espectadores.map((v) => v.id).filter(Boolean)),
    ),
  );

  const grupos = [
    ['Transmitindo', data.users.filter((u) => u.broadcasting)],
    ['Assistindo', data.users.filter((u) => !u.broadcasting && assistindo.has(u.id))],
    ['Online', data.users.filter((u) => !u.broadcasting && !assistindo.has(u.id))],
  ];

  const nodes = [];
  for (const [titulo, gente] of grupos) {
    if (!gente.length) continue;
    nodes.push(el('p', 'membros-cat', `${titulo} — ${gente.length}`));
    for (const pessoa of gente) {
      const linha = el('button', 'membro');
      linha.append(avatarComPonto(pessoa));

      const texto = el('span', 'membro-texto');
      texto.append(el('span', 'membro-nome', pessoa.name));
      texto.append(
        el(
          'span',
          'membro-sub',
          [
            pessoa.rooms.map((id) => nomesDeSala.get(id)).filter(Boolean)[0] ?? 'sem sala',
            Number.isFinite(pessoa.pingMs) ? formatMs(pessoa.pingMs) : null,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      );
      linha.append(texto);
      linha.addEventListener('click', () => abrirPerfil(pessoa.id));
      nodes.push(linha);
    }
  }

  $('membrosVazio').hidden = nodes.length > 0;
  $('membrosLista').replaceChildren(...nodes);
}

// -------------------------------------------------------------------- salas

/**
 * Uma sala por cartão, e o detalhe só quando alguém pede.
 *
 * O detalhe de uma sala movimentada são dezenas de linhas — abrir todas de
 * uma vez faz a página inteira pular de tamanho a cada dois segundos, e é
 * impossível ler um número que se move.
 */
function renderSalas(data) {
  $('salasEmpty').hidden = data.rooms.length > 0;

  $('salasLista').replaceChildren(
    ...data.rooms.map((room) => {
      const aberta = salasAbertas.has(room.id);
      const card = el('article', `card sala${aberta ? ' aberta' : ''}`);

      const head = el('button', 'sala-head');
      head.addEventListener('click', () => {
        if (salasAbertas.has(room.id)) salasAbertas.delete(room.id);
        else salasAbertas.add(room.id);
        renderSalas(visao);
      });

      const seta = icone(ICONE.seta, 'sala-seta');

      const titulo = el('div');
      titulo.append(el('div', 'sala-nome', room.name));
      titulo.append(
        el(
          'div',
          'sala-sub',
          [
            room.isCall ? 'sala da call' : 'sala da lista',
            room.guildName || null,
            room.ownerName ? `de ${room.ownerName}` : null,
            `aberta há ${desde(room.createdAt)}`,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      );

      head.append(seta, titulo, el('div', 'spacer'));

      // O selo diz o estado em uma olhada: quantas telas, quanta gente, e se
      // está descartando — que é o único deles que pede ação.
      if (room.streams.length) head.append(selo(`${room.streams.length} no ar`, 'on'));
      head.append(selo(count(room.connections, 'conexão', 'conexões')));
      if (room.droppedChunks > 0) head.append(selo(`${room.droppedChunks} descartes`, 'warn'));
      if (room.locked) head.append(selo('com senha'));

      card.append(head);
      if (aberta) card.append(corpoDaSala(room));
      return card;
    }),
  );
}

/** A sala aberta pelo canal da esquerda, sozinha na tela. */
function renderSalaDetalhe(data) {
  if (abaAtual !== 'sala') return;

  const room = data.rooms.find((r) => r.id === salaAtual);
  if (!room) {
    $('salaDetalhe').replaceChildren(
      el('p', 'empty', 'Esta sala fechou. Ela some da lista assim que esvazia.'),
    );
    return;
  }

  const card = el('section', 'card panel');
  const head = el('div', 'panel-head');
  head.append(el('h2', null, room.name));
  if (room.streams.length) head.append(selo(`${room.streams.length} no ar`, 'on'));
  if (room.locked) head.append(selo('com senha'));
  head.append(el('div', 'spacer'));
  head.append(
    el(
      'span',
      'hint',
      [
        room.isCall ? 'sala da call' : 'sala da lista',
        room.guildName || null,
        room.ownerName ? `de ${room.ownerName}` : null,
        `aberta há ${desde(room.createdAt)}`,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
  );
  card.append(head);
  card.append(corpoDaSala(room));

  $('salaDetalhe').replaceChildren(card);
}

function selo(texto, tom = '') {
  const s = el('span', `badge ${tom}`.trim());
  if (tom === 'on') s.append(el('i'));
  s.append(document.createTextNode(texto));
  return s;
}

function chip(rotulo, valor) {
  const c = el('span', 'chip');
  c.append(document.createTextNode(rotulo), el('b', null, valor));
  return c;
}

function corpoDaSala(room) {
  const corpo = el('div', 'sala-corpo');

  corpo.append(
    (() => {
      const linha = el('div', 'chips');
      linha.append(
        chip('id', room.id),
        chip('↓', formatRate(room.traffic.receivedBytesPerSecond)),
        chip('↑', formatRate(room.traffic.transmittedBytesPerSecond)),
        chip('abas de captura', String(room.controles)),
        chip('quadro', `${room.quadro.tracos} traços`),
      );
      if (room.emptySince) linha.append(chip('vazia há', desde(room.emptySince)));
      return linha;
    })(),
  );

  for (const stream of room.streams) corpo.append(cartaoDaTela(room, stream));

  if (!room.streams.length) corpo.append(el('p', 'empty', 'Nenhuma transmissão no ar.'));

  const acoes = el('div', 'acoes');
  acoes.append(
    botao('Pedir keyframe', () => acao('keyframe', { room: room.id }, 'Keyframe pedido')),
    botao('Limpar o quadro', () =>
      acao('limpar-quadro', { room: room.id }, 'Quadro limpo', {
        titulo: 'Limpar o quadro desta sala?',
        texto: 'O desenho some para todo mundo que está na sala. Não dá para desfazer.',
      }),
    ),
  );

  // O convite existe aqui pelo mesmo motivo que existe na página pública: a
  // pessoa que precisa ver a tela nem sempre consegue entrar pelo Discord, e
  // ditar o id da sala por voz é como esse link deixava de ser mandado.
  if (!room.isCall) {
    acoes.append(
      botao('Copiar convite', () =>
        copiar(`${location.origin}/convite/${room.id}`, 'Convite desta sala copiado'),
      ),
    );
  }

  acoes.append(assistirNoSite(room));

  acoes.append(
    botao(
      'Fechar a sala',
      () =>
        acao('fechar-sala', { room: room.id }, 'Sala fechada', {
          titulo: 'Fechar esta sala agora?',
          texto:
            'Todo mundo que está dentro é desconectado e as transmissões param. No Discord a sala da call é recriada sozinha na próxima entrada.',
        }),
      'btn-danger',
    ),
  );
  corpo.append(acoes);
  corpo.append(senhaDaSala(room));

  return corpo;
}

/**
 * Abrir esta sala no navegador, a partir do painel.
 *
 * Existe porque a sala de uma call não tem convite — o `/convite/:sala` é
 * recusado para ela — e quem administra a máquina era justamente quem não
 * conseguia olhar a tela de que estavam reclamando sem entrar no canal de voz
 * do Discord. Ver a queixa e não ter como ver a imagem é o pior lugar para se
 * estar num painel de diagnóstico.
 *
 * O link entra na sala como QUEM ESTÁ NO PAINEL: o nome vai carimbado no
 * ingresso, e repassá-lo faria outra pessoa aparecer na sala com esse nome. É
 * link para olhar, não para distribuir — para distribuir existe o "Copiar
 * convite" ao lado, e para as salas do Discord existe a página pública.
 *
 * A aba é aberta ANTES do pedido, ainda dentro do gesto do clique: depois do
 * `await` o navegador já não reconhece a abertura como consequência de um
 * clique e a bloqueia como pop-up. Se ela não vier — bloqueador mais estrito —
 * o link vai para a área de transferência, que é pior mas não é nada.
 */
function assistirNoSite(room) {
  return botao('Assistir no site', async () => {
    const aba = window.open('', '_blank');
    if (aba) aba.opener = null;

    try {
      const r = await fetch('/api/admin/acoes/ingresso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: room.id }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(corpo.error ?? `servidor respondeu ${r.status}`);

      if (aba) aba.location = corpo.url;
      else await copiar(corpo.url, 'Sem aba nova: o link de assistir foi copiado');
    } catch (erro) {
      aba?.close();
      toast(`Não deu: ${erro.message}`, 'ruim');
    }
  });
}

/**
 * A senha da sala, que só pode ser trocada — nunca lida.
 *
 * Vale dizer por que não existe um "mostrar senha" aqui, porque é a primeira
 * coisa que se procura: ela é guardada como scrypt sobre um sal aleatório, e o
 * valor em claro não fica em lugar nenhum depois de definido. Não é uma
 * permissão que falta ao painel; é que não há o que mostrar, nem daqui nem de
 * um terminal no servidor.
 *
 * Então a resposta para "esqueci a senha da sala" é esta caixa: põe uma que
 * você conhece, ou tira a que existe. O aviso na tela diz isso, porque um campo
 * de senha sem explicação faz qualquer um procurar o botão de revelar.
 */
function senhaDaSala(room) {
  const bloco = el('div', 'acoes');

  const campo = el('input');
  campo.type = 'password';
  campo.className = 'input-sm';
  campo.placeholder = room.locked ? 'trocar por…' : 'definir uma senha…';
  campo.autocomplete = 'new-password';
  bloco.append(campo);

  bloco.append(
    botao('Definir', async () => {
      if (!campo.value) {
        toast('Escreva a senha nova antes.', 'ruim');
        return;
      }
      const nova = campo.value;
      // Sai da tela assim que vai para o servidor: um campo preenchido num
      // painel que fica aberto o dia todo é um post-it colado no monitor.
      campo.value = '';
      await acao('senha', { room: room.id, senha: nova }, 'Senha definida');
    }),
  );

  bloco.append(botao('Sortear código', () => acao('codigo', { room: room.id }, 'Código sorteado')));

  if (room.locked) {
    bloco.append(
      botao(
        'Remover',
        () =>
          acao('senha', { room: room.id, senha: '' }, 'Senha removida', {
            titulo: 'Remover a senha desta sala?',
            texto:
              'A sala fica aberta para qualquer pessoa do mesmo servidor. Se era uma senha escolhida a dedo, ela não volta — só o hash dela existe.',
          }),
        'btn-danger',
      ),
    );
  }

  // O código sorteado aparece porque foi feito para aparecer; a senha escolhida
  // a dedo não aparece porque não existe mais em claro. Os dois casos ficam
  // ditos, senão o campo vazio parece defeito do painel.
  if (room.codigoVisivel) {
    const caixa = el('div', 'cell');
    const valor = el('code', 'codigo-sala', room.codigoVisivel);
    valor.title = 'Clique para copiar';
    valor.addEventListener('click', () => copiar(room.codigoVisivel, 'Código copiado'));
    caixa.append(valor);
    caixa.append(el('span', 'second', 'sorteado aqui — pode ser lido e repassado'));
    bloco.append(caixa);
  } else {
    bloco.append(
      el(
        'span',
        'hint',
        room.locked
          ? 'Senha escolhida a dedo: não pode ser lida, só substituída ou removida. Sorteie um código se quiser um valor visível.'
          : 'Sala aberta. Sorteie um código para trancá-la com um valor que o painel mostra.',
      ),
    );
  }

  return bloco;
}

function cartaoDaTela(room, stream) {
  const box = el('div', 'stream');

  const head = el('div', 'stream-head');
  head.append(el('span', 'stream-nome', stream.userName));
  head.append(selo(stream.fonte === 'camera' ? 'câmera' : 'tela'));
  head.append(selo(`slot ${stream.slot}`));
  if (!stream.chunksLigados) head.append(selo('relay desligado', 'warn'));
  box.append(head);

  const chips = el('div', 'chips');
  chips.append(
    chip('codec', stream.codec ?? '—'),
    chip('resolução', stream.width ? `${stream.width}×${stream.height}` : '—'),
    chip('som', stream.audioCodec ?? 'sem'),
    chip('no ar há', desde(stream.startedAt)),
    chip('↑ dele', formatRate(stream.traffic.receivedBytesPerSecond)),
    // O par que explica travamento: o que a transmissão está entregando por
    // segundo, e quanto disso o servidor deixa esperar na fila de alguém.
    chip('taxa', `${formatBytes(stream.taxaBytes)}/s`),
    chip('teto de fila', formatBytes(stream.teto)),
    chip('fila dele', formatBytes(stream.bufferedBytes)),
    chip('ping', formatMs(stream.pingMs)),
  );
  if (stream.droppedChunks > 0) {
    const c = chip('descartes', String(stream.droppedChunks));
    c.style.borderColor = 'color-mix(in srgb, var(--warn) 45%, transparent)';
    chips.append(c);
  }
  if (stream.anotacoes.tracos) chips.append(chip('desenhos', String(stream.anotacoes.tracos)));
  box.append(chips);

  if (stream.espectadores.length) box.append(tabelaDeEspectadores(stream));

  const acoes = el('div', 'acoes');
  acoes.append(
    botao('Keyframe', () =>
      acao('keyframe', { room: room.id, slot: stream.slot }, 'Keyframe pedido'),
    ),
    botao('Limpar desenhos', () =>
      acao('limpar-anotacoes', { room: room.id, slot: stream.slot }, 'Desenhos limpos'),
    ),
    botao(
      'Parar transmissão',
      () =>
        acao('parar-transmissao', { room: room.id, slot: stream.slot }, 'Parada pedida', {
          titulo: `Parar a transmissão de ${stream.userName}?`,
          texto: 'A captura dela é encerrada. A pessoa pode começar de novo quando quiser.',
        }),
      'btn-danger',
    ),
  );
  box.append(acoes);

  return box;
}

/**
 * Quem está recebendo esta tela, e como.
 *
 * É a tabela que responde "por que travou para uma pessoa só": o transporte
 * dela, a fila dela contra o teto do stream, e se o servidor a tirou do fluxo
 * esperando drenar.
 */
function tabelaDeEspectadores(stream) {
  const scroll = el('div', 'table-scroll');
  const tabela = el('table');

  const thead = el('thead');
  const trh = el('tr');
  for (const [rotulo, classe] of [
    ['Assistindo', ''],
    ['Transporte', ''],
    ['Estado', ''],
    ['Fila', 'num'],
    ['Ping', 'num'],
  ]) {
    trh.append(el('th', classe, rotulo));
  }
  thead.append(trh);

  const tbody = el('tbody');
  for (const v of stream.espectadores) {
    const tr = el('tr');
    tr.append(el('td', null, v.name));
    tr.append(
      (() => {
        const td = el('td');
        td.append(
          selo(
            v.transporte === 'webrtc' ? 'WebRTC' : 'relay',
            v.transporte === 'webrtc' ? 'on' : '',
          ),
        );
        return td;
      })(),
    );
    tr.append(
      (() => {
        const td = el('td');
        // Afogado é a explicação de uma tela parada: o servidor tirou essa
        // pessoa do fluxo até a fila dela drenar, e é isso que ela está vendo.
        if (v.afogado) td.append(selo('afogado', 'bad'));
        else if (v.transporte === 'webrtc') td.append(selo('direto'));
        else if (v.pronto) td.append(selo('recebendo', 'on'));
        else td.append(selo('esperando keyframe', 'warn'));
        return td;
      })(),
    );

    const fila = el('td', 'num', formatBytes(v.bufferedBytes));
    if (v.bufferedBytes > stream.teto) fila.style.color = 'var(--warn)';
    tr.append(fila);
    tr.append(el('td', 'num', formatMs(v.pingMs)));
    tbody.append(tr);
  }

  tabela.append(thead, tbody);
  scroll.append(tabela);
  return scroll;
}

function botao(rotulo, aoClicar, classe = '') {
  const b = el('button', `btn btn-sm ${classe}`.trim(), rotulo);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await aoClicar();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

/**
 * Manda a ação e conta o que ela fez.
 *
 * O `afetados` da resposta vira o texto do aviso de propósito: um botão que
 * responde "ok" tanto quando agiu quanto quando não achou nada é um botão que
 * ensina a não confiar nele.
 */
async function acao(nome, corpo, sucesso, confirmacao = null) {
  if (confirmacao && !(await confirmar(confirmacao.titulo, confirmacao.texto))) return;

  try {
    const r = await fetch(`/api/admin/acoes/${nome}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `servidor respondeu ${r.status}`);

    const n = body.afetados;
    toast(Number.isFinite(n) ? `${sucesso} — ${n} afetado(s)` : sucesso, n ? 'bom' : '');
    loadMetrics();
    loadLogs();
  } catch (erro) {
    toast(`Não deu: ${erro.message}`, 'ruim');
  }
}

// ------------------------------------------------------------------ pessoas

function renderPeople(data) {
  const nomesDeGuild = new Map(data.guilds.map((guild) => [guild.id, guild.name || guild.id]));
  const nomesDeSala = new Map(data.rooms.map((room) => [room.id, room.name]));
  const salaDe = new Map(data.rooms.flatMap((r) => r.users.map((u) => [u.id, r.id])));
  const pessoas = data.users;

  text('peopleCount', String(pessoas.length));
  $('peopleEmpty').hidden = pessoas.length > 0;
  $('peopleScroll').hidden = pessoas.length === 0;

  const linhas = pessoas.map((pessoa) => {
    const linha = el('tr');

    // textContent em tudo: nome de usuário e de servidor vêm do Discord, ou
    // seja, são texto que outra pessoa escolhe. Montar isso com innerHTML
    // seria entregar o painel a quem trocar o apelido por uma tag <script>.
    const quem = celula(linha, pessoa.name, pessoa.id);
    quem.firstChild.firstChild.className = 'clicavel';
    quem.addEventListener('click', () => abrirPerfil(pessoa.id));

    celula(linha, pessoa.guilds.map((id) => nomesDeGuild.get(id) ?? id).join(', ') || '—');
    celula(linha, pessoa.rooms.map((id) => nomesDeSala.get(id) ?? id).join(', ') || '—');

    const estado = el('td');
    if (pessoa.broadcasting) estado.append(selo('transmitindo', 'on'));
    else {
      estado.textContent = '—';
      estado.className = 'muted';
    }
    linha.append(estado);

    linha.append(el('td', 'num', formatMs(pessoa.pingMs)));

    // A fila dela e o quanto já recebeu: os dois números que dizem se a
    // conexão dessa pessoa está dando conta.
    const fila = el('td', 'num', formatBytes(pessoa.bufferedBytes));
    if (pessoa.bufferedBytes > 512 * 1024) fila.style.color = 'var(--warn)';
    linha.append(fila);
    linha.append(el('td', 'num', formatBytes(pessoa.mediaBytesOut)));

    const acoes = el('td');
    const sala = salaDe.get(pessoa.id);
    if (sala) acoes.append(botaoDerrubar(pessoa, sala));
    linha.append(acoes);

    return linha;
  });

  $('peopleRows').replaceChildren(...linhas);
}

function botaoDerrubar(pessoa, sala) {
  return botao(
    'Derrubar',
    () =>
      acao('derrubar', { room: sala, userId: pessoa.id }, 'Conexões encerradas', {
        titulo: `Derrubar ${pessoa.name}?`,
        texto:
          'As conexões dela nesta sala são encerradas. Não é banimento: ela volta no instante seguinte se quiser. Serve para aba zumbi que continua contando como espectador.',
      }),
    'btn-danger',
  );
}

/** Uma célula com uma linha principal e, quando útil, uma segunda apagada. */
function celula(linha, principal, secundaria = null) {
  const td = el('td');
  const caixa = el('div', 'cell');
  caixa.append(el('span', null, principal));
  if (secundaria) caixa.append(el('span', 'second', secundaria));
  td.append(caixa);
  linha.append(td);
  return td;
}

// ------------------------------------------------------------------ perfil

/**
 * O cartão de perfil, igual ao do Discord.
 *
 * Clicar num nome — na lista de membros ou na tabela — abre tudo o que se sabe
 * daquela pessoa e o que dá para fazer com ela. Antes, "derrubar fulano" era
 * achar a linha dele numa tabela de oito colunas.
 */
function abrirPerfil(id) {
  const pessoa = visao?.users.find((u) => u.id === id);
  if (!pessoa) return;

  const nomesDeSala = new Map(visao.rooms.map((room) => [room.id, room.name]));
  const nomesDeGuild = new Map(visao.guilds.map((g) => [g.id, g.name || g.id]));

  const img = $('perfilAvatar');
  if (pessoa.avatar) {
    img.src = `/api/avatar/${pessoa.id}/${pessoa.avatar}`;
    img.hidden = false;
    $('perfilIniciais').hidden = true;
  } else {
    img.hidden = true;
    $('perfilIniciais').hidden = false;
    text('perfilIniciais', iniciais(pessoa.name));
  }

  text('perfilNome', pessoa.name);
  text('perfilTag', pessoa.id);

  const linhas = [
    ['Estado', pessoa.broadcasting ? 'transmitindo' : 'assistindo ou no lobby'],
    ['Conexões', String(pessoa.connections)],
    ['Aqui há', desde(pessoa.connectedAt)],
    ['Ping', formatMs(pessoa.pingMs)],
    ['Fila', formatBytes(pessoa.bufferedBytes)],
    ['Recebido', formatBytes(pessoa.mediaBytesOut)],
    ['Salas', pessoa.rooms.map((r) => nomesDeSala.get(r) ?? r).join(', ') || '—'],
    ['Servidores', pessoa.guilds.map((g) => nomesDeGuild.get(g) ?? g).join(', ') || '—'],
    ['Papéis', pessoa.roles.join(', ') || '—'],
  ];

  $('perfilInfo').replaceChildren(
    ...linhas.map(([rotulo, valor]) => {
      const par = el('div');
      const dd = el('dd', null, valor);
      dd.title = valor;
      par.append(el('dt', null, rotulo), dd);
      return par;
    }),
  );

  const acoes = el('div', 'acoes');
  const sala = pessoa.rooms[0];
  if (sala) {
    acoes.append(
      botao('Ver a sala', () => {
        $('perfil').hidden = true;
        abrirSala(sala);
      }),
    );
    acoes.append(botaoDerrubar(pessoa, sala));
  }
  $('perfilAcoes').replaceChildren(acoes);

  $('perfil').hidden = false;
}

// ----------------------------------------------------------------- clientes

/** Como cada estado se chama na tela, e com que cor. */
const ESTADOS = {
  travado: { rotulo: 'travado', tom: 'erro' },
  'sem-imagem': { rotulo: 'sem imagem', tom: 'erro' },
  'sem-decodificador': { rotulo: 'sem decodificador', tom: 'erro' },
  atrasado: { rotulo: 'atrasado', tom: 'aviso' },
  ok: { rotulo: 'ok', tom: '' },
};

/**
 * A tabela do que está chegando do outro lado.
 *
 * As colunas de número são o diagnóstico inteiro, e cada uma acusa uma causa
 * diferente: `fps` diz se a imagem anda; `atraso` diz se ela é de agora ou de
 * minutos atrás; `decode` diz se o decodificador daquela máquina está dando
 * conta; `resync` diz quantas vezes o relógio da origem saltou; `largados` diz
 * quanto foi jogado fora para o atraso não virar permanente; e `pulos` é o
 * único que enxerga a fila que o `bufferedAmount` do servidor não vê.
 *
 * Um `resync` que sobe sozinho é troca de tela ou aba dormindo. Um `decode`
 * fundo com `largados` subindo é aquela máquina não aguentando a resolução. Os
 * dois pareciam a mesma coisa — "travou" — até esta tabela existir.
 */
function renderClientes(data) {
  const lista = data.clientes?.espectadores ?? [];

  text('clientesResumo', String(lista.length));
  $('clientesEmpty').hidden = lista.length > 0;
  $('clientesScroll').hidden = lista.length === 0;
  if (!lista.length) return;

  const nomesDeSala = new Map(data.rooms.map((room) => [room.id, room.name]));

  const linhas = lista.map((c) => {
    const linha = el('tr');
    linha.append(el('td', null, c.nome ?? c.peer));

    const tela = el('td');
    const caixa = el('div', 'cell');
    caixa.append(el('span', null, `tela ${c.slot}`));
    caixa.append(el('span', 'second', nomesDeSala.get(c.sala) ?? c.sala));
    tela.append(caixa);
    linha.append(tela);

    const info = ESTADOS[c.estado] ?? { rotulo: c.estado, tom: '' };
    const estado = el('td', null, info.rotulo);
    if (info.tom) estado.style.color = `var(--${info.tom === 'erro' ? 'danger' : 'warn'})`;
    linha.append(estado);

    const via = el('td', null, c.via === 'rtc' ? 'direto' : 'relay');
    // O codec vai embaixo do transporte: é a primeira coisa que se quer saber
    // quando o estado é "sem decodificador", e a última que se quer caçar.
    if (c.codec) via.append(el('span', 'second', c.codec));
    via.className = 'cell';
    linha.append(via);
    linha.append(el('td', 'num', c.fps === null ? '—' : String(c.fps)));

    const atraso = el('td', 'num', formatMs(c.lag));
    if (c.lag > 2000) atraso.style.color = 'var(--warn)';
    linha.append(atraso);

    linha.append(el('td', 'num', String(c.decode)));
    linha.append(el('td', 'num', String(c.resync)));
    linha.append(el('td', 'num', String(c.largados)));
    const pulos = el('td', 'num', String(c.pulos ?? 0));
    if ((c.pulos ?? 0) > 0) pulos.style.color = 'var(--warn)';
    linha.append(pulos);
    return linha;
  });

  $('clientesRows').replaceChildren(...linhas);
}

// ------------------------------------------------------------------- sinais

/**
 * O que está fora do normal agora.
 *
 * Isto é o que separa um painel de um relatório: os números todos já estão nos
 * outros canais, e ninguém consegue olhar para trinta deles ao mesmo tempo
 * procurando o que mudou. Aqui só entra o que pede ação, e cada linha diz o
 * que fazer a respeito.
 */
function renderSinais(data) {
  const sinais = [];

  // O que chegou do outro lado, que é onde os travamentos de verdade moram.
  const clientes = data.clientes?.espectadores ?? [];
  const parados = clientes.filter(
    (c) => c.estado === 'travado' || c.estado === 'sem-imagem' || c.estado === 'sem-decodificador',
  );
  if (parados.length) {
    sinais.push({
      nivel: 'erro',
      titulo: count(parados.length, 'tela parada', 'telas paradas'),
      texto:
        `Está chegando byte e não está virando imagem: ${parados
          .map((c) => `${c.nome ?? c.peer} (${c.estado})`)
          .join(', ')}. ` +
        'Se o resync estiver subindo, o relógio da origem saltou — trocar de tela e voltar resolve. ' +
        'Se for sem decodificador, o codec não subiu naquela máquina.',
    });
  }

  const atrasados = clientes.filter((c) => c.estado === 'atrasado');
  if (atrasados.length) {
    sinais.push({
      nivel: 'aviso',
      titulo: count(atrasados.length, 'tela atrasada', 'telas atrasadas'),
      texto:
        `Veem a imagem, mas velha: ${atrasados
          .map((c) => `${c.nome ?? c.peer} (${formatMs(c.lag)})`)
          .join(', ')}. ` +
        'Decode fundo com largados subindo é a máquina deles não aguentando a resolução; ' +
        'baixar qualidade ou taxa de quadros é o que devolve o tempo real.',
    });
  }

  const afogados = data.rooms.flatMap((r) =>
    r.streams.flatMap((s) => s.espectadores.filter((v) => v.afogado).map((v) => ({ v, s, r }))),
  );
  if (afogados.length) {
    sinais.push({
      nivel: 'erro',
      titulo: count(afogados.length, 'espectador afogado', 'espectadores afogados'),
      texto: `A fila deles estourou e o servidor os tirou do fluxo até drenar — é isso que eles veem como tela parada. ${afogados
        .map((a) => a.v.name)
        .join(
          ', ',
        )}. Se persistir, quem transmite está mandando mais do que a conexão deles aguenta.`,
    });
  }

  if (data.traffic.droppedBytesPerSecond > 0) {
    sinais.push({
      nivel: 'aviso',
      titulo: `Descartando ${formatRate(data.traffic.droppedBytesPerSecond)}`,
      texto:
        'O servidor está largando quadros que não cabiam na fila de alguém. Um pico é normal numa troca de cena; contínuo significa bitrate acima do que a sala aguenta.',
    });
  }

  const semKeyframe = data.rooms.flatMap((r) =>
    r.streams.flatMap((s) =>
      s.espectadores.filter((v) => !v.pronto && !v.afogado && v.transporte === 'relay'),
    ),
  );
  if (semKeyframe.length) {
    sinais.push({
      nivel: 'aviso',
      titulo: count(semKeyframe.length, 'espectador sem imagem', 'espectadores sem imagem'),
      texto:
        'Estão esperando um ponto de partida para começar a decodificar. Se não sair sozinho em um segundo, o botão "Pedir keyframe" da sala resolve.',
    });
  }

  const cpu = data.system.cpu.hostPercent;
  if (Number.isFinite(cpu) && cpu > 85) {
    sinais.push({
      nivel: 'aviso',
      titulo: `CPU da máquina em ${formatPercent(cpu)}`,
      texto:
        'Acima de 85% o agendador começa a atrasar o repasse, e atraso de repasse é a irregularidade que quem assiste vê como tranco.',
    });
  }

  const memoria = data.system.memory;
  const usoMem = 1 - memoria.hostFreeBytes / memoria.hostTotalBytes;
  if (usoMem > 0.9) {
    sinais.push({
      nivel: 'erro',
      titulo: `Memória da máquina em ${formatPercent(usoMem * 100)}`,
      texto: 'Perto do teto o processo é candidato ao OOM killer, e a queda é sem aviso.',
    });
  }

  const abasOrfas = data.rooms.filter((r) => r.controles > 0 && r.streams.length === 0);
  if (abasOrfas.length) {
    sinais.push({
      nivel: 'aviso',
      titulo: count(abasOrfas.length, 'aba de captura parada', 'abas de captura paradas'),
      texto: `Ligadas sem nada no ar: ${abasOrfas
        .map((r) => r.name)
        .join(
          ', ',
        )}. É o normal de quem abriu e ainda não começou, e também a explicação de metade das transmissões que "somem sozinhas".`,
    });
  }

  const graves = sinais.filter((s) => s.nivel === 'erro').length;
  const avisos = sinais.filter((s) => s.nivel === 'aviso').length;

  if (!sinais.length) {
    sinais.push({
      nivel: 'ok',
      titulo: 'Nada fora do normal',
      texto: 'Sem descarte, sem espectador travado e a máquina com folga.',
    });
  }

  $('sinais').replaceChildren(
    ...sinais.map((s) => {
      const box = el('div', `sinal ${s.nivel === 'ok' ? '' : s.nivel}`.trim());
      box.append(el('span', 'sinal-ponto'));
      const texto = el('div', 'sinal-texto');
      texto.append(el('strong', null, s.titulo), el('span', null, s.texto));
      box.append(texto);
      return box;
    }),
  );

  // A conta no canal, e o aviso do topo com o pior deles. Um alerta que não vai
  // a lugar nenhum vira ruído: os dois levam ao diagnóstico.
  const total = graves + avisos;
  $('navSinais').hidden = total === 0;
  $('navSinais').textContent = String(total);
  $('navSinais').className = graves ? 'conta alerta' : 'conta live';

  const pior = sinais.find((s) => s.nivel === 'erro') ?? sinais.find((s) => s.nivel === 'aviso');
  const pill = $('alertPill');
  pill.hidden = !pior;
  if (pior) pill.textContent = `⚠ ${pior.titulo}`;
}

// ----------------------------------------------------------------- ajustes

/**
 * Os números do relay, editáveis.
 *
 * Os campos só são reescritos quando não estão sendo mexidos: reconstruir a
 * cada dois segundos apagaria o que a pessoa está digitando no meio da palavra.
 */
function renderAjustes(data) {
  const form = $('ajustesForm');
  if (form.dataset.montado === '1') {
    for (const [chave, valor] of Object.entries(data.ajustes)) {
      const input = form.querySelector(`input[name="${chave}"]`);
      if (!input || input === document.activeElement) continue;
      if (!input.classList.contains('sujo')) input.value = String(valor);
      input.dataset.servidor = String(valor);
    }
    return;
  }

  form.dataset.montado = '1';
  form.replaceChildren(
    ...Object.entries(data.limites).map(([chave, limite]) => {
      const linha = el('div', 'ajuste');

      const texto = el('div');
      texto.append(el('div', 'ajuste-nome', limite.rotulo));
      texto.append(
        el('div', 'ajuste-faixa', `${chave} · de ${limite.min} a ${limite.max} ${limite.unidade}`),
      );

      const input = el('input');
      input.type = 'number';
      input.name = chave;
      input.min = String(limite.min);
      input.max = String(limite.max);
      input.step = String(limite.passo);
      input.value = String(data.ajustes[chave]);
      input.dataset.servidor = String(data.ajustes[chave]);
      input.addEventListener('input', () => {
        input.classList.toggle('sujo', input.value !== input.dataset.servidor);
      });

      linha.append(texto, input);
      return linha;
    }),
  );
}

async function aplicarAjustes() {
  const mudancas = {};
  for (const input of $('ajustesForm').querySelectorAll('input')) {
    if (input.value !== input.dataset.servidor) mudancas[input.name] = Number(input.value);
  }
  if (!Object.keys(mudancas).length) return toast('Nada mudou.');

  try {
    const r = await fetch('/api/admin/tuning', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mudancas),
    });
    const body = await r.json();
    const nomes = Object.keys(body.aplicadas ?? {});

    // Recusado em silêncio é o que acontece com valor fora do limite. Dizer
    // "ok" aqui esconderia justamente o caso em que nada foi aceito.
    if (!nomes.length) {
      toast('Nenhum valor foi aceito — confira os limites.', 'ruim');
    } else {
      toast(`${count(nomes.length, 'ajuste aplicado', 'ajustes aplicados')}.`, 'bom');
    }

    for (const input of $('ajustesForm').querySelectorAll('input')) {
      input.classList.remove('sujo');
      const valor = body.ajustes?.[input.name];
      if (valor !== undefined) {
        input.value = String(valor);
        input.dataset.servidor = String(valor);
      }
    }
  } catch (erro) {
    toast(`Não deu: ${erro.message}`, 'ruim');
  }
}

// --------------------------------------------------------------------- log

let ultimoLog = 0;
let logPausado = false;
let logPerdidos = 0;
const logLinhas = [];
const LOG_MAX = 300;
/** Linhas com os dados abertos, por id, para sobreviver ao re-render. */
const logAbertos = new Set();

async function loadLogs() {
  if (logPausado) return;
  try {
    const r = await fetch(`/api/admin/logs?desde=${ultimoLog}`, { cache: 'no-store' });
    if (!r.ok) return;
    const body = await r.json();
    ultimoLog = body.ultimoId ?? ultimoLog;
    logPerdidos = body.perdidos ?? 0;
    if (!body.eventos.length) return;

    logLinhas.push(...body.eventos);
    while (logLinhas.length > LOG_MAX) logLinhas.shift();
    desenharLog();
  } catch {
    // O log é acessório: falhar aqui não pode apagar o resto do painel.
  }
}

function logVisiveis() {
  const nivel = $('logNivel').value;
  const escopo = $('logEscopo').value;
  const busca = $('logBusca').value.trim().toLowerCase();

  return logLinhas.filter(
    (e) =>
      (!nivel || e.nivel === nivel) &&
      (!escopo || e.escopo === escopo) &&
      // A busca cobre os dados junto com o texto: "vp09" costuma estar só lá,
      // e procurar por codec é metade do uso desta caixa.
      (!busca ||
        e.mensagem.toLowerCase().includes(busca) ||
        (e.dados && JSON.stringify(e.dados).toLowerCase().includes(busca))),
  );
}

function horaDe(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function desenharLog() {
  const visiveis = logVisiveis();

  $('logVazio').hidden = visiveis.length > 0;
  $('logPerdidos').hidden = logPerdidos === 0;
  if (logPerdidos) {
    $('logPerdidos').textContent = `${logPerdidos} linha(s) já saíram do anel`;
  }

  const box = $('logBox');
  // Só rola sozinho quem já estava no fim: puxar a barra para ler uma linha
  // antiga e ser arrastado de volta a cada dois segundos é insuportável.
  const noFim = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;

  const nodes = [];
  for (const e of visiveis) {
    const linha = el('div', `log-linha ${e.nivel}${e.dados ? ' tem-dados' : ''}`);
    linha.append(
      el('span', 'log-hora', horaDe(e.em)),
      el('span', 'log-escopo', e.escopo),
      el('span', 'log-msg', e.mensagem),
    );

    // O que o evento trouxe junto abre no clique. É onde mora o codec, o fps e
    // o resync de cada boletim — o que transforma a linha "fulano: travado"
    // numa causa.
    if (e.dados) {
      linha.title = 'Clique para ver o que veio junto';
      linha.addEventListener('click', () => {
        if (logAbertos.has(e.id)) logAbertos.delete(e.id);
        else logAbertos.add(e.id);
        desenharLog();
      });
    }

    nodes.push(linha);
    if (e.dados && logAbertos.has(e.id)) {
      nodes.push(el('div', 'log-dados', JSON.stringify(e.dados, null, 2)));
    }
  }

  box.replaceChildren(...nodes);
  if (noFim) box.scrollTop = box.scrollHeight;
}

/** O log como está na tela, em texto, para colar num relato de problema. */
function baixarLog() {
  const texto = logVisiveis()
    .map(
      (e) =>
        `${new Date(e.em).toISOString()} [${e.nivel}] [${e.escopo}] ${e.mensagem}` +
        (e.dados ? ` ${JSON.stringify(e.dados)}` : ''),
    )
    .join('\n');
  baixar(`sala-de-tela-log-${carimbo()}.txt`, texto, 'text/plain');
}

// -------------------------------------------------------------------- json

/**
 * A resposta crua, colorida e filtrável.
 *
 * Existe para as perguntas que a tela ainda não responde: quando falta um campo
 * que nenhum cartão mostra, o caminho era abrir o DevTools num painel que já
 * tinha o dado na mão. A colorização é montada nó a nó, e não com innerHTML —
 * o texto aqui vem do servidor, e metade dele foi escrita por outra pessoa.
 */
function renderJson() {
  if (abaAtual !== 'json' || !ultimo) return;

  const busca = $('jsonBusca').value.trim().toLowerCase();
  // Congelado enquanto se filtra: rebobinar a lista a cada dois segundos tira
  // do lugar justamente a linha que a pessoa estava lendo.
  if (busca && $('jsonBox').dataset.filtrado === busca) return;
  $('jsonBox').dataset.filtrado = busca;

  const texto = JSON.stringify(ultimo, null, 2);
  const nodes = [];

  for (const linha of texto.split('\n')) {
    const fora = busca && !linha.toLowerCase().includes(busca);
    const caixa = el('div', fora ? 'j-fora' : null);

    // "chave": valor — a chave e o valor ganham cores diferentes, que é o que
    // faz um JSON de mil linhas ser varrido com o olho em vez de lido.
    const m = linha.match(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)?(.*)$/);
    if (!m) {
      caixa.textContent = linha;
      nodes.push(caixa);
      continue;
    }

    const [, espaco, aspas, doisPontos, resto] = m;
    caixa.append(document.createTextNode(espaco));
    caixa.append(el('span', doisPontos ? 'j-chave' : 'j-texto', aspas));
    if (doisPontos) caixa.append(document.createTextNode(doisPontos));
    if (resto) caixa.append(el('span', classeDoValor(resto), resto));
    nodes.push(caixa);
  }

  $('jsonBox').replaceChildren(...nodes);
}

function classeDoValor(valor) {
  const limpo = valor.trim().replace(/,$/, '');
  if (limpo.startsWith('"')) return 'j-texto';
  if (limpo === 'true' || limpo === 'false') return 'j-bool';
  if (limpo === 'null') return 'j-nulo';
  if (/^-?\d/.test(limpo)) return 'j-numero';
  return null;
}

// ------------------------------------------------------- recursos e ambiente

function medidor(id, fracao) {
  const barra = $(id);
  if (!barra) return;
  const pct = Number.isFinite(fracao) ? Math.min(100, Math.max(0, fracao * 100)) : 0;
  barra.style.width = `${pct}%`;
  barra.className = pct > 90 ? 'bad' : pct > 75 ? 'warn' : '';
}

function renderRecursos(system) {
  const memoriaUsada = system.memory.hostTotalBytes - system.memory.hostFreeBytes;
  const disco = system.disk;

  // Processo e máquina lado a lado de propósito: é o que separa "a aplicação
  // está pesada" de "tem outra coisa comendo esta máquina".
  text('cpuProcess', formatPercent(system.cpu.processPercent));
  text('cpuHost', formatPercent(system.cpu.hostPercent));
  medidor('cpuProcessBar', system.cpu.processPercent / 100);
  medidor('cpuHostBar', system.cpu.hostPercent / 100);

  text('memProcess', formatBytes(system.memory.process.rss));
  text('memHost', `${formatBytes(memoriaUsada)} / ${formatBytes(system.memory.hostTotalBytes)}`);
  medidor('memHostBar', memoriaUsada / system.memory.hostTotalBytes);

  text('disk', disco ? `${formatBytes(disco.usedBytes)} / ${formatBytes(disco.totalBytes)}` : '—');
  medidor('diskBar', disco ? disco.usedBytes / disco.totalBytes : null);

  text('uptime', formatDuration(system.processUptimeSeconds));
}

function renderAmbiente(data) {
  const { configuration: config, system } = data;
  const container = system.container;

  const linhas = [
    ['Ambiente', config.environment],
    ['Origem pública', config.publicOrigin],
    ['Porta', String(config.port)],
    ['Client ID', config.clientId ?? 'não configurado'],
    ['Bot do Discord', config.botConfigured ? 'configurado' : 'não configurado'],
    ['Sistema', `${system.platform} ${system.release}`],
    ['Node', system.nodeVersion],
    ['Máquina', system.hostname],
    ['Núcleos', `${system.cpu.logicalCores} · ${system.cpu.model}`],
    ['Carga média', system.cpu.loadAverage.map((v) => v.toFixed(2)).join(' · ')],
  ];

  // Limites de container só aparecem quando existem: numa máquina comum eles
  // seriam duas linhas dizendo "sem limite", que não é informação.
  if (Number.isFinite(container?.cpuLimitCores)) {
    linhas.push(['Limite de CPU', `${container.cpuLimitCores} núcleos`]);
  }
  if (Number.isFinite(container?.memoryMax)) {
    linhas.push(['Limite de memória', formatBytes(container.memoryMax)]);
  }

  $('envList').replaceChildren(
    ...linhas.map(([rotulo, valor]) => {
      const par = el('div');
      const dt = el('dt', null, rotulo);
      // textContent: origem pública e nome da máquina são texto de fora.
      const dd = el('dd', null, valor);
      dd.title = valor;
      par.append(dt, dd);
      return par;
    }),
  );
}

// ------------------------------------------------------------------ gráfico

function drawChart() {
  const canvas = $('chart');
  const box = canvas.getBoundingClientRect();
  if (!box.width) return;

  // Redimensionar o canvas zera a transformação, então a escala vem depois.
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * ratio);
  canvas.height = Math.round(box.height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);

  const style = getComputedStyle(document.documentElement);
  const cor = (nome) => style.getPropertyValue(nome).trim();

  // 64 à esquerda porque o rótulo mais largo é "1.2 Mb/s" em mono de 10px, e
  // com 52 ele começava fora do canvas — a escala aparecia cortada pela metade.
  const pad = { left: 64, right: 6, top: 8, bottom: 18 };
  const larguraPlot = box.width - pad.left - pad.right;
  const alturaPlot = box.height - pad.top - pad.bottom;

  // Piso de 128 KB/s para o gráfico não virar ruído amplificado quando não há
  // ninguém transmitindo.
  const teto = Math.max(128 * 1024, ...historico.flatMap((p) => [p.inbound, p.outbound])) * 1.15;

  ctx.clearRect(0, 0, box.width, box.height);
  ctx.strokeStyle = cor('--border');
  ctx.fillStyle = cor('--dim');
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';

  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (alturaPlot * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(box.width - pad.right, y);
    ctx.stroke();
    ctx.fillText(formatRate(teto * (1 - i / 4)), pad.left - 8, y + 3);
  }

  for (const [chave, nome] of [
    ['inbound', '--brand'],
    ['outbound', '--ok'],
    ['dropped', '--danger'],
  ]) {
    ctx.beginPath();
    ctx.strokeStyle = cor(nome);
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';

    historico.forEach((ponto, index) => {
      const valor = ponto[chave];
      if (!Number.isFinite(valor)) return;
      const x = pad.left + (index / Math.max(1, HISTORICO_MAX - 1)) * larguraPlot;
      const y = pad.top + alturaPlot - (valor / teto) * alturaPlot;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();
  }

  ctx.textAlign = 'left';
  ctx.fillText('−2 min', pad.left, box.height - 4);
  ctx.textAlign = 'right';
  ctx.fillText('agora', box.width - pad.right, box.height - 4);
}

// -------------------------------------------------------------------- canais

/** O que cada canal escreve na barra de cima. */
const CANAIS = {
  visao: { titulo: 'visão-geral', sub: 'está funcionando?' },
  salas: { titulo: 'todas-as-salas', sub: 'cada sala por dentro' },
  pessoas: { titulo: 'pessoas', sub: 'quem está online agora' },
  diagnostico: { titulo: 'diagnóstico', sub: 'o que está fora do normal, e o log ao vivo' },
  ajustes: { titulo: 'ajustes', sub: 'os números do relay, com o servidor no ar' },
  json: { titulo: 'json-cru', sub: 'a resposta inteira, como ela chegou' },
};

function atualizarBarra() {
  if (abaAtual === 'sala') {
    const room = visao?.rooms.find((r) => r.id === salaAtual);
    text('barraIcone', '#');
    text('barraTitulo', room?.name ?? 'sala fechada');
    text(
      'barraSub',
      room
        ? [
            count(room.users.length, 'pessoa', 'pessoas'),
            count(room.streams.length, 'tela no ar', 'telas no ar'),
            room.id,
          ].join(' · ')
        : 'ela some da lista assim que esvazia',
    );
    return;
  }

  const canal = CANAIS[abaAtual] ?? { titulo: abaAtual, sub: '' };
  text('barraIcone', '#');
  text('barraTitulo', canal.titulo);
  text(
    'barraSub',
    // Com um servidor filtrado, a linha diz o que o filtro não alcança: a
    // máquina é uma só, e ninguém deveria descobrir isso deduzindo.
    filtroGuild && abaAtual === 'visao'
      ? 'CPU, memória e disco são da máquina inteira, não deste servidor'
      : canal.sub,
  );
}

function mostrarAba(nome) {
  abaAtual = nome;
  if (nome !== 'sala') salaAtual = null;

  for (const botao of document.querySelectorAll('.canal[data-aba]')) {
    botao.classList.toggle('ativo', botao.dataset.aba === nome);
  }
  for (const secao of document.querySelectorAll('.aba')) {
    secao.hidden = secao.id !== `aba-${nome}`;
  }

  atualizarBarra();
  if (visao) {
    renderCanaisDeSala(visao);
    renderSalaDetalhe(visao);
  }
  renderJson();

  // O canvas mede zero enquanto está escondido, então o desenho só vale depois
  // de a aba aparecer.
  if (nome === 'visao') drawChart();
}

function abrirSala(id) {
  salaAtual = id;
  mostrarAba('sala');
  abaAtual = 'sala';
}

// ------------------------------------------------------------- ir para (⌘K)

/**
 * O "ir para" do Discord, com o mesmo atalho.
 *
 * Numa noite ruim a sala que se procura está na posição catorze de uma lista
 * que não para de mexer, e o nome dela é a única coisa que se sabe. Teclar o
 * nome sempre foi mais rápido do que caçar a linha — só faltava existir.
 */
let switcherMarcado = 0;
let switcherOpcoes = [];

function abrirSwitcher() {
  $('switcher').hidden = false;
  $('switcherInput').value = '';
  $('switcherInput').focus();
  montarSwitcher();
}

function fecharSwitcher() {
  $('switcher').hidden = true;
}

function montarSwitcher() {
  const busca = $('switcherInput').value.trim().toLowerCase();

  const tudo = [
    ...Object.entries(CANAIS).map(([aba, info]) => ({
      rotulo: info.titulo,
      tipo: 'canal',
      ir: () => mostrarAba(aba),
    })),
    ...(visao?.rooms ?? []).map((room) => ({
      rotulo: room.name,
      detalhe: room.streams.length ? `${room.streams.length} no ar` : `${room.users.length} dentro`,
      tipo: 'sala',
      ir: () => abrirSala(room.id),
    })),
    ...(visao?.users ?? []).map((user) => ({
      rotulo: user.name,
      detalhe: user.broadcasting ? 'transmitindo' : null,
      tipo: 'pessoa',
      ir: () => abrirPerfil(user.id),
    })),
  ];

  switcherOpcoes = tudo
    .filter((o) => !busca || o.rotulo.toLowerCase().includes(busca))
    .slice(0, 40);
  switcherMarcado = 0;
  desenharSwitcher();
}

function desenharSwitcher() {
  $('switcherLista').replaceChildren(
    ...switcherOpcoes.map((opcao, i) => {
      const item = el('button', `switcher-item${i === switcherMarcado ? ' marcado' : ''}`);
      item.append(el('span', null, opcao.rotulo));
      if (opcao.detalhe) item.append(el('span', 'hint', opcao.detalhe));
      item.append(el('span', 'switcher-tipo', opcao.tipo));
      item.addEventListener('click', () => {
        fecharSwitcher();
        opcao.ir();
      });
      return item;
    }),
  );

  if (!switcherOpcoes.length) {
    $('switcherLista').replaceChildren(el('p', 'empty', 'Nada com esse nome agora.'));
  }
}

// --------------------------------------------------------------------- boot

async function boot() {
  try {
    const response = await fetch('/api/admin/me', { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      $('loading').hidden = true;
      $('login').hidden = false;
      if (body.configured === false) {
        text(
          'loginMessage',
          'O painel está desligado. Defina DISCORD_ADMIN_ID no arquivo .env e reinicie.',
        );
        $('loginButton').hidden = true;
      }
      return;
    }

    text('adminName', body.user.name);
    text('adminIniciais', iniciais(body.user.name));
    if (body.user.avatar) {
      const img = $('adminAvatar');
      img.src = `/api/avatar/${body.user.id}/${body.user.avatar}`;
      img.hidden = false;
      $('adminIniciais').hidden = true;
    }

    $('loading').hidden = true;
    $('dashboard').hidden = false;
    await loadMetrics();
    await loadLogs();
    startPolling();
  } catch {
    $('loading').hidden = true;
    $('login').hidden = false;
    text('loginMessage', 'O servidor não respondeu. Tente de novo em alguns segundos.');
  }
}

for (const botao of document.querySelectorAll('.canal[data-aba]')) {
  botao.addEventListener('click', () => mostrarAba(botao.dataset.aba));
}

$('railTudo').addEventListener('click', () => {
  filtroGuild = '';
  render(ultimo);
});

$('filtroChip').addEventListener('click', () => {
  filtroGuild = '';
  render(ultimo);
});

$('alertPill').addEventListener('click', () => mostrarAba('diagnostico'));
$('btnAtualizar').addEventListener('click', tick);
$('btnBusca').addEventListener('click', abrirSwitcher);

$('btnMembros').addEventListener('click', () => {
  membrosVisiveis = !membrosVisiveis;
  $('dashboard').classList.toggle('sem-membros', !membrosVisiveis);
  $('dashboard').classList.toggle('com-membros', membrosVisiveis);
  $('btnMembros').classList.toggle('ligado', membrosVisiveis);
});

// Copiar e baixar levam a resposta INTEIRA, sem o filtro de servidor: o que se
// manda para outra pessoa investigar não pode ter um recorte invisível dentro.
$('btnCopiar').addEventListener('click', () => {
  if (!ultimo) return toast('Nada carregado ainda.', 'ruim');
  copiar(JSON.stringify(ultimo, null, 2), 'JSON deste instante copiado');
});

$('btnBaixar').addEventListener('click', () => {
  if (!ultimo) return toast('Nada carregado ainda.', 'ruim');
  baixar(`sala-de-tela-${carimbo()}.json`, JSON.stringify(ultimo, null, 2));
});

$('jsonCopiar').addEventListener('click', () =>
  copiar(JSON.stringify(ultimo, null, 2), 'JSON copiado'),
);
$('jsonBaixar').addEventListener('click', () =>
  baixar(`sala-de-tela-${carimbo()}.json`, JSON.stringify(ultimo, null, 2)),
);
$('jsonBusca').addEventListener('input', () => {
  $('jsonBox').dataset.filtrado = '';
  renderJson();
});

$('ajustesAplicar').addEventListener('click', aplicarAjustes);

$('ajustesPadrao').addEventListener('click', () => {
  // O padrão é o do código, e o painel não o conhece — mas conhece os limites,
  // e o servidor devolve o valor real depois de aplicar. Aqui só se propõe.
  const padroes = {
    atrasoRelayMs: 500,
    bufferMaxBytes: 2 * 1024 * 1024,
    tetoMinBytes: 64 * 1024,
    keyframeIntervaloMs: 1000,
    salaVaziaMs: 12000,
    semPresencaMs: 15000,
  };
  for (const input of $('ajustesForm').querySelectorAll('input')) {
    const valor = padroes[input.name];
    if (valor === undefined) continue;
    input.value = String(valor);
    input.classList.toggle('sujo', input.value !== input.dataset.servidor);
  }
});

$('logNivel').addEventListener('change', desenharLog);
$('logEscopo').addEventListener('change', desenharLog);
$('logBusca').addEventListener('input', desenharLog);
$('logBaixa').addEventListener('click', baixarLog);

$('logPausa').addEventListener('click', () => {
  logPausado = !logPausado;
  $('logPausa').textContent = logPausado ? 'Retomar' : 'Pausar';
  $('logPausa').classList.toggle('btn-brand', logPausado);
});

$('logLimpa').addEventListener('click', () => {
  logLinhas.length = 0;
  logAbertos.clear();
  desenharLog();
});

$('btnSair').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' }).catch(() => null);
  location.reload();
});

$('switcherInput').addEventListener('input', montarSwitcher);

$('switcherInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const passo = e.key === 'ArrowDown' ? 1 : -1;
    switcherMarcado =
      (switcherMarcado + passo + switcherOpcoes.length) % Math.max(1, switcherOpcoes.length);
    desenharSwitcher();
    return;
  }
  if (e.key === 'Enter' && switcherOpcoes[switcherMarcado]) {
    fecharSwitcher();
    switcherOpcoes[switcherMarcado].ir();
  }
});

// Clicar fora fecha os diálogos que não pedem decisão nenhuma.
for (const id of ['switcher', 'perfil']) {
  $(id).addEventListener('click', (e) => {
    if (e.target === $(id)) $(id).hidden = true;
  });
}

window.addEventListener('resize', () => ultimo && abaAtual === 'visao' && drawChart());

window.addEventListener('keydown', (e) => {
  // Esc fecha o que estiver aberto: é o reflexo de todo mundo, e sem ele a
  // única saída de um diálogo aberto por engano é o botão certo.
  if (e.key === 'Escape') {
    if (!$('switcher').hidden) return fecharSwitcher();
    if (!$('perfil').hidden) return ($('perfil').hidden = true);
    if (!$('confirmModal').hidden) return $('confirmNao').click();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    abrirSwitcher();
    return;
  }

  // Atalhos de uma tecla só valem fora de campo de texto — senão a letra some
  // no meio do que a pessoa estava escrevendo.
  const digitando = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (digitando || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'r') tick();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return stopPolling();
  tick();
  startPolling();
});

boot();
