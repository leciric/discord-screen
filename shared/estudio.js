/**
 * O que a câmera manda, depois de passar por aqui.
 *
 * Duas coisas moram no mesmo lugar porque são a mesma coisa: um canvas que
 * desenha alguma fonte e devolve o resultado como se fosse uma webcam.
 *
 *   - a fonte pode ser a câmera de verdade ou um GIF, e quem assiste não tem
 *     como saber a diferença — para o resto do programa é uma faixa de vídeo;
 *   - o fundo pode ser trocado, desfocado ou coberto, para quem não quer
 *     mostrar o quarto junto com o rosto.
 *
 * Separá-las em dois módulos custaria dois canvas, dois relógios e duas
 * capturas em fila, cada uma copiando a imagem inteira de novo. Aqui é um
 * desenho só por quadro.
 *
 * Sobre o fundo, e para não prometer o que não se cumpre: separar pessoa de
 * parede exige um modelo de segmentação, que são megabytes de download e um
 * modelo para manter. O que existe aqui embaixo é um recorte oval no meio do
 * quadro — o que está dentro aparece, o que está fora vira o fundo escolhido.
 * Não é mágica e a interface diz isso com todas as letras. O que é mágica de
 * verdade é o `backgroundBlur` do próprio sistema, e quando ele existe quem
 * chama usa ele e deixa este recorte de lado.
 */

// Teto de resolução. O mesmo do broadcaster, e pelo mesmo motivo: acima disso
// é banda gasta em ruído de sensor.
const MAX_L = 1280;
const MAX_A = 720;

// Dimensão ímpar quebra o encoder de vídeo, que trabalha em blocos de 2.
const par = (n) => Math.max(2, Math.round(n) - (Math.round(n) % 2));

/** A fatia do quadro que o recorte deixa passar, em fração da menor dimensão. */
const JANELA_PADRAO = 0.62;

/**
 * @param {object} opts
 * @param {number} [opts.fps]  ritmo em que o canvas entrega quadros
 */
export function criarEstudio({ fps = 30 } = {}) {
  const tela = document.createElement('canvas');
  tela.width = MAX_L;
  tela.height = MAX_A;
  // alpha: false porque o resultado sempre cobre o quadro inteiro, e um canvas
  // opaco poupa a composição com o que está atrás.
  const ctx = tela.getContext('2d', { alpha: false, desynchronized: true });

  // O canvas do recorte. Um só, reaproveitado a cada quadro: criar um por
  // quadro seria alocar alguns megabytes trinta vezes por segundo.
  const recorte = document.createElement('canvas');
  const recorteCtx = recorte.getContext('2d');

  // captureStream(0) e não captureStream(fps): com zero, o único jeito de sair
  // um quadro é pedindo — e quem pede é o relógio abaixo. É isso que permite
  // trocar a taxa com a transmissão no ar sem refazer a faixa, e que garante
  // que cada quadro entregue é um quadro que acabou de ser desenhado.
  const stream = tela.captureStream(0);
  const faixa = stream.getVideoTracks()[0];

  /** A fonte da imagem. Um `<video>` com a câmera, ou uma animação carregada. */
  let entrada = null;
  let video = null;
  let fundo = { tipo: 'nenhum' };
  let janela = JANELA_PADRAO;
  let vivo = true;

  const relogio = criarRelogio(() => desenhar());
  relogio.intervalo(1000 / fps);

  // ------------------------------------------------------------------ fonte

  /**
   * A câmera de verdade.
   *
   * O `<video>` vai para o documento, fora de vista, porque um elemento solto
   * não decodifica em todos os navegadores e `display: none` chega a pausar a
   * reprodução — o mesmo motivo pelo qual o broadcaster faz igual.
   */
  function usarCamera(mediaStream) {
    soltarEntrada();

    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = mediaStream;
    Object.assign(video.style, {
      position: 'fixed',
      left: '-9999px',
      top: '0',
      width: '2px',
      height: '2px',
      opacity: '0',
      pointerEvents: 'none',
    });
    document.body.append(video);
    video.play().catch(() => {});

    entrada = { tipo: 'camera', midia: mediaStream };
    // O tamanho real só se conhece depois dos metadados, e muda sozinho se a
    // câmera trocar de modo.
    video.addEventListener('loadedmetadata', ajustarTamanho);
    video.addEventListener('resize', ajustarTamanho);
  }

  /** Um GIF no lugar da câmera. */
  function usarAnimacao(animacao) {
    soltarEntrada();
    entrada = { tipo: 'animacao', midia: animacao };
    ajustarTamanho();
  }

  /**
   * Larga a fonte anterior sem parar nada que não seja nosso.
   *
   * Nem o MediaStream da câmera nem a animação nascem aqui, e nenhum dos dois
   * morre aqui. É a regra do módulo inteiro: o estúdio é dono do canvas, do
   * relógio e da faixa que ele produz — de mais nada. Um GIF pode ser a entrada
   * agora e o fundo daqui a pouco, e um estúdio que fechasse o que recebe
   * apagaria a imagem que quem chamou ainda está usando.
   */
  function soltarEntrada() {
    video?.remove();
    video = null;
    entrada = null;
  }

  /** O canvas acompanha a fonte, respeitando o teto. */
  function ajustarTamanho() {
    const { l, a } = medidaDaFonte();
    if (!l || !a) return;

    const escala = Math.min(1, MAX_L / l, MAX_A / a);
    const largura = par(l * escala);
    const altura = par(a * escala);
    if (tela.width === largura && tela.height === altura) return;

    tela.width = largura;
    tela.height = altura;
    recorte.width = largura;
    recorte.height = altura;
  }

  function medidaDaFonte() {
    if (entrada?.tipo === 'camera')
      return { l: video?.videoWidth ?? 0, a: video?.videoHeight ?? 0 };
    if (entrada?.tipo === 'animacao') return { l: entrada.midia.largura, a: entrada.midia.altura };
    return { l: 0, a: 0 };
  }

  /** O que desenhar agora, ou null enquanto a fonte não tem imagem. */
  function fonteAgora(agora) {
    if (entrada?.tipo === 'camera') {
      if (!video || video.readyState < 2 || !video.videoWidth) return null;
      // Aba escondida pode pausar o elemento; sem isto a imagem congela e nada
      // no programa diz por quê.
      if (video.paused) video.play().catch(() => {});
      return video;
    }
    if (entrada?.tipo === 'animacao') return entrada.midia.quadro(agora);
    return null;
  }

  // ------------------------------------------------------------------ fundo

  /**
   * @param {object} opcoes
   * @param {'nenhum'|'desfoque'|'cor'|'midia'} opcoes.tipo
   * @param {string} [opcoes.cor]        para o tipo 'cor'
   * @param {object} [opcoes.animacao]   para o tipo 'midia'
   * @param {number} [opcoes.janela]     fatia visível, de 0.3 a 1
   */
  function definirFundo(opcoes) {
    // A animação anterior não é fechada aqui — ver a nota em soltarEntrada.
    fundo = { ...opcoes };
    if (typeof opcoes.janela === 'number') janela = Math.min(1, Math.max(0.3, opcoes.janela));
  }

  // ---------------------------------------------------------------- desenho

  function desenhar() {
    if (!vivo) return;

    const agora = performance.now();
    const imagem = fonteAgora(agora);
    if (!imagem) return;

    // A câmera pode ter mudado de resolução entre um quadro e outro.
    ajustarTamanho();

    const { width: L, height: A } = tela;

    if (fundo.tipo === 'nenhum' || janela >= 1) {
      cobrir(ctx, imagem, L, A);
      faixa.requestFrame?.();
      return;
    }

    pintarFundo(imagem, L, A, agora);

    // O recorte é montado à parte e colado inteiro: desenhar a pessoa direto
    // sobre o fundo exigiria recortar o contexto principal, e um clip com
    // borda macia não existe — `clip()` corta na unha, e a emenda dura entre
    // rosto e fundo é justamente o que denuncia o truque.
    recorteCtx.clearRect(0, 0, L, A);
    cobrir(recorteCtx, imagem, L, A);
    aplicarMascara(recorteCtx, L, A);
    ctx.drawImage(recorte, 0, 0);

    faixa.requestFrame?.();
  }

  function pintarFundo(imagem, L, A, agora) {
    if (fundo.tipo === 'cor') {
      ctx.fillStyle = fundo.cor || '#101318';
      ctx.fillRect(0, 0, L, A);
      return;
    }

    if (fundo.tipo === 'midia' && fundo.animacao) {
      const quadro = fundo.animacao.quadro(agora);
      if (quadro) {
        cobrir(ctx, quadro, L, A);
        return;
      }
    }

    // Sobra o desfoque — e é também para onde cai um fundo de mídia que ainda
    // não decodificou o primeiro quadro, porque um retângulo preto por um
    // instante seria pior que a própria imagem borrada.
    //
    // O 1.08 é a folga: o filtro de desfoque puxa transparência das bordas para
    // dentro, e sem esticar um pouco sobraria uma moldura clara em volta.
    ctx.filter = `blur(${Math.round(Math.min(L, A) / 22)}px)`;
    cobrir(ctx, imagem, L, A, 1.08);
    ctx.filter = 'none';
  }

  /**
   * Apaga tudo que estiver fora do oval, com a borda esmaecendo.
   *
   * `destination-in` mantém o que já está no canvas apenas onde a nova forma é
   * opaca — então um gradiente radial vira exatamente a máscara desejada, com
   * a transição de graça.
   */
  function aplicarMascara(alvo, L, A) {
    const cx = L / 2;
    const cy = A / 2;
    const raio = (Math.min(L, A) / 2) * janela;

    alvo.save();
    alvo.globalCompositeOperation = 'destination-in';
    alvo.translate(cx, cy);
    // O oval é mais alto que largo porque é um retrato: um círculo perfeito
    // corta o queixo ou sobra parede dos lados, conforme o enquadramento.
    alvo.scale(1, 1.25);

    const g = alvo.createRadialGradient(0, 0, raio * 0.72, 0, 0, raio);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    alvo.fillStyle = g;
    alvo.fillRect(-L, -A, L * 2, A * 2);
    alvo.restore();
  }

  /**
   * Desenha preenchendo a caixa inteira, cortando o excesso.
   *
   * "Cover" e não "contain": uma webcam não tem tarja preta, e a fonte aqui já
   * chega com a proporção do canvas na maioria dos casos — o corte só entra
   * quando o GIF é quadrado e o quadro não.
   */
  function cobrir(alvo, imagem, L, A, folga = 1) {
    const il = imagem.displayWidth ?? imagem.videoWidth ?? imagem.width;
    const ia = imagem.displayHeight ?? imagem.videoHeight ?? imagem.height;
    if (!il || !ia) return;

    const escala = Math.max(L / il, A / ia) * folga;
    const l = il * escala;
    const a = ia * escala;
    alvo.drawImage(imagem, (L - l) / 2, (A - a) / 2, l, a);
  }

  // ---------------------------------------------------------------- controle

  function definirFps(novo) {
    if (!novo || novo === fps) return;
    fps = novo;
    relogio.intervalo(1000 / fps);
  }

  function parar() {
    vivo = false;
    relogio.parar();
    soltarEntrada();
    fundo = { tipo: 'nenhum' };
    stream.getTracks().forEach((t) => t.stop());
  }

  return {
    stream,
    usarCamera,
    usarAnimacao,
    definirFundo,
    definirFps,
    parar,
    medida: () => ({ l: tela.width, a: tela.height }),
    temEntrada: () => Boolean(entrada),
  };
}

/**
 * Um relógio que não para quando a aba some.
 *
 * `requestAnimationFrame` congela em aba escondida, e `setInterval` na página
 * é afunilado para um disparo por segundo. Os dois são fatais aqui: esta é a
 * aba de captura, e ela existe justamente para ficar em segundo plano enquanto
 * a pessoa volta para o Discord.
 *
 * Dentro de um Worker o afunilamento não se aplica. O código vai por blob para
 * não virar mais um arquivo que precisa ser servido, e o `catch` cobre a
 * hipótese de uma política de conteúdo recusar blob: workers — aí volta o
 * setInterval comum, que ao menos funciona com a aba à frente.
 */
function criarRelogio(aoTick) {
  const codigo =
    'let id = null;' +
    'onmessage = (e) => { clearInterval(id); id = null;' +
    'if (e.data > 0) id = setInterval(() => postMessage(0), e.data); };';

  try {
    const url = URL.createObjectURL(new Blob([codigo], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = () => aoTick();
    return {
      intervalo: (ms) => w.postMessage(Math.max(1, Math.round(ms))),
      parar: () => w.terminate(),
    };
  } catch {
    let id = null;
    return {
      intervalo: (ms) => {
        clearInterval(id);
        id = setInterval(aoTick, Math.max(1, Math.round(ms)));
      },
      parar: () => clearInterval(id),
    };
  }
}
