/**
 * A projeção pública é uma função pura, e o que se testa aqui é o que ela
 * DEIXA de fora: id de sala que não abre, número de diagnóstico, id de conta.
 * Um vazamento desses não quebra nada em produção — só aparece, em silêncio,
 * numa página que qualquer um abre. Então o teste é a única coisa que percebe.
 */
import { describe, expect, it } from 'vitest';
import { chaveDe, montarEstadoPublico } from './publico.js';

function trafego(recebido = 0, enviado = 0) {
  return {
    receivedBytes: 0,
    transmittedBytes: 0,
    droppedBytes: 0,
    receivedBytesPerSecond: recebido,
    transmittedBytesPerSecond: enviado,
    droppedBytesPerSecond: 0,
  };
}

function pessoa(id, extra = {}) {
  return {
    id,
    name: `Pessoa ${id}`,
    avatar: null,
    roles: ['viewer'],
    connections: 1,
    connectedAt: 1000,
    pingMs: 12,
    watching: [],
    broadcasting: false,
    mediaBytesOut: 999,
    bufferedBytes: 999,
    ...extra,
  };
}

function sala(id, extra = {}) {
  return {
    id,
    name: `Sala ${id}`,
    ownerName: 'Dona',
    instance: 'web',
    guildId: null,
    guildName: null,
    channelId: null,
    isCall: false,
    locked: false,
    codigoVisivel: null,
    createdAt: 1000,
    connections: 1,
    viewers: 1,
    broadcasters: 0,
    droppedChunks: 3,
    traffic: trafego(),
    controles: 0,
    quadro: { tracos: 0, pontos: 0 },
    emptySince: null,
    users: [],
    streams: [],
    ...extra,
  };
}

function tela(extra = {}) {
  return {
    slot: 0,
    userId: 'u1',
    userName: 'Dona',
    fonte: 'tela',
    startedAt: 2000,
    codec: 'avc1.42E01E',
    width: 1920,
    height: 1080,
    audioCodec: null,
    watchers: 2,
    droppedChunks: 7,
    bufferedBytes: 4096,
    pingMs: 30,
    traffic: trafego(),
    taxaBytes: 100,
    teto: 200,
    chunksLigados: true,
    espectadores: [],
    anotacoes: { tracos: 0, pontos: 0 },
    ...extra,
  };
}

const montar = (rooms, extra = {}) =>
  montarEstadoPublico({
    roomState: { rooms, traffic: trafego(1000, 2000), startedAt: 500, ...extra },
    instanciaWeb: 'web',
  });

describe('montarEstadoPublico', () => {
  it('conta a mesma pessoa em duas salas como uma pessoa', () => {
    const estado = montar([
      sala('a', { users: [pessoa('u1'), pessoa('u2')] }),
      sala('b', { users: [pessoa('u1')] }),
    ]);

    expect(estado.resumo.pessoas).toBe(2);
    expect(estado.pessoas.find((p) => p.nome === 'Pessoa u1').salas).toBe(2);
  });

  it('leva o id da sala do site, que é por onde se entra', () => {
    const [publica] = montar([sala('abc')]).salas;

    expect(publica.id).toBe('abc');
    expect(publica.entravel).toBe(true);
    expect(publica.motivo).toBe(null);
  });

  it('não leva o id da sala da call, que é derivado do canal de voz', () => {
    const [publica] = montar([sala('call-42', { isCall: true, instance: 'atividade-9' })]).salas;

    expect(publica.id).toBe(null);
    expect(publica.entravel).toBe(false);
    expect(publica.motivo).toBe('call');
    // A sala continua aparecendo: ela faz parte do que está acontecendo.
    expect(publica.nome).toBe('Sala call-42');
  });

  it('não leva o id de sala criada dentro do Discord, que o site recusaria', () => {
    const [publica] = montar([sala('x', { instance: 'atividade-9' })]).salas;

    expect(publica.id).toBe(null);
    expect(publica.motivo).toBe('discord');
  });

  it('não leva número de diagnóstico nenhum', () => {
    const estado = montar([
      sala('a', {
        users: [pessoa('u1', { broadcasting: true, watching: [0] })],
        streams: [tela()],
      }),
    ]);

    const texto = JSON.stringify(estado);
    for (const vazamento of ['droppedChunks', 'bufferedBytes', 'pingMs', 'teto', 'taxaBytes']) {
      expect(texto).not.toContain(vazamento);
    }
    // O que sobra da tela é o que interessa a quem vai assistir.
    expect(estado.salas[0].telas[0]).toEqual({
      quem: 'Dona',
      fonte: 'tela',
      desde: 2000,
      resolucao: '1920×1080',
      assistindo: 2,
    });
  });

  it('troca o id da conta por uma chave opaca, e mantém o avatar utilizável', () => {
    const estado = montar([
      sala('a', { users: [pessoa('123456789012345678', { avatar: 'abcdef' })] }),
    ]);

    const [quem] = estado.pessoas;
    expect(quem.chave).toBe(chaveDe('123456789012345678'));
    expect(quem.chave).not.toContain('123456789012345678');
    expect(quem.avatar).toBe('/api/avatar/123456789012345678/abcdef');
    expect(quem.convidado).toBe(false);
  });

  it('marca quem entrou sem conta do Discord', () => {
    const estado = montar([sala('a', { users: [pessoa('guest-abc')] })]);

    expect(estado.pessoas[0].convidado).toBe(true);
    expect(estado.pessoas[0].avatar).toBe(null);
  });

  it('põe na frente a sala com tela no ar, depois a com gente', () => {
    const estado = montar([
      sala('vazia', { createdAt: 1 }),
      sala('cheia', { createdAt: 2, users: [pessoa('u1'), pessoa('u2')] }),
      sala('no-ar', { createdAt: 3, streams: [tela()] }),
    ]);

    expect(estado.salas.map((s) => s.nome)).toEqual(['Sala no-ar', 'Sala cheia', 'Sala vazia']);
  });

  it('resume o que a página mostra no alto', () => {
    const estado = montar([
      sala('a', {
        guildName: 'Servidor X',
        instance: 'atividade-9',
        users: [pessoa('u1', { broadcasting: true })],
        streams: [tela({ watchers: 3 })],
      }),
      sala('b', { users: [pessoa('u2')] }),
    ]);

    expect(estado.resumo).toEqual({
      pessoas: 2,
      salas: 2,
      abertas: 1,
      telas: 1,
      assistindo: 3,
      servidores: 1,
    });
    expect(estado.banda).toEqual({ recebido: 1000, enviado: 2000 });
    expect(estado.noArDesde).toBe(500);
  });

  it('dá a mesma chave para a mesma sala e chaves diferentes para salas diferentes', () => {
    const primeira = montar([sala('a'), sala('b')]).salas;
    const segunda = montar([sala('a')]).salas;

    expect(primeira[0].chave).not.toBe(primeira[1].chave);
    expect(segunda[0].chave).toBe(primeira.find((s) => s.nome === 'Sala a').chave);
  });
});
