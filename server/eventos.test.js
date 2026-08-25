/**
 * O anel de eventos que alimenta o log do painel.
 *
 * O que importa provar aqui não é que uma lista guarda itens: é que ela não
 * cresce sem fim, que o `desde` devolve só o que é novo, e que derivar o
 * console não tira nada do terminal nem duplica linha quando alguém chama a
 * derivação duas vezes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { derivarConsole, limpar, listar, registrar } from './eventos.js';

beforeEach(() => limpar());

describe('registrar', () => {
  it('guarda o evento com id crescente e o devolve na listagem', () => {
    registrar('info', 'sala', 'primeira');
    registrar('erro', 'rede', 'segunda');

    const { eventos } = listar();
    expect(eventos.map((e) => e.mensagem)).toEqual(['primeira', 'segunda']);
    expect(eventos[1].id).toBeGreaterThan(eventos[0].id);
  });

  it('normaliza nível e escopo desconhecidos em vez de guardar lixo', () => {
    registrar('catastrofe', 'inventado', 'oi');

    const [evento] = listar().eventos;
    expect(evento.nivel).toBe('info');
    expect(evento.escopo).toBe('sistema');
  });

  it('corta mensagem gigante: uma linha longa não ajuda e enche o anel', () => {
    registrar('info', 'sala', 'x'.repeat(2000));

    expect(listar().eventos[0].mensagem).toHaveLength(400);
  });

  it('não cresce sem teto — log sem limite é vazamento com data marcada', () => {
    for (let i = 0; i < 800; i++) registrar('info', 'sala', `linha ${i}`);

    const { eventos, perdidos } = listar({ limite: 400 });
    expect(eventos.length).toBeLessThanOrEqual(400);
    // O que o anel descartou é dito, e não escondido: buraco no log que o
    // painel mostra sem avisar é pior do que buraco nenhum.
    expect(perdidos).toBeGreaterThan(0);
    expect(eventos.at(-1).mensagem).toBe('linha 799');
  });
});

describe('listar', () => {
  it('devolve só o que nasceu depois do id pedido', () => {
    registrar('info', 'sala', 'velha');
    const { ultimoId } = listar();
    registrar('info', 'sala', 'nova');

    const { eventos } = listar({ desde: ultimoId });
    expect(eventos.map((e) => e.mensagem)).toEqual(['nova']);
  });

  it('filtra por nível e por origem', () => {
    registrar('info', 'sala', 'a');
    registrar('erro', 'sala', 'b');
    registrar('erro', 'rede', 'c');

    expect(listar({ nivel: 'erro' }).eventos.map((e) => e.mensagem)).toEqual(['b', 'c']);
    expect(listar({ escopo: 'rede' }).eventos.map((e) => e.mensagem)).toEqual(['c']);
  });
});

describe('derivarConsole', () => {
  it('espelha para o anel sem tirar nada do terminal', () => {
    const escrito = [];
    const falso = {
      log: (...a) => escrito.push(['log', ...a]),
      warn: (...a) => escrito.push(['warn', ...a]),
      error: (...a) => escrito.push(['error', ...a]),
    };

    derivarConsole(falso);
    falso.log('[room abc] alguém entrou');
    falso.warn('[rtc] oferta falhou');

    // O terminal continua recebendo tudo, exatamente como antes.
    expect(escrito).toEqual([
      ['log', '[room abc] alguém entrou'],
      ['warn', '[rtc] oferta falhou'],
    ]);

    // E o prefixo que o servidor já usava vira o escopo, sem que nenhuma
    // chamada de log tenha sido reescrita.
    const { eventos } = listar();
    expect(eventos[0]).toMatchObject({ escopo: 'sala', nivel: 'info' });
    expect(eventos[1]).toMatchObject({ escopo: 'transmissao', nivel: 'aviso' });
  });

  it('derivar duas vezes não duplica cada linha', () => {
    const falso = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    derivarConsole(falso);
    derivarConsole(falso);
    falso.log('uma vez só');

    expect(listar().eventos.filter((e) => e.mensagem === 'uma vez só')).toHaveLength(1);
  });
});
