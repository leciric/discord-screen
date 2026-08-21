// @vitest-environment jsdom
/**
 * O estúdio, com canvas e relógio de mentira.
 *
 * Não dá para inspecionar pixel nenhum aqui — jsdom não pinta. O que dá para
 * provar, e é o que interessa, é a decisão: qual desenho sai em qual modo, em
 * que ordem, com que tamanho, e quem é dono do que quando tudo se desliga.
 *
 * Esse último ponto é o que mais custou a acertar: um GIF pode ser a entrada
 * agora e o fundo daqui a pouco, então o estúdio não pode fechar nada que ele
 * apenas recebeu. Dois casos aqui embaixo existem só para trancar isso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { criarEstudio } from './estudio.js';

let ctxs;
let faixa;
let stream;
let relogios;

/** Uma animação carregada, do jeito que animacao.js a devolve. */
const animacaoFalsa = (largura = 400, altura = 300, marca = 'gif') => ({
  largura,
  altura,
  animada: true,
  quadro: vi.fn(() => ({ marca, displayWidth: largura, displayHeight: altura })),
  parar: vi.fn(),
});

function contextoFalso() {
  const ctx = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    filter: 'none',
    fillStyle: '',
    globalCompositeOperation: 'source-over',
  };
  // Os valores são anotados no instante do desenho, e não lidos no fim: o
  // dublê não desfaz nada no `restore`, então só o valor final sobreviveria — e
  // é justamente o valor de durante que estes testes querem provar.
  ctx.filtrosNoDesenho = [];
  ctx.composicaoNoPreenchimento = [];
  const desenhar = ctx.drawImage;
  ctx.drawImage = vi.fn((...args) => {
    ctx.filtrosNoDesenho.push(ctx.filter);
    return desenhar(...args);
  });
  const preencher = ctx.fillRect;
  ctx.fillRect = vi.fn((...args) => {
    ctx.composicaoNoPreenchimento.push(ctx.globalCompositeOperation);
    return preencher(...args);
  });
  return ctx;
}

beforeEach(() => {
  ctxs = [];
  relogios = [];
  // O documento é o mesmo para o arquivo inteiro: sem limpar, os `<video>` de
  // um caso são contados no seguinte.
  document.body.replaceChildren();

  faixa = { kind: 'video', requestFrame: vi.fn(), stop: vi.fn() };
  stream = {
    getVideoTracks: () => [faixa],
    getTracks: () => [faixa],
  };

  HTMLCanvasElement.prototype.getContext = vi.fn(() => {
    const ctx = contextoFalso();
    ctxs.push(ctx);
    return ctx;
  });
  HTMLCanvasElement.prototype.captureStream = vi.fn(() => stream);
  HTMLVideoElement.prototype.play = vi.fn(() => Promise.resolve());

  // O Worker do relógio: guardado para os testes poderem disparar o tick à mão
  // em vez de esperar o tempo passar.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:relogio');
  globalThis.URL.revokeObjectURL = vi.fn();
  globalThis.Worker = class {
    constructor() {
      this.intervalos = [];
      this.onmessage = null;
      relogios.push(this);
    }
    postMessage(ms) {
      this.intervalos.push(ms);
    }
    terminate() {
      this.morto = true;
    }
  };
});

afterEach(() => {
  delete globalThis.Worker;
  vi.restoreAllMocks();
});

/** O canvas principal é o primeiro contexto pedido; o do recorte é o segundo. */
const principal = () => ctxs[0];
const recorte = () => ctxs[1];

const tick = () => relogios[0].onmessage();

describe('a faixa que sai', () => {
  it('nasce pedindo quadro a quadro, no ritmo escolhido', () => {
    criarEstudio({ fps: 25 });

    // captureStream(0): sem taxa própria, o único jeito de sair um quadro é
    // pedindo — e é isso que permite trocar de taxa sem refazer a faixa.
    expect(HTMLCanvasElement.prototype.captureStream).toHaveBeenCalledWith(0);
    expect(relogios[0].intervalos).toEqual([40]);
  });

  it('sem entrada nenhuma não entrega quadro', () => {
    criarEstudio();
    tick();

    expect(faixa.requestFrame).not.toHaveBeenCalled();
    expect(principal().drawImage).not.toHaveBeenCalled();
  });

  it('trocar a taxa reprograma o relógio', () => {
    const e = criarEstudio({ fps: 30 });
    e.definirFps(60);
    e.definirFps(60);

    // A repetição não vale um postMessage: o valor já é esse.
    expect(relogios[0].intervalos).toEqual([1000 / 30, 1000 / 60].map(Math.round));
  });
});

describe('um GIF no lugar da câmera', () => {
  it('o canvas assume o tamanho do GIF', () => {
    const e = criarEstudio();
    e.usarAnimacao(animacaoFalsa(400, 300));

    expect(e.medida()).toEqual({ l: 400, a: 300 });
  });

  it('desce ao teto de resolução, em números pares', () => {
    const e = criarEstudio();
    e.usarAnimacao(animacaoFalsa(3841, 2161));

    const { l, a } = e.medida();
    expect(l).toBeLessThanOrEqual(1280);
    expect(a).toBeLessThanOrEqual(720);
    // Dimensão ímpar quebra o encoder, que trabalha em blocos de 2.
    expect(l % 2).toBe(0);
    expect(a % 2).toBe(0);
  });

  it('cada tick desenha o quadro da vez e entrega', () => {
    const e = criarEstudio();
    const anim = animacaoFalsa();
    e.usarAnimacao(anim);

    tick();
    tick();

    expect(anim.quadro).toHaveBeenCalledTimes(2);
    expect(principal().drawImage).toHaveBeenCalledTimes(2);
    expect(faixa.requestFrame).toHaveBeenCalledTimes(2);
  });

  it('animação que ainda não tem quadro não vira quadro preto', () => {
    const e = criarEstudio();
    const anim = animacaoFalsa();
    anim.quadro = vi.fn(() => null);
    e.usarAnimacao(anim);

    tick();

    expect(principal().drawImage).not.toHaveBeenCalled();
    expect(faixa.requestFrame).not.toHaveBeenCalled();
  });
});

describe('a câmera', () => {
  /** Um `<video>` que já tem imagem, para o desenho poder acontecer. */
  function comCamera(e) {
    e.usarCamera({ getTracks: () => [], getVideoTracks: () => [] });
    const video = document.querySelector('video');
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true });
    return video;
  }

  it('o vídeo vai para o documento, fora de vista', () => {
    const e = criarEstudio();
    const video = comCamera(e);

    // Solto ele não decodifica em todo navegador, e display:none chega a
    // pausar a reprodução.
    expect(video.isConnected).toBe(true);
    expect(video.style.position).toBe('fixed');
    expect(video.muted).toBe(true);
  });

  it('vídeo pausado volta a tocar sozinho', () => {
    const e = criarEstudio();
    const video = comCamera(e);
    Object.defineProperty(video, 'paused', { value: true, configurable: true });

    tick();

    // Aba escondida pode pausar o elemento, e uma imagem congelada não diz
    // por quê.
    expect(video.play).toHaveBeenCalled();
  });

  it('trocar de câmera não deixa dois vídeos para trás', () => {
    const e = criarEstudio();
    comCamera(e);
    comCamera(e);

    expect(document.querySelectorAll('video')).toHaveLength(1);
  });
});

describe('o fundo', () => {
  function comAnimacao(fundo) {
    const e = criarEstudio();
    e.usarAnimacao(animacaoFalsa(640, 480));
    if (fundo) e.definirFundo(fundo);
    return e;
  }

  it('sem fundo, um desenho só e nenhum recorte', () => {
    comAnimacao();
    tick();

    expect(principal().drawImage).toHaveBeenCalledTimes(1);
    expect(recorte().drawImage).not.toHaveBeenCalled();
  });

  it('cor sólida pinta atrás e recorta na frente', () => {
    comAnimacao({ tipo: 'cor', cor: '#ff00ff', janela: 0.6 });
    tick();

    expect(principal().fillStyle).toBe('#ff00ff');
    expect(principal().composicaoNoPreenchimento).toEqual(['source-over']);
    // O recorte é montado à parte e colado inteiro: `clip()` cortaria na unha,
    // e a emenda dura é o que denuncia o truque.
    expect(recorte().drawImage).toHaveBeenCalled();
    // `destination-in` é o que faz o gradiente virar máscara: mantém o que já
    // está no canvas só onde a forma nova é opaca, e a borda esmaece de graça.
    expect(recorte().composicaoNoPreenchimento).toEqual(['destination-in']);
    expect(recorte().createRadialGradient).toHaveBeenCalled();
    expect(recorte().restore).toHaveBeenCalled();
  });

  it('desfoque borra o fundo e devolve o filtro ao normal', () => {
    comAnimacao({ tipo: 'desfoque', janela: 0.6 });
    tick();

    expect(principal().filtrosNoDesenho[0]).toMatch(/^blur\(\d+px\)$/);
    // Sem devolver, o recorte colado por cima sairia borrado junto.
    expect(principal().filter).toBe('none');
  });

  it('mídia de fundo desenha o quadro dela, não a câmera borrada', () => {
    const e = criarEstudio();
    e.usarAnimacao(animacaoFalsa(640, 480, 'frente'));
    const atras = animacaoFalsa(640, 480, 'tras');
    e.definirFundo({ tipo: 'midia', animacao: atras, janela: 0.6 });

    tick();

    expect(atras.quadro).toHaveBeenCalled();
    expect(principal().drawImage.mock.calls[0][0].marca).toBe('tras');
    expect(recorte().drawImage.mock.calls[0][0].marca).toBe('frente');
  });

  it('fundo de mídia sem quadro ainda cai no desfoque', () => {
    const e = criarEstudio();
    e.usarAnimacao(animacaoFalsa());
    const atras = animacaoFalsa();
    atras.quadro = vi.fn(() => null);
    e.definirFundo({ tipo: 'midia', animacao: atras, janela: 0.6 });

    tick();

    // Um retângulo preto por um instante seria pior que a imagem borrada.
    expect(principal().filtrosNoDesenho[0]).toMatch(/^blur/);
  });

  it('recorte inteiro é o mesmo que não recortar', () => {
    comAnimacao({ tipo: 'cor', cor: '#000', janela: 1 });
    tick();

    expect(principal().fillRect).not.toHaveBeenCalled();
    expect(recorte().drawImage).not.toHaveBeenCalled();
  });

  it('o recorte tem piso e teto', () => {
    const e = comAnimacao({ tipo: 'cor', cor: '#000', janela: 5 });
    tick();
    // 5 vira 1, e 1 dispensa o recorte.
    expect(recorte().drawImage).not.toHaveBeenCalled();

    e.definirFundo({ tipo: 'cor', cor: '#000', janela: 0 });
    tick();
    // 0 vira o piso de 0.3, e aí há recorte.
    expect(recorte().drawImage).toHaveBeenCalled();
  });
});

describe('quem é dono do quê', () => {
  it('trocar de entrada não fecha a animação que chegou de fora', () => {
    const e = criarEstudio();
    const anim = animacaoFalsa();
    e.usarAnimacao(anim);
    e.usarCamera({ getTracks: () => [], getVideoTracks: () => [] });

    // Ela pode virar o fundo no clique seguinte; fechá-la aqui apagaria uma
    // imagem que quem chamou ainda está usando.
    expect(anim.parar).not.toHaveBeenCalled();
  });

  it('parar fecha o que é seu, e só', () => {
    const e = criarEstudio();
    const entrada = animacaoFalsa();
    const fundo = animacaoFalsa();
    e.usarAnimacao(entrada);
    e.definirFundo({ tipo: 'midia', animacao: fundo, janela: 0.6 });

    e.parar();

    expect(faixa.stop).toHaveBeenCalled();
    expect(relogios[0].morto).toBe(true);
    expect(document.querySelectorAll('video')).toHaveLength(0);
    expect(entrada.parar).not.toHaveBeenCalled();
    expect(fundo.parar).not.toHaveBeenCalled();
  });

  it('depois de parar, tick não desenha mais nada', () => {
    const e = criarEstudio();
    e.usarAnimacao(animacaoFalsa());
    e.parar();
    tick();

    expect(principal().drawImage).not.toHaveBeenCalled();
  });

  it('temEntrada responde o que está montado', () => {
    const e = criarEstudio();
    expect(e.temEntrada()).toBe(false);
    e.usarAnimacao(animacaoFalsa());
    expect(e.temEntrada()).toBe(true);
  });
});

/** Um `<video>` com a câmera e imagem pronta, para o desenho poder acontecer. */
function comCameraPronta(e) {
  e.usarCamera({ getTracks: () => [], getVideoTracks: () => [] });
  const video = document.querySelector('video');
  for (const [prop, value] of [
    ['readyState', 4],
    ['videoWidth', 640],
    ['videoHeight', 480],
  ]) {
    Object.defineProperty(video, prop, { value, configurable: true });
  }
  return video;
}

describe('o desenho que preenche a caixa', () => {
  /** Uma fonte com a cara de ImageBitmap: só `width`/`height`. */
  const bitmapFalso = (width, height) => ({ width, height });

  it('aceita fonte que só tem width/height', () => {
    const e = criarEstudio();
    const anim = animacaoFalsa(400, 300);
    anim.quadro = vi.fn(() => bitmapFalso(400, 300));
    e.usarAnimacao(anim);

    tick();

    // ImageBitmap não tem displayWidth; ler só ele deixaria o desenho de fora
    // sem erro nenhum, que é a pior forma de quebrar.
    expect(principal().drawImage).toHaveBeenCalled();
  });

  it('fonte sem tamanho não é desenhada', () => {
    const e = criarEstudio();
    const anim = animacaoFalsa(400, 300);
    anim.quadro = vi.fn(() => bitmapFalso(0, 0));
    e.usarAnimacao(anim);

    tick();

    expect(principal().drawImage).not.toHaveBeenCalled();
  });

  it('recorta a sobra em vez de deixar tarja preta', () => {
    const e = criarEstudio();
    // Um GIF quadrado num canvas quadrado: a escala tem de ser exata.
    e.usarAnimacao(animacaoFalsa(400, 400));
    tick();

    const [, x, y, l, a] = principal().drawImage.mock.calls[0];
    expect({ x, y, l, a }).toEqual({ x: 0, y: 0, l: 400, a: 400 });
  });
});

describe('cantos', () => {
  it('faixa sem requestFrame não derruba o desenho', () => {
    delete faixa.requestFrame;
    const e = criarEstudio();
    e.usarAnimacao(animacaoFalsa());

    // Navegador que não implementa o pedido entrega no ritmo dele; é pior, não
    // é quebrado.
    expect(() => tick()).not.toThrow();
  });

  it('vídeo tocando não leva play de novo', () => {
    const e = criarEstudio();
    const video = comCameraPronta(e);
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    video.play.mockClear();

    tick();

    expect(video.play).not.toHaveBeenCalled();
    expect(principal().drawImage).toHaveBeenCalled();
  });

  it('fonte com altura zero não redimensiona o canvas', () => {
    const e = criarEstudio();
    e.usarAnimacao(animacaoFalsa(400, 0));

    // Metadados que ainda não chegaram: escrever 400x0 no canvas o deixaria
    // inutilizável até a próxima mudança de tamanho.
    expect(e.medida()).toEqual({ l: 1280, a: 720 });
  });

  it('fundo sem cor e sem recorte declarados usa os padrões', () => {
    const e = criarEstudio();
    e.usarAnimacao(animacaoFalsa(640, 480));
    e.definirFundo({ tipo: 'cor' });

    tick();

    expect(principal().fillStyle).toBe('#101318');
    // Sem `janela` no objeto, vale o que já estava — e o padrão recorta.
    expect(recorte().drawImage).toHaveBeenCalled();
  });

  it('taxa zero é ignorada', () => {
    const e = criarEstudio({ fps: 30 });
    e.definirFps(0);
    expect(relogios[0].intervalos).toEqual([Math.round(1000 / 30)]);
  });

  it('sem taxa escolhida, trinta por segundo', () => {
    criarEstudio();
    expect(relogios[0].intervalos).toEqual([Math.round(1000 / 30)]);
  });

  it('câmera ainda sem imagem não desenha nada', () => {
    const e = criarEstudio();
    e.usarCamera({ getTracks: () => [], getVideoTracks: () => [] });

    // readyState 0: o `<video>` existe, mas não há quadro nenhum nele.
    tick();
    expect(principal().drawImage).not.toHaveBeenCalled();
    expect(e.medida()).toEqual({ l: 1280, a: 720 });
  });
});

describe('sem Worker', () => {
  it('cai para o relógio comum em vez de desistir', () => {
    // Política de conteúdo que recusa blob: workers é o caso real. A aba à
    // frente continua funcionando; só o segundo plano perde o ritmo.
    vi.useFakeTimers();
    globalThis.URL.createObjectURL = () => {
      throw new Error('blob: bloqueado');
    };

    const e = criarEstudio({ fps: 50 });
    e.usarAnimacao(animacaoFalsa());
    vi.advanceTimersByTime(60);

    expect(faixa.requestFrame).toHaveBeenCalled();
    e.parar();
    vi.useRealTimers();
  });
});
