// @vitest-environment jsdom
/**
 * O GIF, com um ImageDecoder de mentira no lugar do de verdade.
 *
 * O que importa provar aqui é o relógio, e não a decodificação: quem decodifica
 * é o navegador. O relógio é nosso, e é ele que existe justamente porque a aba
 * de captura vive escondida — a pergunta que estes casos respondem é "o quadro
 * troca na hora certa mesmo sem ninguém olhando", que é a única coisa que a
 * abordagem óbvia (um `<img>` animando sozinho) não garantiria.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { carregarAnimacao } from './animacao.js';

/** Um quadro decodificado, com a cara de um VideoFrame. */
function quadroFalso(id, duracaoUs) {
  return {
    id,
    duration: duracaoUs,
    displayWidth: 240,
    displayHeight: 180,
    close: vi.fn(),
  };
}

/**
 * O decodificador de mentira.
 *
 * `decode` resolve numa microtask, como o de verdade — é isso que faz o módulo
 * ter de continuar desenhando o quadro anterior enquanto o próximo não chega.
 */
function prepararDecoder({ quadros = 4, duracaoUs = 100_000, falhaEm = null } = {}) {
  const decodificados = [];
  const fechado = { valor: false };

  globalThis.ImageDecoder = class {
    constructor() {
      this.tracks = {
        ready: Promise.resolve(),
        selectedTrack: { frameCount: quadros },
      };
    }

    decode({ frameIndex }) {
      decodificados.push(frameIndex);
      if (frameIndex === falhaEm) return Promise.reject(new Error('quadro podre'));
      return Promise.resolve({ image: quadroFalso(frameIndex, duracaoUs) });
    }

    close() {
      fechado.valor = true;
    }
  };
  globalThis.ImageDecoder.isTypeSupported = vi.fn(() => Promise.resolve(true));

  return { decodificados, fechado };
}

/** O arquivo: o módulo só lhe pergunta o tipo e os bytes. */
const arquivoFalso = (type = 'image/gif') => ({
  type,
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
});

/** Deixa as promessas de decode assentarem antes da próxima pergunta. */
const assentar = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => {
  globalThis.createImageBitmap = vi.fn(() =>
    Promise.resolve({ width: 64, height: 48, close: vi.fn() }),
  );
});

afterEach(() => {
  delete globalThis.ImageDecoder;
  vi.restoreAllMocks();
});

describe('GIF animado', () => {
  it('abre no primeiro quadro, já com tamanho', async () => {
    prepararDecoder();
    const anim = await carregarAnimacao(arquivoFalso());

    expect(anim.animada).toBe(true);
    expect(anim.largura).toBe(240);
    expect(anim.altura).toBe(180);
    // Sem esperar tick nenhum: quem carrega quer poder desenhar na mesma hora,
    // e um null aqui apareceria como um piscar preto.
    expect(anim.quadro(0).id).toBe(0);
  });

  it('segura o quadro até a duração dele acabar', async () => {
    prepararDecoder({ duracaoUs: 100_000 });
    const anim = await carregarAnimacao(arquivoFalso());

    anim.quadro(0);
    expect(anim.quadro(99).id).toBe(0);

    anim.quadro(100);
    await assentar();
    expect(anim.quadro(100).id).toBe(1);
  });

  it('dá a volta no último quadro', async () => {
    prepararDecoder({ quadros: 2, duracaoUs: 50_000 });
    const anim = await carregarAnimacao(arquivoFalso());

    anim.quadro(0);
    anim.quadro(50);
    await assentar();
    expect(anim.quadro(50).id).toBe(1);

    anim.quadro(100);
    await assentar();
    expect(anim.quadro(100).id).toBe(0);
  });

  it('continua mostrando o anterior enquanto o próximo decodifica', async () => {
    prepararDecoder({ duracaoUs: 10_000 });
    const anim = await carregarAnimacao(arquivoFalso());

    anim.quadro(0);
    // Vencido o prazo, mas antes de a promessa do decode assentar: o que está
    // na tela continua na tela. O contrário seria um quadro preto entre cada
    // dois quadros do GIF.
    expect(anim.quadro(999).id).toBe(0);
    expect(anim.quadro(999).id).toBe(0);
  });

  it('não empilha decodificações enquanto uma está em curso', async () => {
    const { decodificados } = prepararDecoder({ duracaoUs: 10_000 });
    const anim = await carregarAnimacao(arquivoFalso());

    anim.quadro(0);
    for (let i = 0; i < 5; i++) anim.quadro(1000);
    // O de abertura mais um pedido, e não seis: sem a trava, um GIF pesado
    // acumularia uma fila de decodificações que nunca alcança o relógio.
    expect(decodificados).toEqual([0, 1]);
  });

  it('quadro podre não derruba a animação', async () => {
    prepararDecoder({ duracaoUs: 10_000, falhaEm: 1 });
    const anim = await carregarAnimacao(arquivoFalso());

    anim.quadro(0);
    anim.quadro(100);
    await assentar();

    // Fica o anterior, e a vida segue: um GIF meio corrompido vira um GIF com
    // falhas, não uma transmissão morta.
    expect(anim.quadro(150).id).toBe(0);
  });

  it('adota um piso quando o GIF não declara duração', async () => {
    prepararDecoder({ duracaoUs: 0 });
    const anim = await carregarAnimacao(arquivoFalso());

    anim.quadro(0);
    // Duração zero é comum e navegador nenhum a respeita — sem piso, a
    // animação viraria um borrão de CPU.
    expect(anim.quadro(50).id).toBe(0);
    anim.quadro(100);
    await assentar();
    expect(anim.quadro(100).id).toBe(1);
  });

  it('quadro sem duração nenhuma também tem piso', async () => {
    prepararDecoder({ duracaoUs: undefined });
    const anim = await carregarAnimacao(arquivoFalso());

    anim.quadro(0);
    expect(anim.quadro(50).id).toBe(0);
    anim.quadro(100);
    await assentar();
    expect(anim.quadro(100).id).toBe(1);
  });

  it('quadro que chega depois do parar é fechado, não exibido', async () => {
    prepararDecoder({ duracaoUs: 10_000 });
    const anim = await carregarAnimacao(arquivoFalso());

    anim.quadro(0);
    anim.quadro(1000);
    // Parar no meio de uma decodificação é o caso normal de quem fecha a aba:
    // o quadro chega depois e não tem mais onde ser desenhado.
    anim.parar();
    await assentar();

    expect(anim.quadro(2000)).toBeNull();
  });

  it('parar fecha o quadro em uso e o decodificador', async () => {
    const { fechado } = prepararDecoder();
    const anim = await carregarAnimacao(arquivoFalso());

    const atual = anim.quadro(0);
    anim.parar();

    expect(atual.close).toHaveBeenCalled();
    expect(fechado.valor).toBe(true);
    expect(anim.quadro(9999)).toBeNull();
  });
});

describe('imagem parada', () => {
  it('um quadro só não vira animação', async () => {
    const { fechado } = prepararDecoder({ quadros: 1 });
    const anim = await carregarAnimacao(arquivoFalso());

    // Um decodificador vivo pelo resto da transmissão para servir sempre a
    // mesma imagem custaria mais do que o ImageBitmap que o substitui.
    expect(anim.animada).toBe(false);
    expect(fechado.valor).toBe(true);
    expect(anim.largura).toBe(64);
  });

  it('formato fora da lista nem tenta o caminho animado', async () => {
    prepararDecoder();
    const anim = await carregarAnimacao(arquivoFalso('image/bmp'));

    expect(anim.animada).toBe(false);
    expect(globalThis.createImageBitmap).toHaveBeenCalled();
  });

  it('tipo que o decodificador recusa cai para a imagem parada', async () => {
    prepararDecoder();
    globalThis.ImageDecoder.isTypeSupported = vi.fn(() => Promise.resolve(false));

    expect((await carregarAnimacao(arquivoFalso())).animada).toBe(false);
  });

  it('decodificador que explode não derruba o arquivo', async () => {
    prepararDecoder();
    globalThis.ImageDecoder = class {
      constructor() {
        throw new Error('sem memória');
      }
    };
    globalThis.ImageDecoder.isTypeSupported = () => Promise.resolve(true);

    // Arquivo que o ImageDecoder recusa ainda pode ser imagem que o resto do
    // navegador abre.
    expect((await carregarAnimacao(arquivoFalso())).animada).toBe(false);
  });

  it('arquivo sem tipo declarado é tratado como GIF', async () => {
    prepararDecoder();
    const anim = await carregarAnimacao({
      type: '',
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });

    // É o que quase sempre é, e o decodificador confere de verdade — errar
    // aqui custa uma tentativa, não a imagem.
    expect(anim.animada).toBe(true);
  });

  it('faixa sem contagem de quadros não vira animação', async () => {
    prepararDecoder();
    globalThis.ImageDecoder = class {
      constructor() {
        this.tracks = { ready: Promise.resolve(), selectedTrack: null };
      }
      close() {}
    };
    globalThis.ImageDecoder.isTypeSupported = () => Promise.resolve(true);

    expect((await carregarAnimacao(arquivoFalso())).animada).toBe(false);
  });

  it('sem ImageDecoder nenhum, ainda abre', async () => {
    delete globalThis.ImageDecoder;
    const anim = await carregarAnimacao(arquivoFalso());

    expect(anim.animada).toBe(false);
    expect(anim.quadro(0)).toBe(anim.quadro(1_000_000));
    anim.parar();
  });
});
