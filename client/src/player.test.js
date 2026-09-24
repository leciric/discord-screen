/**
 * O relógio do player.
 *
 * O que se testa aqui não é decodificação — é ritmo. Os quadros são capturados
 * em intervalos cravados e chegam em intervalos irregulares; a função deste
 * módulo é devolver o intervalo original na hora de desenhar. Um erro nessa
 * conta não aparece como imagem errada, aparece como solavanco, e solavanco não
 * quebra teste nenhum a menos que alguém escreva estes.
 *
 * Sem navegador: o player só chama `getContext`, `drawImage` e `requestAnimationFrame`.
 * Um canvas de mentira e um relógio na mão cobrem tudo, e cobrem mais depressa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayer } from './player.js';

const BUFFER_MS = 80;
const KEYFRAME = 1;
const DELTA = 2;
// Mesmo valor de PISO_JANELA_MS em player.js — não exportado, então duplicado
// aqui como os outros parâmetros de tempo deste arquivo (ver BUFFER_MS acima).
const PISO_JANELA_MS = 60_000;

let agora = 0;
let pendentes = [];
let desenhados = [];
/** Em que instante cada quadro de `desenhados` foi para a tela. */
let momentos = [];
/** O ultimo decodificador que o player criou, para o teste mexer na fila dele. */
let ultimoDecoder = null;

/** Canvas de mentira: o player só olha getContext, width/height e o retângulo. */
function canvasFalso() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (frame) => {
        desenhados.push(frame.timestamp / 1000);
        momentos.push(agora);
      },
      fillRect: () => {},
      set fillStyle(_) {},
    }),
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  };
}

/** Avança o relógio e roda os callbacks de animação que venceram. */
function avancar(ms, passo = 16) {
  const alvo = agora + ms;
  while (agora < alvo) {
    agora = Math.min(alvo, agora + passo);
    const rodando = pendentes;
    pendentes = [];
    for (const cb of rodando) cb(agora);
  }
}

/** Um pacote no formato do relay: [slot][tipo][timestamp][relógio][payload] */
function pacote(tipoDoQuadro, timestampMs) {
  const buffer = new ArrayBuffer(20);
  const view = new DataView(buffer);
  view.setUint8(0, 0);
  view.setUint8(1, tipoDoQuadro);
  view.setFloat64(2, timestampMs * 1000);
  view.setFloat64(10, Date.now());
  return buffer;
}

beforeEach(() => {
  agora = 1000;
  pendentes = [];
  desenhados = [];
  momentos = [];
  ultimoDecoder = null;

  vi.spyOn(performance, 'now').mockImplementation(() => agora);
  globalThis.requestAnimationFrame = (cb) => {
    pendentes.push(cb);
    return pendentes.length;
  };
  globalThis.cancelAnimationFrame = () => {};

  // Decodificador de mentira: entrega o quadro na hora, que é o pior caso para
  // o agendamento — nenhum atraso de decodificação para esconder erro de conta.
  globalThis.VideoDecoder = class {
    constructor({ output }) {
      this.output = output;
      this.state = 'unconfigured';
      // O de verdade tem fila; o teste a controla na mao para poder simular um
      // decodificador que nao esta dando conta.
      this.decodeQueueSize = 0;
      ultimoDecoder = this;
    }
    configure() {
      this.state = 'configured';
    }
    decode(chunk) {
      this.decodificados++;
      this.output({
        timestamp: chunk.timestamp,
        displayWidth: 1280,
        displayHeight: 720,
        close: vi.fn(),
      });
    }
    close() {
      this.state = 'closed';
    }
  };
  globalThis.VideoDecoder.prototype.decodificados = 0;
  globalThis.EncodedVideoChunk = class {
    constructor(init) {
      Object.assign(this, init);
    }
  };
  globalThis.window = { VideoDecoder: globalThis.VideoDecoder };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.window;
});

function player() {
  const p = createPlayer(canvasFalso(), {});
  expect(p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 })).toBe(true);
  return p;
}

describe('ritmo de exibição', () => {
  it('não desenha o quadro na chegada — ele espera a vez', () => {
    const p = player();

    p.push(pacote(KEYFRAME, 0));
    avancar(BUFFER_MS - 32);

    expect(desenhados).toHaveLength(0);
  });

  it('desenha depois da espera combinada', () => {
    const p = player();

    p.push(pacote(KEYFRAME, 0));
    avancar(BUFFER_MS + 32);

    expect(desenhados).toEqual([0]);
  });

  it('devolve o intervalo da captura a quadros que chegaram irregulares', () => {
    const p = player();
    const chegadas = [0, 55, 60, 130, 133]; // rajada e buraco, como numa rede ruim
    const capturas = [0, 33, 66, 99, 132]; // cravados a 30 fps

    // Entrega tudo de uma vez respeitando a hora de chegada de cada um.
    let anterior = 0;
    capturas.forEach((ts, i) => {
      avancar(chegadas[i] - anterior);
      anterior = chegadas[i];
      p.push(pacote(i === 0 ? KEYFRAME : DELTA, ts));
    });

    // Roda até o último quadro ter a vez.
    avancar(BUFFER_MS + 132);

    expect(desenhados).toEqual(capturas);
  });

  it('reancora e desenha na hora quando o quadro perdeu a própria hora', () => {
    const p = player();
    p.push(pacote(KEYFRAME, 0));
    avancar(BUFFER_MS + 16);
    expect(desenhados).toEqual([0]);

    // A rede parou meio segundo: o próximo quadro chega muito depois da hora
    // que a referência antiga previa para ele.
    avancar(500);
    p.push(pacote(DELTA, 33));

    // Sem esperar mais nada: apareceu no mesmo instante.
    expect(desenhados).toEqual([0, 33]);
  });

  it('descarta o quadro mais velho quando a fila estoura, e fecha o que descartou', () => {
    const p = player();
    const fechados = [];
    globalThis.VideoDecoder.prototype.decode = function (chunk) {
      this.output({
        timestamp: chunk.timestamp,
        displayWidth: 1280,
        displayHeight: 720,
        close: () => fechados.push(chunk.timestamp / 1000),
      });
    };

    // Vinte quadros de uma vez, sem deixar o relógio andar: nenhum tem a vez
    // ainda, e a fila tem que se defender sozinha.
    for (let i = 0; i < 20; i++) p.push(pacote(i === 0 ? KEYFRAME : DELTA, i * 33));

    // VideoFrame segura memória de GPU: descartar sem fechar trava a aba.
    expect(fechados.length).toBeGreaterThan(0);
    expect(fechados[0]).toBe(0);
  });

  it('fecha os quadros que ficaram na fila quando a transmissão para', () => {
    const p = player();
    const fechados = [];
    globalThis.VideoDecoder.prototype.decode = function (chunk) {
      this.output({
        timestamp: chunk.timestamp,
        displayWidth: 1280,
        displayHeight: 720,
        close: () => fechados.push(chunk.timestamp / 1000),
      });
    };

    p.push(pacote(KEYFRAME, 0));
    p.push(pacote(DELTA, 33));
    p.stop();

    expect(fechados).toEqual([0, 33]);
  });
});

describe('irregularidade', () => {
  it('começa sem medida, porque ainda não houve janela', () => {
    expect(player().getJitter()).toBeNull();
  });

  it('mede a distancia entre o quadro mais folgado e o mais apertado', () => {
    const p = player();

    // 30 fps cravados na origem; na chegada, alternando 53 ms e 13 ms — mesma
    // media, entregue em rajada. Cada quadro impar chega 20 ms depois da hora
    // dele, e o par volta ao lugar: e esse vaivem que vira solavanco quando se
    // desenha na chegada, e e ele que este numero mede.
    for (let i = 0; i < 70; i++) {
      p.push(pacote(i === 0 ? KEYFRAME : DELTA, i * 33));
      const intervalo = i % 2 === 0 ? 53 : 13;
      avancar(intervalo, intervalo);
    }

    expect(p.getJitter()).toBeGreaterThanOrEqual(18);
    expect(p.getJitter()).toBeLessThanOrEqual(22);
  });
});

/**
 * O relogio da origem nao e o mesmo o tempo todo.
 *
 * Trocar de tela, uma aba que dormiu, uma transmissao que recomecou: qualquer
 * um traz timestamps de outra regua. O salto para tras sempre foi tratado. O
 * salto para a FRENTE nao era tratado por ninguem, e era ele que congelava a
 * tela — os quadros ficavam marcados para daqui a meio minuto, a fila estourava
 * pelo teto antes de a hora chegar, e nenhum era desenhado. A queixa vinha em
 * duas partes que pareciam problemas diferentes: "travou" e "mostra 0 fps".
 */
describe('salto do relogio da origem', () => {
  /** Enche o player de quadros normais e drena, devolvendo o player pronto. */
  function transmitindo() {
    const p = player();
    for (let i = 0; i < 10; i++) {
      p.push(pacote(i === 0 ? KEYFRAME : DELTA, i * 33.33));
      avancar(33.33);
    }
    avancar(2000);
    expect(p.takeFrameCount()).toBeGreaterThan(0);
    return p;
  }

  it('a origem que dorme e volta nao congela a tela', () => {
    const p = transmitindo();

    // Trinta segundos de sono: o relogio de captura pulou para a frente.
    for (let i = 0; i < 30; i++) {
      p.push(pacote(DELTA, 30_000 + i * 33.33));
      avancar(33.33);
    }
    avancar(200);

    expect(p.takeFrameCount()).toBeGreaterThan(0);
  });

  it('e o contador de quadros nao fica em zero, que era o outro sintoma', () => {
    const p = transmitindo();
    p.push(pacote(DELTA, 60_000));
    avancar(100);

    expect(p.takeFrameCount()).toBe(1);
  });

  it('conta a ressincronizacao, para o diagnostico poder culpar o relogio', () => {
    const p = transmitindo();
    expect(p.getSaude().resync).toBe(0);

    p.push(pacote(DELTA, 30_000));
    avancar(100);

    expect(p.getSaude().resync).toBe(1);
  });

  it('adiantamento de rajada normal nao conta como salto', () => {
    // Uma fila inteira chegando de uma vez adianta os quadros em ate ~400 ms.
    // Isso e a rede entregando em rajada, e nao origem nova: reancorar aqui
    // jogaria fora o buffer que existe justamente para absorver a rajada.
    const p = player();
    p.push(pacote(KEYFRAME, 0));
    for (let i = 1; i < 10; i++) p.push(pacote(DELTA, i * 33.33));

    expect(p.getSaude().resync).toBe(0);
  });

  it('o salto para tras continua tratado', () => {
    const p = transmitindo();
    p.push(pacote(KEYFRAME, 0));
    avancar(100);

    expect(p.takeFrameCount()).toBeGreaterThan(0);
  });
});

/**
 * A fila do decodificador era a unica do caminho sem teto.
 *
 * Quando ela cresce, os quadros continuam saindo em ordem e no ritmo certo —
 * so que cada vez mais velhos. E a queixa de "estou vendo o que fiz minutos
 * atras", e nada no player a media, porque a referencia de tempo alinha o ritmo
 * e nao a idade.
 */
describe('fila do decodificador', () => {
  it('larga o que chega enquanto o decodificador nao vaza', () => {
    const p = player();
    p.push(pacote(KEYFRAME, 0));
    const antes = ultimoDecoder.decodificados;

    ultimoDecoder.decodeQueueSize = 20;
    for (let i = 1; i < 10; i++) p.push(pacote(DELTA, i * 33.33));

    expect(ultimoDecoder.decodificados).toBe(antes);
    expect(p.getSaude().largados).toBe(9);
  });

  it('volta ao vivo no primeiro keyframe depois de a fila drenar', () => {
    const p = player();
    p.push(pacote(KEYFRAME, 0));

    ultimoDecoder.decodeQueueSize = 20;
    for (let i = 1; i < 10; i++) p.push(pacote(DELTA, i * 33.33));

    // Drenou. Um delta nao serve — a cadeia de referencia foi cortada —, mas o
    // keyframe seguinte devolve a imagem.
    ultimoDecoder.decodeQueueSize = 0;
    const antes = ultimoDecoder.decodificados;
    p.push(pacote(DELTA, 10 * 33.33));
    expect(ultimoDecoder.decodificados).toBe(antes);

    p.push(pacote(KEYFRAME, 11 * 33.33));
    expect(ultimoDecoder.decodificados).toBe(antes + 1);
  });

  it('fila curta passa direto, que e o caso normal', () => {
    const p = player();
    p.push(pacote(KEYFRAME, 0));
    ultimoDecoder.decodeQueueSize = 2;
    p.push(pacote(DELTA, 33.33));

    expect(p.getSaude().largados).toBe(0);
  });
});

describe('saude', () => {
  it('entrega as duas filas e o que elas ja custaram', () => {
    const p = player();
    p.push(pacote(KEYFRAME, 0));

    expect(p.getSaude()).toMatchObject({
      fila: expect.any(Number),
      decode: expect.any(Number),
      resync: 0,
      largados: 0,
      decoder: 'configured',
    });
  });

  it('sem decodificador diz que nao ha, e nao finge um estado', () => {
    const p = player();
    p.stop();

    expect(p.getSaude().decoder).toBe('ausente');
  });
});

/**
 * O atraso que ninguem no caminho consegue ver.
 *
 * O freio do relay decide pelo `bufferedAmount` do socket daquele espectador, e
 * ele so conta o que ainda nao foi entregue ao sistema operacional. Medido com
 * um espectador que nao le nada: o servidor ja tinha mandado 3,1 MB quando o
 * `bufferedAmount` marcava 0,5 MB — 2,6 MB invisiveis no kernel e na rede, uns
 * cinco segundos de video a 4 Mb/s.
 *
 * Como o servidor nao pode ver, quem ve e quem recebe: o carimbo de envio vem
 * dentro do pacote. Isto testa que o player age nisso em vez de reproduzir o
 * passado com um ritmo lindo — e que ele nao confunde isso com o relogio da
 * outra maquina estar so adiantado (ver `piso`), nem repete o pulo pra sempre
 * enquanto o mesmo atraso persiste (ver `jaPulou`).
 */
describe('pulo para o vivo', () => {
  /** Um pacote carimbado como enviado ha `atrasoMs`. */
  function atrasado(tipo, tsMs, atrasoMs) {
    const buffer = new ArrayBuffer(20);
    const view = new DataView(buffer);
    view.setUint8(0, 0);
    view.setUint8(1, tipo);
    view.setFloat64(2, tsMs * 1000);
    view.setFloat64(10, Date.now() - atrasoMs);
    return buffer;
  }

  it('um pico isolado nao vale o solavanco', () => {
    const onAtrasado = vi.fn();
    const p = createPlayer(canvasFalso(), { onAtrasado });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    p.push(atrasado(KEYFRAME, 0, 30_000));

    expect(onAtrasado).not.toHaveBeenCalled();
  });

  it('desvio de relogio constante desde o primeiro pacote nao dispara', () => {
    const onAtrasado = vi.fn();
    const p = createPlayer(canvasFalso(), { onAtrasado });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    // O mesmo atraso enorme em todo pacote, desde sempre, e a assinatura de um
    // relogio adiantado — nao de uma fila crescendo. `piso` acompanha esse
    // minimo e o atraso medido contra ele fica sempre zero.
    const real = Date.now;
    let t = real();
    Date.now = () => t;
    p.push(atrasado(KEYFRAME, 0, 30_000));
    t += 4000;
    p.push(atrasado(KEYFRAME, 33, 30_000));
    t += 4000;
    p.push(atrasado(KEYFRAME, 66, 30_000));
    t += 4000;
    p.push(atrasado(KEYFRAME, 99, 30_000));
    Date.now = real;

    expect(onAtrasado).not.toHaveBeenCalled();
  });

  it('a janela do piso vencendo sozinha, com atraso estavel, nao produz pulo espurio', () => {
    const onAtrasado = vi.fn();
    const p = createPlayer(canvasFalso(), { onAtrasado });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    // Nenhum salto de origem aqui — só o relogio de parede andando o
    // suficiente para a janela do piso vencer sozinha (ver PISO_JANELA_MS),
    // com o mesmo atraso de sempre. Reaprender o piso do zero não pode custar
    // um pulo: o pacote que vence a janela também é quem define o novo piso.
    const real = Date.now;
    let t = real();
    Date.now = () => t;
    p.push(atrasado(KEYFRAME, 0, 100));
    t += PISO_JANELA_MS + 1000;
    p.push(atrasado(DELTA, 33, 100));
    t += PISO_JANELA_MS + 1000;
    p.push(atrasado(DELTA, 66, 100));
    Date.now = real;

    expect(onAtrasado).not.toHaveBeenCalled();
  });

  it('atraso que cresce de verdade acima do piso dispara', () => {
    const onAtrasado = vi.fn();
    const p = createPlayer(canvasFalso(), { onAtrasado });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    // O relogio de `Date.now` e o que decide a persistencia, entao ele anda.
    const real = Date.now;
    let t = real();
    Date.now = () => t;
    p.push(atrasado(KEYFRAME, 0, 100)); // estabelece o piso, sem desvio
    t += 1000;
    p.push(atrasado(DELTA, 33, 30_000)); // fila cresceu de verdade
    t += 5000;
    p.push(atrasado(DELTA, 66, 30_000)); // ainda alta 5s depois: persistiu
    Date.now = real;

    expect(onAtrasado).toHaveBeenCalledTimes(1);
    expect(onAtrasado.mock.calls[0][0]).toBeGreaterThan(3000);
  });

  it('atraso normal nao dispara nada', () => {
    const onAtrasado = vi.fn();
    const p = createPlayer(canvasFalso(), { onAtrasado });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    p.push(atrasado(KEYFRAME, 0, 120));
    p.push(atrasado(DELTA, 33, 90));

    expect(onAtrasado).not.toHaveBeenCalled();
    expect(p.getSaude().pulos).toBe(0);
  });

  it('conta os pulos, que e o numero que acusa a rede daquela pessoa', () => {
    const onAtrasado = vi.fn();
    const p = createPlayer(canvasFalso(), { onAtrasado });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    const real = Date.now;
    let t = real();
    Date.now = () => t;
    p.push(atrasado(KEYFRAME, 0, 100));
    t += 1000;
    p.push(atrasado(DELTA, 33, 30_000));
    t += 5000;
    p.push(atrasado(DELTA, 66, 30_000));
    Date.now = real;

    expect(p.getSaude().pulos).toBe(1);
  });

  it('depois de disparar, o mesmo atraso nao dispara de novo antes de cair', () => {
    const onAtrasado = vi.fn();
    const p = createPlayer(canvasFalso(), { onAtrasado });
    p.start({ codec: 'vp8', codedWidth: 1280, codedHeight: 720 });

    const real = Date.now;
    let t = real();
    Date.now = () => t;

    p.push(atrasado(KEYFRAME, 0, 100)); // piso baixo
    t += 1000;
    p.push(atrasado(KEYFRAME, 33, 4000)); // acima do piso, comeca a contar
    t += 4000;
    p.push(atrasado(KEYFRAME, 66, 4000)); // persistiu: pula (1)
    t += 4000;
    p.push(atrasado(KEYFRAME, 99, 4000)); // mesmo atraso: ja pulou, nao pula de novo
    t += 4000;
    p.push(atrasado(KEYFRAME, 132, 4000)); // idem
    expect(onAtrasado).toHaveBeenCalledTimes(1);

    t += 1000;
    p.push(atrasado(KEYFRAME, 165, 100)); // atraso caiu de verdade: destrava
    t += 1000;
    p.push(atrasado(KEYFRAME, 198, 4000)); // sobe de novo
    t += 4000;
    p.push(atrasado(KEYFRAME, 231, 4000)); // persistiu de novo: pula (2)

    Date.now = real;
    expect(onAtrasado).toHaveBeenCalledTimes(2);
  });
});

/**
 * A zona morta entre o teto da fila e o salto de relógio.
 *
 * Quadro adiantado demais para caber na fila, e de menos para contar como
 * salto (SALTO_MS), não era reancorado nem desenhado: a fila estourava antes de
 * chegar a vez dele, a cada quadro, e a tela ficava parada até o ajuste fino
 * alcançar — 78 s numa transmissão real, bem depois de o vigia de main.js
 * (15 s) acusar "a imagem parou de chegar".
 *
 * O adiantamento nasce de um engasgo: o primeiro quadro atrasado reancora a
 * referência, e a rajada que vem atrás dele chega adiantada pelo engasgo
 * inteiro. Os testes reproduzem exatamente isso, em vez de forçar o número.
 */
describe('adiantamento maior que a fila', () => {
  /**
   * Entrega cada quadro na hora de chegada dele, como TCP entrega: em ordem,
   * nunca antes do anterior. Devolve o maior intervalo sem desenho, em ms.
   */
  function transmitir(p, capturas, chegadas) {
    capturas.forEach((ts, i) => {
      avancar(Math.max(0, chegadas[i] - agora), 4);
      p.push(pacote(i === 0 ? KEYFRAME : DELTA, ts));
    });
    avancar(2000, 4);
    return maiorBuraco();
  }

  function maiorBuraco() {
    let maior = 0;
    for (let i = 1; i < momentos.length; i++)
      maior = Math.max(maior, momentos[i] - momentos[i - 1]);
    return maior;
  }

  /** Gerador pseudoaleatório fixo: o teste precisa falhar sempre igual. */
  function sorteio(semente) {
    let s = semente;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  it('uma origem 600 ms adiantada continua desenhando', () => {
    const p = player();
    const capturas = [];
    const chegadas = [];

    // Dez segundos a 30 fps. No segundo 2, a rede segura 600 ms e solta tudo
    // de uma vez; depois disso volta ao normal — só que cada quadro chega
    // 600 ms antes da hora que a referência nova marcou para ele.
    for (let i = 0; i < 300; i++) {
      const ts = i * 33.33;
      capturas.push(ts);
      chegadas.push(1000 + (ts >= 2000 && ts < 2600 ? 2600 : ts));
    }

    const buraco = transmitir(p, capturas, chegadas);

    // O engasgo de 600 ms aparece na tela, é claro — o que não pode é ficar.
    expect(buraco).toBeLessThan(1000);
    // E volta ao lugar: o último quadro aparece a uma espera do vivo, e não a
    // 600 ms dele.
    expect(momentos.at(-1) - chegadas.at(-1)).toBeLessThanOrEqual(BUFFER_MS + 16);
  });

  it('a fila cheia sem nada vencido reancora, em vez de largar o próximo da vez', () => {
    const p = player();
    p.push(pacote(KEYFRAME, 0));
    avancar(BUFFER_MS + 16);

    // A referência foi feita em cima de um quadro atrasado: todos os seguintes
    // chegam 600 ms antes da hora marcada para eles.
    for (let i = 1; i < 40; i++) {
      p.push(pacote(DELTA, 600 + i * 33.33));
      avancar(33.33, 4);
    }

    expect(p.getSaude().resync).toBeGreaterThan(0);
    expect(desenhados.length).toBeGreaterThan(20);
  });

  it('câmera com pouca luz, entre 8 e 15 fps e com tremor, nunca fica 15 s sem quadro', () => {
    const p = player();
    const aleatorio = sorteio(42);
    const capturas = [];
    const chegadas = [];

    // Cinco minutos de uma webcam que baixa a taxa sozinha: cada intervalo de
    // captura entre 66 e 125 ms, e a rede somando até 60 ms de tremor. A cada
    // vinte segundos, um engasgo de até 900 ms — é ele que cria o adiantamento.
    let ts = 0;
    let chegada = 1000;
    let proximoEngasgo = 20_000;
    while (ts < 300_000) {
      capturas.push(ts);
      let ideal = 1000 + ts + aleatorio() * 60;
      if (ts >= proximoEngasgo) {
        ideal += 300 + aleatorio() * 600;
        proximoEngasgo += 20_000;
      }
      chegada = Math.max(chegada, ideal);
      chegadas.push(chegada);
      ts += 66 + aleatorio() * 59;
    }

    const buraco = transmitir(p, capturas, chegadas);

    expect(buraco).toBeLessThan(15_000);
    // O pior buraco honesto é um engasgo mais um intervalo de captura.
    expect(buraco).toBeLessThan(1200);
    // E quase tudo o que foi capturado chegou à tela.
    expect(desenhados.length).toBeGreaterThan(capturas.length * 0.9);
  });

  it('o adiantamento que sobra de um engasgo sai em uma janela, e não em um minuto', () => {
    const p = player();
    const capturas = [];
    const chegadas = [];

    // Engasgo de 300 ms: cabe na fila, então não congela — mas deixava 300 ms
    // a mais de atraso em cada quadro, saindo a 7,5 ms por segundo.
    for (let i = 0; i < 300; i++) {
      const ts = i * 33.33;
      capturas.push(ts);
      chegadas.push(1000 + (ts >= 2000 && ts < 2300 ? 2300 : ts));
    }

    transmitir(p, capturas, chegadas);

    expect(momentos.at(-1) - chegadas.at(-1)).toBeLessThanOrEqual(BUFFER_MS + 16);
  });
});
