/**
 * As ações do painel e os números ajustáveis.
 *
 * O que se prova aqui é a única coisa que separa um botão útil de um botão que
 * ensina a não confiar nele: que ele age de verdade, que diz quanto agiu, e que
 * um valor absurdo digitado com pressa é recusado em vez de aplicado.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as R from './rooms.js';

let n = 0;
const instancia = () => `acoes-${Date.now().toString(36)}-${n++}`;

function socket() {
  return {
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
    tipos() {
      return this.recebidas.map((m) => m.type);
    },
    limpar() {
      this.recebidas.length = 0;
      return this;
    },
  };
}

/** Sala com uma transmissão no ar e alguém assistindo. */
function cena() {
  const room = R.createRoom({ instance: instancia(), ownerId: 'dono', ownerName: 'Dono' }).room;

  const captura = socket();
  const entry = R.attachBroadcaster(room, captura, { id: 'dono', name: 'Dono' });
  R.startStream(room, entry);
  R.setConfig(room, entry, { codec: 'vp8' });

  const plateia = socket();
  R.attachViewer(room, plateia, { id: 'plateia', name: 'Plateia' });
  R.watch(room, plateia, entry.slot);

  return { room, entry, captura: captura.limpar(), plateia: plateia.limpar() };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('pedirKeyframe', () => {
  it('pede à transmissão e diz a quantas pediu', () => {
    const { room, entry, captura } = cena();

    expect(R.pedirKeyframe(room)).toBe(1);
    expect(captura.tipos()).toContain('need-keyframe');
    expect(entry.slot).toBe(0);
  });

  it('ignora o intervalo mínimo: quem aperta isto olha para uma tela parada', () => {
    const { room, captura } = cena();

    R.pedirKeyframe(room);
    captura.limpar();
    // Pelo caminho normal o segundo pedido seria engolido pelo intervalo de um
    // segundo. Aqui não: o custo é um quadro, e o benefício é a imagem voltar.
    R.pedirKeyframe(room);

    expect(captura.tipos()).toContain('need-keyframe');
  });

  it('tira quem estava afogado do banco antes de mandar o keyframe', () => {
    const { room, entry, plateia } = cena();
    plateia.__afogado.add(entry.slot);

    R.pedirKeyframe(room, entry.slot);

    // Sem isto, o keyframe pedido passaria por ele sem ser aproveitado — e o
    // botão pareceria não fazer nada justamente para quem precisava.
    expect(plateia.__afogado.has(entry.slot)).toBe(false);
  });

  it('não conta transmissão que não existe', () => {
    const { room } = cena();
    expect(R.pedirKeyframe(room, 3)).toBe(0);
  });
});

describe('pararTransmissao', () => {
  it('pede a parada com o motivo, e quem para é a captura', () => {
    const { room, entry, captura } = cena();

    expect(R.pararTransmissao(room, entry.slot, 'teste')).toBe(true);
    expect(captura.recebidas.at(-1)).toEqual({ type: 'stop-request', motivo: 'teste' });
  });

  it('diz que não achou em vez de fingir que fez', () => {
    const { room } = cena();
    expect(R.pararTransmissao(room, 3)).toBe(false);
  });
});

describe('limparAnotacoes', () => {
  it('apaga o desenho da tela e avisa os dois lados', () => {
    const { room, entry, plateia, captura } = cena();
    R.pushAnn(room, plateia, entry.slot, { k: 's', id: 1, c: '#ff4d4f', w: 10, pts: [1, 2, 3, 4] });
    plateia.limpar();
    captura.limpar();

    expect(R.limparAnotacoes(room, entry.slot)).toBe(1);

    expect(plateia.recebidas.at(-1)).toMatchObject({ type: 'ann-sync', tracos: [] });
    // Também para quem transmite: ele vê o desenho pela própria captura, e sem
    // este aviso ficaria com o traço na tela depois de o painel apagá-lo.
    expect(captura.recebidas.at(-1)).toMatchObject({ type: 'ann-sync', tracos: [] });
  });
});

describe('derrubarPessoa', () => {
  it('fecha as conexões dela e conta quantas fechou', () => {
    const { room, plateia } = cena();

    expect(R.derrubarPessoa(room, 'plateia')).toBe(1);
    expect(plateia.fechado).toBe(true);
    // Diz por quê antes de fechar: uma conexão que cai sem explicação é
    // indistinguível de queda de rede.
    expect(plateia.recebidas.at(-1).message).toMatch(/painel/i);
  });

  it('não encosta em quem não foi pedido', () => {
    const { room, plateia } = cena();

    expect(R.derrubarPessoa(room, 'outra-pessoa')).toBe(0);
    expect(plateia.fechado).toBe(false);
  });
});

describe('fecharSala', () => {
  it('avisa todo mundo, para a transmissão e some do registro', () => {
    const { room, plateia, captura } = cena();

    const gente = R.fecharSala(room);

    expect(gente).toBeGreaterThan(0);
    expect(captura.recebidas.at(-1)).toMatchObject({ type: 'stop-request' });
    // `room-gone` antes de fechar: é ele que manda a atividade voltar ao lobby
    // em vez de ficar presa numa sala que o servidor já esqueceu.
    expect(plateia.recebidas.at(-1)).toEqual({ type: 'room-gone' });
    expect(plateia.fechado).toBe(true);
    expect(R.getRoom(room.id)).toBeNull();
  });
});

describe('ajustar', () => {
  it('aplica o que cabe e devolve de onde para onde foi', () => {
    const antes = R.ajustes.atrasoRelayMs;

    const aplicadas = R.ajustar({ atrasoRelayMs: 800 });

    expect(aplicadas).toEqual({ atrasoRelayMs: { de: antes, para: 800 } });
    expect(R.ajustes.atrasoRelayMs).toBe(800);

    R.ajustar({ atrasoRelayMs: antes });
  });

  it('recusa fora do limite: zero aqui vira laço de keyframe', () => {
    const antes = R.ajustes.keyframeIntervaloMs;

    expect(R.ajustar({ keyframeIntervaloMs: 0 })).toEqual({});
    expect(R.ajustar({ keyframeIntervaloMs: 999_999 })).toEqual({});
    expect(R.ajustes.keyframeIntervaloMs).toBe(antes);
  });

  it('ignora chave que não é ajuste, em vez de inventar um', () => {
    expect(R.ajustar({ naoExiste: 1, MAX_TRACOS: 9999 })).toEqual({});
    expect(R.ajustes).not.toHaveProperty('naoExiste');
  });

  it('não conta como mudança quem já estava no valor pedido', () => {
    expect(R.ajustar({ atrasoRelayMs: R.ajustes.atrasoRelayMs })).toEqual({});
  });

  it('o teto de fila acompanha o ajuste, e é ele que decide o descarte', () => {
    const { room, entry, plateia } = cena();
    plateia.__primed.add(entry.slot);
    // Fila acima do piso de 64 KB, que é o teto que vale enquanto não há taxa
    // medida. O mesmo quadro, a mesma fila: só o número muda entre as duas
    // metades deste teste.
    plateia.bufferedAmount = 100 * 1024;

    R.pushChunk(room, entry, quadro(entry.slot, 2));
    expect(room.droppedChunks).toBe(1);

    R.ajustar({ tetoMinBytes: 256 * 1024 });
    plateia.__afogado.delete(entry.slot);
    plateia.__primed.add(entry.slot);

    const antes = room.droppedChunks;
    R.pushChunk(room, entry, quadro(entry.slot, 2));

    // Com o piso subido, a mesma fila passa a caber e nada é largado.
    expect(room.droppedChunks).toBe(antes);

    R.ajustar({ tetoMinBytes: 64 * 1024 });
  });
});

/** Um quadro cru: slot no primeiro byte, tipo no segundo. */
function quadro(slot, tipo, tamanho = 64) {
  const buffer = Buffer.alloc(tamanho);
  buffer[0] = slot;
  buffer[1] = tipo;
  return buffer;
}
