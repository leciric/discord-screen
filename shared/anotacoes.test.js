// @vitest-environment jsdom
/**
 * A camada de anotações, com um dublê no lugar do canvas.
 *
 * O que sai na tela é pixel, e pixel se confere no navegador. O que se prova
 * aqui é o que decide o pixel: a conta que diz onde a imagem está dentro da
 * caixa, a que normaliza um ponto para a grade do vídeo, e a máquina de estado
 * dos traços — que é o que precisa concordar com a do servidor, senão duas
 * pessoas veem desenhos diferentes da mesma tela.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CORES, ESPESSURAS, GRADE, conter, criarCamada, paraGrade } from './anotacoes.js';

/** Canvas 2D no contrato que a camada usa, registrando o que foi chamado. */
function canvasFalso() {
  const ctx = {
    chamadas: [],
    globalAlpha: 1,
    canvas: null,
  };

  const metodos = [
    'setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo',
    'arc', 'fill', 'stroke', 'save', 'restore', 'fillText', 'roundRect', 'fillRect',
  ];
  for (const m of metodos) ctx[m] = vi.fn((...args) => ctx.chamadas.push([m, ...args]));
  ctx.createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
  ctx.measureText = vi.fn((t) => ({ width: t.length * 6 }));

  const canvas = { width: 0, height: 0, getContext: () => ctx };
  ctx.canvas = canvas;
  return { canvas, ctx };
}

const vistaCheia = () => ({ boxW: 400, boxH: 300, x: 0, y: 0, w: 400, h: 300 });

/** A camada pinta no rAF; o teste roda os quadros pendentes na mão. */
function pintar() {
  vi.advanceTimersByTime(20);
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom não tem rAF ligado ao relógio falso; este o liga.
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});

// ------------------------------------------------------------------ geometria

describe('conter', () => {
  it('centra a imagem larga na horizontal e deixa tarja em cima e embaixo', () => {
    // 16:9 dentro de uma caixa quadrada.
    expect(conter(400, 400, 1600, 900)).toEqual({ x: 0, y: 87.5, w: 400, h: 225 });
  });

  it('centra a imagem alta na vertical', () => {
    expect(conter(400, 400, 900, 1600)).toEqual({ x: 87.5, y: 0, w: 225, h: 400 });
  });

  it('sem tamanho conhecido devolve a caixa inteira, em vez de dividir por zero', () => {
    expect(conter(400, 300, 0, 0)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });
});

describe('paraGrade', () => {
  const v = { x: 100, y: 50, w: 200, h: 100 };

  it('o canto da imagem é a origem da grade', () => {
    expect(paraGrade(100, 50, v)).toMatchObject({ x: 0, y: 0, dentro: true });
  });

  it('o meio da imagem é o meio da grade, independente de onde ela está na caixa', () => {
    const meio = paraGrade(200, 100, v);
    expect(meio.x).toBe(Math.round(GRADE / 2));
    expect(meio.y).toBe(Math.round(GRADE / 2));
  });

  it('fora da imagem marca "dentro: false" e ainda assim entrega ponto na borda', () => {
    // A tarja preta não é conteúdo: quem desenha ali não pode virar coordenada
    // negativa do outro lado.
    const fora = paraGrade(50, 50, v);
    expect(fora.dentro).toBe(false);
    expect(fora.x).toBe(0);
  });

  it('sem vista não há ponto', () => {
    expect(paraGrade(1, 1, null)).toBeNull();
    expect(paraGrade(1, 1, { w: 0, h: 0 })).toBeNull();
  });
});

describe('a paleta', () => {
  it('tem cores em hexadecimal, que é o que o servidor valida', () => {
    for (const cor of CORES) expect(cor).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('as espessuras cabem no teto que o servidor aceita', () => {
    for (const e of Object.values(ESPESSURAS)) {
      expect(e).toBeGreaterThan(0);
      expect(e).toBeLessThanOrEqual(64);
    }
  });
});

// --------------------------------------------------------------------- estado

describe('a camada', () => {
  it('desenha um traço recebido, e nada antes de receber', () => {
    const { canvas, ctx } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    pintar();
    expect(ctx.stroke).not.toHaveBeenCalled();

    camada.aplicar({ uid: 'a', name: 'A', ev: { k: 's', id: 1, c: '#ff0000', w: 10, pts: [0, 0, 100, 100, 200, 200] } });
    pintar();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it('continuar um traço acrescenta pontos ao mesmo traço', () => {
    const { canvas } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    camada.aplicar({ uid: 'a', name: 'A', ev: { k: 's', id: 1, c: '#f00', w: 10, pts: [0, 0] } });
    camada.aplicar({ uid: 'a', name: 'A', ev: { k: 'a', id: 1, pts: [10, 10] } });

    expect(camada.instantaneo()).toHaveLength(1);
    expect(camada.instantaneo()[0].pts).toEqual([0, 0, 10, 10]);
  });

  it('desfazer tira o último traço de quem pediu, e só dele', () => {
    const { canvas } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    for (const [uid, id] of [['a', 1], ['b', 2], ['a', 3]]) {
      camada.aplicar({ uid, name: uid, ev: { k: 's', id, c: '#f00', w: 10, pts: [0, 0, 1, 1] } });
    }
    camada.aplicar({ uid: 'a', ev: { k: 'u' } });

    expect(camada.instantaneo().map((t) => t.id)).toEqual(['a:1', 'b:2']);
  });

  it('apagar o meu não encosta no dos outros; limpar tudo leva os dois', () => {
    const { canvas } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    camada.aplicar({ uid: 'a', ev: { k: 's', id: 1, c: '#f00', w: 10, pts: [0, 0, 1, 1] } });
    camada.aplicar({ uid: 'b', ev: { k: 's', id: 2, c: '#f00', w: 10, pts: [0, 0, 1, 1] } });

    camada.aplicar({ uid: 'a', ev: { k: 'c' } });
    expect(camada.instantaneo().map((t) => t.uid)).toEqual(['b']);

    camada.aplicar({ uid: 'b', ev: { k: 'ca' } });
    expect(camada.instantaneo()).toHaveLength(0);
  });

  it('sincronizar substitui o estado, que é o que quem chega no meio recebe', () => {
    const { canvas } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    camada.aplicar({ uid: 'a', ev: { k: 's', id: 9, c: '#f00', w: 10, pts: [0, 0, 1, 1] } });
    camada.sincronizar([{ id: 'z:1', uid: 'z', name: 'Z', color: '#0f0', width: 5, pts: [2, 2, 3, 3] }]);

    expect(camada.instantaneo()).toHaveLength(1);
    expect(camada.instantaneo()[0].uid).toBe('z');
  });

  it('o instantâneo é uma cópia: mexer nele não mexe na camada', () => {
    const { canvas } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    camada.aplicar({ uid: 'a', ev: { k: 's', id: 1, c: '#f00', w: 10, pts: [0, 0, 1, 1] } });
    camada.instantaneo()[0].pts.push(999, 999);

    expect(camada.instantaneo()[0].pts).toEqual([0, 0, 1, 1]);
  });

  it('evento sem dono ou sem tipo não vira estado', () => {
    const { canvas } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    camada.aplicar({ ev: { k: 's', id: 1, pts: [0, 0] } });
    camada.aplicar({ uid: 'a', ev: null });
    camada.aplicar({ uid: 'a', ev: { k: 'nada' } });

    expect(camada.instantaneo()).toHaveLength(0);
  });

  it('não guarda traço sem teto: os mais antigos saem', () => {
    const { canvas } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    for (let i = 1; i <= 450; i++) {
      camada.aplicar({ uid: 'a', ev: { k: 's', id: i, c: '#f00', w: 10, pts: [0, 0, 1, 1] } });
    }

    expect(camada.instantaneo().length).toBeLessThanOrEqual(400);
    // O que ficou é o fim da fila, não o começo.
    expect(camada.instantaneo().at(-1).id).toBe('a:450');
  });

  it('escondido não pinta nada, e mostrar de novo traz o que chegou no escuro', () => {
    const { canvas, ctx } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    camada.aplicar({ uid: 'a', ev: { k: 's', id: 1, c: '#f00', w: 10, pts: [0, 0, 1, 1, 2, 2] } });
    pintar();
    expect(ctx.stroke).toHaveBeenCalled();

    camada.mostrar(false);
    ctx.stroke.mockClear();
    pintar();
    camada.aplicar({ uid: 'a', ev: { k: 's', id: 2, c: '#f00', w: 10, pts: [0, 0, 5, 5, 9, 9] } });
    pintar();
    expect(ctx.stroke).not.toHaveBeenCalled();
    // O estado seguiu chegando: é o que faz voltar a mostrar não custar nada.
    expect(camada.instantaneo()).toHaveLength(2);

    camada.mostrar(true);
    pintar();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it('sem caixa não pinta, e volta a pintar quando ela existe', () => {
    const { canvas, ctx } = canvasFalso();
    let v = null;
    const camada = criarCamada(canvas, { vista: () => v });

    camada.aplicar({ uid: 'a', ev: { k: 's', id: 1, c: '#f00', w: 10, pts: [0, 0, 1, 1, 2, 2] } });
    pintar();
    expect(ctx.stroke).not.toHaveBeenCalled();

    v = vistaCheia();
    camada.repintar();
    pintar();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it('o laser some sozinho depois de parado', () => {
    const { canvas, ctx } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    camada.aplicar({ uid: 'a', name: 'A', ev: { k: 'p', x: 100, y: 100, c: '#f00' } });
    pintar();
    expect(ctx.arc).toHaveBeenCalled();

    // Passada a vida do ponto, o quadro seguinte não desenha mais nada.
    vi.advanceTimersByTime(3000);
    ctx.arc.mockClear();
    camada.repintar();
    pintar();
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it('tirar o laser da tela o apaga na hora', () => {
    const { canvas, ctx } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    camada.aplicar({ uid: 'a', name: 'A', ev: { k: 'p', x: 10, y: 10, c: '#f00' } });
    pintar();
    ctx.arc.mockClear();

    camada.aplicar({ uid: 'a', ev: { k: 'po' } });
    pintar();
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it('um toque só vira bolinha, senão nada apareceria', () => {
    const { canvas, ctx } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    camada.aplicar({ uid: 'a', ev: { k: 's', id: 1, c: '#f00', w: 10, pts: [50, 50] } });
    pintar();

    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it('o canvas acompanha a caixa, e parar solta tudo', () => {
    const { canvas } = canvasFalso();
    const camada = criarCamada(canvas, { vista: vistaCheia });

    camada.aplicar({ uid: 'a', ev: { k: 's', id: 1, c: '#f00', w: 10, pts: [0, 0, 1, 1] } });
    pintar();
    expect(canvas.width).toBeGreaterThan(0);

    camada.parar();
    expect(camada.instantaneo()).toHaveLength(0);
    expect(camada.vazio()).toBe(true);
  });
});
