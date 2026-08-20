/**
 * Laser e caneta sobre a tela de alguém, do lado do servidor.
 *
 * O que se prova aqui não é o desenho — isso é pixel, e mora no navegador. É a
 * decisão: quem pode marcar a tela de quem, o que é aceito como evento, quanto
 * cabe antes de recusar, e para quem o relay repassa. São as três coisas que,
 * erradas, viram tela de outra sala, memória do processo, ou traço que só uma
 * pessoa vê.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as R from './rooms.js';

let n = 0;
const instancia = () => `ann-${Date.now().toString(36)}-${n++}`;

/** Dublê de socket, no contrato que o rooms.js usa. */
function socket(info = null) {
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    recebidas: [],
    fechado: false,
    send(data) {
      if (typeof data === 'string') this.recebidas.push(JSON.parse(data));
    },
    close() {
      this.fechado = true;
      this.readyState = 3;
    },
  };
  if (info) ws.__info = info;
  return ws;
}

const anns = (ws) => ws.recebidas.filter((m) => m.type === 'ann');
const traco = (id, pts = [10, 10, 20, 20]) => ({ k: 's', id, c: '#ff4d4f', w: 10, pts });

/** Sala com uma transmissão no ar e um espectador assistindo a ela. */
function cena() {
  const room = R.createRoom({ instance: instancia(), ownerId: 'dono', ownerName: 'Dono' }).room;

  const wsCaptura = socket();
  const entry = R.attachBroadcaster(room, wsCaptura, { id: 'dono', name: 'Dono' });
  R.startStream(room, entry);
  R.setConfig(room, entry, { codec: 'vp8' });

  const wsDono = socket();
  R.attachViewer(room, wsDono, { id: 'dono', name: 'Dono' });

  const wsPlateia = socket();
  R.attachViewer(room, wsPlateia, { id: 'plateia', name: 'Plateia' });
  R.watch(room, wsPlateia, entry.slot);

  wsCaptura.recebidas.length = 0;
  wsDono.recebidas.length = 0;
  wsPlateia.recebidas.length = 0;

  return { room, entry, slot: entry.slot, wsCaptura, wsDono, wsPlateia };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('quem pode marcar', () => {
  it('quem assiste marca, e o traço chega a quem assiste e a quem transmite', () => {
    const { room, slot, wsPlateia, wsDono, wsCaptura } = cena();

    R.pushAnn(room, wsPlateia, slot, traco(1));

    // Quem desenhou também recebe de volta: o eco local do cliente é o que
    // evita o traço aparecer duas vezes, não o servidor filtrar por remetente.
    expect(anns(wsPlateia)).toHaveLength(1);
    expect(anns(wsPlateia)[0].uid).toBe('plateia');
    // A aba de captura recebe pelo socket de transmissor: é assim que quem
    // mostra a tela vê a marcação sem assistir a si mesmo.
    expect(anns(wsCaptura)).toHaveLength(1);
    // O dono não pediu para assistir esta tela; nada é gasto com ele.
    expect(anns(wsDono)).toHaveLength(0);
  });

  it('quem não está assistindo aquela tela não marca nela', () => {
    const { room, slot, wsDono, wsPlateia } = cena();

    // Um segundo dono, para o slot não ser "a tela dele".
    const outro = socket();
    R.attachViewer(room, outro, { id: 'estranho', name: 'Estranho' });

    R.pushAnn(room, outro, slot, { k: 'p', x: 10, y: 10 });

    expect(anns(wsPlateia)).toHaveLength(0);
    expect(anns(wsDono)).toHaveLength(0);
  });

  it('quem transmite marca a própria tela sem assistir a si mesmo', () => {
    const { room, slot, wsDono, wsPlateia } = cena();

    // wsDono é o socket de espectador do dono da transmissão, e ele nunca
    // pediu para assistir: vê a captura direto da máquina.
    R.pushAnn(room, wsDono, slot, { k: 'p', x: 10, y: 10, c: '#ffffff' });

    expect(anns(wsPlateia)).toHaveLength(1);
    expect(anns(wsPlateia)[0].uid).toBe('dono');
  });

  it('socket sem identidade não marca nada', () => {
    const { room, slot, wsPlateia } = cena();
    R.pushAnn(room, socket(), slot, traco(1));
    expect(anns(wsPlateia)).toHaveLength(0);
  });

  it('slot sem transmissão no ar não aceita marcação', () => {
    const { room, wsPlateia } = cena();
    R.pushAnn(room, wsPlateia, 3, traco(1));
    expect(anns(wsPlateia)).toHaveLength(0);
  });
});

describe('o que é aceito como evento', () => {
  it.each([
    ['tipo desconhecido', { k: 'xxx' }],
    ['sem evento nenhum', null],
    ['coordenada fora da grade', { k: 'p', x: 99999, y: 0 }],
    ['coordenada negativa', { k: 'p', x: -1, y: 0 }],
    ['pontos em número ímpar', { k: 's', id: 1, pts: [1, 2, 3] }],
    ['pontos que não são lista', { k: 's', id: 1, pts: 'nope' }],
    ['id que não é inteiro', { k: 's', id: 'um', pts: [1, 2] }],
    ['fim de traço sem id', { k: 'e' }],
  ])('recusa %s', (_nome, ev) => {
    const { room, slot, wsPlateia } = cena();
    R.pushAnn(room, wsPlateia, slot, ev);
    expect(anns(wsPlateia)).toHaveLength(0);
  });

  it('recusa um pacote com pontos demais de uma vez', () => {
    const { room, slot, wsPlateia } = cena();
    R.pushAnn(room, wsPlateia, slot, { k: 's', id: 1, pts: new Array(400).fill(10) });
    expect(anns(wsPlateia)).toHaveLength(0);
  });

  it('cor inválida vira a padrão em vez de derrubar o evento', () => {
    const { room, slot, wsPlateia } = cena();
    R.pushAnn(room, wsPlateia, slot, { k: 'p', x: 1, y: 1, c: 'javascript:alert(1)' });
    expect(anns(wsPlateia)[0].ev.c).toBe('#ff4d4f');
  });

  it('arredonda o que vem fracionário, que é o que a grade espera', () => {
    const { room, slot, wsPlateia } = cena();
    R.pushAnn(room, wsPlateia, slot, { k: 'p', x: 10.7, y: 3.2 });
    expect(anns(wsPlateia)[0].ev).toMatchObject({ x: 11, y: 3 });
  });
});

describe('o que fica guardado', () => {
  it('quem chega no meio recebe o que já está desenhado', () => {
    const { room, entry, slot, wsPlateia } = cena();

    R.pushAnn(room, wsPlateia, slot, traco(1));
    R.pushAnn(room, wsPlateia, slot, { k: 'a', id: 1, pts: [30, 30] });

    const novato = socket();
    R.attachViewer(room, novato, { id: 'novato', name: 'Novato' });
    R.watch(room, novato, entry.slot);

    const sync = novato.recebidas.find((m) => m.type === 'ann-sync');
    expect(sync.tracos).toHaveLength(1);
    expect(sync.tracos[0].pts).toEqual([10, 10, 20, 20, 30, 30]);
  });

  it('o laser não é guardado: ele se refaz no quadro seguinte', () => {
    const { room, entry, slot, wsPlateia } = cena();
    R.pushAnn(room, wsPlateia, slot, { k: 'p', x: 5, y: 5 });

    const novato = socket();
    R.attachViewer(room, novato, { id: 'novato', name: 'Novato' });
    R.watch(room, novato, entry.slot);

    expect(novato.recebidas.some((m) => m.type === 'ann-sync')).toBe(false);
  });

  it('continuar um traço que não existe não vira traço novo', () => {
    const { room, slot, wsPlateia } = cena();
    R.pushAnn(room, wsPlateia, slot, { k: 'a', id: 99, pts: [1, 1] });
    expect(anns(wsPlateia)).toHaveLength(0);
  });

  it('transmissão nova começa com a tela limpa', () => {
    const { room, entry, slot, wsPlateia } = cena();
    R.pushAnn(room, wsPlateia, slot, traco(1));

    R.startStream(room, entry);
    const novato = socket();
    R.attachViewer(room, novato, { id: 'novato', name: 'Novato' });
    R.watch(room, novato, entry.slot);

    expect(novato.recebidas.some((m) => m.type === 'ann-sync')).toBe(false);
  });
});

describe('desfazer, apagar e limpar', () => {
  it('desfazer tira o último traço de quem pediu, e só dele', () => {
    const { room, entry, slot, wsPlateia, wsDono } = cena();

    R.pushAnn(room, wsPlateia, slot, traco(1));
    R.pushAnn(room, wsDono, slot, traco(2));
    R.pushAnn(room, wsPlateia, slot, traco(3));

    R.pushAnn(room, wsPlateia, slot, { k: 'u' });

    const novato = socket();
    R.attachViewer(room, novato, { id: 'novato', name: 'Novato' });
    R.watch(room, novato, entry.slot);

    const ids = novato.recebidas.find((m) => m.type === 'ann-sync').tracos.map((t) => t.id);
    expect(ids).toEqual(['plateia:1', 'dono:2']);
  });

  it('desfazer sem nada desenhado não vira mensagem', () => {
    const { room, slot, wsPlateia } = cena();
    R.pushAnn(room, wsPlateia, slot, { k: 'u' });
    expect(anns(wsPlateia)).toHaveLength(0);
  });

  it('apagar o meu não encosta no dos outros', () => {
    const { room, entry, slot, wsPlateia, wsDono } = cena();

    R.pushAnn(room, wsPlateia, slot, traco(1));
    R.pushAnn(room, wsDono, slot, traco(2));
    R.pushAnn(room, wsPlateia, slot, { k: 'c' });

    const novato = socket();
    R.attachViewer(room, novato, { id: 'novato', name: 'Novato' });
    R.watch(room, novato, entry.slot);

    const tracos = novato.recebidas.find((m) => m.type === 'ann-sync').tracos;
    expect(tracos.map((t) => t.uid)).toEqual(['dono']);
  });

  it('quem só assiste não limpa a tela dos outros', () => {
    const { room, entry, slot, wsPlateia } = cena();
    R.pushAnn(room, wsPlateia, slot, traco(1));
    wsPlateia.recebidas.length = 0;

    R.pushAnn(room, wsPlateia, slot, { k: 'ca' });

    expect(anns(wsPlateia)).toHaveLength(0);
    const novato = socket();
    R.attachViewer(room, novato, { id: 'novato', name: 'Novato' });
    R.watch(room, novato, entry.slot);
    expect(novato.recebidas.find((m) => m.type === 'ann-sync').tracos).toHaveLength(1);
  });

  it('quem transmite limpa a tela de todo mundo', () => {
    const { room, entry, slot, wsPlateia, wsDono } = cena();
    R.pushAnn(room, wsPlateia, slot, traco(1));

    R.pushAnn(room, wsDono, slot, { k: 'ca' });

    const novato = socket();
    R.attachViewer(room, novato, { id: 'novato', name: 'Novato' });
    R.watch(room, novato, entry.slot);
    expect(novato.recebidas.some((m) => m.type === 'ann-sync')).toBe(false);
  });

  it('quem criou a sala também limpa', () => {
    const room = R.createRoom({ instance: instancia(), ownerId: 'chefe', ownerName: 'Chefe' }).room;
    const captura = socket();
    const entry = R.attachBroadcaster(room, captura, { id: 'outro', name: 'Outro' });
    R.startStream(room, entry);

    const plateia = socket();
    R.attachViewer(room, plateia, { id: 'plateia', name: 'Plateia' });
    R.watch(room, plateia, entry.slot);
    R.pushAnn(room, plateia, entry.slot, traco(1));

    const chefe = socket();
    R.attachViewer(room, chefe, { id: 'chefe', name: 'Chefe' });
    R.watch(room, chefe, entry.slot);
    chefe.recebidas.length = 0;

    R.pushAnn(room, chefe, entry.slot, { k: 'ca' });

    expect(anns(chefe).some((m) => m.ev.k === 'ca')).toBe(true);
  });
});

describe('tetos', () => {
  it('para de aceitar traço quando o quadro enche, e avisa quem desenhava', () => {
    // Relógio controlado porque há dois tetos, e este teste é sobre o outro: o
    // freio por segundo cortaria a enxurrada antes de o quadro encher. Avançar
    // o tempo entre as levas zera o freio e deixa o teto de pontos aparecer.
    vi.useFakeTimers();
    try {
      const { room, slot, wsPlateia } = cena();

      const cheio = new Array(128).fill(100);
      let recusados = 0;
      for (let i = 1; i <= 500; i++) {
        if (i % 100 === 0) vi.advanceTimersByTime(1100);
        const antes = anns(wsPlateia).length;
        R.pushAnn(room, wsPlateia, slot, { k: 's', id: i, c: '#ff4d4f', w: 10, pts: cheio });
        if (anns(wsPlateia).length === antes) recusados++;
      }

      expect(recusados).toBeGreaterThan(0);
      expect(wsPlateia.recebidas.some((m) => m.type === 'error' && /cheio/i.test(m.message))).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('o freio corta uma enxurrada de eventos do mesmo socket', () => {
    const { room, slot, wsPlateia } = cena();

    for (let i = 0; i < 400; i++) R.pushAnn(room, wsPlateia, slot, { k: 'p', x: i % 4000, y: 1 });

    // Passou do teto por segundo: o excesso não sai do relay.
    expect(anns(wsPlateia).length).toBeLessThan(400);
  });
});
