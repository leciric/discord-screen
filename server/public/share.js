/**
 * Página de captura externa.
 *
 * Só existe como alternativa: quando o Discord não concede `display-capture` ao
 * iframe da Activity, a transmissão precisa nascer numa página top-level, onde
 * getDisplayMedia funciona sem restrição.
 *
 * Uma página, duas fontes. Tela e câmera são painéis independentes, cada um com
 * sua própria conexão e seu próprio ligar/desligar — abrir uma aba por fonte
 * dobraria as janelas que a pessoa precisa manter vivas, e nenhuma delas pode
 * ser fechada enquanto transmite.
 *
 * Toda a lógica de captura e codificação vive em /shared/broadcaster.js, a mesma
 * usada dentro da Activity — aqui é só a interface.
 */
import {
  createBroadcaster,
  supportError,
  fonteIndisponivel,
  opcoesTela,
} from '/shared/broadcaster.js?v=10';
import { criarCamada, conter } from '/shared/anotacoes.js?v=3';
import { criarFlutuante, flutuarDisponivel } from '/shared/flutuar.js?v=1';
import { criarEstudio } from '/shared/estudio.js?v=1';
import { carregarAnimacao } from '/shared/animacao.js?v=1';

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const token = query.get('t');

const FONTES = ['tela', 'camera'];
const TITULO = document.title;

/**
 * As opções da transmissão.
 *
 * Esta página é o lugar delas. Chegam pela URL quando a aba é aberta, podem
 * ser trocadas pelo `start-request` — a aba costuma estar aberta desde antes
 * da última mexida — e são editáveis aqui, que é onde quem transmite está
 * quando percebe que a imagem está pesada demais para a conexão.
 *
 * A escolha fica guardada no navegador: quem baixou a qualidade uma vez não
 * quer descobrir de novo, na próxima transmissão, que precisava baixar.
 */
const GUARDADAS = 'opcoesTransmissao';

function guardadas() {
  try {
    return JSON.parse(localStorage.getItem(GUARDADAS) ?? '{}');
  } catch {
    return {};
  }
}

const salvas = guardadas();
const opcoes = {
  // A URL vence o que está guardado: ela carrega a intenção desta abertura.
  bitrate: Number(query.get('q')) || Number(salvas.bitrate) || 2_500_000,
  fps: Number(query.get('fps')) || Number(salvas.fps) || 30,
};

function guardar() {
  try {
    localStorage.setItem(GUARDADAS, JSON.stringify(opcoes));
  } catch {
    /* navegação privada: vale só para esta sessão */
  }
}

function espelharOpcoes() {
  $('qualidade').value = String(opcoes.bitrate);
  $('quadros').value = String(opcoes.fps);
}

function aplicarOpcoes(novas) {
  if (!novas) return;
  if (Number(novas.q)) opcoes.bitrate = Number(novas.q);
  if (Number(novas.fps)) opcoes.fps = Number(novas.fps);
  // Os selects seguem o valor efetivo: mostrar 5 Mbps enquanto se transmite a
  // 1 Mbps é pior do que não mostrar nada.
  espelharOpcoes();
}

/**
 * Troca aplicada na hora, sem derrubar quem assiste.
 *
 * O setQuality reconfigura o encoder e pede a taxa nova à própria captura, então
 * quem está no ar vê a mudança sem reconexão. Fora do ar, só fica guardado para
 * a próxima.
 */
function mudarOpcao(chave, valor) {
  if (!Number(valor)) return;
  opcoes[chave] = Number(valor);
  guardar();
  for (const painel of Object.values(paineis)) painel?.aplicarQualidade?.();
}

const paineis = {};

function readTokenPayload() {
  try {
    return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function falhar(titulo, msg) {
  for (const f of FONTES) $(`bloco-${f}`).hidden = true;
  // Título e motivo no mesmo lugar: sem o cabeçalho não há mais onde separar
  // os dois, e separados em duas linhas eles diziam a mesma coisa duas vezes.
  const el = $('pageStatus');
  el.textContent = `${titulo} ${msg}`;
  el.className = 'status error';
}

// --------------------------------------------------------------- chamamento

let piscando = null;

/**
 * Destaca a fonte que a atividade pediu e chama pelo título.
 *
 * Uma aba em segundo plano não pode se trazer para a frente: `window.focus()` é
 * ignorado, e quem abriu esta página foi o navegador do sistema, não uma página
 * nossa que pudesse chamá-la de volta. O título é o único lugar onde ela ainda
 * aparece para quem está olhando outra coisa.
 */
function chamar(fonte) {
  for (const f of FONTES) $(`bloco-${f}`).classList.toggle('chamando', f === fonte);

  clearInterval(piscando);
  piscando = null;
  document.title = TITULO;
  if (!fonte) return;

  // Piscar só serve para quem não está olhando; com a aba à frente, o destaque
  // no bloco já diz qual é.
  if (!document.hidden) return;

  const aviso = fonte === 'camera' ? '● Ligar a câmera' : '● Compartilhar a tela';
  let ligado = false;
  piscando = setInterval(() => {
    ligado = !ligado;
    document.title = ligado ? aviso : TITULO;
  }, 1200);
}

// Visto o recado, para de piscar — o destaque no bloco continua dizendo qual é.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !piscando) return;
  clearInterval(piscando);
  piscando = null;
  document.title = TITULO;
});

/**
 * A configuração mudou na engrenagem da atividade.
 *
 * Vale na hora para o que já está no ar. O som não passa por aqui: ele é
 * decidido no seletor do navegador, na hora da captura.
 */
function aplicarConfig(novas) {
  aplicarOpcoes(novas);
  for (const f of FONTES) paineis[f]?.aplicarQualidade();
}

/**
 * A atividade pediu uma fonte.
 *
 * A câmera abre aqui mesmo, mas em prévia: getUserMedia não exige gesto do
 * usuário depois da permissão concedida, então dá para mostrar o que ela vê — e
 * mostrar é o certo, porque ir ao ar com a webcam errada não tem desfazer.
 *
 * Tela não abre nem em prévia: `getDisplayMedia` exige ativação transitória e
 * lança InvalidStateError sem ela, então o seletor só nasce de um clique nesta
 * página. O que resta é chamar e esperar.
 */
function atenderPedido(fonte, novas) {
  aplicarOpcoes(novas);

  const painel = paineis[fonte];
  if (!painel || painel.ativo() || painel.indisponivel()) return;

  chamar(fonte);
  if (fonte === 'camera') painel.abrirPrevia();
}

// --------------------------------------------------------------- controle

/**
 * Conexão de controle: aberta ao carregar, viva enquanto esta aba estiver.
 *
 * É por ela que a atividade alcança esta página **antes** de existir qualquer
 * transmissão — para pedir uma fonte, ou para avisar que a configuração mudou.
 * As conexões de transmissão não serviriam: cada uma nasce só depois que a
 * captura foi concedida, então com nada no ar não há ninguém escutando.
 */
let controle = null;
let religar = null;

function ligarControle() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  controle = new WebSocket(
    `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&modo=controle`,
  );

  controle.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;

    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    if (msg.type === 'start-request') atenderPedido(msg.fonte, msg.opcoes);
    else if (msg.type === 'config-request') aplicarConfig(msg.opcoes);
    else if (msg.type === 'room-gone') {
      // Sala fechada: não há a quem transmitir, e insistir na reconexão só
      // gastaria rede contra um id que não existe mais.
      clearTimeout(religar);
      religar = 'morto';
      $('pageStatus').textContent = 'A sala foi fechada. Volte à atividade e comece de novo.';
      $('pageStatus').className = 'status aviso';
    }
  });

  // Sem reconectar, uma queda de rede deixa a aba aberta e surda, sem nada na
  // tela dizendo que ela parou de obedecer à atividade.
  controle.addEventListener('close', () => {
    controle = null;
    if (religar === 'morto') return;
    clearTimeout(religar);
    religar = setTimeout(ligarControle, 3000);
  });
}

// ------------------------------------------------------------------ painel

function criarPainel(fonte) {
  const el = (sufixo) => $(`${fonte}-${sufixo}`);
  const camera = fonte === 'camera';

  let broadcaster = null;

  /**
   * Prévia local: o que a fonte mostra, antes de qualquer transmissão.
   *
   * Existe porque ir ao ar com a fonte errada não tem desfazer — quem está
   * assistindo já viu a janela que não era para ver, ou a webcam que não era
   * para ligar. Conferir e transmitir passam a ser dois gestos.
   *
   * O stream da prévia é reaproveitado pela transmissão, e é por isso que ela
   * pede a tela com as mesmas opções: com outras, ligar o som depois exigiria
   * escolher a tela de novo.
   */
  let previa = null;
  // Qual câmera. `null` é o que o navegador escolher.
  let dispositivo = null;

  /**
   * O estúdio, só no painel da câmera.
   *
   * A tela vai crua para o encoder: ninguém quer um recorte oval sobre uma
   * planilha, e passar 1080p de texto por um canvas a mais custaria uma cópia
   * inteira por quadro sem nada em troca. A câmera é a única fonte em que
   * trocar o fundo — ou trocar a própria câmera por um GIF — faz sentido.
   */
  let estudio = null;
  // A câmera de verdade, antes do estúdio. Guardada à parte porque é ela que
  // segura o hardware e é ela que precisa ser solta.
  let cameraCrua = null;
  // As animações são de quem as carregou: o estúdio só as desenha. Ver a nota
  // em shared/estudio.js.
  let animacaoEntrada = null;
  let animacaoFundo = null;

  function pararPrevia() {
    // A prévia da câmera É a faixa do estúdio, e o estúdio sobrevive à prévia:
    // pará-la aqui mataria o canvas que a transmissão está prestes a usar.
    if (previa && previa !== estudio?.stream) previa.getTracks().forEach((t) => t.stop());
    previa = null;
    el('previa').srcObject = null;
    el('previa').hidden = true;
    el('vazio').hidden = false;
  }

  /**
   * @param {MediaStream} stream          o que aparece na prévia
   * @param {MediaStreamTrack|null} vigiada  a faixa cujo fim significa que a
   *   fonte acabou. Pela câmera é a faixa do dispositivo, e não a do canvas —
   *   o canvas continua desenhando um quadro parado depois da webcam sumir.
   */
  function mostrarPrevia(stream, vigiada = stream.getVideoTracks()[0]) {
    previa = stream;
    el('previa').srcObject = stream;
    el('previa')
      .play()
      .catch(() => {});
    el('previa').hidden = false;
    el('vazio').hidden = true;

    // A fonte pode acabar sozinha — webcam desconectada, janela fechada. Sem
    // isto o último quadro fica congelado e a prévia passa a mentir.
    vigiada?.addEventListener('ended', () => {
      if (previa !== stream) return;
      pararPrevia();
      pararEstudio();
      setStatus(camera ? 'A câmera foi desligada.' : 'O compartilhamento acabou.');
    });
  }

  /** O estúdio nasce na primeira vez que alguém precisa dele. */
  function montarEstudio() {
    if (!estudio) estudio = criarEstudio({ fps: opcoes.fps });
    return estudio;
  }

  function soltarCamera() {
    cameraCrua?.getTracks().forEach((t) => t.stop());
    cameraCrua = null;
  }

  function pararEstudio() {
    estudio?.parar();
    estudio = null;
    soltarCamera();
    animacaoEntrada?.parar();
    animacaoEntrada = null;
    animacaoFundo?.parar();
    animacaoFundo = null;
  }

  function setStatus(msg, kind = '') {
    const alvo = el('status');
    alvo.textContent = msg;
    alvo.className = `status ${kind}`;
  }

  function mostrarSetup() {
    el('preview').srcObject = null;
    el('live').hidden = true;
    el('setup').hidden = false;
    el('start').disabled = false;
  }

  // -------------------------------------------------- marcações de quem assiste

  /**
   * Laser e desenho de quem está assistindo, sobre o próprio preview.
   *
   * É o que fecha a conversa: sem isto, quem transmite só saberia que apontaram
   * para alguma coisa se voltasse para a janela do Discord — e voltar para o
   * Discord costuma significar minimizar justamente o que se está mostrando.
   *
   * A vista é recalculada a cada pintura porque o preview é `object-fit:
   * contain` dentro de uma caixa 16:9 fixa: numa tela 16:10 sobram tarjas, e um
   * traço posicionado pela caixa cairia deslocado da imagem.
   */
  const camada = criarCamada(el('ann'), {
    vista: () => {
      const video = el('preview');
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
   * despercebido — e o preview aqui é uma miniatura dela. Some sozinha depois
   * de um tempo parado: a lista é de quem está marcando agora.
   */
  const marcando = new Map();
  const MARCA_VIDA_MS = 4000;

  let flutuante = null;

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
    if (msg.ev.k === 'ca') marcando.clear();
    else if (msg.ev.k === 'c' || msg.ev.k === 'u' || msg.ev.k === 'po') marcando.delete(msg.uid);
    else marcando.set(msg.uid, { nome: msg.name, em: Date.now() });

    mostrarQuemMarca();
  }

  function mostrarQuemMarca() {
    const agora = Date.now();
    for (const [uid, m] of marcando) if (agora - m.em > MARCA_VIDA_MS) marcando.delete(uid);

    const nomes = [...new Set([...marcando.values()].map((m) => m.nome))];
    el('marcando').textContent = nomes.length
      ? `${nomes.join(', ')} ${nomes.length === 1 ? 'está marcando' : 'estão marcando'}`
      : '';
    el('marcando').hidden = !nomes.length;
  }

  // A linha precisa sumir mesmo quando não chega mais evento nenhum — e é
  // justamente aí que ela precisa sumir.
  setInterval(() => marcando.size && mostrarQuemMarca(), 1000);

  // O preview redimensiona junto com a janela, e a caixa nova desloca tudo o
  // que já estava desenhado.
  window.addEventListener('resize', () => camada.repintar());

  function limparMarcacoes() {
    flutuante?.parar();
    flutuante = null;
    camada.limpar();
    marcando.clear();
    mostrarQuemMarca();
    mostrarBotaoFlutuar();
  }

  // ------------------------------------------------------- janela por cima

  /**
   * A tela e as marcações por cima dos outros programas.
   *
   * É a resposta para "estou compartilhando e quero ver o que desenharam sem
   * voltar para o Discord". Nenhuma página desenha no desktop — isso o
   * navegador não permite a ninguém —, mas ela abre uma janela do sistema que
   * fica acima de tudo, e é o mais perto disso sem instalar um programa.
   */
  function mostrarBotaoFlutuar() {
    const pode = flutuarDisponivel() && Boolean(broadcaster);
    el('flutuar').hidden = !pode;
    el('flutuar').textContent = flutuante ? 'Fechar a janela de cima' : 'Ver por cima de tudo';
  }

  async function alternarFlutuante() {
    if (flutuante) {
      flutuante.parar();
      flutuante = null;
      mostrarBotaoFlutuar();
      return;
    }

    const f = criarFlutuante({
      fonte: () => (el('preview').videoWidth ? el('preview') : null),
      dim: () => ({ w: el('preview').videoWidth, h: el('preview').videoHeight }),
      aoFechar: () => {
        flutuante = null;
        mostrarBotaoFlutuar();
      },
    });

    // Nasce com o que já está desenhado: quem clica no meio da conversa não
    // pode receber um quadro em branco e achar que quebrou.
    f.sincronizar(camada.instantaneo());
    flutuante = f;

    try {
      await f.abrir();
    } catch (err) {
      flutuante = null;
      f.parar();
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError')
        setStatus(err.message, 'error');
    }
    mostrarBotaoFlutuar();
  }

  // ------------------------------------------------------ escolher a fonte

  /**
   * Abre a prévia da câmera, trocando a que estiver aberta.
   *
   * O que vai para a tela — e, depois, para o ar — é a saída do estúdio, não a
   * câmera crua: é isso que faz o fundo escolhido valer já na prévia. Ver a
   * webcam sem efeito aqui e com efeito no ar seria conferir a coisa errada.
   */
  async function verCamera(id = dispositivo) {
    setStatus('Abrindo a câmera…');
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: id ? { deviceId: { exact: id } } : true,
        audio: false,
      });
      // Sem escolha explícita, adota a que o navegador deu: assim o tique do
      // menu marca a que está no ar em vez de não marcar nenhuma.
      dispositivo = id ?? s.getVideoTracks()[0]?.getSettings().deviceId ?? null;

      soltarCamera();
      cameraCrua = s;
      montarEstudio().usarCamera(s);
      await aplicarFundo();

      pararPrevia();
      mostrarPrevia(estudio.stream, s.getVideoTracks()[0]);
      setStatus('Prévia — ainda não está no ar.');
      await listarCameras();
    } catch (err) {
      setStatus(
        err.name === 'NotAllowedError'
          ? 'Acesso à câmera negado. Libere a permissão na barra de endereço e tente de novo.'
          : err.message,
        'error',
      );
    }
  }

  /**
   * Um GIF no lugar da câmera.
   *
   * A webcam é solta de propósito: quem escolheu mostrar um GIF não quer a luz
   * da câmera acesa nem o dispositivo preso por esta aba enquanto isso.
   */
  async function verGif(arquivo) {
    if (!arquivo) {
      setStatus('Escolha um GIF ou uma imagem para mostrar.', 'aviso');
      return;
    }

    setStatus('Abrindo o arquivo…');
    try {
      const nova = await carregarAnimacao(arquivo);
      animacaoEntrada?.parar();
      animacaoEntrada = nova;

      soltarCamera();
      montarEstudio().usarAnimacao(nova);
      // Sem recorte: aqui a imagem inteira É o que se quer mostrar, e cobrir a
      // borda dela com um "fundo" seria esconder o próprio conteúdo.
      estudio.definirFundo({ tipo: 'nenhum' });

      pararPrevia();
      // Sem faixa vigiada: um canvas não acaba sozinho, e a animação também não.
      mostrarPrevia(estudio.stream, null);
      setStatus(
        nova.animada
          ? 'GIF pronto — ainda não está no ar.'
          : 'Imagem pronta — ainda não está no ar.',
      );
    } catch (err) {
      setStatus(`Não deu para abrir esse arquivo: ${err.message}`, 'error');
    }
  }

  // ------------------------------------------------------------------ fundo

  /**
   * O sistema sabe separar pessoa de parede?
   *
   * Onde `backgroundBlur` existe como constraint, quem desfoca é a própria
   * pilha de captura do sistema operacional, com segmentação de verdade. É
   * incomparavelmente melhor que o recorte geométrico daqui, então quando
   * existe é ele que vale — e o recorte sai de cena inteiro.
   */
  const temDesfoqueNativo = () =>
    Boolean(navigator.mediaDevices.getSupportedConstraints?.().backgroundBlur);

  async function pedirDesfoqueNativo(ligado) {
    const faixa = cameraCrua?.getVideoTracks()[0];
    if (!faixa || !temDesfoqueNativo()) return false;
    try {
      await faixa.applyConstraints({ backgroundBlur: ligado });
      return ligado;
    } catch {
      // Câmera que não faz: cai no recorte, como em qualquer outro sistema.
      return false;
    }
  }

  /** Lê os controles e manda o estúdio obedecer. */
  async function aplicarFundo() {
    if (!estudio) return;

    // Com um GIF no lugar da câmera não há fundo a esconder: o quadro inteiro
    // já é escolha de quem transmite.
    const tipo = entradaEscolhida() === 'gif' ? 'nenhum' : $('camera-fundo').value;
    const janela = Number($('camera-janela').value) / 100;

    const nativo = await pedirDesfoqueNativo(tipo === 'desfoque');

    if (tipo === 'nenhum' || nativo) {
      estudio.definirFundo({ tipo: 'nenhum' });
    } else if (tipo === 'cor') {
      estudio.definirFundo({ tipo: 'cor', cor: $('camera-cor').value, janela });
    } else if (tipo === 'midia' && animacaoFundo) {
      estudio.definirFundo({ tipo: 'midia', animacao: animacaoFundo, janela });
    } else {
      // Sobra o desfoque — e é onde cai também um fundo de mídia sem arquivo
      // escolhido ainda, que é melhor do que um retângulo preto sem explicação.
      estudio.definirFundo({ tipo: 'desfoque', janela });
    }
  }

  /** Abre a prévia da tela. O seletor exige o clique, que é quem chama isto. */
  async function verTela() {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia(
        opcoesTela({ fps: opcoes.fps, comSom: true }),
      );
      pararPrevia();
      mostrarPrevia(s);
      setStatus('Prévia — ainda não está no ar.');
    } catch (err) {
      // Cancelar o seletor é escolha, não falha.
      if (err.name !== 'NotAllowedError') setStatus(err.message, 'error');
    }
  }

  function fecharMenu() {
    el('menu').hidden = true;
    el('escolher').setAttribute('aria-expanded', 'false');
  }

  /**
   * A lista de câmeras.
   *
   * Os nomes só chegam depois da permissão — antes dela o navegador entrega os
   * dispositivos anônimos, para não revelar o hardware a quem não pediu nada.
   * Por isso abrir o menu abre a prévia primeiro.
   */
  async function listarCameras() {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'videoinput',
    );

    el('menu').replaceChildren(
      ...cams.map((d, i) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(d.deviceId === dispositivo));
        b.textContent = d.label || `Câmera ${i + 1}`;
        b.addEventListener('click', () => {
          fecharMenu();
          verCamera(d.deviceId);
        });
        li.append(b);
        return li;
      }),
    );
  }

  /**
   * Abre o menu de câmeras.
   *
   * Lista sem pedir a câmera: `enumerateDevices` responde sem permissão — só
   * devolve os nomes em branco, e uma lista de "Câmera 1, Câmera 2" já deixa
   * escolher. Exigir a permissão antes acorrentava o menu ao sucesso do
   * `getUserMedia`: bastava a câmera estar ocupada por outro programa para a
   * seta parar de responder, sem nada explicando por quê.
   *
   * Os nomes de verdade chegam depois da primeira prévia, e a próxima abertura
   * do menu já os mostra.
   */
  async function escolher() {
    if (!camera) return verTela();

    if (!el('menu').hidden) return fecharMenu();

    await listarCameras();

    if (!el('menu').childElementCount) {
      setStatus('Nenhuma câmera encontrada neste computador.', 'error');
      return;
    }

    el('menu').hidden = false;
    el('escolher').setAttribute('aria-expanded', 'true');
  }

  // ------------------------------------------------------------- transmitir

  async function ligar() {
    // Pedido repetido não reabre nada: a segunda conexão seria recusada pelo
    // servidor, e o seletor de tela abriria por cima do que já está no ar.
    if (broadcaster) return;

    // A câmera nunca vai crua para o encoder: quem transmite escolheu um fundo
    // (ou um GIF), e quem entrega isso é o estúdio. Sem prévia montada não há
    // estúdio, então ele é montado agora — `getUserMedia` não exige gesto do
    // usuário depois da permissão dada, e o arquivo já está escolhido.
    if (camera && !previa) {
      await (entradaEscolhida() === 'gif' ? verGif(arquivoEntrada()) : verCamera());
      // Deu errado: o status já disse o quê, e ir ao ar sem imagem seria pior.
      if (!previa) {
        el('start').disabled = false;
        return;
      }
    }

    el('start').disabled = true;
    setStatus(camera ? 'Aguardando a permissão da câmera…' : 'Aguardando você escolher a tela…');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';

    broadcaster = createBroadcaster({
      wsUrl: `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&fonte=${fonte}`,
      bitrate: opcoes.bitrate,
      fps: opcoes.fps,
      audio: !camera,
      fonte,
      // A prévia já pagou o gesto do usuário e a permissão: reaproveitá-la é o
      // que evita o seletor de tela abrir uma segunda vez para o mesmo
      // compartilhamento.
      streamPronto: previa,
      deviceId: camera ? dispositivo : null,
      onStatus: (s) =>
        setStatus(
          `Codec: ${s.codec} · ${s.width}×${s.height} · captura ${s.direct ? 'direta' : 'via <video>'}` +
            // A linha que faltava: codificar na CPU derruba a taxa pela metade
            // e não aparecia em lugar nenhum.
            (s.porHardware === null ? '' : ` · ${s.porHardware ? 'hardware' : 'software'}`),
        ),
      onStats: (s) => {
        el('viewers').textContent = s.viewers;
        el('fps').textContent = `${s.fps} fps`;
        el('bitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
        el('elapsed').textContent =
          `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;
      },
      onAviso: (msg) => setStatus(msg, 'aviso'),
      // O socket de quem transmite recebe o que desenham nesta fonte: é assim
      // que o traço chega aqui sem esta aba assistir a si mesma.
      onAnn: anotar,
      onEnd: (reason) => {
        broadcaster = null;
        limparMarcacoes();
        // O broadcaster para as faixas do que recebeu, e o que ele recebeu foi
        // a saída do estúdio: com a faixa morta, o estúdio não tem mais por
        // onde entregar. O próximo "ligar" monta outro.
        pararEstudio();
        mostrarSetup();
        setStatus(reason);
      },
    });

    // O broadcaster assume as faixas daqui para a frente, então a referência sai
    // sem pará-las — pará-las seria desligar o que acabou de ir ao ar.
    previa = null;
    el('previa').srcObject = null;
    el('previa').hidden = true;
    el('vazio').hidden = false;

    try {
      const stream = await broadcaster.start();
      el('preview').srcObject = stream;
      el('preview')
        .play()
        .catch(() => {});
      el('setup').hidden = true;
      el('live').hidden = false;
      // A tela sempre pede som, e a caixa do seletor pode ter ficado desmarcada:
      // a saída fica à mão desde o início, em vez de só depois de um aviso.
      if (!camera) $('somAba').hidden = false;
      mostrarBotaoFlutuar();
      chamar(null);
    } catch (err) {
      broadcaster = null;
      el('start').disabled = false;
      // NotAllowedError quer dizer coisas diferentes nas duas fontes: na tela é
      // quase sempre cancelar o seletor; na câmera é a permissão negada.
      const negado = camera
        ? 'Acesso à câmera negado. Libere a permissão na barra de endereço e tente de novo.'
        : 'Você cancelou a seleção de tela.';
      setStatus(err.name === 'NotAllowedError' ? negado : err.message, 'error');
    }
  }

  // ------------------------------------------------- controles da câmera

  const entradaEscolhida = () => (camera ? $('camera-entrada').value : 'camera');
  const arquivoEntrada = () => $('camera-gif').files?.[0] ?? null;

  /**
   * Mostra só os campos que a escolha atual usa.
   *
   * Um seletor de cor visível enquanto o fundo é "desfocar" é um controle que
   * não faz nada — e um controle que não faz nada é lido como quebrado.
   */
  function espelharControles() {
    if (!camera) return;

    const entrada = entradaEscolhida();
    const gif = entrada === 'gif';
    const tipo = $('camera-fundo').value;

    $('camera-gif-campo').hidden = !gif;
    // Com um GIF no lugar da câmera não existe fundo separado do resto.
    $('camera-fundo-campo').hidden = gif;
    $('camera-cor-campo').hidden = gif || tipo !== 'cor';
    $('camera-fundo-arquivo-campo').hidden = gif || tipo !== 'midia';

    // O recorte só existe onde ele é o mecanismo. Com o desfoque do sistema no
    // ar não há recorte nenhum para dimensionar.
    const recortando = !gif && tipo !== 'nenhum' && !(tipo === 'desfoque' && temDesfoqueNativo());
    $('camera-janela-campo').hidden = !recortando;

    el('start').textContent = gif ? 'Mostrar este GIF' : 'Ligar a câmera';
    // A seta escolhe entre câmeras; com um GIF no ar não há o que escolher.
    el('escolher').hidden = gif;

    const nota = $('camera-fundo-nota');
    nota.textContent = textoDoFundo(gif, tipo);
    nota.hidden = !nota.textContent;
  }

  function textoDoFundo(gif, tipo) {
    if (gif) return 'O GIF vai no lugar da câmera, e aparece para os outros como se fosse ela.';
    if (tipo === 'nenhum') return '';
    if (tipo === 'desfoque' && temDesfoqueNativo()) {
      return 'Desfoque do próprio sistema: ele separa você do fundo de verdade.';
    }
    // Prometer segmentação que não existe seria descobrir a verdade ao vivo.
    return 'Aparece o miolo do quadro; o resto vira o fundo escolhido. Centralize-se e ajuste o tamanho do recorte.';
  }

  if (camera) {
    espelharControles();

    $('camera-entrada').addEventListener('change', () => {
      espelharControles();
      // Nada no ar ainda e nada escolhido: só espera o arquivo ou o clique.
      if (entradaEscolhida() === 'gif') {
        if (arquivoEntrada()) verGif(arquivoEntrada());
        return;
      }
      // Voltar para a câmera de verdade só faz sentido se já havia imagem: sem
      // isso, seria acender a webcam por causa de um clique num seletor.
      if (previa || broadcaster) verCamera();
    });

    $('camera-gif').addEventListener('change', () => {
      const arquivo = arquivoEntrada();
      if (!arquivo) return;
      $('camera-entrada').value = 'gif';
      espelharControles();
      verGif(arquivo);
    });

    $('camera-fundo').addEventListener('change', () => {
      espelharControles();
      aplicarFundo();
    });

    $('camera-cor').addEventListener('input', aplicarFundo);
    $('camera-janela').addEventListener('input', aplicarFundo);

    $('camera-fundo-arquivo').addEventListener('change', async () => {
      const arquivo = $('camera-fundo-arquivo').files?.[0];
      if (!arquivo) return;
      try {
        const nova = await carregarAnimacao(arquivo);
        animacaoFundo?.parar();
        animacaoFundo = nova;
        $('camera-fundo').value = 'midia';
        espelharControles();
        await aplicarFundo();
      } catch (err) {
        setStatus(`Não deu para abrir esse fundo: ${err.message}`, 'error');
      }
    });
  }

  // O que impede esta fonte, sem derrubar a outra: um celular não tem
  // `getDisplayMedia` e tem `getUserMedia`, então a tela cai e a câmera fica.
  const indisponivel = fonteIndisponivel(fonte);
  if (indisponivel) {
    el('start').disabled = true;
    el('escolher').disabled = true;
    setStatus(indisponivel, 'error');
  }

  el('start').addEventListener('click', ligar);
  el('flutuar').addEventListener('click', alternarFlutuante);
  el('stop').addEventListener('click', () =>
    broadcaster?.stop(camera ? 'Câmera desligada.' : 'Transmissão encerrada.'),
  );

  // stopPropagation para o clique não chegar ao document e fechar o que acabou
  // de abrir.
  el('escolher').addEventListener('click', (e) => {
    e.stopPropagation();
    escolher().catch((err) => setStatus(err.message, 'error'));
  });

  if (camera) {
    document.addEventListener('click', fecharMenu);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') fecharMenu();
    });
  }

  return {
    ligar,
    escolher,
    verCamera,
    verGif,
    /**
     * A prévia da câmera, seja ela qual for.
     *
     * A atividade pede "a câmera" e não sabe — nem precisa saber — que do lado
     * de cá isso pode ser um GIF. A escolha mora nesta página, então é ela que
     * decide o que abrir.
     */
    abrirPrevia: () => (entradaEscolhida() === 'gif' ? verGif(arquivoEntrada()) : verCamera()),
    setStatus,
    indisponivel: () => Boolean(indisponivel),
    aplicarQualidade: () => {
      // O canvas do estúdio só entrega quadro quando o relógio dele pede, então
      // a taxa nova precisa chegar aos dois: sem isto, subir para 60 fps não
      // teria de onde tirar os quadros a mais.
      estudio?.definirFps(opcoes.fps);
      broadcaster?.setQuality({ bitrate: opcoes.bitrate, fps: opcoes.fps });
    },
    ativo: () => Boolean(broadcaster),
    // Fechar a aba tem que soltar a câmera, esteja ela no ar ou só na prévia.
    parar: () => {
      broadcaster?.stop();
      flutuante?.parar();
      pararPrevia();
      pararEstudio();
    },
    trocarSom: () => broadcaster?.trocarSom(),
  };
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
// requireChromium: nos demais navegadores a captura sai visivelmente pior.
const missing = supportError({ requireChromium: true });

if (!payload) {
  falhar('Link inválido.', 'Volte à atividade no Discord e clique em compartilhar novamente.');
  // `exp` é opcional: tokens de sala não expiram, a sala é que fecha.
} else if (payload.exp && payload.exp * 1000 < Date.now()) {
  falhar('Link expirado.', 'Gere um novo pela atividade.');
} else if (missing) {
  falhar('Navegador sem suporte.', missing);
} else {
  for (const f of FONTES) paineis[f] = criarPainel(f);
  ligarControle();

  // A atividade diz qual fonte motivou a abertura da aba. A tela espera o
  // clique, que é o gesto que o seletor exige; a câmera abre a prévia, mas só
  // depois que a página apareceu — pedir permissão numa aba que o navegador
  // acabou de abrir em segundo plano deixaria o pedido preso sem ninguém ver.
  const pedida = query.get('fonte');
  if (FONTES.includes(pedida)) atenderPedido(pedida);
}

// Mantém o vídeo como está e troca só de onde vem o som — as fontes que não
// carregam o Discord junto são uma aba e a janela de um aplicativo.
$('somAba').addEventListener('click', async () => {
  if (!paineis.tela?.ativo()) return;
  try {
    await paineis.tela.trocarSom();
    paineis.tela.setStatus('Som ligado, vindo da fonte escolhida.', 'ok');
    $('somAba').textContent = 'Trocar a fonte do som';
  } catch (err) {
    // Cancelar a segunda janela é escolha, não falha.
    if (err.name !== 'NotAllowedError') paineis.tela.setStatus(err.message, 'error');
  }
});

espelharOpcoes();
$('qualidade').addEventListener('change', (e) => mudarOpcao('bitrate', e.target.value));
$('quadros').addEventListener('change', (e) => mudarOpcao('fps', e.target.value));

window.addEventListener('beforeunload', () => {
  for (const f of FONTES) paineis[f]?.parar();
});
