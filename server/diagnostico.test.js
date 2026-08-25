/**
 * O boletim de quem assiste.
 *
 * O que se prova aqui é a classificação, que é a parte que decide se alguém vai
 * ser chamado às três da manhã. Ela tem duas armadilhas, e as duas têm teste:
 * "travado" só existe na comparação entre dois boletins — um boletim sozinho
 * não sabe se o contador andou —, e "sem imagem" precisa vir antes de
 * "travado", senão quem nunca teve decodificador é diagnosticado como quem
 * tinha e parou.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as EV from './eventos.js';
import { limpar, limparSala, registrarRelato, relatorio } from './diagnostico.js';

/** Um boletim saudável, com só o que o teste quiser mudar por cima. */
const relato = (extra = {}) => ({
  sala: 'sala1',
  peer: 'p1',
  slot: 0,
  saude: {
    desenhados: 100,
    fila: 2,
    decode: 1,
    resync: 0,
    largados: 0,
    lag: 90,
    jitter: 12,
    decoder: 'configured',
    ...(extra.saude ?? {}),
  },
  ...extra,
});

beforeEach(() => {
  limpar();
  EV.limpar();
});

afterEach(() => limpar());

describe('classificação', () => {
  it('o primeiro boletim de quem está bem é ok', () => {
    expect(registrarRelato(relato()).estado).toBe('ok');
  });

  it('quem nunca desenhou um quadro está sem imagem, e não travado', () => {
    // É o tile eterno em "Conectando…". Chamar isso de travamento mandaria
    // quem investiga procurar a rede, quando pode nunca ter havido decodificador.
    expect(registrarRelato(relato({ saude: { desenhados: 0 } })).estado).toBe('sem-imagem');
  });

  it('sem decodificador vem antes de tudo, porque explica o resto', () => {
    const r = registrarRelato(relato({ saude: { desenhados: 0, decoder: 'closed' } }));
    expect(r.estado).toBe('sem-decodificador');
  });

  it('e diz QUAL codec foi recusado, senao manda adivinhar', () => {
    // Foi exatamente o que faltou na primeira vez que isto apareceu em
    // producao: dezenas de "sem-decodificador" sem dizer de que, e a resposta
    // (H.264? VP9? VP8?) muda completamente o que se conserta.
    const r = registrarRelato(
      relato({ saude: { desenhados: 0, decoder: 'ausente', codec: 'vp09.00.41.08' } }),
    );

    expect(r.codec).toBe('vp09.00.41.08');
    const linha = EV.listar({ escopo: 'cliente' }).eventos.at(-1);
    expect(linha.mensagem).toContain('vp09.00.41.08');
    expect(linha.dados.codec).toBe('vp09.00.41.08');
  });

  it('quem nao vai ver nada aparece na frente de quem travou', () => {
    registrarRelato(relato({ peer: 'travou' }));
    registrarRelato(relato({ peer: 'travou' }));
    registrarRelato(relato({ peer: 'sem-codec', saude: { desenhados: 0, decoder: 'ausente' } }));

    expect(relatorio().espectadores[0].peer).toBe('sem-codec');
  });

  it('o contador que não anda entre dois boletins é o travamento de verdade', () => {
    registrarRelato(relato());
    expect(registrarRelato(relato()).estado).toBe('travado');
  });

  it('e ele volta a ok assim que um quadro novo aparece', () => {
    registrarRelato(relato());
    registrarRelato(relato());
    expect(registrarRelato(relato({ saude: { desenhados: 130 } })).estado).toBe('ok');
  });

  it('atraso alto é atrasado, e não travado: a imagem anda, só que velha', () => {
    // A queixa de "estou vendo o que fiz minutos atrás" — os quadros continuam
    // saindo, em ordem e no ritmo certo, só que cada vez mais antigos.
    registrarRelato(relato());
    const r = registrarRelato(relato({ saude: { desenhados: 130, lag: 9000 } }));
    expect(r.estado).toBe('atrasado');
  });

  it('fila de decodificação funda também conta como atrasado', () => {
    registrarRelato(relato());
    const r = registrarRelato(relato({ saude: { desenhados: 130, decode: 40 } }));
    expect(r.estado).toBe('atrasado');
  });
});

describe('taxa medida entre boletins', () => {
  it('não inventa fps no primeiro, que não tem com o que comparar', () => {
    expect(registrarRelato(relato()).fps).toBe(null);
  });

  it('mede pelo que o contador andou, e não pelo que o cliente disse', () => {
    const a = registrarRelato(relato());
    a.em -= 2000; // dois segundos atrás
    const b = registrarRelato(relato({ saude: { desenhados: 160 } }));
    expect(b.fps).toBe(30);
  });
});

describe('o que vai para o log', () => {
  it('só a mudança de estado vira linha', () => {
    registrarRelato(relato());
    registrarRelato(relato({ saude: { desenhados: 130 } }));
    registrarRelato(relato({ saude: { desenhados: 160 } }));

    // Três boletins saudáveis, uma linha só: a de entrada em 'ok'.
    expect(EV.listar({ escopo: 'cliente' }).eventos).toHaveLength(1);
  });

  it('travar e voltar são as duas linhas que alguém vai querer ler amanhã', () => {
    registrarRelato(relato());
    registrarRelato(relato());
    registrarRelato(relato({ saude: { desenhados: 200 } }));

    const msgs = EV.listar({ escopo: 'cliente' }).eventos.map((e) => e.mensagem);
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toContain('travado');
    expect(msgs[2]).toContain('ok');
  });

  it('problema é aviso, e não info: no painel eles não se misturam', () => {
    registrarRelato(relato());
    registrarRelato(relato());
    const ultimo = EV.listar({ escopo: 'cliente' }).eventos.at(-1);
    expect(ultimo.nivel).toBe('aviso');
  });
});

describe('higiene do que veio do navegador', () => {
  it('número que não é número vira zero, e não NaN no painel', () => {
    const r = registrarRelato(relato({ saude: { fila: 'muita', lag: null } }));
    expect(r.fila).toBe(0);
    expect(r.lag).toBe(0);
  });

  it('texto de cliente entra limitado', () => {
    const r = registrarRelato(relato({ nome: 'x'.repeat(200) }));
    expect(r.nome).toHaveLength(32);
  });

  it('via só aceita os dois caminhos que existem', () => {
    expect(registrarRelato(relato({ via: 'pombo-correio' })).via).toBe('relay');
    expect(registrarRelato(relato({ via: 'rtc' })).via).toBe('rtc');
  });
});

describe('relatório', () => {
  it('põe quem está com problema em cima, que é a linha que se abre o painel para ver', () => {
    registrarRelato(relato({ peer: 'bem' }));
    registrarRelato(relato({ peer: 'mal', saude: { desenhados: 0 } }));

    expect(relatorio().espectadores[0].peer).toBe('mal');
  });

  it('conta quantos estão em cada estado', () => {
    registrarRelato(relato({ peer: 'a' }));
    registrarRelato(relato({ peer: 'b', saude: { desenhados: 0 } }));

    expect(relatorio().resumo).toEqual({ ok: 1, 'sem-imagem': 1 });
  });

  it('filtra por sala', () => {
    registrarRelato(relato({ sala: 'sala1' }));
    registrarRelato(relato({ sala: 'sala2', peer: 'outro' }));

    expect(relatorio({ sala: 'sala2' }).espectadores).toHaveLength(1);
  });

  it('esquece quem parou de dar notícia', () => {
    const r = registrarRelato(relato());
    r.em -= 120_000;

    expect(relatorio().espectadores).toHaveLength(0);
  });

  it('a mesma pessoa em duas telas são duas linhas', () => {
    registrarRelato(relato({ slot: 0 }));
    registrarRelato(relato({ slot: 1 }));

    expect(relatorio().espectadores).toHaveLength(2);
  });
});

describe('limpeza', () => {
  it('sala que acabou leva os boletins dela junto', () => {
    registrarRelato(relato({ sala: 'sala1' }));
    registrarRelato(relato({ sala: 'sala2', peer: 'outro' }));

    limparSala('sala1');

    expect(relatorio().espectadores.map((e) => e.sala)).toEqual(['sala2']);
  });
});
