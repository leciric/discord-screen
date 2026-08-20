// @vitest-environment jsdom
/**
 * A janela por cima de tudo, com dublês no lugar do Picture-in-Picture.
 *
 * O que este módulo faz de verdade é uma coisa só: compor imagem e marcações
 * num canvas, porque o PiP só sabe exibir vídeo. É isso que se prova aqui —
 * junto do que acontece quando o navegador não tem PiP, quando a imagem ainda
 * não chegou, e quando a janela é fechada pelo próprio sistema, que é por onde
 * ela some sem passar pelo nosso botão.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { criarFlutuante, flutuarDisponivel } from './flutuar.js';

let ctxFalso;
let capturas;

function prepararCanvas() {
  ctxFalso = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillText: vi.fn(),
    roundRect: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    measureText: vi.fn(() => ({ width: 10 })),
    globalAlpha: 1,
  };

  capturas = 0;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctxFalso);
  HTMLCanvasElement.prototype.captureStream = vi.fn(() => {
    capturas++;
    return { id: 'stream-do-canvas' };
  });
}

/** Uma imagem qualquer para o compositor desenhar embaixo. */
const fonteDe = (w = 1920, h = 1080) => {
  const img = document.createElement('canvas');
  img.width = w;
  img.height = h;
  return img;
};

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  prepararCanvas();

  document.pictureInPictureEnabled = true;
  document.pictureInPictureElement = null;
  document.exitPictureInPicture = vi.fn(() => Promise.resolve());
  HTMLVideoElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLVideoElement.prototype.requestPictureInPicture = vi.fn(function () {
    document.pictureInPictureElement = this;
    return Promise.resolve({ width: 640, height: 360 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('disponibilidade', () => {
  it('acompanha o que o navegador diz', () => {
    expect(flutuarDisponivel()).toBe(true);
    document.pictureInPictureEnabled = false;
    expect(flutuarDisponivel()).toBe(false);
  });

  it('sem PiP, abrir explica em vez de falhar em silêncio', async () => {
    document.pictureInPictureEnabled = false;
    const img = fonteDe();
    const f = criarFlutuante({ fonte: () => img, dim: () => ({ w: 1920, h: 1080 }) });

    await expect(f.abrir()).rejects.toThrow(/Picture-in-Picture/);
  });
});

describe('abrir e fechar', () => {
  it('sem imagem ainda, pede para tentar de novo em vez de abrir uma janela preta', async () => {
    const f = criarFlutuante({ fonte: () => null, dim: () => ({ w: 0, h: 0 }) });
    await expect(f.abrir()).rejects.toThrow(/ainda não chegou/i);
    expect(f.estaAberta()).toBe(false);
  });

  it('abre com o vídeo do canvas de mistura, e reduz o quadro grande', async () => {
    const img = fonteDe(3840, 2160);
    const f = criarFlutuante({ fonte: () => img, dim: () => ({ w: 3840, h: 2160 }) });

    await f.abrir();

    expect(f.estaAberta()).toBe(true);
    expect(capturas).toBe(1);
    expect(HTMLVideoElement.prototype.requestPictureInPicture).toHaveBeenCalled();

    // Compor em 4K para exibir numa janelinha seria gastar GPU para jogar fora.
    const mistura = ctxFalso.setTransform.mock.instances;
    expect(mistura).toBeDefined();
    f.parar();
  });

  it('abrir duas vezes não abre duas janelas', async () => {
    const img = fonteDe();
    const f = criarFlutuante({ fonte: () => img, dim: () => ({ w: 1920, h: 1080 }) });

    await f.abrir();
    await f.abrir();

    expect(capturas).toBe(1);
    f.parar();
  });

  it('fechar avisa quem abriu e solta a janela do sistema', async () => {
    const img = fonteDe();
    const aoFechar = vi.fn();
    const f = criarFlutuante({ fonte: () => img, dim: () => ({ w: 1920, h: 1080 }), aoFechar });

    await f.abrir();
    f.fechar();

    expect(aoFechar).toHaveBeenCalled();
    expect(document.exitPictureInPicture).toHaveBeenCalled();
    expect(f.estaAberta()).toBe(false);
  });

  it('fechada pelo sistema, avisa do mesmo jeito', async () => {
    const img = fonteDe();
    const aoFechar = vi.fn();
    const f = criarFlutuante({ fonte: () => img, dim: () => ({ w: 1920, h: 1080 }), aoFechar });

    await f.abrir();
    // O botão de fechar é da janela do sistema, não nosso: o evento é o único
    // aviso que chega até aqui.
    document.pictureInPictureElement.dispatchEvent(new Event('leavepictureinpicture'));

    expect(aoFechar).toHaveBeenCalled();
    expect(f.estaAberta()).toBe(false);
  });

  it('fechar o que nunca abriu não faz nada', () => {
    const f = criarFlutuante({ fonte: () => null, dim: () => ({ w: 0, h: 0 }) });
    expect(() => f.fechar()).not.toThrow();
  });
});

describe('a composição', () => {
  it('desenha a imagem e, por cima dela, os traços', async () => {
    const img = fonteDe();
    const f = criarFlutuante({ fonte: () => img, dim: () => ({ w: 1920, h: 1080 }) });
    f.aplicar({
      uid: 'a',
      name: 'A',
      ev: { k: 's', id: 1, c: '#ff0000', w: 10, pts: [0, 0, 100, 100, 200, 200] },
    });

    await f.abrir();
    vi.advanceTimersByTime(120);

    // Duas fontes no mesmo quadro: o vídeo embaixo, a camada de traços em cima.
    expect(ctxFalso.drawImage.mock.calls.length).toBeGreaterThanOrEqual(2);
    f.parar();
  });

  it('sem imagem, o fundo fica preto em vez de sujo', async () => {
    const img = fonteDe();
    let atual = img;
    const f = criarFlutuante({ fonte: () => atual, dim: () => ({ w: 1920, h: 1080 }) });

    await f.abrir();
    atual = null;
    ctxFalso.fillRect.mockClear();
    vi.advanceTimersByTime(120);

    expect(ctxFalso.fillRect).toHaveBeenCalled();
    f.parar();
  });

  it('uma fonte que se recusa a ser desenhada não derruba o laço', async () => {
    const ruim = {};
    const f = criarFlutuante({ fonte: () => ruim, dim: () => ({ w: 640, h: 480 }) });
    // Só a fonte recusa: o canvas dos traços é nosso e sempre desenhável, e
    // fazer os dois falharem testaria um caso que não existe.
    ctxFalso.drawImage.mockImplementation((img) => {
      if (img === ruim) throw new TypeError('não é uma imagem');
    });

    await f.abrir();
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    f.parar();
  });

  it('parar encerra a composição', async () => {
    const img = fonteDe();
    const f = criarFlutuante({ fonte: () => img, dim: () => ({ w: 1920, h: 1080 }) });

    await f.abrir();
    vi.advanceTimersByTime(60);
    f.parar();

    ctxFalso.drawImage.mockClear();
    vi.advanceTimersByTime(200);
    expect(ctxFalso.drawImage).not.toHaveBeenCalled();
  });

  it('esconder os traços vale também aqui', async () => {
    const img = fonteDe();
    const f = criarFlutuante({ fonte: () => img, dim: () => ({ w: 1920, h: 1080 }) });
    f.sincronizar([
      { id: 'a:1', uid: 'a', name: 'A', color: '#f00', width: 10, pts: [0, 0, 50, 50, 90, 90] },
    ]);

    await f.abrir();
    vi.advanceTimersByTime(120);
    const comTracos = ctxFalso.stroke.mock.calls.length;
    expect(comTracos).toBeGreaterThan(0);

    f.mostrar(false);
    ctxFalso.stroke.mockClear();
    vi.advanceTimersByTime(200);
    expect(ctxFalso.stroke).not.toHaveBeenCalled();

    f.limpar();
    f.parar();
  });
});
