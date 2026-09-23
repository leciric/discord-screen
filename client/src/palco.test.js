import { describe, it, expect } from 'vitest';
import {
  PALCO_VAZIO,
  acertarPalco,
  aLargar,
  dividido,
  porDoLado,
  promover,
  telasNoPalco,
  tirarDoPalco,
} from './palco.js';

describe('telasNoPalco', () => {
  it('lista a do destaque primeiro e ignora o lado vazio', () => {
    expect(telasNoPalco(PALCO_VAZIO)).toEqual([]);
    expect(telasNoPalco({ ativo: 2, lado: null })).toEqual([2]);
    expect(telasNoPalco({ ativo: 2, lado: 0 })).toEqual([2, 0]);
  });

  it('o slot 0 é uma tela como outra qualquer, não a ausência dela', () => {
    expect(telasNoPalco({ ativo: 0, lado: 1 })).toEqual([0, 1]);
    expect(dividido({ ativo: 0, lado: 1 })).toBe(true);
    expect(dividido({ ativo: 0, lado: null })).toBe(false);
  });
});

describe('acertarPalco', () => {
  it('sem transmissão, o palco fica vazio', () => {
    expect(acertarPalco({ ativo: 1, lado: 2 }, [])).toEqual(PALCO_VAZIO);
  });

  it('com transmissão e nada em destaque, a primeira do grid vai para o palco', () => {
    expect(acertarPalco(PALCO_VAZIO, [3, 1])).toEqual({ ativo: 3, lado: null });
  });

  it('não divide sozinho: duas no ar continuam sendo uma tela no palco', () => {
    expect(acertarPalco(PALCO_VAZIO, [0, 1])).toEqual({ ativo: 0, lado: null });
    expect(acertarPalco({ ativo: 1, lado: null }, [0, 1])).toEqual({ ativo: 1, lado: null });
  });

  it('mantém as duas enquanto as duas estão no ar', () => {
    expect(acertarPalco({ ativo: 1, lado: 0 }, [0, 1, 2])).toEqual({ ativo: 1, lado: 0 });
  });

  it('a do lado acabou: volta a uma tela só, com a do destaque', () => {
    expect(acertarPalco({ ativo: 0, lado: 1 }, [0])).toEqual({ ativo: 0, lado: null });
  });

  it('a do destaque acabou: a do lado fica sozinha, e não a primeira da lista', () => {
    expect(acertarPalco({ ativo: 0, lado: 2 }, [1, 2])).toEqual({ ativo: 2, lado: null });
  });

  it('as duas acabaram: cai na primeira que sobrou', () => {
    expect(acertarPalco({ ativo: 0, lado: 1 }, [3, 2])).toEqual({ ativo: 3, lado: null });
  });

  it('nunca divide uma tela com ela mesma', () => {
    expect(acertarPalco({ ativo: 1, lado: 1 }, [0, 1])).toEqual({ ativo: 1, lado: null });
  });
});

describe('porDoLado', () => {
  it('divide o palco com a tela pedida, mantendo a do destaque', () => {
    expect(porDoLado({ ativo: 0, lado: null }, 1)).toEqual({ ativo: 0, lado: 1 });
  });

  it('já dividido, a nova toma o lugar da do lado', () => {
    expect(porDoLado({ ativo: 0, lado: 1 }, 2)).toEqual({ ativo: 0, lado: 2 });
  });

  it('com a própria tela em destaque, ou sem palco, não muda nada', () => {
    const palco = { ativo: 0, lado: null };
    expect(porDoLado(palco, 0)).toBe(palco);
    expect(porDoLado(PALCO_VAZIO, 1)).toBe(PALCO_VAZIO);
    expect(porDoLado(palco, null)).toBe(palco);
  });
});

describe('tirarDoPalco', () => {
  it('tirar a do lado deixa a do destaque sozinha', () => {
    expect(tirarDoPalco({ ativo: 0, lado: 1 }, 1)).toEqual({ ativo: 0, lado: null });
  });

  it('tirar a do destaque passa o destaque para a do lado', () => {
    expect(tirarDoPalco({ ativo: 0, lado: 1 }, 0)).toEqual({ ativo: 1, lado: null });
  });

  it('com uma tela só, tirá-la esvazia o palco para o render escolher outra', () => {
    expect(tirarDoPalco({ ativo: 0, lado: null }, 0)).toEqual(PALCO_VAZIO);
  });

  it('uma tela que não está no palco não muda nada', () => {
    const palco = { ativo: 0, lado: 1 };
    expect(tirarDoPalco(palco, 3)).toBe(palco);
  });
});

describe('promover', () => {
  it('sem divisão, é a troca de destaque de sempre', () => {
    expect(promover({ ativo: 0, lado: null }, 2)).toEqual({ ativo: 2, lado: null });
  });

  it('dividido, a miniatura toma o lugar do destaque e a do lado fica', () => {
    expect(promover({ ativo: 0, lado: 1 }, 2)).toEqual({ ativo: 2, lado: 1 });
  });

  it('promover a do lado troca as duas de lugar, sem tirar nenhuma do palco', () => {
    expect(promover({ ativo: 0, lado: 1 }, 1)).toEqual({ ativo: 1, lado: 0 });
  });
});

describe('aLargar', () => {
  it('nada a largar enquanto a emprestada está no palco', () => {
    expect(aLargar({ ativo: 0, lado: 1 }, new Set([1]))).toEqual([]);
  });

  it('a emprestada que saiu do palco volta a ser convite', () => {
    const emprestadas = new Set([1]);
    const depois = tirarDoPalco({ ativo: 0, lado: 1 }, 1);
    expect(aLargar(depois, emprestadas)).toEqual([1]);
  });

  it('trocar a do lado larga a emprestada que estava lá', () => {
    const depois = porDoLado({ ativo: 0, lado: 1 }, 2);
    expect(aLargar(depois, new Set([1, 2]))).toEqual([1]);
  });

  it('as que já eram assistidas antes de dividir não são largadas', () => {
    // A 1 era assistida antes (não é emprestada): sair do palco a devolve à
    // lateral como miniatura, ainda tocando.
    const depois = tirarDoPalco({ ativo: 0, lado: 1 }, 1);
    expect(aLargar(depois, new Set())).toEqual([]);
  });

  it('a emprestada que ficou sozinha no destaque continua sendo assistida', () => {
    const depois = tirarDoPalco({ ativo: 0, lado: 1 }, 0);
    expect(aLargar(depois, new Set([1]))).toEqual([]);
  });
});
