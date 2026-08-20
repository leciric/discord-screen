/**
 * Página de captura externa.
 *
 * Só existe como alternativa: quando o Discord não concede `display-capture` ao
 * iframe da Activity, a transmissão precisa nascer numa página top-level, onde
 * getDisplayMedia funciona sem restrição.
 *
 * Toda a lógica de captura e codificação vive em /shared/broadcaster.js, a mesma
 * usada dentro da Activity — aqui é só a interface.
 */
import { createBroadcaster, supportError } from '/shared/broadcaster.js?v=6';
import { criarCamada, conter } from '/shared/anotacoes.js?v=3';
import { criarFlutuante, flutuarDisponivel } from '/shared/flutuar.js?v=1';

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const token = query.get('t');

let broadcaster = null;

// Quantas leituras seguidas ficaram bem abaixo do alvo. Uma sozinha não diz
// nada: o primeiro segundo sempre sai curto, e uma engasgada pontual também.
let curtas = 0;
let ritmoAvisado = false;

/**
 * Avisa quando o computador não está entregando os quadros pedidos.
 *
 * O encoder por software (vp8, quando não há H264 por hardware) não acompanha
 * 60 fps em tela grande. O backpressure então descarta quadros — o que é a
 * decisão certa, porque fila no encoder vira atraso que nunca mais sai — mas
 * sem este aviso a pessoa escolhe 60, recebe 35 e não fica sabendo.
 */
function conferirRitmo({ fps, seconds }) {
  const alvo = Number($('fps').value);
  if (ritmoAvisado || seconds < 4) return;

  curtas = fps < alvo * 0.7 ? curtas + 1 : 0;
  if (curtas < 4) return;

  ritmoAvisado = true;
  setStatus(
    `Seu computador está entregando ~${fps} dos ${alvo} quadros pedidos. ` +
      'Para uma imagem mais estável, pare e escolha uma taxa menor.',
    'aviso'
  );
}

/**
 * Laser e desenho de quem assiste, sobre o próprio preview.
 *
 * É o que fecha a conversa: sem isto, quem mostra a tela só saberia que
 * apontaram para alguma coisa se voltasse para a janela do Discord — e voltar
 * para o Discord costuma significar minimizar justamente o que se está
 * mostrando.
 *
 * A vista é recalculada a cada pintura porque o preview é `object-fit: contain`
 * dentro de uma caixa 16:9 fixa: numa tela 16:10 sobram tarjas, e um traço
 * posicionado pela caixa cairia deslocado da imagem.
 */
const camada = criarCamada($('previewAnn'), {
  vista: () => {
    const video = $('preview');
    const caixa = video.getBoundingClientRect();
    if (!caixa.width || !video.videoWidth) return null;
    const fit = conter(caixa.width, caixa.height, video.videoWidth, video.videoHeight);
    return { boxW: caixa.width, boxH: caixa.height, ...fit };
  },
});

/**
 * Quem mexeu na tela nos últimos segundos.
 *
 * A linha existe porque um traço no canto de uma tela de 27 polegadas passa
 * despercebido — e o preview aqui é uma miniatura dela. Some sozinha depois de
 * um tempo parado: a lista é de quem está marcando agora, não de quem já marcou.
 */
const desenhando = new Map();
const MARCA_VIDA_MS = 4000;

function anotar(msg) {
  if (msg.type === 'ann-sync') {
    camada.sincronizar(msg.tracos);
    flutuante?.sincronizar(msg.tracos);
    return;
  }

  camada.aplicar(msg);
  // A janela flutuante tem a própria cópia do desenho: ela o mostra no tamanho
  // do quadro, e esta aqui no tamanho do preview.
  flutuante?.aplicar(msg);

  // Apagar não é marcar: quem limpou o que fez sai da linha na hora.
  if (msg.ev.k === 'ca') desenhando.clear();
  else if (msg.ev.k === 'c' || msg.ev.k === 'u' || msg.ev.k === 'po') desenhando.delete(msg.uid);
  else desenhando.set(msg.uid, { name: msg.name, at: Date.now() });

  mostrarQuemMarca();
}

function mostrarQuemMarca() {
  const agora = Date.now();
  for (const [uid, m] of desenhando) {
    if (agora - m.at > MARCA_VIDA_MS) desenhando.delete(uid);
  }

  const nomes = [...new Set([...desenhando.values()].map((m) => m.name))];
  $('annLine').textContent = nomes.length
    ? `${nomes.join(', ')} ${nomes.length === 1 ? 'está marcando' : 'estão marcando'} sua tela`
    : '';
  $('annLine').hidden = !nomes.length;
}

// A linha precisa sumir mesmo quando não chega mais evento nenhum — e é
// justamente aí que ela precisa sumir.
setInterval(() => desenhando.size && mostrarQuemMarca(), 1000);

// O preview redimensiona junto com a janela, e a caixa nova desloca tudo o que
// já estava desenhado.
window.addEventListener('resize', () => camada.repintar());

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function fail(title, msg) {
  $('roomLine').textContent = title;
  $('setup').hidden = true;
  setStatus(msg, 'error');
}

function readTokenPayload() {
  try {
    return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
// requireChromium: nos demais navegadores a captura sai visivelmente pior.
const missing = supportError({ requireChromium: true });

if (!payload) {
  fail('Link inválido.', 'Volte à atividade no Discord e clique em compartilhar novamente.');
  // `exp` é opcional: tokens de sala não expiram, a sala é que fecha.
} else if (payload.exp && payload.exp * 1000 < Date.now()) {
  fail('Link expirado.', 'Gere um novo pela atividade.');
} else if (missing) {
  fail('Navegador sem suporte.', missing);
} else {
  $('roomLine').textContent = `Transmitindo como ${payload.name}`;
  applyPresets();
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', () => broadcaster?.stop('Transmissão encerrada.'));
}

/**
 * Aplica as opções escolhidas no modal da Activity, que chegam pela URL.
 *
 * Com elas definidas, os seletores saem de cena: repetir a mesma escolha aqui
 * só confundiria. Sem elas, a página segue mostrando os controles.
 */
function applyPresets() {
  const q = query.get('q');
  const fps = query.get('fps');
  const som = query.get('som');

  // A opção de som veio decidida da atividade, então a caixa some junto com os
  // seletores — repetir a mesma escolha aqui só confundiria.
  if (som !== null) {
    $('withAudio').checked = som === '1';
    document.querySelector('.check').hidden = true;
  }

  if (!q && !fps) return;

  if (q) $('quality').value = q;
  if (fps) $('fps').value = fps;

  for (const row of document.querySelectorAll('#setup .row')) row.hidden = true;

  const mbps = (Number($('quality').value) / 1e6).toFixed(1).replace('.', ',');
  const comSom = $('withAudio').checked ? ' · com som' : '';
  $('presetLine').textContent = `${mbps} Mb/s · ${$('fps').value} fps${comSom}`;
  $('presetLine').hidden = false;
}

/**
 * A janela flutuante: a tela e as marcações por cima dos outros programas.
 *
 * É a resposta para "estou compartilhando e quero ver o que desenharam sem
 * voltar para o Discord". Nenhuma página desenha no seu desktop — isso o
 * navegador não permite a ninguém —, mas ela abre uma janela do sistema que
 * fica acima de tudo, e é o mais perto disso que dá para chegar sem instalar
 * um programa.
 */
let flutuante = null;

$('flutuar').addEventListener('click', async () => {
  if (flutuante) {
    flutuante.parar();
    flutuante = null;
    mostrarBotaoFlutuar();
    return;
  }

  const f = criarFlutuante({
    fonte: () => ($('preview').videoWidth ? $('preview') : null),
    dim: () => ({ w: $('preview').videoWidth, h: $('preview').videoHeight }),
    aoFechar: () => {
      flutuante = null;
      mostrarBotaoFlutuar();
    },
  });

  // Nasce com o que já está desenhado: quem clica no meio da conversa não pode
  // receber um quadro em branco e achar que quebrou.
  f.sincronizar(camada.instantaneo());
  flutuante = f;

  try {
    await f.abrir();
  } catch (err) {
    flutuante = null;
    f.parar();
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') setStatus(err.message, 'error');
  }
  mostrarBotaoFlutuar();
});

function mostrarBotaoFlutuar() {
  const podeVer = flutuarDisponivel() && Boolean(broadcaster);
  $('flutuar').hidden = !podeVer;
  $('flutuarNota').hidden = !podeVer || Boolean(flutuante);
  $('flutuar').textContent = flutuante ? 'Fechar a janela de cima' : 'Ver por cima de tudo';
}

// -------------------------------------------------------------------- ações

async function start() {
  curtas = 0;
  ritmoAvisado = false;
  $('start').disabled = true;
  setStatus('Aguardando você escolher a tela…');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';

  broadcaster = createBroadcaster({
    wsUrl: `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}`,
    bitrate: Number($('quality').value),
    fps: Number($('fps').value),
    audio: $('withAudio').checked,
    onStatus: (s) =>
      setStatus(
        `Codec: ${s.codec} · ${s.width}×${s.height} · captura ${s.direct ? 'direta' : 'via <video>'}`
      ),
    onStats: (s) => {
      $('viewers').textContent = s.viewers;
      $('fpsOut').textContent = `${s.fps} fps`;
      $('bitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
      $('elapsed').textContent =
        `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;
      conferirRitmo(s);
    },
    onAnn: anotar,
    onAviso: (msg) => {
      setStatus(msg, 'aviso');
      // O aviso sozinho é um beco: o botão é a saída dele.
      $('somAba').hidden = false;
    },
    onEnd: (reason) => {
      broadcaster = null;
      flutuante?.parar();
      flutuante = null;
      mostrarBotaoFlutuar();
      camada.limpar();
      desenhando.clear();
      $('annLine').hidden = true;
      $('preview').srcObject = null;
      $('live').hidden = true;
      $('setup').hidden = false;
      $('start').disabled = false;
      setStatus(reason);
    },
  });

  try {
    const stream = await broadcaster.start();
    $('preview').srcObject = stream;
    $('preview').play().catch(() => {});
    $('setup').hidden = true;
    $('live').hidden = false;
    mostrarBotaoFlutuar();
  } catch (err) {
    broadcaster = null;
    $('start').disabled = false;
    setStatus(
      err.name === 'NotAllowedError' ? 'Você cancelou a seleção de tela.' : err.message,
      'error'
    );
  }
}

// Mantém o vídeo como está e troca só de onde vem o som — a única fonte que
// não carrega o Discord junto é uma aba.
$('somAba').addEventListener('click', async () => {
  if (!broadcaster) return;
  try {
    await broadcaster.trocarSom();
    setStatus('Som ligado, vindo da aba escolhida.', 'ok');
    $('somAba').textContent = 'Trocar a aba do som';
  } catch (err) {
    if (err.name !== 'NotAllowedError') setStatus(err.message, 'error');
  }
});

window.addEventListener('beforeunload', () => broadcaster?.stop());
