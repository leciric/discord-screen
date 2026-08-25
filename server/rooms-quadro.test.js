/**
 * O quadro branco da sala, do lado do servidor.
 *
 * A máquina é a mesma das anotações — mesma validação, mesmos tetos, mesma
 * grade —, então o que se prova aqui são só as diferenças, que são as que
 * decidem se ele é um quadro ou um mal-entendido: pertence à sala e não a uma
 * transmissão, chega a todo mundo sem opt-in, e quem apaga o desenho dos outros
 * é quem criou a sala.
 */
import { describe, expect, it } from 'vitest';
import * as R from './rooms.js';

let n = 0;
const instancia = () => `quadro-${Date.now().toString(36)}-${n++}`;

function socket() {
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    recebidas: [],
    send(data) {
      if (typeof data === 'string') this.recebidas.push(JSON.parse(data));
    },
    close() {
      this.readyState = 3;
    },
    limpar() {
      this.recebidas.length = 0;
      return this;
    },
  };
}

const quadros = (ws) => ws.recebidas.filter((m) => m.type === 'quadro');
const syncs = (ws) => ws.recebidas.filter((m) => m.type === 'quadro-sync');
const traco = (id, pts = [10, 10, 20, 20]) => ({ k: 's', id, c: '#ff4d4f', w: 10, pts });

/** Uma sala com duas pessoas dentro e nada no ar. */
function sala() {
  const room = R.createRoom({ instance: instancia(), ownerId: 'dono', ownerName: 'Dono' }).room;

  const wsDono = socket();
  R.attachViewer(room, wsDono, { id: 'dono', name: 'Dono' });

  const wsOutro = socket();
  R.attachViewer(room, wsOutro, { id: 'outro', name: 'Outro' });

  return { room, wsDono: wsDono.limpar(), wsOutro: wsOutro.limpar() };
}

describe('quadro branco', () => {
  it('existe sem transmissão nenhuma no ar', () => {
    const { room, wsDono, wsOutro } = sala();

    // Este é o ponto inteiro do quadro: as anotações precisam de um `entry`
    // para existir, e por isso somem junto com a tela. Aqui não há tela.
    R.pushQuadro(room, wsDono, traco(1));

    expect(quadros(wsDono)).toHaveLength(1);
    expect(quadros(wsOutro)).toHaveLength(1);
  });

  it('chega a todo mundo na sala, sem ninguém precisar pedir', () => {
    const { room, wsDono, wsOutro } = sala();

    // Assistir é opt-in porque quadro de vídeo custa megabits. Um traço custa
    // dezenas de bytes, e um quadro que só metade da sala vê não é um quadro.
    R.pushQuadro(room, wsOutro, traco(7));

    expect(quadros(wsDono)[0]).toMatchObject({ uid: 'outro', name: 'Outro' });
  });

  it('não vaza para outra sala', () => {
    const { room, wsDono } = sala();
    const vizinha = sala();

    R.pushQuadro(room, wsDono, traco(1));

    expect(quadros(vizinha.wsDono)).toHaveLength(0);
  });

  it('quem chega no meio recebe o que já está desenhado', () => {
    const { room, wsDono } = sala();
    R.pushQuadro(room, wsDono, traco(1, [10, 10, 20, 20, 30, 30]));

    const tarde = socket();
    R.attachViewer(room, tarde, { id: 'tarde', name: 'Tarde' });

    const sync = syncs(tarde)[0];
    expect(sync.tracos).toHaveLength(1);
    expect(sync.tracos[0]).toMatchObject({ uid: 'dono', pts: [10, 10, 20, 20, 30, 30] });
  });

  it('sala em branco não gasta uma mensagem dizendo que está em branco', () => {
    const { room } = sala();

    const tarde = socket();
    R.attachViewer(room, tarde, { id: 'tarde', name: 'Tarde' });

    expect(syncs(tarde)).toHaveLength(0);
  });

  it('cada um desfaz o seu, e só o seu', () => {
    const { room, wsDono, wsOutro } = sala();
    R.pushQuadro(room, wsDono, traco(1));
    R.pushQuadro(room, wsOutro, traco(2));

    R.pushQuadro(room, wsOutro, { k: 'u' });

    expect(R.quadroResumo(room).tracos).toBe(1);
    const tarde = socket();
    R.attachViewer(room, tarde, { id: 'tarde', name: 'Tarde' });
    expect(syncs(tarde)[0].tracos[0].uid).toBe('dono');
  });

  it('apagar o quadro de todo mundo é de quem criou a sala', () => {
    const { room, wsDono, wsOutro } = sala();
    R.pushQuadro(room, wsDono, traco(1));

    // Quem não é dono tenta e não acontece nada — nem o evento é repassado,
    // senão a tela dos outros ficaria diferente do que o servidor guardou.
    R.pushQuadro(room, wsOutro, { k: 'ca' });
    expect(R.quadroResumo(room).tracos).toBe(1);

    R.pushQuadro(room, wsDono, { k: 'ca' });
    expect(R.quadroResumo(room).tracos).toBe(0);
  });

  it('recusa evento que não passa na validação', () => {
    const { room, wsDono, wsOutro } = sala();

    R.pushQuadro(room, wsDono, { k: 's', id: 1, pts: [10, 99999] });
    R.pushQuadro(room, wsDono, { k: 'nao-existe' });
    R.pushQuadro(room, wsDono, null);

    expect(quadros(wsOutro)).toHaveLength(0);
  });

  it('o painel limpa o quadro e avisa a sala', () => {
    const { room, wsDono, wsOutro } = sala();
    R.pushQuadro(room, wsDono, traco(1));
    wsOutro.limpar();

    expect(R.limparQuadro(room)).toBe(1);

    expect(R.quadroResumo(room).tracos).toBe(0);
    expect(syncs(wsOutro)[0].tracos).toEqual([]);
  });

  it('limpar um quadro já vazio não incomoda ninguém', () => {
    const { room, wsOutro } = sala();

    expect(R.limparQuadro(room)).toBe(0);
    expect(syncs(wsOutro)).toHaveLength(0);
  });

  it('conta o que guarda, para o painel saber', () => {
    const { room, wsDono } = sala();
    R.pushQuadro(room, wsDono, traco(1, [1, 2, 3, 4, 5, 6]));

    expect(R.quadroResumo(room)).toEqual({ tracos: 1, pontos: 3 });
  });
});
