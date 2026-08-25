import { DiscordSDK } from '@discord/embedded-app-sdk';
import { createPlayer } from './player.js';
import { createAudio } from './audio.js';
import { createBroadcaster } from '../../shared/broadcaster.js';
import { criarCamada, conter, paraGrade, CORES, ESPESSURAS } from '../../shared/anotacoes.js';
import { criarFlutuante, flutuarDisponivel } from '../../shared/flutuar.js';
import {
  iceServers,
  criarPeer,
  suportaWebRTC,
  resumoPeer,
  MORTO,
  PRAZO_CONEXAO_MS,
} from '../../shared/rtc.js';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
// O Discord injeta frame_id/instance_id na URL do iframe. Sem eles, estamos
// rodando direto no navegador — modo de desenvolvimento.
const inDiscord = params.has('frame_id');

// Dentro da Activity todo tráfego precisa passar pelo proxy do Discord.
const P = inDiscord ? '/.proxy' : '';

// Um decoder e um canvas por transmissor, indexados pelo slot que o servidor
// atribuiu. Os canvas vivem fora do DOM entre renderizações e são movidos para
// dentro do tile de cada pessoa — detachar não apaga o conteúdo nem invalida o
// contexto 2D, então os decoders seguem desenhando sem saber de nada.
const streams = new Map(); // slot -> { userId, canvas, player }

// Transmissões anunciadas pelo servidor, assistidas ou não. Assistir é opt-in:
// sem pedir, o servidor nem envia os quadros — a economia de banda depende
// disso, filtrar só na exibição gastaria a mesma saída.
const available = new Map(); // slot -> { userId, config }
const watching = new Set(); // slots que eu pedi para assistir

/**
 * Telas que esta pessoa fechou de propósito.
 *
 * Existe por causa da abertura automática logo abaixo: sem a lista, fechar a
 * única transmissão da sala seria desfeito no render seguinte, e o botão de
 * parar de assistir reabriria o que acabou de fechar. Uma transmissão nova no
 * mesmo slot limpa a marca — é outra coisa, e ninguém a dispensou.
 */
const dispensados = new Set();

// Quem tem aba de captura aberta, segundo o servidor. É o que decide entre
// falar com a aba existente e abrir outra.
const abas = new Set();

let sdk = null;
let session = null;
let clientId = null;
let ws = null;
let participants = [];
let reconnectDelay = 1000;
let lagTimer = null;
// Transmissão nascida aqui dentro, quando o Discord permite capturar no iframe.
let myBroadcast = null;
// A captura em si, quando ela nasce nesta página. É o que alimenta a prévia
// local — a tela de quem transmite, mostrada a ele sem passar pela rede.
let meuStream = null;
// Volume de tudo que chega, de 0 a 1. Vale para todas as telas e sobrevive a
// trocar de sala: é preferência de quem assiste, não estado de uma transmissão.
// Zero é o mudo — um número só, em vez de dois estados que precisam concordar.
let volume = Math.min(1, Math.max(0, Number(read('volume') ?? 1)));

/**
 * Volume de cada pessoa, separado do volume geral.
 *
 * Como no Discord: o cursor do dock é o volume de tudo, e cada transmissão tem
 * o seu, guardado por pessoa e não por sessão — quem sempre chega alto demais
 * continua ajustado amanhã. O que sai no alto-falante é o produto dos dois.
 */
const volumePessoa = lerVolumes();

function lerVolumes() {
  try {
    return new Map(Object.entries(JSON.parse(read('volumePessoa') ?? '{}')));
  } catch {
    return new Map();
  }
}

const gravarVolumes = () => store('volumePessoa', JSON.stringify(Object.fromEntries(volumePessoa)));

const volumeEfetivo = (userId) => volume * (volumePessoa.get(userId) ?? 1);

/** Reaplica o volume de um stream depois de qualquer um dos dois mudar. */
function aplicarVolume(slot) {
  const s = streams.get(slot);
  if (!s) return;
  s.audio?.setVolume(volumeEfetivo(s.userId));
  // Pela conexão direta o som sai do próprio <video>, e não do decodificador
  // de áudio — o mesmo controle precisa alcançar os dois.
  if (s.video) s.video.volume = Math.min(1, volumeEfetivo(s.userId));
}
// Para onde o botão de silenciar volta. Sem isto, desmutar cairia sempre em
// 100%, ignorando o ajuste que a pessoa tinha feito.
let volumeAntes = volume || 1;
// Qual tela está no palco, e se ela ocupa tudo. Guardados fora do render
// porque a grade é reconstruída a cada mudança de estado da sala, e a escolha
// de quem assiste precisa sobreviver a isso.
let activeSlot = null;
let telaCheia = false;

/**
 * Ferramenta do ponteiro sobre a tela em destaque.
 *
 * 'mover' arrasta a imagem ampliada, 'laser' aponta e 'caneta' desenha. Só uma
 * de cada vez, como em qualquer editor: o mesmo arrasto não pode significar
 * duas coisas.
 */
let ferramenta = 'mover';
let corCaneta = CORES.includes(read('annCor')) ? read('annCor') : CORES[0];
let espessura = Number(read('annEsp')) || ESPESSURAS.medio;
// Esconder os traços é escolha de quem assiste e não sai daqui: some da minha
// tela, continua na de todo mundo. Guardado como as outras preferências de
// quem assiste — e a barra fica firme enquanto vale, senão vira um estado
// invisível que faz o recurso parecer quebrado na sessão seguinte.
let esconderTracos = read('annEsconder') === '1';
// Ids de traço só precisam ser únicos dentro de uma pessoa: o servidor os
// namespaceia com o id de quem desenhou.
let seqTraco = 0;
// Arrastar, desenhar e apontar terminam num clique que o navegador entrega ao
// tile — e o tile alterna a tela cheia. Este relógio é o que separa um clique
// de verdade do rastro de uma interação que já aconteceu.
let cliqueBloqueadoAte = 0;
const bloquearClique = () => (cliqueBloqueadoAte = performance.now() + 350);

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

// Gesto em curso sobre a tela em destaque, e se a grade pediu para ser refeita
// enquanto isso. Ver a guarda em renderGrid.
let interagindo = false;
let renderPendente = false;
// O que o link da atividade pediu: qual tela no palco e se já em tela cheia.
// Não dá para aplicar no arranque — a sala ainda não tem transmissão nenhuma, e
// o render zera a escolha justamente nesse estado. Fica guardado até a tela
// aparecer.
// Não tem prazo de propósito. Tinha, e era uma corrida perdida: se o estado da
// sala demorasse — aba aberta em segundo plano, WebSocket lento, ninguém
// transmitindo ainda — a intenção morria antes de poder ser cumprida, e a
// pessoa caía no convite que o link existia para pular. Ela se apaga sozinha ao
// ser usada, que é a única condição que importa.
let chegada = null;

// ------------------------------------------------------------------- helpers

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

function setEmpty(title, text) {
  $('emptyTitle').textContent = title;
  $('emptyText').textContent = text;
}

/** Cor estável por usuário — mesma pessoa, mesma cor, em qualquer sessão. */
function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 42%)`;
}

/**
 * Avatares passam pelo nosso próprio servidor, não pelo CDN do Discord.
 *
 * O CSP da Activity bloqueia cdn.discordapp.com, e o proxy do Discord só
 * repassa domínios mapeados no portal do desenvolvedor — sem esse mapeamento a
 * foto caía sempre nas iniciais. Pela nossa rota a URL é a mesma dentro e fora
 * da Activity, e não depende de configuração que ninguém lembra de fazer.
 */
function avatarUrl(p) {
  if (!p.avatar) return null;
  return `${P}/api/avatar/${p.id}/${p.avatar}`;
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();
}

/** Todas as transmissões de uma pessoa — hoje até duas: a tela e a câmera. */
const slotsOf = (userId) =>
  [...available.entries()].filter(([, a]) => a.userId === userId).map(([slot]) => slot);

/**
 * O que o grid desenha: uma entrada por transmissão, mais uma por pessoa que
 * não está transmitindo.
 *
 * Antes era uma entrada por pessoa, com o slot deduzido dela. Bastava enquanto
 * ninguém podia ter duas — a partir da câmera, a segunda transmissão
 * simplesmente não aparecia, e o motivo não ficava visível em lugar nenhum.
 */
function entradasDoGrid() {
  const saida = [];
  for (const p of participants) {
    const slots = p.broadcasting ? slotsOf(p.id) : [];
    if (!slots.length) saida.push({ p, slot: null });
    else for (const slot of slots) saida.push({ p, slot });
  }
  return saida;
}

/**
 * O nó que mostra esta transmissão agora: canvas do relay ou vídeo da conexão
 * direta. Só um dos dois está no DOM por vez, e trocar de um para o outro é o
 * que a mudança de transporte faz de visível.
 */
const noDe = (s) => s.surface;

/**
 * Qual dos dois elementos está mostrando a imagem agora.
 *
 * São três casos e dois elementos: o canvas que o decodificador pinta, o
 * <video> da conexão direta, e o mesmo <video> ligado na captura local de quem
 * transmite daqui. Os três moram na mesma superfície e trocam de lugar sem que
 * o resto do arquivo precise saber qual está no ar.
 */
const midiaDe = (s) => (s.local || s.viaRtc ? s.video : s.canvas);

/** Resolução nativa, venha de onde vier. Zero enquanto nada foi desenhado. */
function medidaDe(s) {
  const el = midiaDe(s);
  return el.tagName === 'VIDEO'
    ? { w: el.videoWidth, h: el.videoHeight }
    : { w: el.width, h: el.height };
}

/** Mostra o elemento que está no ar e esconde o outro, sem tirar nenhum do DOM. */
function mostrarMidia(s) {
  const ativo = midiaDe(s);
  s.canvas.hidden = ativo !== s.canvas;
  s.video.hidden = ativo !== s.video;
}

function watchSlot(slot) {
  const info = available.get(slot);
  if (!info) return;
  watching.add(slot);
  ws?.send(JSON.stringify({ type: 'watch', slot }));
  // O config pode já ter chegado; se não, ele chega logo e dispara o start.
  if (info.config) {
    openStream(slot, info.userId);
    startStream(slot, info.config);
  }
  renderGrid();
}

function unwatchSlot(slot) {
  dispensados.add(slot);
  watching.delete(slot);
  ws?.send(JSON.stringify({ type: 'unwatch', slot }));
  closeStream(slot);
  renderGrid();
  renderBar();
}

/**
 * Uma transmissão só na sala abre sozinha.
 *
 * Assistir é opt-in porque o servidor não manda os quadros de quem ninguém
 * pediu, e é essa economia que faz uma sala com várias telas caber na banda de
 * todo mundo. Só que a escolha precisa ter mais de uma opção para ser escolha:
 * com uma tela no ar, o convite "Assistir tela" é um clique cobrado para
 * chegar ao único lugar aonde dava para ir — e quem entrou numa sala com uma
 * tela no ar entrou justamente para vê-la.
 *
 * A partir da segunda transmissão o convite volta, porque aí a pergunta existe
 * de verdade: baixar as duas custa o dobro, e qual delas interessa é resposta
 * de quem assiste.
 *
 * A própria transmissão nunca entra: ela já aparece pela prévia local, sem
 * passar pela rede, e baixá-la de volta seria pagar banda para ver o que está
 * a um palmo daqui.
 */
function autoAssistir() {
  const meu = session?.user?.id;
  const outras = [...available.keys()].filter((slot) => available.get(slot)?.userId !== meu);
  if (outras.length !== 1) return;

  const [slot] = outras;
  if (watching.has(slot) || dispensados.has(slot)) return;

  // Adiado porque watchSlot chama renderGrid, e quem chama isto está dentro de
  // um. As condições são conferidas de novo lá: entre um e outro a sala pode
  // ter mudado, e a mais provável das mudanças é uma segunda tela entrando.
  queueMicrotask(() => {
    if (!available.has(slot) || watching.has(slot) || dispensados.has(slot)) return;
    if (autoAssistirAlvo() !== slot) return;
    watchSlot(slot);
  });
}

/** O slot que a abertura automática escolheria agora, ou null. */
function autoAssistirAlvo() {
  const meu = session?.user?.id;
  const outras = [...available.keys()].filter((slot) => available.get(slot)?.userId !== meu);
  return outras.length === 1 ? outras[0] : null;
}

// --------------------------------------------------------------------- grade

/** Colunas aproximando o layout da call do Discord: quadrado, crescendo em passos. */
function columnsFor(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

// Largura da barra lateral. É preferência de quem assiste, não estado da sala —
// por isso vive no localStorage, e não no servidor.
const STRIP_DEFAULT = 300;
const STRIP_MIN = 200;
let stripW = Number(read('stripW')) || STRIP_DEFAULT;

const divider = document.createElement('div');
divider.className = 'divider';
divider.title = 'Arraste para redimensionar · duplo clique restaura';

/** Aplica a largura guardada, respeitando o teto da janela atual. */
function applyStrip() {
  // O teto acompanha a janela: uma largura guardada grande demais engoliria o
  // palco depois de alguém encolher o Discord.
  const max = Math.max(STRIP_MIN, $('grid').clientWidth * 0.45);
  const largura = `${Math.round(Math.min(max, stripW))}px`;
  $('grid').style.setProperty('--strip', largura);
  // Também no #app: a barra de controles é irmã da grade, não filha, e precisa
  // da mesma medida para se centrar no palco em vez de na janela.
  $('app').style.setProperty('--strip', largura);
}

function setStrip(px) {
  stripW = Math.max(STRIP_MIN, Math.round(px));
  applyStrip();
  store('stripW', String(stripW));
}

divider.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  divider.classList.add('dragging');

  // Os ouvintes vão na janela, não no divisor: a grade é reconstruída a cada
  // mudança de estado da sala, e o arrasto não pode morrer no meio disso.
  // 21px = os 16 de padding da grade mais a meia largura do divisor.
  const move = (ev) => setStrip($('grid').getBoundingClientRect().right - ev.clientX - 21);
  const up = () => {
    divider.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

divider.addEventListener('dblclick', () => setStrip(STRIP_DEFAULT));
window.addEventListener('resize', () => inRoom() && applyStrip());

/**
 * Duas formas de mostrar a sala, e o que decide é ter alguém transmitindo.
 *
 * Sem transmissão, uma grade de pessoas — a sala de espera. Com transmissão, um
 * palco: a tela escolhida ocupa a área principal e, ao lado, ficam as outras
 * telas em cima e as pessoas embaixo. Dar a grade inteira à tela esconderia
 * quem está junto, e é a call que se perde nisso.
 */
function renderGrid() {
  // Um gesto em andamento não pode ser interrompido por uma mudança de estado
  // da sala: a grade é refeita do zero, o tile do palco é outro nó, e tirar a
  // superfície do DOM no meio do caminho solta a captura do ponteiro — o traço
  // seria cortado ao meio porque alguém entrou na sala.
  if (interagindo) {
    renderPendente = true;
    return;
  }
  renderPendente = false;

  // A barra é refeita a cada render, junto do tile do palco. Zerar aqui evita
  // que a referência sobreviva ao tile que a continha — sem palco não há barra.
  barra = null;

  const grid = $('grid');

  // Fora de uma sala quem manda é o lobby. Sem esta guarda, o render disparado
  // pelo fechamento do WebSocket mostrava o painel "Ninguém na sala" por cima
  // da lista de salas.
  if (!inRoom()) {
    grid.hidden = true;
    $('empty').hidden = true;
    $('fullscreen').hidden = true;
    $('watchSite').hidden = true;
    $('app').classList.remove('cheia', 'flutua', 'palco');
    return;
  }

  const hasPeople = participants.length > 0;
  $('empty').hidden = hasPeople;
  grid.hidden = !hasPeople;

  const casters = participants.filter((p) => p.broadcasting);

  if (!casters.length) {
    activeSlot = null;
    telaCheia = false;
  } else if (activeSlot === null || !available.has(activeSlot)) {
    // Sempre há uma tela em destaque quando existe transmissão: chegar numa
    // sala com tela no ar e ver só avatares esconderia o que importa.
    activeSlot = entradasDoGrid().find((e) => e.slot !== null)?.slot ?? null;
  }

  // Quem chegou pelo link da atividade já pediu para assistir lá atrás: parar
  // num convite de "Assistir tela" seria cobrar o mesmo clique duas vezes.
  //
  // A tela pedida tem preferência, mas não é condição. Ela pode não vir no link
  // (atividade com bundle antigo em cache) ou não ter chegado ainda neste
  // render — e em nenhum dos dois casos vale desistir e mostrar o convite,
  // porque a escolha automática logo acima já garante uma tela válida no palco.
  //
  // Só espera enquanto não houver tela nenhuma: aí não há o que assistir, e a
  // intenção fica de pé até alguém transmitir ou o prazo dela vencer.
  if (chegada && activeSlot === null) {
    console.info('[sala] link pediu para assistir, mas ninguém está transmitindo ainda');
  }

  if (chegada && activeSlot !== null) {
    const pedida = chegada.slot;
    const alvo = pedida !== null && available.has(pedida) ? pedida : activeSlot;
    console.info('[sala] assistindo automaticamente', {
      pedida,
      alvo,
      slots: [...available.keys()],
    });
    // Zerado antes de qualquer coisa: watchSlot renderiza de novo, e a segunda
    // passada não pode reabrir este mesmo caminho.
    const cheia = chegada.cheia;
    chegada = null;

    activeSlot = alvo;
    telaCheia = cheia;
    // Adiado porque watchSlot chama renderGrid, e estamos dentro de um.
    if (!watching.has(alvo)) queueMicrotask(() => watchSlot(alvo));
  }

  autoAssistir();

  const noPalco = activeSlot !== null;
  $('fullscreen').hidden = !noPalco;
  // A classe vai no #app, e não na grade: quem sai do layout são as barras, que
  // são irmãs dela. Fica acima do `return` de sala vazia — senão as barras
  // continuariam flutuando sobre o painel de "ninguém na sala".
  $('app').classList.toggle('cheia', noPalco && telaCheia);
  // Dentro da sala as barras sempre flutuam, tendo transmissão ou não: a barra
  // não deve pular de lugar quando alguém começa a transmitir, e um dock que
  // muda de posição sozinho é a mesma barra parecendo duas.
  $('app').classList.add('flutua');
  // Sumir por ócio, porém, só faz sentido com imagem embaixo — é a imagem que
  // se quer descobrir. Sobre uma grade de avatares o sumiço não revelaria nada
  // e só faria os controles parecerem quebrados.
  $('app').classList.toggle('palco', noPalco);
  $('fullscreen').classList.toggle('on', telaCheia);
  // A dica e o nome acessível andam juntos: o botão faz duas coisas conforme o
  // estado, e anunciar sempre a mesma coisa mentiria para quem usa leitor.
  const rotulo = telaCheia ? 'Sair da tela cheia' : 'Tela cheia';
  $('fullscreen').dataset.tip = rotulo;
  $('fullscreen').setAttribute('aria-label', rotulo);

  // Só em tela cheia, e só dentro do Discord: é ali que a moldura da atividade
  // aperta, e no site a pessoa já está onde o botão levaria. A dica sai daqui,
  // e não do clique, porque o palco também entra em tela cheia pelo clique no
  // tile — dois caminhos, um lugar só para avisar.
  const podeIrAoSite = inDiscord && noPalco && Boolean(origemDoSite());
  $('watchSite').hidden = !podeIrAoSite;

  if (!hasPeople) return;

  grid.classList.toggle('palco', noPalco);
  grid.classList.toggle('cheia', noPalco && telaCheia);

  // Com a lateral no ar, a contagem no topo repete o que está logo ali — e
  // custa uma faixa inteira de altura, que é o que falta para a tela. Vazia, a
  // barra de cima se recolhe sozinha.
  $('people').hidden = noPalco && !telaCheia;

  // Os canvas são reanexados abaixo; removê-los daqui não perde o conteúdo.
  grid.replaceChildren();

  if (!noPalco) {
    const entradas = entradasDoGrid();
    grid.style.setProperty('--cols', columnsFor(entradas.length));
    grid.append(...entradas.map((e) => buildTile(e.p, { slot: e.slot }).el));
    sincronizarZoom();
    return;
  }

  const dono = available.get(activeSlot)?.userId;
  const emCena = participants.find((p) => p.id === dono) ?? {
    id: dono ?? 'desconhecido',
    name: 'Transmitindo',
    broadcasting: true,
  };
  // O slot em destaque, e não o da pessoa: cada transmissão tem um nó de canvas
  // só, então montar o palco com o slot errado o arranca do tile que o estava
  // mostrando — e um dos dois fica preto, conforme a ordem do desenho.
  grid.append(buildTile(emCena, { palco: true, slot: activeSlot }).el);

  if (telaCheia) {
    sincronizarZoom();
    return;
  }

  applyStrip();
  grid.append(divider, buildSidebar());
  sincronizarZoom();
}

/**
 * Reaplica o zoom depois de cada render.
 *
 * A aproximação só vale no palco, e o palco muda: promover outra tela precisa
 * devolver a anterior ao tamanho normal e ampliar a nova onde ela parou.
 */
function sincronizarZoom() {
  for (const slot of streams.keys()) aplicarZoom(slot);
}

/**
 * Barra lateral: as outras telas em cima, as pessoas embaixo.
 *
 * Telas primeiro porque é o que se olha; pessoas depois porque é o que se
 * confere. Cada uma no formato que merece — a tela como miniatura, a pessoa
 * como linha, que cabe muito mais gente no mesmo espaço.
 */
function buildSidebar() {
  const barra = document.createElement('aside');
  barra.className = 'sidebar';

  // Por transmissão, e não por pessoa: quem divide tela e câmera tem duas
  // miniaturas aqui, e a que está no palco é a única que não se repete.
  const outras = entradasDoGrid().filter((e) => e.slot !== null && e.slot !== activeSlot);
  if (outras.length) {
    barra.append(secaoTitulo(outras.length === 1 ? 'Outra transmissão' : 'Outras transmissões'));
    for (const e of outras) barra.append(buildTile(e.p, { slot: e.slot }).el);
  }

  barra.append(contagemPessoas());

  // semVideo é obrigatório aqui: o canvas de cada transmissão é um nó de DOM
  // só, e anexá-lo neste tile o arrancaria do palco — que ficaria preto
  // enquanto a miniatura ao lado mostrava a tela.
  const gente = document.createElement('div');
  gente.className = 'sidebar-people';
  for (const p of participants) gente.append(buildTile(p, { semVideo: true }).el);
  barra.append(gente);

  return barra;
}

function secaoTitulo(texto) {
  const t = document.createElement('h2');
  t.className = 'sidebar-title';
  t.textContent = texto;
  return t;
}

/**
 * Quantas pessoas na sala, na mesma pílula usada no resto da interface.
 *
 * Era um título em caixa alta, que gastava uma faixa inteira da lateral para
 * dizer o que um número diz — e a lateral é justamente onde falta espaço.
 */
function contagemPessoas() {
  const chip = document.createElement('div');
  chip.className = 'sidebar-count';
  chip.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 0 0-3-3.87"/>' +
    '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  chip.append(document.createTextNode(String(participants.length)));
  chip.title =
    participants.length === 1 ? '1 pessoa na sala' : `${participants.length} pessoas na sala`;
  return chip;
}

/**
 * Um tile: a tela de quem transmite, ou o avatar de quem só assiste.
 *
 * `palco` distingue o tile em destaque dos da lateral, e é o que decide o que o
 * clique faz: no palco, alterna tela cheia; na lateral, promove aquela tela.
 *
 * `semVideo` força o avatar mesmo para quem está transmitindo. É o que permite
 * a mesma pessoa aparecer no palco e na lista de pessoas sem que os dois
 * disputem o único canvas daquela transmissão.
 */
function buildTile(p, { palco = false, semVideo = false, slot: slotDado = null } = {}) {
  // O slot é obrigatório para quem quer vídeo, e não deduzido da pessoa: com
  // duas fontes por pessoa não existe "a transmissão dela". Quem passa
  // `semVideo` quer só o avatar, e aí não há slot para acertar.
  const slot = p.broadcasting && !semVideo ? slotDado : null;
  const stream = slot !== null ? streams.get(slot) : null;
  const isMe = p.id === session?.user?.id;

  const tile = document.createElement('div');
  tile.className = p.broadcasting ? 'tile sharing' : 'tile';
  if (palco) tile.classList.add('tile-palco');

  // Com a forma do vídeo no próprio tile, a moldura passa a abraçar a imagem.
  // Sem isto, uma tela 16:9 dentro de um palco largo e baixo encolhia até caber
  // na altura e sobrava um retângulo preto ocupando metade da área.
  const medida = stream ? medidaDe(stream) : null;
  if (palco && medida?.w) {
    tile.style.aspectRatio = `${medida.w} / ${medida.h}`;
  }

  // Sem rótulo, dois tiles da mesma pessoa lado a lado no grid não se
  // distinguem até alguém clicar em um deles.
  if (slot !== null && available.get(slot)?.fonte === 'camera') {
    const marca = document.createElement('span');
    marca.className = 'tile-fonte';
    marca.textContent = 'Câmera';
    tile.append(marca);
  }

  const aoClicar = () => {
    // Arrastar, desenhar, apontar e ampliar terminam num clique que o navegador
    // entrega aqui. Sem esta guarda, cada traço alternava a tela cheia.
    if (performance.now() < cliqueBloqueadoAte) return;
    if (palco) telaCheia = !telaCheia;
    else activeSlot = slot;
    renderGrid();
  };

  if (stream) {
    tile.append(noDe(stream));
    if (palco) tile.append(buildFerramentas(slot));
    tile.title = palco
      ? telaCheia
        ? 'Clique para sair da tela cheia'
        : 'Clique para ver em tela cheia'
      : 'Clique para ver em destaque';
    tile.addEventListener('click', aoClicar);

    // Entre pedir para assistir e o primeiro quadro chegar existe uma espera
    // real: sem este aviso ela é indistinguível de um travamento.
    if (!stream.started) tile.append(buildLoading());

    // Nada de "parar de assistir" na prévia da própria captura: não há o que
    // parar, ela não veio pela rede. Quem quer parar usa o botão de encerrar a
    // transmissão, que é outra coisa e mora no dock.
    if (!stream.local) {
      // Botão direito para largar a tela, sem precisar caçar controle.
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTileMenu(e.clientX, e.clientY, slot, p.name);
      });

      // O clique direito pode ser capturado pelo cliente do Discord antes de
      // chegar aqui, então o botão visível é o caminho garantido.
      const stop = document.createElement('button');
      stop.className = 'tile-stop';
      stop.dataset.tip = 'Parar de assistir';
      stop.setAttribute('aria-label', `Parar de assistir ${p.name}`);
      stop.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      stop.addEventListener('click', (e) => {
        e.stopPropagation();
        unwatchSlot(slot);
      });
      tile.append(stop);
    }
  } else if (slot !== null) {
    // O convite tem botão próprio, que para o clique antes de chegar no tile.
    if (!palco) tile.addEventListener('click', aoClicar);
    tile.append(buildWatchPrompt(slot, p.name, isMe));
  } else {
    tile.append(buildAvatar(p));
  }

  const footer = document.createElement('div');
  footer.className = 'tile-footer';

  const badge = document.createElement('div');
  badge.className = 'tile-name';
  if (p.broadcasting) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    badge.append(dot);
  }
  badge.append(document.createTextNode(p.name));
  footer.append(badge);

  if (slot !== null) footer.append(buildWatchers(slot));
  tile.append(footer);

  if (isMe) {
    const you = document.createElement('span');
    you.className = 'tile-you';
    you.textContent = 'você';
    tile.append(you);
  }

  return { el: tile, slot };
}

/** Espera pelo primeiro quadro. Sai sozinha quando o decoder desenha. */
function buildLoading() {
  const wrap = document.createElement('div');
  wrap.className = 'tile-loading';
  wrap.innerHTML = '<span class="spinner"></span>';
  wrap.append(document.createTextNode('Conectando…'));
  return wrap;
}

/** Quantas pessoas assistem esta tela; a lista aparece ao passar o mouse. */
function buildWatchers(slot) {
  const people = available.get(slot)?.watchers ?? [];

  const badge = document.createElement('div');
  badge.className = 'tile-watchers';
  badge.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="12" cy="7" r="4"/></svg>';
  badge.append(document.createTextNode(String(people.length)));
  badge.title = people.length === 1 ? '1 pessoa assistindo' : `${people.length} pessoas assistindo`;

  const list = document.createElement('div');
  list.className = 'hover-list';

  if (!people.length) {
    const empty = document.createElement('span');
    empty.className = 'hover-empty';
    empty.textContent = 'Ninguém assistindo';
    list.append(empty);
  } else {
    for (const w of people) {
      const row = document.createElement('span');
      row.className = 'hover-row';
      row.append(buildAvatar(w));
      // textContent, nunca innerHTML: o nome vem do Discord, é conteúdo de terceiro.
      row.append(document.createTextNode(w.name));
      list.append(row);
    }
  }

  badge.append(list);
  return badge;
}

/** Tela cinza com o convite para assistir — nada é baixado até clicar. */
function buildWatchPrompt(slot, name, isMe) {
  const camera = available.get(slot)?.fonte === 'camera';
  const wrap = document.createElement('div');
  wrap.className = 'watch-prompt';

  const btn = document.createElement('button');
  btn.className = 'btn go';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v11H3z"/><path d="M8 20h8"/></svg>';
  btn.append(
    document.createTextNode(
      camera
        ? isMe
          ? 'Ver minha câmera'
          : 'Assistir câmera'
        : isMe
          ? 'Ver minha tela'
          : 'Assistir tela',
    ),
  );
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    watchSlot(slot);
  });

  const who = document.createElement('span');
  who.className = 'watch-who';
  // Ver a própria tela é conferência, não bisbilhotice: o texto precisa dizer
  // que o que está no ar é a sua, não a de outra pessoa com o seu nome.
  who.textContent = isMe
    ? 'Sua transmissão está no ar'
    : `${name} está ${camera ? 'com a câmera ligada' : 'transmitindo'}`;

  wrap.append(btn, who);
  return wrap;
}

// -------------------------------------------------------------------- perfil

function renderProfileButton() {
  if (!session) return;
  const me = participants.find((p) => p.id === session.user.id) ?? session.user;

  // A identidade vive só no cabeçalho do lobby agora: bolinha com nome.
  const name = document.createElement('span');
  name.textContent = me.name;
  $('lobbyUser').replaceChildren(buildAvatar({ ...me, id: session.user.id }), name);
  $('lobbyUser').hidden = false;
}

$('lobbyUser').addEventListener('click', openProfile);

function openProfile() {
  if (!session) return;
  const me = participants.find((p) => p.id === session.user.id) ?? session.user;

  $('profileAvatar').replaceChildren(buildAvatar({ ...me, id: session.user.id }));
  $('profileName').textContent = me.name;
  $('profileId').textContent = inDiscord ? `Discord · ${session.user.id}` : 'modo local';
  $('profileInput').value = me.name;

  $('profileModal').hidden = false;
  $('profileInput').focus();
  $('profileInput').select();
}

const closeProfile = () => {
  $('profileModal').hidden = true;
};

$('profileCancel').addEventListener('click', closeProfile);

$('profileModal').addEventListener('click', (e) => {
  if (e.target === $('profileModal')) closeProfile();
});

$('profileInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('profileSave').click();
});

$('profileSave').addEventListener('click', () => {
  const name = $('profileInput').value.replace(/\s+/g, ' ').trim().slice(0, 32);
  if (name) {
    session.user.name = name;
    storeName(name);
    ws?.send(JSON.stringify({ type: 'rename', name }));
    renderProfileButton();
  }
  closeProfile();
});

/**
 * O apelido vive no localStorage, não no servidor.
 *
 * Os acessos vão em try/catch porque dentro de um iframe de terceiro o
 * armazenamento pode estar particionado ou bloqueado — e perder o apelido é
 * bem melhor do que a sala não abrir.
 */
const storedName = () => read('displayName');
const storeName = (name) => store('displayName', name);

/** Menu de contexto do tile. Some ao primeiro clique ou tecla em qualquer lugar. */
function openTileMenu(x, y, slot, name) {
  document.querySelector('.tile-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'tile-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // O cursor só aparece onde há som para ajustar: oferecer um controle que não
  // faz nada é pior do que não oferecer nenhum.
  const stream = streams.get(slot);
  if (stream?.audio) menu.append(buildMenuVolume(stream.userId, name, slot));

  const item = document.createElement('button');
  item.textContent = `Parar de assistir ${name}`;
  item.addEventListener('click', () => {
    menu.remove();
    unwatchSlot(slot);
  });

  menu.append(item);
  document.body.append(menu);

  // Mantém o menu dentro da janela quando o clique acontece perto das bordas.
  const box = menu.getBoundingClientRect();
  if (x + box.width > window.innerWidth) menu.style.left = `${window.innerWidth - box.width - 8}px`;
  if (y + box.height > window.innerHeight)
    menu.style.top = `${window.innerHeight - box.height - 8}px`;

  // setTimeout: sem ele, o próprio clique que abriu o menu já o fecharia.
  setTimeout(() => {
    const close = (e) => {
      // pointerdown dispara ANTES do click. Sem esta guarda, clicar no item
      // removia o menu do DOM e o click nunca chegava ao botão — era por isso
      // que "parar de assistir" não fazia nada.
      if (e.type === 'pointerdown' && menu.contains(e.target)) return;
      menu.remove();
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
  }, 0);
}

/** Cursor de volume de uma pessoa, no menu do botão direito. */
function buildMenuVolume(userId, name, slot) {
  const bloco = document.createElement('div');
  bloco.className = 'menu-volume';

  const rotulo = document.createElement('span');
  rotulo.className = 'menu-volume-nome';
  // textContent, nunca innerHTML: nome vem do Discord, é conteúdo de terceiro.
  rotulo.textContent = `Volume de ${name}`;

  const linha = document.createElement('div');
  linha.className = 'menu-volume-linha';

  const barra = document.createElement('input');
  barra.type = 'range';
  barra.min = '0';
  barra.max = '200';
  barra.step = '5';
  barra.setAttribute('aria-label', `Volume de ${name}`);

  const valor = document.createElement('span');
  valor.className = 'menu-volume-valor';

  const mostrar = () => {
    valor.textContent = `${barra.value}%`;
  };

  barra.value = String(Math.round((volumePessoa.get(userId) ?? 1) * 100));
  mostrar();

  barra.addEventListener('input', () => {
    const nivel = Number(barra.value) / 100;
    // 100% é o padrão: não guardar significa "nunca foi mexido", e é o que
    // mantém o armazenamento pequeno depois de muita gente passar pela sala.
    if (nivel === 1) volumePessoa.delete(userId);
    else volumePessoa.set(userId, nivel);
    gravarVolumes();
    aplicarVolume(slot);
    mostrar();
  });

  linha.append(barra, valor);
  bloco.append(rotulo, linha);
  return bloco;
}

function buildAvatar(p) {
  const url = avatarUrl(p);

  const fallback = () => {
    const div = document.createElement('div');
    div.className = 'avatar';
    div.style.background = colorFor(p.id);
    div.textContent = initials(p.name);
    return div;
  };

  if (!url) return fallback();

  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = url;
  img.alt = p.name;
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

/**
 * Quem está na sala, listado na pílula do topo.
 *
 * Com telas no ar a grade passa a ser delas, então é aqui que ainda dá para ver
 * a sala inteira — inclusive quem só assiste.
 */
function buildPeopleList() {
  const list = document.createElement('div');
  list.className = 'hover-list';

  if (!participants.length) {
    const empty = document.createElement('span');
    empty.className = 'hover-empty';
    empty.textContent = 'Ninguém na sala';
    list.append(empty);
    return list;
  }

  for (const p of participants) {
    const row = document.createElement('span');
    row.className = 'hover-row';
    if (p.broadcasting) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      row.append(dot);
    }
    // textContent, nunca innerHTML: nome vem do Discord, é conteúdo de terceiro.
    row.append(document.createTextNode(p.id === session?.user?.id ? `${p.name} (você)` : p.name));
    list.append(row);
  }

  return list;
}

function renderBar() {
  $('people').replaceChildren();
  $('people').insertAdjacentHTML(
    'afterbegin',
    '<svg viewBox="0 0 24 24"><path d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>' +
      '<circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 0 0-3-3.87"/>' +
      '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  );
  $('people').append(document.createTextNode(String(participants.length)));
  $('people').append(buildPeopleList());

  const casters = participants.filter((p) => p.broadcasting);

  const minhas = minhasFontes();
  const telaNoAr = minhas.has('tela') || Boolean(myBroadcast);
  const cameraNoAr = minhas.has('camera');

  const btn = $('share');
  btn.classList.toggle('live', telaNoAr);
  btn.disabled = false;

  const rotuloShare = telaNoAr ? 'Parar tela' : 'Compartilhar tela';
  btn.dataset.tip = rotuloShare;
  btn.setAttribute('aria-label', rotuloShare);

  // A câmera tem botão próprio, com o mesmo par ligar/desligar da tela — e a
  // mesma aparência: são a mesma ação em duas fontes, e pintar só uma delas
  // dizia que a outra era secundária.
  const cam = $('camera');
  cam.classList.toggle('live', cameraNoAr);
  const rotuloCam = cameraNoAr ? 'Desligar câmera' : 'Ligar câmera';
  cam.dataset.tip = rotuloCam;
  cam.setAttribute('aria-label', rotuloCam);

  // O controle de som só existe quando há som para controlar.
  const temSom = [...streams.values()].some((s) => s.audio);
  $('volumeBox').hidden = !temSom;
  renderVolume();

  renderProfileButton();

  $('pWho').textContent = casters.length ? casters.map((p) => p.name).join(', ') : 'ninguém';
}

// ---------------------------------------------------------- zoom e anotações

/**
 * Onde a imagem do vídeo está, em pixels CSS dentro da caixa do tile.
 *
 * Todo o resto depende disto: o zoom escreve nela, o desenho lê dela para
 * normalizar o ponto, e a camada de anotações a usa para pintar. O canvas do
 * vídeo tem `object-fit: contain`, então a imagem quase nunca ocupa a caixa
 * inteira — desenhar assumindo que ocupa põe o traço na tarja preta.
 */
function vistaDe(slot) {
  const s = streams.get(slot);
  if (!s) return null;

  const box = s.surface.getBoundingClientRect();
  const { w: vw, h: vh } = medidaDe(s);
  if (!box.width || !box.height || !vw || !vh) return null;

  const fit = conter(box.width, box.height, vw, vh);
  const { z, tx, ty } = zoomDe(slot, s);

  return {
    left: box.left,
    top: box.top,
    boxW: box.width,
    boxH: box.height,
    x: fit.x * z + tx,
    y: fit.y * z + ty,
    w: fit.w * z,
    h: fit.h * z,
  };
}

/**
 * O zoom vale só no palco.
 *
 * A mesma transmissão aparece em miniatura na lateral, e ampliar ali cortaria a
 * miniatura sem que ninguém tivesse pedido. O valor fica guardado: quem volta a
 * pôr aquela tela em destaque encontra a aproximação onde deixou.
 */
const zoomDe = (slot, s) => (slot === activeSlot ? s.zoom : { z: 1, tx: 0, ty: 0 });

/** Ponto do evento na grade normalizada do vídeo, ou null fora dele. */
function pontoDe(slot, e) {
  const v = vistaDe(slot);
  if (!v) return null;
  return paraGrade(e.clientX - v.left, e.clientY - v.top, v);
}

/**
 * Mantém a imagem cobrindo a caixa enquanto for maior que ela, e centrada
 * quando for menor. Sem isto, arrastar leva a tela para fora e sobra preto.
 */
function limitarPan(s) {
  const box = s.surface.getBoundingClientRect();
  const { w: vw, h: vh } = medidaDe(s);
  if (!box.width || !vw) return;

  const fit = conter(box.width, box.height, vw, vh);
  s.zoom.tx = limitarEixo(s.zoom.tx, fit.x, fit.w, box.width, s.zoom.z);
  s.zoom.ty = limitarEixo(s.zoom.ty, fit.y, fit.h, box.height, s.zoom.z);
}

function limitarEixo(t, inicio, tamanho, caixa, z) {
  const i = inicio * z;
  const tam = tamanho * z;
  if (tam <= caixa) return (caixa - tam) / 2 - i;
  return Math.min(-i, Math.max(caixa - i - tam, t));
}

/** Escreve o zoom no canvas do vídeo e manda a camada repintar em cima. */
function aplicarZoom(slot) {
  const s = streams.get(slot);
  if (!s) return;

  const { z, tx, ty } = zoomDe(slot, s);
  aplicarTransformacao(s, z === 1 && !tx && !ty ? '' : `translate(${tx}px, ${ty}px) scale(${z})`);
  s.surface.classList.toggle('ampliado', slot === activeSlot && s.zoom.z > 1);
  s.ann.repintar();

  if (slot === activeSlot) mostrarZoom();
}

/** O zoom vale para os dois elementos: trocar de transporte não pode desfazê-lo. */
function aplicarTransformacao(s, valor) {
  s.canvas.style.transform = valor;
  s.video.style.transform = valor;
}

/**
 * @param {number} alvo       fator desejado
 * @param {number} [cx],[cy]  âncora em coordenadas de tela; sem ela, o centro
 */
function definirZoom(slot, alvo, cx, cy) {
  const s = streams.get(slot);
  if (!s || slot !== activeSlot) return;

  const box = s.surface.getBoundingClientRect();
  const { w: vw, h: vh } = medidaDe(s);
  if (!box.width || !vw) return;

  const z0 = s.zoom.z;
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, alvo));
  if (Math.abs(z - z0) < 0.001) return;

  const fit = conter(box.width, box.height, vw, vh);
  const bx = (cx ?? box.left + box.width / 2) - box.left;
  const by = (cy ?? box.top + box.height / 2) - box.top;

  // Guarda o ponto do vídeo que está sob o cursor e o recoloca lá depois de
  // trocar a escala. É o que faz a roda aproximar o que se está olhando, em vez
  // do centro da tela.
  const u = (bx - (fit.x * z0 + s.zoom.tx)) / (fit.w * z0);
  const v = (by - (fit.y * z0 + s.zoom.ty)) / (fit.h * z0);

  s.zoom.z = z;
  s.zoom.tx = bx - u * fit.w * z - fit.x * z;
  s.zoom.ty = by - v * fit.h * z - fit.y * z;

  limitarPan(s);
  aplicarZoom(slot);
}

/**
 * Abre a prévia da própria captura, assim que houver onde pendurá-la.
 *
 * Chamada de dois lugares porque a ordem entre eles não é garantida: a captura
 * fica pronta aqui, mas o número do slot só existe depois que o servidor
 * anuncia a transmissão de volta. Quem chegar por último é quem abre.
 */
function garantirPreviaLocal() {
  if (!meuStream || !session) return;

  const slot = slotsOf(session.user.id).find((s) => available.get(s)?.fonte !== 'camera');
  if (slot === undefined) return;
  if (streams.get(slot)?.local) return;

  abrirPreviaLocal(slot);
  renderGrid();
  renderBar();
}

/** Tira a prévia de cena. Quem encerra a captura é quem a abriu. */
function fecharPreviaLocal() {
  for (const [slot, s] of [...streams]) if (s.local) closeStream(slot);
}

/**
 * Laser e desenho chegando pelo socket de quem transmite.
 *
 * Este é o outro caminho da mesma informação: quem assiste recebe pelo socket
 * de espectador, quem transmite recebe pelo de transmissor. Só existe porque
 * quem transmite não assiste à própria tela — ele a vê pela captura.
 */
function anotarNaPrevia(msg) {
  const slot = session
    ? slotsOf(session.user.id).find((x) => available.get(x)?.fonte !== 'camera')
    : undefined;
  const s = slot === undefined ? null : streams.get(slot);
  if (!s?.local) return;

  if (msg.type === 'ann-sync') {
    sincronizarAnn(slot, msg.tracos);
    return;
  }
  // O meu já foi desenhado no eco local, como do lado de quem assiste.
  if (msg.uid !== session?.user?.id) anotarEm(slot, msg);
}

/**
 * Abre (ou fecha) a janela flutuante daquela tela.
 *
 * Ela nasce já com o que estiver desenhado: quem clica no meio de uma conversa
 * não pode receber um quadro em branco e achar que quebrou.
 */
async function alternarFlutuante(slot) {
  const s = streams.get(slot);
  if (!s) return;

  if (s.flutuante) {
    s.flutuante.parar();
    s.flutuante = null;
    sincronizarBarra();
    return;
  }

  const f = criarFlutuante({
    fonte: () => (medidaDe(s).w ? midiaDe(s) : null),
    dim: () => medidaDe(s),
    aoFechar: () => {
      s.flutuante = null;
      sincronizarBarra();
    },
  });

  f.sincronizar(s.ann.instantaneo());
  f.mostrar(!esconderTracos);
  s.flutuante = f;

  try {
    await f.abrir();
  } catch (err) {
    s.flutuante = null;
    f.parar();
    // Cancelar não é erro; qualquer outra coisa a pessoa precisa saber.
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast(err.message, true);
  }
  sincronizarBarra();
}

/** Fator atual de uma tela, ou 1 quando ela não está sendo assistida. */
const zoomAtual = (slot) => streams.get(slot)?.zoom.z ?? 1;

function zerarZoom(slot = activeSlot) {
  const s = streams.get(slot);
  if (!s) return;
  s.zoom = { z: 1, tx: 0, ty: 0 };
  aplicarZoom(slot);
}

/**
 * Envia a anotação e a desenha aqui na mesma hora.
 *
 * O eco local não é otimização: a volta pelo servidor é visível na ponta do
 * lápis, e um traço que aparece depois da mão parece um travamento.
 */
function emitir(slot, ev) {
  ws?.send(JSON.stringify({ type: 'ann', slot, ev }));
  anotarEm(slot, { uid: session?.user?.id, name: session?.user?.name, ev });
}

/**
 * Aplica uma anotação em todas as superfícies daquela tela.
 *
 * São até duas: a do palco e a da janela flutuante. Elas mostram o mesmo estado
 * em tamanhos diferentes — uma na caixa do tile, com o zoom de quem assiste, a
 * outra no tamanho do quadro —, então cada uma guarda a sua cópia e as duas
 * recebem tudo.
 */
function anotarEm(slot, msg) {
  const s = streams.get(slot);
  if (!s) return;
  s.ann.aplicar(msg);
  s.flutuante?.aplicar(msg);
}

/**
 * Espalha a escolha de mostrar ou esconder por tudo que desenha.
 *
 * Toda camada que existe agora e toda que nascer depois — por isso as duas
 * fábricas também chamam isto, e não só o botão.
 */
function aplicarVisibilidade() {
  for (const s of streams.values()) {
    s.ann.mostrar(!esconderTracos);
    s.flutuante?.mostrar(!esconderTracos);
  }
}

function alternarTracos() {
  esconderTracos = !esconderTracos;
  store('annEsconder', esconderTracos ? '1' : '');
  aplicarVisibilidade();
  sincronizarBarra();
}

function sincronizarAnn(slot, tracos) {
  const s = streams.get(slot);
  if (!s) return;
  s.ann.sincronizar(tracos);
  s.flutuante?.sincronizar(tracos);
}

/** Quem apaga o desenho dos outros: o dono da tela e quem criou a sala. */
function podeLimparTudo() {
  const eu = session?.user?.id;
  if (!eu || activeSlot === null) return false;
  return available.get(activeSlot)?.userId === eu || lastRoomState?.ownerId === eu;
}

function definirFerramenta(f) {
  if (ferramenta === f) return;

  // Pegar o lápis com os traços escondidos é desenhar no escuro: nem o próprio
  // traço apareceria. Volta a mostrar em vez de deixar a pessoa concluir que a
  // caneta parou de funcionar.
  if (esconderTracos && (f === 'caneta' || f === 'laser')) {
    esconderTracos = false;
    store('annEsconder', '');
    aplicarVisibilidade();
  }

  // Sai apontando: o ponto de quem trocou de ferramenta ficaria parado na tela
  // dos outros até o tempo de vida do laser acabar.
  if (ferramenta === 'laser' && activeSlot !== null) emitir(activeSlot, { k: 'po' });

  ferramenta = f;
  for (const s of streams.values()) s.surface.dataset.f = f;
  sincronizarBarra();
}

// -------------------------------------------------------- pointer no palco

/**
 * Liga roda, arrasto, pinça e desenho na superfície de uma transmissão.
 *
 * Os ouvintes nascem uma vez, junto da superfície, e não a cada renderGrid: a
 * superfície é um nó só que passeia entre os tiles, e reatar ouvintes a cada
 * mudança de estado da sala derrubaria um traço no meio.
 *
 * Todo handler começa perguntando se esta tela está no palco. Na lateral, o
 * evento precisa continuar subindo até o tile — é o clique que promove aquela
 * tela ao destaque.
 */
function ligarInteracao(slot, s) {
  const sup = s.surface;
  const noPalco = () => slot === activeSlot;

  // Um por ponteiro: é o que permite reconhecer a pinça de dois dedos.
  const pontos = new Map();
  let arrasto = null;
  let traco = null;
  let pinca = null;
  let laserEm = 0;

  sup.dataset.f = ferramenta;

  sup.addEventListener(
    'wheel',
    (e) => {
      if (!noPalco()) return;
      e.preventDefault();
      // deltaMode 1 é linha e 2 é página: sem normalizar, um passo de roda no
      // Firefox salta a escala inteira.
      const passo =
        e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      definirZoom(slot, s.zoom.z * Math.exp(-passo / 400), e.clientX, e.clientY);
      bloquearClique();
    },
    { passive: false },
  );

  sup.addEventListener('pointerdown', (e) => {
    if (!noPalco()) return;

    pontos.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pontos.size === 2) return iniciarPinca();
    if (pontos.size > 2) return;

    // O botão do meio arrasta com qualquer ferramenta: é o reflexo de quem já
    // usa mapa e editor de imagem, e evita ter que trocar de ferramenta para
    // mexer a tela um dedo para o lado.
    if (e.button === 1 || ferramenta === 'mover') {
      // Sem zoom não há o que arrastar, e engolir o clique aqui tiraria de quem
      // assiste o gesto de alternar a tela cheia.
      if (s.zoom.z <= 1 && e.button !== 1) return;
      e.preventDefault();
      sup.setPointerCapture(e.pointerId);
      interagindo = true;
      arrasto = { x: e.clientX, y: e.clientY, tx: s.zoom.tx, ty: s.zoom.ty, moveu: false };
      sup.classList.add('arrastando');
      return;
    }

    if (e.button !== 0) return;
    e.preventDefault();
    bloquearClique();
    sup.setPointerCapture(e.pointerId);
    interagindo = true;

    if (ferramenta === 'caneta') iniciarTraco(e);
    else if (ferramenta === 'laser') apontar(e, true);
  });

  sup.addEventListener('pointermove', (e) => {
    if (pontos.has(e.pointerId)) pontos.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinca) return moverPinca();
    if (!noPalco()) return;

    if (arrasto) {
      const dx = e.clientX - arrasto.x;
      const dy = e.clientY - arrasto.y;
      // Três pixels separam um arrasto de um clique com a mão trêmula. Abaixo
      // disso o gesto ainda é um clique, e clique no palco é tela cheia.
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) arrasto.moveu = true;
      s.zoom.tx = arrasto.tx + dx;
      s.zoom.ty = arrasto.ty + dy;
      limitarPan(s);
      aplicarZoom(slot);
      return;
    }

    if (traco) return moverTraco(e);
    // O laser segue o cursor sem precisar apertar nada: é ponteiro, não pincel.
    if (ferramenta === 'laser') apontar(e);
  });

  for (const tipo of ['pointerup', 'pointercancel']) {
    sup.addEventListener(tipo, (e) => {
      pontos.delete(e.pointerId);

      // O navegador entrega um `click` ao tile logo depois deste pointerup, e o
      // tile alterna a tela cheia. Só um clique de verdade pode chegar lá: com
      // ferramenta na mão, ou depois de arrastar, o clique é rastro do gesto.
      //
      // Bloquear no pointerdown não bastava: o bloqueio tem prazo, e um traço
      // longo dura mais que ele — desenhar devagar entrava em tela cheia.
      if (arrasto?.moveu || traco || pinca || ferramenta !== 'mover') bloquearClique();

      if (pontos.size < 2) pinca = null;

      if (arrasto) {
        arrasto = null;
        sup.classList.remove('arrastando');
      }
      if (traco) terminarTraco();
      // Num toque, o dedo que sai é o ponteiro que sumiu — deixar o laser aceso
      // marcaria a tela de todo mundo com um ponto parado.
      if (ferramenta === 'laser' && e.pointerType !== 'mouse') emitir(slot, { k: 'po' });

      if (pontos.size === 0) soltar();
    });
  }

  sup.addEventListener('pointerleave', () => {
    if (ferramenta === 'laser' && noPalco()) emitir(slot, { k: 'po' });
  });

  // Rede de segurança: soltar o botão fora da janela, o sistema roubar o
  // ponteiro ou a aba perder o foco não disparam pointerup em toda parte, e um
  // gesto que não termina prenderia a grade sem redesenhar para sempre.
  sup.addEventListener('lostpointercapture', (e) => {
    pontos.delete(e.pointerId);
    if (pontos.size === 0) {
      pinca = null;
      arrasto = null;
      sup.classList.remove('arrastando');
      if (traco) terminarTraco();
      soltar();
    }
  });

  // Duplo clique zera a aproximação — o mesmo reflexo de qualquer mapa.
  sup.addEventListener('dblclick', (e) => {
    if (!noPalco() || ferramenta !== 'mover') return;
    e.preventDefault();
    bloquearClique();
    zerarZoom(slot);
  });

  // ------------------------------------------------------------------ laser

  function apontar(e, forcar = false) {
    const t = performance.now();
    // 25 por segundo: acima disso o olho não distingue e o teto do servidor
    // começa a ficar perto.
    if (!forcar && t - laserEm < 40) return;

    const p = pontoDe(slot, e);
    if (!p) return;
    laserEm = t;
    emitir(slot, { k: 'p', x: p.x, y: p.y, c: corCaneta });
  }

  // ----------------------------------------------------------------- caneta

  function iniciarTraco(e) {
    const p = pontoDe(slot, e);
    if (!p?.dentro) return;
    traco = { id: ++seqTraco, pendentes: [], ultimo: p, enviadoEm: performance.now() };
    emitir(slot, { k: 's', id: traco.id, c: corCaneta, w: espessura, pts: [p.x, p.y] });
  }

  function moverTraco(e) {
    const p = pontoDe(slot, e);
    if (!p) return;

    // Ponto que praticamente não andou só engorda o traço e o pacote. O limiar
    // é na grade do vídeo, então vale igual com ou sem zoom.
    if (Math.abs(p.x - traco.ultimo.x) < 4 && Math.abs(p.y - traco.ultimo.y) < 4) return;

    traco.ultimo = p;
    traco.pendentes.push(p.x, p.y);

    // Agrupar pontos antes de enviar troca dezenas de mensagens minúsculas por
    // algumas cheias, sem que a linha atrase o bastante para se notar.
    if (traco.pendentes.length >= 12 || performance.now() - traco.enviadoEm > 60) descarregar();
  }

  function descarregar() {
    while (traco?.pendentes.length) {
      // 64 pares é o teto que o servidor aceita por mensagem.
      emitir(slot, { k: 'a', id: traco.id, pts: traco.pendentes.splice(0, 128) });
    }
    if (traco) traco.enviadoEm = performance.now();
  }

  function terminarTraco() {
    descarregar();
    emitir(slot, { k: 'e', id: traco.id });
    traco = null;
  }

  // ------------------------------------------------------------------ pinça

  function iniciarPinca() {
    if (traco) terminarTraco();
    arrasto = null;
    sup.classList.remove('arrastando');

    const [a, b] = [...pontos.values()];
    pinca = { d: distancia(a, b), z: s.zoom.z };
  }

  /** Fim do gesto: a grade que ficou esperando pode ser refeita agora. */
  function soltar() {
    interagindo = false;
    if (renderPendente) renderGrid();
  }

  function moverPinca() {
    const [a, b] = [...pontos.values()];
    const d = distancia(a, b);
    if (!pinca.d || !d) return;
    definirZoom(slot, pinca.z * (d / pinca.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
    bloquearClique();
  }
}

const distancia = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// --------------------------------------------------------- barra do palco

/**
 * Ferramentas da tela em destaque.
 *
 * Flutua sobre o palco em vez de morar no dock de baixo: o que ela controla
 * está ali, e um controle a uma tela de distância do que ele altera é um
 * controle que ninguém acha.
 */
let barra = null;

function buildFerramentas(slot) {
  const el = document.createElement('div');
  el.className = 'tools';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'Ferramentas da tela');

  // Cliques daqui não podem chegar ao tile: lá embaixo eles alternariam a tela
  // cheia a cada botão apertado.
  el.addEventListener('click', (e) => e.stopPropagation());
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('dblclick', (e) => e.stopPropagation());
  el.addEventListener('wheel', (e) => e.stopPropagation());

  const botoes = {};
  const criar = (nome, dica, svg, aoClicar, classe = 'tool') => {
    const b = document.createElement('button');
    b.className = classe;
    b.dataset.tip = dica;
    b.setAttribute('aria-label', dica);
    b.innerHTML = svg;
    b.addEventListener('click', aoClicar);
    botoes[nome] = b;
    return b;
  };

  el.append(
    criar('mover', 'Mover e ampliar  ·  V', ICONES.mover, () => definirFerramenta('mover')),
    criar('laser', 'Laser  ·  L', ICONES.laser, () => definirFerramenta('laser')),
    criar('caneta', 'Desenhar  ·  C', ICONES.caneta, () => definirFerramenta('caneta')),
  );

  const cores = document.createElement('div');
  cores.className = 'tool-cores';
  const swatches = [];
  for (const cor of CORES) {
    const b = document.createElement('button');
    b.className = 'cor';
    b.style.setProperty('--cor', cor);
    b.dataset.cor = cor;
    b.dataset.tip = 'Cor do traço e do laser';
    b.setAttribute('aria-label', `Cor ${cor}`);
    b.addEventListener('click', () => {
      corCaneta = cor;
      store('annCor', cor);
      sincronizarBarra();
    });
    swatches.push(b);
    cores.append(b);
  }

  const grossuras = [];
  for (const [nome, valor] of Object.entries(ESPESSURAS)) {
    const b = document.createElement('button');
    b.className = 'grossura';
    b.dataset.esp = String(valor);
    b.dataset.tip = `Traço ${nome}`;
    b.setAttribute('aria-label', `Traço ${nome}`);
    b.innerHTML = `<span style="height:${Math.max(2, Math.round(valor / 2.5))}px"></span>`;
    b.addEventListener('click', () => {
      espessura = valor;
      store('annEsp', String(valor));
      sincronizarBarra();
    });
    grossuras.push(b);
    cores.append(b);
  }

  el.append(cores);
  el.append(separador());

  el.append(
    criar('esconder', 'Esconder os desenhos  ·  O', ICONES.olho, () => alternarTracos()),
    criar('desfazer', 'Desfazer meu último traço  ·  Ctrl+Z', ICONES.desfazer, () =>
      emitir(slot, { k: 'u' }),
    ),
    criar('apagar', 'Apagar tudo que eu desenhei', ICONES.apagar, () => emitir(slot, { k: 'c' })),
    criar('apagarTudo', 'Limpar os desenhos de todo mundo', ICONES.apagarTudo, () =>
      emitir(slot, { k: 'ca' }),
    ),
  );

  // Só aparece onde o navegador tem PiP. Dentro do iframe da Activity o
  // Discord pode negar a permissão, e um botão que só sabe dar erro é pior do
  // que botão nenhum.
  if (flutuarDisponivel()) {
    el.append(
      separador(),
      criar('flutuar', 'Manter numa janela por cima de tudo', ICONES.flutuar, () =>
        alternarFlutuante(slot),
      ),
    );
  }

  el.append(separador());

  const menos = criar('menos', 'Afastar  ·  −', ICONES.menos, () =>
    definirZoom(slot, zoomAtual(slot) / 1.4),
  );

  const nivel = document.createElement('button');
  nivel.className = 'tool tool-zoom';
  nivel.dataset.tip = 'Voltar ao tamanho normal  ·  0';
  nivel.addEventListener('click', () => zerarZoom(slot));

  const mais = criar('mais', 'Aproximar  ·  +', ICONES.mais, () =>
    definirZoom(slot, zoomAtual(slot) * 1.4),
  );

  el.append(menos, nivel, mais);

  barra = { el, botoes, cores, swatches, grossuras, nivel };
  sincronizarBarra();
  return el;
}

function separador() {
  const d = document.createElement('div');
  d.className = 'tool-sep';
  return d;
}

/**
 * Espelha ferramenta, cor, espessura, visibilidade e zoom na barra.
 *
 * A guarda é por existir, e não por estar no DOM. `buildFerramentas` chama isto
 * antes de anexar a barra ao tile — era o que fazia o estado inicial nunca ser
 * aplicado: a paleta aparecia sem a caneta escolhida, "mover" não vinha
 * marcado, e o olho abria dizendo o contrário do que estava valendo. Escrever
 * num nó ainda solto é inofensivo; não escrever é o bug.
 */
function sincronizarBarra() {
  if (!barra) return;

  for (const nome of ['mover', 'laser', 'caneta']) {
    barra.botoes[nome].classList.toggle('ativo', ferramenta === nome);
  }

  // Cor e espessura só aparecem com a caneta escolhida: com o laser elas
  // mudariam só a cor do ponto, e com a mão nenhuma delas faz nada.
  barra.cores.hidden = ferramenta !== 'caneta';
  for (const b of barra.swatches) b.classList.toggle('ativa', b.dataset.cor === corCaneta);
  for (const b of barra.grossuras) {
    b.classList.toggle('ativa', Number(b.dataset.esp) === espessura);
  }

  // O olho fechado diz "está escondido"; o aberto, "clique para esconder". O
  // rótulo troca junto, senão o leitor de tela anunciaria sempre a mesma coisa.
  barra.botoes.esconder.classList.toggle('ativo', esconderTracos);
  barra.botoes.esconder.innerHTML = esconderTracos ? ICONES.olhoCortado : ICONES.olho;
  const rotuloOlho = esconderTracos
    ? 'Mostrar os desenhos de novo  ·  O'
    : 'Esconder os desenhos, só para mim  ·  O';
  barra.botoes.esconder.dataset.tip = rotuloOlho;
  barra.botoes.esconder.setAttribute('aria-label', rotuloOlho);

  barra.botoes.apagarTudo.hidden = !podeLimparTudo();
  // O mesmo botão abre e fecha, e precisa dizer qual dos dois vai fazer.
  const flutuando = Boolean(activeSlot !== null && streams.get(activeSlot)?.flutuante);
  if (barra.botoes.flutuar) {
    barra.botoes.flutuar.classList.toggle('ativo', flutuando);
    const rotulo = flutuando ? 'Fechar a janela flutuante' : 'Manter numa janela por cima de tudo';
    barra.botoes.flutuar.dataset.tip = rotulo;
    barra.botoes.flutuar.setAttribute('aria-label', rotulo);
  }
  mostrarZoom();
}

/**
 * A barra some quase toda quando não está em uso — a tela é o que importa —, e
 * fica firme enquanto houver ferramenta escolhida ou aproximação aplicada.
 */
function firmarBarra() {
  barra?.el.classList.toggle(
    'fixa',
    ferramenta !== 'mover' || zoomAtual(activeSlot) > 1 || esconderTracos,
  );
}

function mostrarZoom() {
  if (!barra || activeSlot === null) return;
  const z = zoomAtual(activeSlot);
  barra.nivel.textContent = `${Math.round(z * 100)}%`;
  barra.nivel.classList.toggle('ativo', z > 1);
  firmarBarra();
}

const ICONES = {
  mover:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 3.2 11 19.5l2.1-6.4 6.4-2.1z"/></svg>',
  laser:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/>' +
    '<path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"/></svg>',
  caneta:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20.5l1.2-4.2L15.6 5.9a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8L9.7 20.8z"/>' +
    '<path d="M14.2 7.3l4.5 4.5"/></svg>',
  desfazer:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 14.5 4 10l4.5-4.5"/>' +
    '<path d="M4 10h10.5a5.5 5.5 0 0 1 0 11H10"/></svg>',
  apagar:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 20.5H21"/>' +
    '<path d="M14.8 4.6 3.9 15.5a2 2 0 0 0 0 2.8l2.2 2.2h4.6l9.4-9.4a2 2 0 0 0 0-2.8l-2.5-2.5a2 2 0 0 0-2.8 0z"/>' +
    '<path d="M10.6 8.8l5.3 5.3"/></svg>',
  apagarTudo:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9.5 7V4.8h5V7"/>' +
    '<path d="M6.2 7l1 12.2h9.6L18 7"/><path d="M10.5 10.6v5.6M13.5 10.6v5.6"/></svg>',
  menos:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/>' +
    '<path d="M7.5 10.5h6M20 20l-4.8-4.8"/></svg>',
  mais:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/>' +
    '<path d="M7.5 10.5h6M10.5 7.5v6M20 20l-4.8-4.8"/></svg>',
  flutuar:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="14" rx="2"/>' +
    '<rect x="12" y="11" width="8.5" height="6.5" rx="1.2"/></svg>',
  olho:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.7-6.4 10-6.4S22 12 22 12s-3.7 6.4-10 6.4S2 12 2 12z"/>' +
    '<circle cx="12" cy="12" r="2.8"/></svg>',
  olhoCortado:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.7 6.2A10.6 10.6 0 0 1 12 6.1c6.3 0 10 5.9 10 5.9a19 19 0 0 1-3 3.7"/>' +
    '<path d="M6.8 7.9A18.6 18.6 0 0 0 2 12s3.7 5.9 10 5.9a10 10 0 0 0 3.4-.6"/>' +
    '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3.2 3.2l17.6 17.6"/></svg>',
};

// ------------------------------------------------------------------- streams

/** Prepara o lugar do transmissor; o decoder só nasce quando o config chega. */
function openStream(slot, userId) {
  closeStream(slot);

  const canvas = document.createElement('canvas');

  // O elemento de vídeo da conexão direta. Nasce junto e fica fora do DOM até
  // ela fechar; criá-lo só na hora custaria um quadro preto no meio da troca.
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // A política de autoplay recusa vídeo com som antes de qualquer gesto. Entrar
  // mudo e abrir o som quando ele chega é o que evita o play() rejeitado —
  // aplicarVolume, logo abaixo, é quem devolve o volume de verdade.
  video.muted = true;

  const s = montarSuperficie(slot, userId, canvas, video);

  s.player = createPlayer(canvas, {
    onError: (m) => toast(m, true),
    onTamanho: () => {
      s.started = true;
      renderGrid();
    },
  });

  streams.set(slot, s);
  ligarInteracao(slot, s);
}

/**
 * A superfície: os dois elementos de imagem e a camada de traços, num nó só.
 *
 * É este nó que passeia entre os tiles, e é por isso que os dois transportes
 * moram dentro dele em vez de se revezarem no tile: trocar o relay pela conexão
 * direta vira esconder um e mostrar o outro, sem passar pelo DOM do palco e sem
 * levar junto o desenho que está por cima.
 *
 * A camada de anotações é um canvas separado, e não um desenho por cima do
 * canvas do vídeo: o decodificador repinta o quadro inteiro dezenas de vezes
 * por segundo, e qualquer traço feito ali sumiria no quadro seguinte.
 *
 * Ela também fica de fora do zoom, de propósito. A imagem é ampliada pelo
 * navegador; a camada é redesenhada na resolução da tela a cada mudança — é
 * isso que mantém a linha nítida com dez vezes de aproximação.
 */
function montarSuperficie(slot, userId, canvas, video) {
  canvas.className = 'video';
  video.className = 'video';
  video.hidden = true;

  const overlay = document.createElement('canvas');
  overlay.className = 'ann';

  const surface = document.createElement('div');
  surface.className = 'surface';
  surface.append(canvas, video, overlay);

  const s = {
    userId,
    canvas,
    video,
    overlay,
    surface,
    // Conexão direta com quem transmite, quando existir. Null é o normal: ela
    // pode nunca fechar, e nesse caso tudo continua pelo relay.
    pc: null,
    // Verdadeiro quando os quadros já estão chegando por ela. É esta bandeira,
    // e não o estado do RTCPeerConnection, que decide o que vai para a tela.
    viaRtc: false,
    prazoRtc: null,
    // Prévia da própria captura, e não algo que veio pela rede.
    local: false,
    // Vira true no primeiro quadro desenhado. Até lá o tile mostra "Conectando…"
    // em vez de uma caixa preta que não se distingue de um travamento.
    started: false,
    // Aproximação de quem assiste, não da transmissão: cada pessoa amplia o
    // canto que quiser sem mexer no que os outros veem.
    zoom: { z: 1, tx: 0, ty: 0 },
    player: null,
    // Só nasce quando a transmissão anuncia que tem som — nem toda tem.
    audio: null,
    // Janela flutuante desta tela, quando alguém a abriu.
    flutuante: null,
  };

  s.ann = criarCamada(overlay, { vista: () => vistaDe(slot) });
  s.ann.mostrar(!esconderTracos);

  // A caixa muda de tamanho ao arrastar o divisor, ao entrar em tela cheia e ao
  // redimensionar a janela — e nenhum desses caminhos passa por renderGrid.
  s.observer = new ResizeObserver(() => {
    limitarPan(s);
    aplicarZoom(slot);
  });
  s.observer.observe(surface);

  return s;
}

/**
 * A própria tela, para quem está transmitindo.
 *
 * Quem compartilha era o único que não via o que desenhavam na tela dele. Dava
 * para pedir "assistir a própria transmissão", mas isso é codificar, subir,
 * baixar e decodificar uma imagem que já está aqui — banda e meio segundo de
 * atraso para ver um traço por cima do que já está na tela.
 *
 * O <video> pendura a captura direto na origem: sem rede, sem atraso, e a
 * camada de anotação por cima é a mesma que todo mundo está vendo.
 */
function abrirPreviaLocal(slot) {
  closeStream(slot);

  const canvas = document.createElement('canvas');
  const video = document.createElement('video');
  // Mudo por construção: é o som desta máquina saindo dela de novo, e o eco
  // apareceria antes mesmo de alguém entrar na sala.
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  const s = montarSuperficie(slot, session?.user?.id, canvas, video);
  s.local = true;
  video.srcObject = meuStream;
  video.play().catch(() => {});
  mostrarMidia(s);

  // O tamanho da captura só se conhece depois dos metadados, e muda sozinho
  // quando a janela capturada é redimensionada — as duas coisas mudam a forma
  // do palco e a conta que posiciona os traços.
  video.addEventListener('loadedmetadata', () => {
    s.started = true;
    renderGrid();
  });
  video.addEventListener('resize', () => {
    limitarPan(s);
    aplicarZoom(slot);
    renderGrid();
  });

  streams.set(slot, s);
  ligarInteracao(slot, s);
}

/** Liga o som desta transmissão. Chamado quando a config de áudio chega. */
function startAudio(slot, config) {
  const s = streams.get(slot);
  if (!s) return;

  s.audio?.stop();
  s.audio = createAudio({ onError: (m) => toast(m, true), volume: volumeEfetivo(s.userId) });
  if (!s.audio.start(config)) {
    s.audio = null;
    return;
  }
  renderBar();
}

function startStream(slot, config) {
  const s = streams.get(slot);
  if (!s) return;
  // A conexão direta está entregando: montar o decodificador do relay agora
  // gastaria memória de GPU para desenhar num canvas que ninguém está vendo.
  if (s.viaRtc) return;

  // O servidor reenvia a config a cada pedido de assistir, e o transmissor a
  // reenvia sempre que a resolução muda. Reconfigurar o decoder com a mesma
  // config custa um keyframe e um piscar de tela à toa.
  const chave = JSON.stringify(config);
  if (s.configKey === chave) return;

  if (!s.player?.start(config)) return;
  s.configKey = chave;
  renderGrid();
  renderBar();
  ensureStatsTimer();
}

function closeStream(slot) {
  const s = streams.get(slot);
  if (!s) return;
  s.player?.stop();
  s.audio?.stop();
  fecharPeer(s);
  s.flutuante?.parar();
  s.ann.parar();
  s.observer.disconnect();
  // Sem soltar a origem, o <video> segura a captura viva depois do tile sumir.
  if (s.local) s.video.srcObject = null;
  s.surface.remove();
  streams.delete(slot);
  // Quem estava no palco saiu: renderGrid escolhe a próxima na próxima passada.
  if (activeSlot === slot) activeSlot = null;
}

function endStream(slot) {
  if (!streams.has(slot)) return;
  closeStream(slot);

  if (streams.size === 0) {
    clearInterval(lagTimer);
    lagTimer = null;
    for (const id of ['pLag', 'pFps', 'pRes']) $(id).textContent = '—';
  }

  renderGrid();
  renderBar();
}

function closeAllStreams() {
  for (const slot of [...streams.keys()]) closeStream(slot);
  clearInterval(lagTimer);
  lagTimer = null;
}

/**
 * O painel mostra os números de um stream por vez: o ampliado, ou o primeiro.
 * Somar latências de fontes diferentes não significaria nada.
 */
// -------------------------------------------------------------- WebRTC

/**
 * A oferta chegou: monta a resposta e espera os quadros.
 *
 * Quem assiste nunca oferece, só responde — a mídia está do outro lado, e é
 * quem tem a mídia que sabe descrevê-la. Enquanto esta negociação acontece, o
 * relay segue entregando normalmente: a troca só acontece no primeiro quadro
 * que chegar de fato pela conexão direta, e não um instante antes.
 */
async function receberOferta(slot, sdp) {
  const s = streams.get(slot);
  if (!s || !suportaWebRTC()) return;

  // Oferta nova para um slot que já tinha conexão significa que o outro lado
  // recomeçou; a antiga não vai voltar a entregar nada.
  fecharPeer(s);

  try {
    const ice = await iceServers(P);
    // Deu tempo de a transmissão acabar enquanto a lista vinha.
    if (streams.get(slot) !== s) return;

    const pc = criarPeer({
      ice,
      onIce: (candidate) => enviarRtc(slot, { kind: 'ice', candidate }),
      onEstado: (estado) => {
        if (MORTO.has(estado)) desistirDoRtc(slot);
      },
      onTrack: (e) => {
        const [remoto] = e.streams;
        if (!remoto || s.video.srcObject === remoto) return;
        s.video.srcObject = remoto;
        s.video.play().catch(() => {});
      },
    });
    s.pc = pc;

    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    enviarRtc(slot, { kind: 'answer', sdp: pc.localDescription });

    // O sinal de que deu certo é quadro na tela, não estado de conexão: um peer
    // "connected" que não entrega nada é indistinguível de um travamento, e é
    // exatamente o que este caminho existe para evitar.
    s.video.addEventListener('loadeddata', () => assumirRtc(slot), { once: true });

    clearTimeout(s.prazoRtc);
    s.prazoRtc = setTimeout(() => {
      if (!s.viaRtc) desistirDoRtc(slot);
    }, PRAZO_CONEXAO_MS);
  } catch (err) {
    console.warn('[rtc] resposta falhou:', err.message);
    desistirDoRtc(slot);
  }
}

async function receberIce(slot, candidate) {
  const pc = streams.get(slot)?.pc;
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    // Candidato fora de ordem é rotina e se recupera sozinho no próximo.
    console.warn('[rtc]', err.message);
  }
}

/** A conexão direta entregou o primeiro quadro: ela assume, e o relay sai. */
function assumirRtc(slot) {
  const s = streams.get(slot);
  if (!s || s.viaRtc) return;

  s.viaRtc = true;
  clearTimeout(s.prazoRtc);
  s.prazoRtc = null;

  // O som passa a sair do <video>; manter o decodificador de áudio tocando
  // junto daria eco com meio segundo de diferença entre os dois caminhos.
  s.audio?.stop();
  s.audio = null;
  s.video.muted = false;
  // Tirar do mudo pode fazer a política de autoplay pausar o vídeo; pedir o
  // play de volta é barato e é o que evita a tela congelar no primeiro quadro.
  s.video.play().catch(() => {});
  mostrarMidia(s);
  s.started = true;

  aplicarVolume(slot);
  ws?.send(JSON.stringify({ type: 'rtc-ativo', slot, on: true }));
  renderGrid();
  renderBar();
}

/**
 * Desiste da conexão direta e volta para o relay.
 *
 * Vale tanto para a que nunca fechou quanto para a que caiu no meio. Nos dois
 * casos o relay é o destino, e ele nunca precisou ser religado do lado de cá:
 * basta o servidor voltar a mandar os bytes, e é isso que o aviso faz.
 */
function desistirDoRtc(slot) {
  const s = streams.get(slot);
  if (!s) return;

  const estava = s.viaRtc;
  fecharPeer(s);

  if (estava) {
    // O decodificador está frio desde que o relay parou; o servidor manda um
    // keyframe junto com a religada, e é ele que traz a imagem de volta.
    s.started = false;
    const config = available.get(slot)?.config;
    if (config) s.player.start(config);
    renderGrid();
    renderBar();
  }

  if (watching.has(slot)) ws?.send(JSON.stringify({ type: 'rtc-ativo', slot, on: false }));
}

function fecharPeer(s) {
  clearTimeout(s.prazoRtc);
  s.prazoRtc = null;
  s.viaRtc = false;
  s.video.srcObject = null;
  s.video.muted = true;
  mostrarMidia(s);
  if (!s.pc) return;
  try {
    s.pc.close();
  } catch {
    // Fechar o que já se fechou lança, e não há nada a desfazer.
  }
  s.pc = null;
}

function enviarRtc(slot, payload) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'rtc', slot, payload }));
}

/**
 * Quadros por segundo do elemento de vídeo desde a última leitura.
 *
 * `getVideoPlaybackQuality` é o único jeito de contar quadros de um <video> sem
 * pendurar um callback por quadro — que custaria mais do que o diagnóstico vale.
 */
function quadrosDoVideo(s) {
  const q = s.video.getVideoPlaybackQuality?.();
  if (!q) return '—';
  const total = q.totalVideoFrames;
  const n = total - (s.quadrosAntes ?? total);
  s.quadrosAntes = total;
  // Quadro descartado pelo navegador é exatamente a micro-travada que se vê.
  const perdidos = q.droppedVideoFrames - (s.perdidosAntes ?? q.droppedVideoFrames);
  s.perdidosAntes = q.droppedVideoFrames;
  return perdidos > 0 ? `${n} fps · ${perdidos} perdidos` : `${n} fps`;
}

function ensureStatsTimer() {
  if (lagTimer) return;
  lagTimer = setInterval(() => {
    // Prévia local não tem número nenhum a mostrar: a imagem não veio pela
    // rede, então latência, quadros recebidos e resolução decodificada não
    // existem para ela.
    const s = [streams.get(activeSlot), ...streams.values()].find((x) => x?.player);
    if (!s) return;

    // Pela conexão direta quem conta os quadros é o próprio elemento de vídeo,
    // e o atraso vem do ida-e-volta medido pelo ICE. O carimbo de tempo do
    // relay não existe nesse caminho — e o do player ficaria congelado na
    // última medição, o que é pior que não mostrar nada.
    if (s.viaRtc) {
      const m = medidaDe(s);
      $('pVia').textContent = 'WebRTC (direto)';
      $('pRes').textContent = m.w ? `${m.w}×${m.h}` : '—';
      $('pFps').textContent = quadrosDoVideo(s);
      $('pJitter').textContent = 'do WebRTC';
      resumoPeer(s.pc).then(({ rtt, relay }) => {
        if (!s.viaRtc) return;
        $('pLag').textContent = rtt === null ? '—' : `${rtt} ms${relay ? ' · TURN' : ''}`;
      });
    } else {
      $('pVia').textContent = s.pc ? 'relay (negociando direto…)' : 'relay (WebSocket)';
      $('pLag').textContent = `${Math.max(0, s.player.getLag())} ms`;
      $('pFps').textContent = `${s.player.takeFrameCount()} fps`;
      $('pRes').textContent = s.player.getSizes().video;
      // O número que interessa quando a imagem anda aos saltos sem perder um
      // quadro sequer: o desencontro entre o ritmo em que os quadros foram
      // capturados e o ritmo em que eles chegaram.
      const j = s.player.getJitter();
      $('pJitter').textContent = j === null ? '—' : `${j} ms`;
    }

    // Quatro estados diferentes que, sem isto, parecem todos "sem som".
    if (s.viaRtc) {
      const temSom = (s.video.srcObject?.getAudioTracks?.().length ?? 0) > 0;
      if (!temSom) $('pSom').textContent = 'a transmissão não tem áudio';
      else if (volume === 0) $('pSom').textContent = 'silenciado aqui';
      else $('pSom').textContent = `tocando · ${Math.round(volume * 100)}%`;
    } else if (!s.audio) $('pSom').textContent = 'a transmissão não tem áudio';
    else if (!s.audio.temSom()) $('pSom').textContent = 'aguardando o áudio…';
    else if (volume === 0) $('pSom').textContent = 'silenciado aqui';
    else $('pSom').textContent = `tocando · ${Math.round(volume * 100)}%`;
  }, 1000);
}

/**
 * Ctrl+Shift+D reabre o diagnóstico.
 *
 * O botão que abria este painel saiu da barra de propósito, mas o painel em si
 * continua sendo a única forma de saber por onde o vídeo está vindo e o quanto
 * ele está chegando irregular. Um atalho não ocupa espaço na tela e é o que
 * separa "está travando" de "está travando por causa disto".
 */
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey || e.code !== 'KeyD') return;
  e.preventDefault();
  const painel = $('panel');
  painel.hidden = !painel.hidden;
  if (!painel.hidden) ensureStatsTimer();
});

// ------------------------------------------------------------------- arranque

/**
 * O vigia do arranque, guardado aqui fora e não dentro de `boot`.
 *
 * Ele nascia local, e só o caminho de sucesso o desarmava. Toda falha de
 * arranque então acontecia duas vezes na tela: primeiro o motivo de verdade
 * ("O Discord recusou o login: …"), e oito segundos depois o palpite do vigia
 * apagando aquilo e escrevendo "Sem resposta do servidor. Ele está no ar?".
 *
 * O segundo texto é o que ficava, porque depois dele não roda mais nada — e
 * era ele que fazia qualquer tropeço na entrada parecer um aplicativo
 * desligado, escondendo justamente a informação que resolveria o problema.
 */
let vigiaArranque = null;
let arrancando = false;

const desarmarVigia = () => {
  clearTimeout(vigiaArranque);
  vigiaArranque = null;
};

/**
 * O arranque, com direito a segunda tentativa.
 *
 * Recarregar a página não serve dentro do Discord: o iframe pede a página de
 * novo à hospedagem, e basta um X-Frame-Options no caminho para ele virar o
 * retângulo branco. Então quem tenta de novo é o próprio arranque, no lugar.
 */
async function tentarArranque() {
  if (arrancando) return;
  arrancando = true;
  $('emptyRetry').hidden = true;

  try {
    await boot();
  } catch (err) {
    console.error(err);
    // Antes de escrever o motivo, e não depois: com o vigia ainda armado o
    // texto abaixo teria oito segundos de vida.
    desarmarVigia();
    setEmpty('Não foi possível entrar', err.message);
    $('empty').hidden = false;
    $('emptyRetry').hidden = false;
  } finally {
    arrancando = false;
  }
}

$('emptyRetry').addEventListener('click', () => {
  setEmpty('Conectando…', 'Tentando de novo');
  tentarArranque();
});

tentarArranque();

async function boot() {
  // O painel inicial é estático. Sem este vigia, qualquer espera que não
  // termine fica com a cara de "Conectando…" para sempre, sem dizer o que
  // está faltando — que foi exatamente como este arranque ja travou.
  //
  // O botão vai junto: dizer "está demorando" e não oferecer nada para fazer
  // deixa quem está dentro do Discord sem saída nenhuma.
  desarmarVigia();
  vigiaArranque = setTimeout(() => {
    setEmpty('Está demorando…', 'Sem resposta do servidor. Ele está no ar?');
    $('emptyRetry').hidden = false;
  }, 8000);

  // Buscada em paralelo, nunca antes: ela traz o diagnóstico de versão e o
  // client id de reserva, e nenhum dos dois vale segurar o login.
  const config = loadConfig();

  // Sem login o lobby ainda abre: dá para ver as salas antes de entrar. Só
  // criar e entrar é que pedem identidade.
  session = inDiscord ? await authDiscord(config) : await authWeb();

  clientId = params.get('client_id') || (await config).clientId || null;
  checkVersion((await config).asset);
  desarmarVigia();
  $('emptyRetry').hidden = true;

  renderProfileButton();

  // Dentro do Discord não existe lobby: a atividade já É a sala daquela call, e
  // oferecer uma lista de salas ali seria oferecer uma escolha entre uma opção.
  // No site é o contrário — não há call nenhuma para herdar, então a lista de
  // salas é a única forma de as pessoas se encontrarem.
  if (inDiscord) return entrarNaCall();

  // Lido antes de showLobby, que limpa o parâmetro da URL ao voltar ao lobby.
  const alvo = new URLSearchParams(location.search).get('sala');
  // Do ?t= não: ele é lido do params do arranque, capturado antes de tudo.
  const ingresso = params.get('t');

  await showLobby();
  if (ingresso) return abrirPeloIngresso(ingresso);
  if (session && alvo) await joinById(alvo);
}

/**
 * Entra direto na sala de um link recebido da atividade.
 *
 * Não passa pelo lobby nem pela senha: a sala da call não aparece na lista e
 * recusaria o join de fora do canal de voz. O ingresso é a prova de que essa
 * porta já se abriu, e o servidor reemite os tokens a partir dele.
 */
async function abrirPeloIngresso(ingresso) {
  setEmpty('Entrando…', 'Sala da call');

  // Guardado antes de conectar: o primeiro render pode chegar antes daqui de
  // baixo terminar, e sem a intenção pronta ele escolheria outra tela.
  // O ingresso, sozinho, já diz o que a pessoa veio fazer: assistir. O slot
  // refina qual tela, e a tela cheia é o padrão de quem veio da atividade —
  // links antigos, sem esses dois, continuam valendo.
  const pedido = params.get('slot');
  const numero = Number(pedido);
  chegada = {
    slot: pedido !== null && Number.isInteger(numero) ? numero : null,
    cheia: params.get('cheia') !== '0',
  };
  console.info('[sala] chegou pelo link da atividade', chegada);

  try {
    const { name, ...tokens } = await post(`${P}/api/rooms/open`, { token: ingresso });
    openRoom(tokens, { id: tokens.roomId, name });

    // openRoom já trocou a URL para ?sala=<id>; o ingresso sai junto, para não
    // ficar no histórico nem em link copiado da barra de endereço.
    const url = new URL(location.href);
    for (const chave of ['t', 'slot', 'cheia']) url.searchParams.delete(chave);
    history.replaceState(null, '', url);
  } catch (err) {
    setEmpty('Não foi possível abrir', err.message);
    $('emptyRetry').hidden = false;
  }
}

/** Abre a sala desta call, criando-a na primeira pessoa que chega. */
async function entrarNaCall() {
  setEmpty('Entrando…', 'Sala desta call');
  try {
    // A sessão costuma trazer a sala junto — ver a nota no /api/session. A ida
    // ao /api/rooms/call fica para quem chegou aqui sem ela: identidade
    // reaproveitada de uma visita anterior, ou servidor mais antigo.
    const tokens =
      session?.sala ?? (await post(`${P}/api/rooms/call`, { identity: session.identity }));
    openRoom(tokens, { id: tokens.roomId, name: 'Sala da call' });
  } catch (err) {
    // O botão é a única saída dentro do Discord: sem ele, um tropeço aqui —
    // e o /api/session fala com o Discord, então tropeça — deixa a atividade
    // parada com cara de desligada até alguém fechá-la e abrir de novo.
    setEmpty('Não foi possível entrar', err.message);
    $('emptyRetry').hidden = false;
  }
}

// ---------------------------------------------------------------- login web

$('loginBtn').addEventListener('click', () => {
  // Sobe de convidado para conta do Discord: a identidade nova substitui a
  // antiga, então as salas criadas como convidado ficam sem dono.
  remove('identity');
  location.href = '/auth/login';
});

/**
 * Identidade fora do Discord.
 *
 * O callback do OAuth devolve o token no fragmento da URL — que não é enviado
 * ao servidor nem entra em log de proxy. Lemos, guardamos e limpamos a barra
 * de endereço para o token não ficar visível nem no histórico.
 */
async function authWeb() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const fromLogin = fragment.get('identity');

  if (fromLogin) {
    store('identity', fromLogin);
    history.replaceState(null, '', location.pathname + location.search);
  }

  let identity = fromLogin ?? read('identity');

  // Sem identidade nenhuma: entra como convidado. O login do Discord é uma
  // melhoria opcional, não um pedágio para assistir uma tela.
  if (!identity) {
    const guest = await post('/api/session-guest', { name: storedName() }, { retry: false });
    store('identity', guest.identity);
    identity = guest.identity;
  }

  const payload = decodeIdentity(identity);
  if (!payload) {
    remove('identity');
    return null;
  }

  return {
    identity,
    isGuest: String(payload.uid).startsWith('guest-'),
    call: payload.call ?? null,
    user: { id: payload.uid, name: payload.name, avatar: payload.av ?? null },
  };
}

function decodeIdentity(token) {
  try {
    const p = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    // O servidor revalida a assinatura; aqui só descartamos o que já venceu,
    // para não tentar usar um token morto e cair num erro sem explicação.
    if (p.exp && p.exp * 1000 < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

// O armazenamento pode estar bloqueado num iframe de terceiro, então todo
// acesso é protegido — perder a sessão é melhor do que a página não abrir.
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sessão só em memória */
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nada a limpar */
  }
}

// -------------------------------------------------------------------- lobby

/** Tokens da sala atual. null = estamos no lobby. */
let roomTokens = null;
let roomInfo = null;
let joinTarget = null;
let lastRoomState = null;
let lobbyRooms = [];

function inRoom() {
  return roomTokens !== null;
}

// A lista precisa se atualizar sozinha: salas abrem, enchem e fecham enquanto
// alguém olha o lobby parado.
const LOBBY_REFRESH_MS = 4000;
let lobbyTimer = null;

/**
 * Larga a sala atual por completo.
 *
 * Funil único: sair pelo botão, a sala fechar sozinha e o arranque precisam
 * deixar exatamente o mesmo estado para trás. Parar a transmissão vem primeiro
 * porque a captura da aba externa só para se o servidor avisar, e depois do
 * close() não sobra por onde avisar.
 */
function limparSala() {
  stopMyBroadcast();

  closeAllStreams();
  available.clear();
  watching.clear();
  dispensados.clear();
  participants = [];
  lastRoomState = null;
  activeSlot = null;
  telaCheia = false;

  if (roomInfo) remove(`sala:${roomInfo.id}`);
  roomTokens = null;
  roomInfo = null;
  setRoomUrl(null);

  ws?.close();
  ws = null;
}

async function showLobby() {
  limparSala();

  $('lobby').hidden = false;
  $('grid').hidden = true;
  $('empty').hidden = true;
  $('roomPill').hidden = true;
  $('leaveRoom').hidden = true;
  $('roomSettings').hidden = true;
  $('share').hidden = true;
  $('camera').hidden = true;

  // O dock inteiro sai de cena: todo controle dele é de dentro da sala, e o
  // cabeçalho do lobby já traz perfil e criar sala.
  $('fullscreen').hidden = true;
  $('panel').hidden = true;

  // O login só aparece para convidado: quem já entrou pelo Discord não tem o
  // que melhorar.
  $('loginBtn').hidden = inDiscord || !session?.isGuest;
  $('people').hidden = true;

  await loadRooms();

  clearInterval(lobbyTimer);
  lobbyTimer = setInterval(() => {
    // Nenhum modal aberto: recarregar sob o cursor tiraria o card do lugar no
    // meio de um clique.
    const busy = ['createModal', 'joinModal'].some((id) => !$(id).hidden);
    if (!busy && !$('lobby').hidden) loadRooms();
  }, LOBBY_REFRESH_MS);
}

async function loadRooms() {
  const list = $('roomList');

  let rooms;
  try {
    rooms = (await post(`${P}/api/rooms/list`, { identity: session?.identity })).rooms ?? [];
  } catch (err) {
    list.replaceChildren(msgRow(`Não foi possível carregar: ${err.message}`));
    return;
  }

  lobbyRooms = rooms;

  const cards = rooms.map(roomCard);

  if (!cards.length) {
    list.replaceChildren(msgRow('Nenhuma sala aberta. Crie a primeira.'));
    return;
  }

  list.replaceChildren(...cards);
}

function msgRow(text) {
  const el = document.createElement('div');
  el.className = 'lobby-empty';
  el.textContent = text;
  return el;
}

function roomCard(room) {
  const card = document.createElement('button');
  card.className = 'room-card';

  const top = document.createElement('div');
  top.className = 'room-card-top';

  if (room.locked) {
    top.insertAdjacentHTML(
      'afterbegin',
      '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/>' +
        '<path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    );
  }

  const name = document.createElement('span');
  name.className = 'room-card-name';
  // textContent: nome de sala é escrito por outra pessoa.
  name.textContent = room.name;
  top.append(name);

  const meta = document.createElement('span');
  meta.className = 'room-card-meta';
  const pessoas = room.people === 1 ? '1 pessoa' : `${room.people} pessoas`;
  meta.textContent = `${pessoas} · por ${room.owner}`;

  card.append(top, meta);

  if (room.streams > 0) {
    const live = document.createElement('span');
    live.className = 'room-card-meta room-live';
    live.textContent = room.streams === 1 ? '1 tela no ar' : `${room.streams} telas no ar`;
    card.append(live);
  }

  card.addEventListener('click', () => enterRoom(room));
  return card;
}

async function enterRoom(room, password) {
  if (!session) return;

  try {
    const tokens = await post(`${P}/api/rooms/join`, {
      identity: session.identity,
      roomId: room.id,
      password: password ?? '',
    });
    openRoom(tokens, room);
  } catch (err) {
    // 403 numa sala trancada é o caminho normal: pedir a senha.
    if (err.status === 403 && !password) return askPassword(room);
    if (err.status === 403) return askPassword(room, 'Senha incorreta.');
    if (err.status === 429) return askPassword(room, err.detail);
    if (err.status === 404) {
      toast('Essa sala já fechou.', true);
      remove(`sala:${room.id}`);
      setRoomUrl(null);
      loadRooms();
      return;
    }
    toast(err.message, true);
  }
}

function askPassword(room, error) {
  joinTarget = room;
  $('joinSub').textContent = `"${room.name}" pede uma senha para entrar.`;
  $('joinError').textContent = error ?? '';
  $('joinError').hidden = !error;
  if (!error) $('joinPass').value = '';
  $('joinModal').hidden = false;
  $('joinPass').focus();
}

/**
 * Entra na sala apontada pela URL.
 *
 * Serve para os dois casos: recarregar a página estando numa sala, e abrir um
 * link `?sala=<id>` que alguém mandou.
 */
async function joinById(id) {
  // Token guardado de uma visita anterior: entra sem pedir a senha de novo.
  const saved = read(`sala:${id}`);
  if (saved) {
    try {
      const { tokens, name } = JSON.parse(saved);
      openRoom(tokens, { id, name });
      return;
    } catch {
      remove(`sala:${id}`);
    }
  }

  // Link recebido de fora: usa o fluxo normal, que pede a senha quando precisa.
  // O nome vem da lista já carregada; salas com senha também aparecem nela.
  const known = lobbyRooms.find((r) => r.id === id);
  await enterRoom(known ?? { id, name: 'Sala' });
}

/** Mantém `?sala=` na barra de endereço, preservando os parâmetros do Discord. */
function setRoomUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('sala', id);
  else url.searchParams.delete('sala');
  history.replaceState(null, '', url);
}

function openRoom(tokens, room) {
  roomTokens = tokens;
  roomInfo = room;

  setRoomUrl(room.id);
  store(`sala:${room.id}`, JSON.stringify({ tokens, name: room.name }));

  $('lobby').hidden = true;
  $('empty').hidden = false;
  // A entrada deu certo: o convite a tentar de novo não tem mais o que tentar.
  $('emptyRetry').hidden = true;
  $('share').hidden = false;
  $('camera').hidden = false;
  $('people').hidden = false;
  $('loginBtn').hidden = true;

  // Dentro do Discord não há lista para onde voltar nem outra sala com que
  // confundir esta: quem fecha a atividade é o próprio Discord.
  $('roomPill').hidden = inDiscord;
  $('leaveRoom').hidden = inDiscord;

  clearInterval(lobbyTimer);
  lobbyTimer = null;
  $('roomPill').textContent = room.name;

  setEmpty('Entrando…', room.name);
  connect();
}

// A limpeza toda — inclusive parar de transmitir — vive em showLobby.
$('leaveRoom').addEventListener('click', () => showLobby());

/** Client id e versão do bundle, decididos pelo servidor. */
async function loadConfig() {
  try {
    const r = await fetch(`${P}/api/config`, {
      cache: 'no-store',
      // fetch não expira sozinho. Sem prazo, um pedido que trava segura tudo o
      // que vem depois — e nada aqui vale prender o arranque.
      signal: AbortSignal.timeout(6000),
    });
    return await r.json();
  } catch {
    // Nem o id nem o diagnóstico podem impedir a sala de abrir.
    return {};
  }
}

/**
 * Detecta bundle velho e recarrega.
 *
 * O index.html vai com no-store, mas o cliente do Discord pode entregar uma
 * cópia antiga assim mesmo — e o iframe fica preso num build anterior sem
 * nenhum sinal visível, o que já custou horas de diagnóstico enganoso.
 *
 * Comparamos o nome do próprio arquivo (que leva hash de conteúdo) com o que o
 * servidor diz ser o atual.
 */
function checkVersion(asset) {
  const mine = import.meta.url.split('/').pop().split('?')[0];

  // Em desenvolvimento o Vite serve `main.js` sem hash nenhum, enquanto o
  // servidor relata o nome do último build. Comparar os dois acusa uma
  // desatualização que não existe e joga a página num recarregamento eterno.
  //
  // A pergunta "isto é um build?" é respondida pelo próprio nome do arquivo, e
  // não por `import.meta.env.DEV`. O DEV depende de NODE_ENV, que este projeto
  // define como "development" no .env — e o Vite lê esse arquivo. Resultado: no
  // build de produção o DEV vinha true, e a função inteira era removida por
  // codigo morto. Ela existia sem nunca rodar.
  if (!/^index-[A-Za-z0-9_-]+.js$/.test(mine)) return;

  if (!asset || asset === mine) return;

  // Dentro do Discord a página não se recarrega: o iframe pede a página de novo
  // à hospedagem, e basta ela devolver X-Frame-Options para o navegador se
  // recusar a desenhar — vira o retângulo branco. Fechar e reabrir a atividade
  // faz o Discord montar o iframe do jeito certo, e é o que se pede aqui.
  //
  // O aviso continua: detectar a versão velha é o motivo desta função existir,
  // e é dentro do Discord que ela mais serve, porque o cliente serve bundle
  // antigo sem nenhum sinal visível.
  if (inDiscord) {
    toast('Esta atividade está numa versão antiga. Feche e abra de novo para atualizar.', true);
    return;
  }

  // Se recarregar não resolveu, o HTML servido também está velho: avisa em
  // vez de entrar em laço de reload.
  if (sessionStorage.getItem('reloadedFor') === asset) {
    toast('Versão desatualizada e o cache não cede. Recarregue a página.', true);
    return;
  }
  sessionStorage.setItem('reloadedFor', asset);
  location.reload();
}

/**
 * @param {Promise<{clientId?:string}>|string} fonteDoId promessa da config, ou
 * o id direto quando já se sabe qual é (o caminho da renovação de sessão).
 */
async function authDiscord(fonteDoId) {
  // O Discord injeta client_id na URL do iframe. Preferir essa via tira o login
  // da dependência de uma ida ao servidor: quando ela demorava, a atividade
  // ficava parada sem nada para mostrar. A config entra só como reserva.
  const id =
    params.get('client_id') ||
    (typeof fonteDoId === 'string' ? fonteDoId : (await fonteDoId)?.clientId);

  if (!id) {
    throw new Error('O servidor está sem as credenciais do Discord. Rode: npm run configurar');
  }

  const clientId = id;
  // Reaproveitado quando já existe: o arranque pode rodar de novo pelo botão
  // de tentar outra vez, e um segundo DiscordSDK sobre o mesmo iframe disputa
  // o canal de mensagens com o primeiro. `ready()` é idempotente.
  sdk = sdk ?? new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    // Só precisamos de /users/@me. Menos escopo, menos atrito no consentimento.
    scope: ['identify'],
  });

  const { access_token } = await post(`${P}/api/token`, { code, client_id: clientId });

  // Em paralelo, e não em fila: o authenticate avisa o cliente do Discord, o
  // /api/session consulta o Discord pelo nosso servidor, e nenhum dos dois
  // depende do resultado do outro. Em série eram duas esperas somadas.
  //
  // guild/channel vão junto para o servidor poder confirmar, pelo Discord, que
  // a pessoa está mesmo naquela call.
  const [, sessao] = await Promise.all([
    sdk.commands.authenticate({ access_token }),
    post(`${P}/api/session`, {
      access_token,
      instance_id: sdk.instanceId,
      guild_id: sdk.guildId,
      channel_id: sdk.channelId,
    }),
  ]);

  return sessao;
}

/**
 * Emite uma identidade nova, jogando fora a que o servidor recusou.
 *
 * O crachá vive no localStorage e vale até o servidor trocar o segredo que o
 * assina. Quando isso acontece — reinstalação, mudança de máquina, rotação de
 * segredo —, todo crachá guardado vira inválido de uma vez. Sem isto o cliente
 * insistia no mesmo token para sempre e a pessoa ficava presa em "sessão
 * inválida", sem nada na interface que resolvesse.
 */
async function renovarIdentidade() {
  remove('identity');
  try {
    session = inDiscord ? await authDiscord(clientId) : await authWeb();
    renderProfileButton();
    return session?.identity ?? null;
  } catch {
    return null;
  }
}

/**
 * `retry` existe para a chamada que renova a identidade não cair nela mesma:
 * um 401 ali significa que renovar não resolve, e insistir viraria laço.
 */
async function post(url, body, { retry = true } = {}) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Um pedido pendurado é pior que um pedido que falha: o que falha diz
      // alguma coisa, o pendurado só deixa a tela parada.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg =
      err.name === 'TimeoutError'
        ? 'O servidor não respondeu a tempo.'
        : 'Não foi possível falar com o servidor.';
    throw Object.assign(new Error(msg), { status: 0 });
  }

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    // 401 numa chamada que levava identidade quer dizer crachá morto, não falta
    // de permissão: renova uma vez e repete, em vez de devolver um erro que a
    // pessoa não tem como resolver.
    if (r.status === 401 && retry && body?.identity) {
      const nova = await renovarIdentidade();
      if (nova) return post(url, { ...body, identity: nova }, { retry: false });
    }

    // O status carrega significado (403 = senha, 429 = bloqueio, 404 = sala
    // fechou), então vai junto do erro em vez de virar texto.
    const err = new Error(data.error ?? `Servidor respondeu ${r.status}.`);
    err.status = r.status;
    err.detail = data.error;
    throw err;
  }
  return data;
}

// ----------------------------------------------------------------- websocket

function connect() {
  if (!roomTokens) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(
    `${proto}://${location.host}${P}/ws?t=${encodeURIComponent(roomTokens.viewerToken)}`,
  );
  ws.binaryType = 'arraybuffer';

  let abriu = false;

  ws.addEventListener('open', () => {
    abriu = true;
    reconnectDelay = 1000;
    $('grid').hidden = false;
    setEmpty('Ninguém na sala', 'Aguardando participantes.');

    // O apelido é do cliente, então precisa ser reenviado a cada conexão —
    // inclusive nas reconexões, senão o nome volta ao do Discord sozinho.
    const saved = storedName();
    if (saved && saved !== session.user.name) {
      session.user.name = saved;
      ws.send(JSON.stringify({ type: 'rename', name: saved }));
    }
  });

  ws.addEventListener('message', (e) => {
    // Primeiro byte é o slot, segundo é o tipo: um diz de quem, o outro diz
    // para qual decodificador — som e imagem dividem o mesmo canal.
    if (typeof e.data !== 'string') {
      const view = new DataView(e.data);
      const s = streams.get(view.getUint8(0));
      if (!s) return;
      if (view.getUint8(1) === 3) s.audio?.push(e.data);
      // A prévia local não tem decodificador: ela é a captura, não algo que
      // veio pela rede. Byte que chegue para o slot dela não tem para onde ir.
      else s.player?.push(e.data);
      return;
    }

    const msg = JSON.parse(e.data);

    // Sinalização da conexão direta, repassada por quem transmite.
    if (msg.type === 'rtc' && Number.isInteger(msg.slot)) {
      if (msg.payload?.kind === 'offer') receberOferta(msg.slot, msg.payload.sdp);
      else if (msg.payload?.kind === 'ice') receberIce(msg.slot, msg.payload.candidate);
      return;
    }

    if (msg.type === 'state') {
      participants = msg.participants ?? [];
      abas.clear();
      for (const uid of msg.abas ?? []) abas.add(uid);

      lastRoomState = msg.room ?? null;

      // A senha da sala só aparece para quem a criou.
      $('roomPill').textContent =
        `${lastRoomState?.locked ? '🔒 ' : ''}${lastRoomState?.name ?? ''}`;
      $('roomSettings').hidden = lastRoomState?.ownerId !== session?.user?.id;
      $('roomSettings').classList.toggle('on', Boolean(lastRoomState?.locked));

      // Limpa o que sumiu sem stream-stop (queda abrupta, por exemplo).
      const live = new Set((msg.streams ?? []).map((s) => s.slot));
      for (const s of msg.streams ?? []) {
        const info = available.get(s.slot) ?? { userId: s.userId, config: null };
        info.watchers = s.watchers ?? [];
        // Servidor antigo não manda fonte; tela é o que sempre houve.
        info.fonte = s.fonte ?? 'tela';
        available.set(s.slot, info);
      }
      for (const slot of [...available.keys()]) {
        if (live.has(slot)) continue;
        available.delete(slot);
        dispensados.delete(slot);
      }
      for (const slot of [...streams.keys()]) if (!live.has(slot)) closeStream(slot);
      for (const slot of [...watching]) if (!live.has(slot)) watching.delete(slot);
      renderGrid();
      renderBar();
    } else if (msg.type === 'stream-start') {
      // Só anuncia; ninguém assiste até pedir.
      available.set(msg.slot, { userId: msg.userId, fonte: msg.fonte ?? 'tela', config: null });
      watching.delete(msg.slot);
      // Transmissão nova no mesmo slot é outra transmissão: quem dispensou a
      // anterior não dispensou esta.
      dispensados.delete(msg.slot);
      closeStream(msg.slot);
      // A transmissão que acabou de ser anunciada pode ser a minha, e é aqui
      // que o slot dela passa a existir.
      garantirPreviaLocal();
      renderGrid();
    } else if (msg.type === 'config') {
      const info = available.get(msg.slot);
      if (info) info.config = msg.config;
      if (watching.has(msg.slot)) {
        // Config nova no meio da transmissao e so troca de resolucao — a tela
        // compartilhada foi para tela cheia, por exemplo. Recriar o stream aqui
        // levava o audio junto (closeStream para o AudioContext e zera
        // s.audio), e o audio-config so e enviado uma vez por transmissao: o
        // som nunca voltava. startStream ja reconfigura o decoder de video
        // sozinho, entao o lugar so precisa existir na primeira vez.
        if (!streams.has(msg.slot)) openStream(msg.slot, info?.userId ?? msg.slot);
        startStream(msg.slot, msg.config);
      }
    } else if (msg.type === 'ann') {
      // O meu já foi desenhado no eco local; redesenhar a volta do servidor
      // duplicaria o traço no primeiro pacote reordenado.
      if (msg.uid !== session?.user?.id) anotarEm(msg.slot, msg);
    } else if (msg.type === 'ann-sync') {
      // Estado de quem chegou no meio: o que já está desenhado na tela.
      sincronizarAnn(msg.slot, msg.tracos);
    } else if (msg.type === 'audio-config') {
      // Pode chegar antes de eu pedir para assistir; aí não há o que ligar, e
      // o servidor reenvia assim que o pedido chegar.
      if (watching.has(msg.slot)) startAudio(msg.slot, msg.config);
    } else if (msg.type === 'stream-stop') {
      available.delete(msg.slot);
      watching.delete(msg.slot);
      dispensados.delete(msg.slot);
      endStream(msg.slot);
    } else if (msg.type === 'room-gone') {
      roomTokens = null;
      // No Discord a sala é a da call: ela é recriada e a atividade volta para
      // ela. No site, quem some é a sala escolhida, então o lugar é a lista.
      if (inDiscord) {
        limparSala();
        entrarNaCall();
      } else {
        toast('A sala foi fechada.', true);
        showLobby();
      }
    } else if (msg.type === 'error') {
      toast(msg.message, true);
    }
  });

  ws.addEventListener('close', () => {
    closeAllStreams();
    available.clear();
    watching.clear();
    dispensados.clear();
    participants = [];
    renderGrid();

    // Saímos da sala de propósito: nada a reconectar.
    if (!roomTokens) return;

    // Fechou sem nunca abrir: o token da sala foi recusado. Guardado, ele não
    // vale mais depois que o servidor troca o segredo — e reconectar com o
    // mesmo token repete o 401 até o fim dos tempos. Descartar e recomeçar é o
    // único caminho que sai daqui.
    if (!abriu) {
      const id = roomInfo?.id;
      limparSala();
      if (id) remove(`sala:${id}`);
      toast('Sua sessão expirou. Entrando de novo…');
      if (inDiscord) entrarNaCall();
      else showLobby();
      return;
    }

    setEmpty('Reconectando…', 'A conexão com a sala caiu.');
    // Backoff — evita martelar o servidor se ele estiver fora do ar.
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
  });

  ws.addEventListener('error', () => ws.close());
}

// --------------------------------------------------------------------- ações

/**
 * Estou transmitindo?
 *
 * myBroadcast entra no OU porque o `state` leva um instante para chegar, e sem
 * isso o botão pisca de volta para "Compartilhar" logo após começar.
 */
/** As fontes que eu estou transmitindo agora, segundo o servidor. */
function minhasFontes() {
  const meu = session?.user?.id;
  if (!meu) return new Set();
  return new Set(slotsOf(meu).map((slot) => available.get(slot)?.fonte ?? 'tela'));
}

/**
 * Existe uma aba de captura minha conectada?
 *
 * Quem responde é o servidor, pela lista `abas` do estado. Antes isto era
 * deduzido do que estava no ar, e errava justamente no caso que mais importa:
 * a aba recém-aberta, ainda sem transmitir, ficava invisível — e um novo clique
 * abria outra em cima dela.
 */
function abaAberta() {
  return abas.has(session?.user?.id);
}

/**
 * As opções da próxima transmissão, editadas pela engrenagem.
 *
 * Ficam no localStorage porque são preferência de quem transmite, não estado da
 * sala: quem escolheu 5 Mb/s uma vez não quer reescolher a cada abertura. E
 * ficam aqui, e não num modal que aparece antes de cada início, porque decidir
 * qualidade toda vez que se quer mostrar a tela é atrito no caminho curto.
 */
const AJUSTES_PADRAO = { bitrate: 2500000, fps: 30 };

let ajustes = (() => {
  try {
    return { ...AJUSTES_PADRAO, ...JSON.parse(read('ajustes') ?? '{}') };
  } catch {
    return { ...AJUSTES_PADRAO };
  }
})();

/**
 * As opções no formato que a página de captura lê da URL.
 *
 * O som não vem aqui: a tela sempre o pede e a câmera nunca, então quem decide
 * é a caixa "Compartilhar o áudio" do seletor do navegador — que já é uma
 * escolha. Repetir a pergunta aqui só criava um jeito de a captura ir muda sem
 * querer, e a câmera não leva o microfone porque a voz já anda pela call.
 */
function opcoesDaFonte() {
  return {
    q: String(ajustes.bitrate),
    fps: String(ajustes.fps),
  };
}

/**
 * Liga uma fonte pelo caminho mais curto que existir para ela.
 *
 * Com uma aba já aberta, o pedido vai por ela em vez de abrir outra: seriam
 * duas janelas para a pessoa manter vivas, e a que existe já faz as duas
 * coisas. A aba resolve o que dá — câmera ela liga sozinha, tela precisa do
 * clique lá, porque getDisplayMedia exige gesto do usuário.
 */
/** Nome da aba de captura, para reencontrá-la em vez de empilhar outra. */
const JANELA_CAPTURA = 'discord-screen-captura';

function ligarFonte(fonte) {
  if (abaAberta()) return trazerAba(fonte);
  abrirCaptura(fonte);
}

/**
 * A aba de captura já existe: leva a pessoa até ela.
 *
 * O pedido pelo WebSocket sozinho não resolvia. Ele chega, a aba atende — mas
 * em segundo plano, onde ninguém vê, e uma aba não consegue se trazer para a
 * frente. Avisar por toast que ela existe deixava a pessoa procurando entre as
 * janelas qual era.
 */
function trazerAba(fonte) {
  // Dentro do Discord a aba foi parar no navegador do sistema, que é outro
  // processo: daqui não há como focá-la. Abrir de novo é o que existe, e a
  // fonte vai na URL, então a aba nova já nasce no que se pediu. Se a antiga
  // continuar aberta, ficam duas — é o preço da fronteira entre os processos.
  if (inDiscord) return abrirLink(fonte);

  // Fora do Discord a aba é nossa, e o nome fixo a encontra. String vazia de
  // propósito: passar a URL faria o navegador *navegar* nela, e navegar é
  // recarregar — mataria a transmissão que estiver no ar ali dentro.
  const aba = window.open('', JANELA_CAPTURA);
  if (!aba) return abrirLink(fonte);

  // `window.open('')` num nome que não existe cria uma aba em branco em vez de
  // achar alguma. Aí ela precisa ser levada para o lugar certo.
  let emBranco = false;
  try {
    emBranco = aba.location.href === 'about:blank';
  } catch {
    /* já navegou para outra origem: é a aba de captura mesmo */
  }
  if (emBranco) {
    aba.location.href = urlDaCaptura(fonte).toString();
    aba.focus();
    return;
  }

  aba.focus();
  // A URL não mudou, então o pedido tem de ir por fora dela. As opções vão
  // junto: a aba pode estar aberta desde antes da última mexida na engrenagem.
  ws?.send(JSON.stringify({ type: 'start-broadcast', fonte, opcoes: opcoesDaFonte() }));
}

async function abrirCaptura(fonte) {
  if (!roomTokens) return;

  // Só a tela tem chance de nascer aqui dentro; o Discord anula o getUserMedia
  // no iframe, então a câmera vai direto para a aba.
  if (fonte === 'tela' && (await broadcastFromHere())) return;

  abrirLink(fonte);
}

/** O endereço da página de captura, já com as opções e a fonte pedida. */
function urlDaCaptura(fonte) {
  const url = new URL(roomTokens.shareUrl);
  for (const [chave, valor] of Object.entries(opcoesDaFonte())) {
    url.searchParams.set(chave, valor);
  }
  url.searchParams.set('fonte', fonte);
  return url;
}

async function abrirLink(fonte) {
  if (!roomTokens) return;
  const url = urlDaCaptura(fonte).toString();

  if (inDiscord) {
    try {
      const res = await sdk.commands.openExternalLink({ url });
      // Clientes antigos devolvem null; só tratamos false como recusa explícita.
      if (res?.opened === false) {
        toast('Você recusou abrir o link. Sem isso não dá para capturar a tela.', true);
      }
    } catch (err) {
      toast(`Não foi possível abrir o link: ${err.message}`, true);
    }
    return;
  }

  window.open(url, JANELA_CAPTURA);
}

/**
 * A origem pública do site, ou null quando o servidor não a conhece.
 *
 * Ela só chega ao cliente dentro do shareUrl. Sem PUBLIC_ORIGIN configurado o
 * servidor emite um caminho relativo, e aí não existe endereço externo a
 * oferecer: dentro do Discord, location.origin é o proxy da atividade, que não
 * abre por fora. Devolver null é o que faz o botão sumir em vez de levar a
 * pessoa a um link quebrado.
 */
function origemDoSite() {
  try {
    return new URL(roomTokens.shareUrl).origin;
  } catch {
    return null;
  }
}

/**
 * O endereço desta sala no site, com o ingresso de quem já está aqui.
 *
 * Leva junto a tela em que a pessoa estava: abrir o site na sala certa mas na
 * transmissão errada seria fazer ela procurar de novo o que já estava vendo.
 *
 * A tela cheia vai sempre, e não só quando já estava ligada aqui: sair da
 * atividade é o pedido por mais espaço, e é o que este botão existe para
 * atender.
 */
function urlDoSite(origem) {
  const url = new URL(origem);
  url.searchParams.set('t', roomTokens.viewerToken);
  if (activeSlot !== null) {
    url.searchParams.set('slot', String(activeSlot));
    url.searchParams.set('cheia', '1');
  }
  return url.toString();
}

async function abrirNoSite() {
  const origem = roomTokens && origemDoSite();
  if (!origem) return;
  const url = urlDoSite(origem);

  if (!inDiscord) {
    window.open(url, '_blank', 'noopener');
    return;
  }

  try {
    const res = await sdk.commands.openExternalLink({ url });
    // Clientes antigos devolvem null; só false é recusa explícita.
    if (res?.opened === false) toast('Você recusou abrir o link.', true);
  } catch (err) {
    toast(`Não foi possível abrir o link: ${err.message}`, true);
  }
}

$('watchSite').addEventListener('click', abrirNoSite);

/**
 * Encerra a minha transmissão, tenha ela nascido aqui ou na aba externa.
 *
 * Funil único de propósito: parar pelo botão, sair da sala e a sala fechar
 * precisam encerrar do mesmo jeito. Deixar a captura viva depois de sair é
 * vazamento de tela, não detalhe de interface — e a aba externa tem conexão
 * própria, então só o servidor consegue mandá-la parar.
 */
function stopMyBroadcast(fonte = null) {
  // O myBroadcast é sempre a tela: é a única fonte que a atividade consegue
  // capturar por conta própria.
  if (!fonte || fonte === 'tela') {
    myBroadcast?.stop();
    myBroadcast = null;
    fecharPreviaLocal();
    meuStream = null;
  }
  if (participants.some((p) => p.broadcasting && p.id === session?.user?.id)) {
    // Sem fonte o servidor derruba tudo — que é o certo para sair da sala.
    ws?.send(JSON.stringify({ type: 'stop-broadcast', ...(fonte ? { fonte } : {}) }));
  }
}

$('share').addEventListener('click', () => {
  if (!session) return;

  if (minhasFontes().has('tela') || myBroadcast) {
    stopMyBroadcast('tela');
    renderBar();
    return;
  }

  ligarFonte('tela');
});

$('camera').addEventListener('click', () => {
  if (!session) return;

  if (minhasFontes().has('camera')) {
    stopMyBroadcast('camera');
    renderBar();
    return;
  }

  ligarFonte('camera');
});

/** Espelha o volume atual no botão e no cursor, sem tocar no áudio. */
function renderVolume() {
  const pct = Math.round(volume * 100);
  $('volume').value = String(pct);
  $('volumeVal').textContent = pct + '%';

  const rotulo = volume === 0 ? 'Ligar o som' : 'Silenciar';
  $('mute').setAttribute('aria-label', rotulo);
  $('mute').title = rotulo;
  $('mute').classList.toggle('on', volume === 0);
  $('muteOn').hidden = volume === 0;
  $('muteOff').hidden = volume !== 0;
}

function setVolume(valor) {
  volume = Math.min(1, Math.max(0, valor));
  if (volume > 0) volumeAntes = volume;
  store('volume', String(volume));
  // O geral mudou: cada stream recalcula, porque o dele é o produto dos dois.
  for (const slot of streams.keys()) aplicarVolume(slot);
  renderVolume();
}

// Clique no alto-falante silencia e devolve; o cursor ajusta no meio termo.
$('mute').addEventListener('click', () => setVolume(volume === 0 ? volumeAntes : 0));
$('volume').addEventListener('input', (e) => setVolume(Number(e.target.value) / 100));

/**
 * Transmite a partir daqui mesmo, sem abrir aba.
 *
 * Só funciona se o Discord conceder `display-capture` ao iframe da Activity.
 * Retorna true quando o fluxo foi resolvido — transmitindo, ou a pessoa
 * cancelou o seletor — e false quando resta cair para a aba externa.
 *
 * NotAllowedError é ambíguo: vale tanto para "a plataforma bloqueou" quanto
 * para "a pessoa cancelou". O tempo separa os dois — bloqueio de política falha
 * na hora, sem nunca desenhar o seletor, enquanto cancelar exige que alguém
 * tenha visto a janela e clicado.
 */
async function broadcastFromHere() {
  if (!navigator.mediaDevices?.getDisplayMedia || !window.VideoEncoder) return false;

  if (!roomTokens) return false;
  const shareToken = new URL(roomTokens.shareUrl).searchParams.get('t');
  if (!shareToken) return false;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';

  const b = createBroadcaster({
    wsUrl: `${proto}://${location.host}${P}/ws?t=${encodeURIComponent(shareToken)}`,
    apiBase: P,
    bitrate: ajustes.bitrate,
    fps: ajustes.fps,
    audio: true,
    onAviso: (m) => toast(m, true),
    // O socket de quem transmite recebe o que desenham na tela dele: é assim
    // que o traço chega em quem está compartilhando, sem ele assistir a si.
    onAnn: anotarNaPrevia,
    onEnd: () => {
      myBroadcast = null;
      fecharPreviaLocal();
      meuStream = null;
      renderGrid();
      renderBar();
    },
  });

  const startedAt = performance.now();
  try {
    meuStream = await b.start();
    myBroadcast = b;
    garantirPreviaLocal();
    renderBar();
    return true;
  } catch (err) {
    const showedPicker = performance.now() - startedAt > 250;
    if (err.name === 'NotAllowedError' && showedPicker) return true;
    return false;
  }
}

// ------------------------------------------------------- modais das salas

$('newRoom').addEventListener('click', () => {
  if (!session) return;
  $('createName').value = '';
  $('createPass').value = '';
  $('createModal').hidden = false;
  $('createName').focus();
});

$('createCancel').addEventListener('click', () => ($('createModal').hidden = true));
$('createModal').addEventListener('click', (e) => {
  if (e.target === $('createModal')) $('createModal').hidden = true;
});

$('createGo').addEventListener('click', async () => {
  const name = $('createName').value.trim();

  try {
    const tokens = await post(`${P}/api/rooms/create`, {
      identity: session.identity,
      name,
      password: $('createPass').value || null,
    });
    $('createModal').hidden = true;
    openRoom(tokens, {
      id: tokens.roomId,
      // O servidor decide o nome quando fica em branco.
      name: name || `Sala de ${session.user.name}`,
      owner: session.user.name,
    });
  } catch (err) {
    toast(err.message, true);
  }
});

$('joinCancel').addEventListener('click', () => ($('joinModal').hidden = true));
$('joinModal').addEventListener('click', (e) => {
  if (e.target === $('joinModal')) $('joinModal').hidden = true;
});
$('joinPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('joinGo').click();
});

$('joinGo').addEventListener('click', async () => {
  if (!joinTarget) return;
  $('joinModal').hidden = true;
  await enterRoom(joinTarget, $('joinPass').value);
});

// Ajustes da sala: só o dono muda a senha, e o servidor confere de novo.
$('roomCancel').addEventListener('click', () => ($('roomModal').hidden = true));
$('roomModal').addEventListener('click', (e) => {
  if (e.target === $('roomModal')) $('roomModal').hidden = true;
});

$('roomSave').addEventListener('click', async () => {
  try {
    const r = await post(`${P}/api/rooms/password`, {
      identity: session.identity,
      roomId: roomTokens.roomId,
      password: $('roomPass').value || '',
    });
    $('roomModal').hidden = true;
    toast(r.locked ? 'Sala protegida com senha.' : 'Senha removida.');
  } catch (err) {
    toast(err.message, true);
  }
});

function openRoomSettings() {
  $('roomSub').textContent = roomInfo?.name ?? '';
  $('roomPass').value = '';
  $('roomModal').hidden = false;
  $('roomPass').focus();
}

$('roomSettings').addEventListener('click', openRoomSettings);

// ----------------------------------------------------------------- painel

/**
 * As barras somem com o cursor parado e voltam ao primeiro movimento. Valem
 * dentro da sala inteira, transmitindo ou não — flutuando, elas cobrem o que
 * está embaixo nos dois casos.
 *
 * O relógio corre sempre: um `if` aqui pagaria uma consulta ao estado a cada
 * movimento do mouse para poupar um setTimeout, e quem decide se a classe pinta
 * alguma coisa já é o CSS.
 *
 * Cursor que sai da janela recolhe na hora, sem esperar o relógio: não há mais
 * movimento nenhum para vir, então o tempo de espera só adiaria o inevitável.
 */
const OCIO = 3000;
let ocioso = null;

function acordarBarras() {
  $('app').classList.remove('ocioso');
  clearTimeout(ocioso);
  ocioso = setTimeout(() => $('app').classList.add('ocioso'), OCIO);
}

function recolherBarras() {
  clearTimeout(ocioso);
  $('app').classList.add('ocioso');
}

// pointerdown junto com o movimento: em tela sensível ao toque não há mousemove
// nenhum, e sem isto as barras sumiriam para sempre no primeiro silêncio.
window.addEventListener('mousemove', acordarBarras);
window.addEventListener('pointerdown', acordarBarras);
// No document, e não na window: o mouseleave da window não dispara ao sair pela
// borda em todos os navegadores.
document.addEventListener('mouseleave', recolherBarras);
acordarBarras();

// O estado visual do botão é decidido por renderGrid, que é quem sabe se há
// tela no palco — aqui só se troca a intenção.
$('fullscreen').addEventListener('click', () => {
  if (activeSlot === null) return;
  telaCheia = !telaCheia;
  renderGrid();
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  // Fecha o modal aberto mais recente antes de mexer no modo ampliado.
  for (const id of ['profileModal', 'roomModal', 'joinModal', 'createModal']) {
    if (!$(id).hidden) {
      $(id).hidden = true;
      return;
    }
  }

  // Esc sai da tela cheia — é o reflexo de todo mundo.
  if (telaCheia) {
    telaCheia = false;
    renderGrid();
  }
});

/**
 * Atalhos das ferramentas do palco.
 *
 * Uma tecla só para cada coisa que se faz com a mão ocupada segurando o mouse.
 * Ficam de fora quando há campo em foco ou modal aberto: `c` de caneta não pode
 * roubar um `c` digitado numa senha.
 */
window.addEventListener('keydown', (e) => {
  if (!inRoom() || activeSlot === null || e.altKey || e.metaKey) return;
  if (
    e.target instanceof Element &&
    e.target.closest('input, select, textarea, [contenteditable]')
  ) {
    return;
  }
  if (document.querySelector('.modal:not([hidden])')) return;

  if (e.ctrlKey) {
    if (e.key.toLowerCase() === 'z') {
      e.preventDefault();
      emitir(activeSlot, { k: 'u' });
    }
    return;
  }

  switch (e.key.toLowerCase()) {
    case 'v':
      definirFerramenta('mover');
      break;
    case 'l':
      definirFerramenta('laser');
      break;
    case 'c':
      definirFerramenta('caneta');
      break;
    case 'o':
      alternarTracos();
      break;
    case '+':
    case '=':
      definirZoom(activeSlot, zoomAtual(activeSlot) * 1.4);
      break;
    case '-':
    case '_':
      definirZoom(activeSlot, zoomAtual(activeSlot) / 1.4);
      break;
    case '0':
      zerarZoom();
      break;
    default:
      return;
  }
  e.preventDefault();
});

/**
 * Diagnóstico: tenta capturar a tela direto de dentro do iframe.
 *
 * Se um dia o Discord conceder `display-capture` ao iframe da Activity, isso
 * funciona e a aba externa deixa de ser necessária.
 */
$('probe').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('getDisplayMedia nem existe neste contexto — iframe sem permissão.', true);
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    toast('Funcionou! O iframe permite captura direta — dá para dispensar a aba externa.');
  } catch (err) {
    toast(`Bloqueado (${err.name}): ${err.message}`, true);
  }
});
