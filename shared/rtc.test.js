// @vitest-environment jsdom
/**
 * A camada WebRTC, com um RTCPeerConnection de mentira.
 *
 * Este módulo chegou pelo merge sem teste nenhum, e era ele — sozinho —
 * que segurava o piso de cobertura do CI no vermelho.
 *
 * O que se prova aqui é a política, que é a parte que não é do navegador: o
 * candidato nulo que não pode ser repassado, o `failed` do ICE que precisa
 * virar aviso mesmo onde o `connectionstatechange` não vem, a diferença entre
 * ceder resolução (tela) e ceder quadros (câmera), e o fato de que nada disso
 * pode derrubar a transmissão quando falha — porque o relay é o piso e o
 * WebRTC é só o atalho.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  criarPeer,
  suportaWebRTC,
  resumoPeer,
  ajustarEnvio,
  MORTO,
  PRAZO_CONEXAO_MS,
} from './rtc.js';

const STUN = 'stun:stun.l.google.com:19302';

/** Um RTCPeerConnection só com o que este módulo usa. */
function peerFalso() {
  const ouvintes = new Map();
  return {
    connectionState: 'new',
    iceConnectionState: 'new',
    config: null,
    addEventListener: (tipo, fn) => ouvintes.set(tipo, fn),
    disparar: (tipo, evento) => ouvintes.get(tipo)?.(evento),
    getSenders: () => [],
  };
}

let ultimoPeer;

beforeEach(() => {
  ultimoPeer = null;
  globalThis.RTCPeerConnection = vi.fn(function (config) {
    ultimoPeer = peerFalso();
    ultimoPeer.config = config;
    return ultimoPeer;
  });
});

afterEach(() => {
  delete globalThis.RTCPeerConnection;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('o que é constante', () => {
  it('só os estados sem volta contam como morte', () => {
    expect([...MORTO].sort()).toEqual(['closed', 'disconnected', 'failed']);
    // Um peer que ainda está negociando não pode ser dado por perdido.
    expect(MORTO.has('connecting')).toBe(false);
    expect(MORTO.has('connected')).toBe(false);
  });

  it('o prazo é folgado porque esperar não custa nada', () => {
    // Quem assiste está vendo pelo relay o tempo todo; encurtar isto só
    // desistiria de conexões que estavam lentas, não quebradas.
    expect(PRAZO_CONEXAO_MS).toBeGreaterThanOrEqual(5000);
  });

  it('suportaWebRTC responde pelo que o navegador tem', () => {
    expect(suportaWebRTC()).toBe(true);
    delete globalThis.RTCPeerConnection;
    expect(suportaWebRTC()).toBe(false);
  });
});

describe('servidores ICE', () => {
  /**
   * O módulo guarda a promessa para não perguntar duas vezes, e é justamente
   * isso que um caso testa — então cada caso precisa de uma cópia limpa.
   */
  const recarregar = async () => {
    vi.resetModules();
    return (await import('./rtc.js')).iceServers;
  };

  it('usa o que o servidor mandar', async () => {
    const meu = [{ urls: 'turn:exemplo:3478', username: 'a', credential: 'b' }];
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => ({ iceServers: meu }) }),
    );

    expect(await (await recarregar())('/base')).toEqual(meu);
    expect(globalThis.fetch).toHaveBeenCalledWith('/base/api/ice');
  });

  it('busca uma vez só, por mais que perguntem', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => ({ iceServers: [{ urls: 'turn:x' }] }) }),
    );

    const ice = await recarregar();
    await Promise.all([ice(), ice(), ice()]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('rede fora não desliga o WebRTC, cai no STUN público', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sem rede')));

    // Falha aqui não é motivo para desistir: o STUN já atende NAT doméstico.
    expect(await (await recarregar())()).toEqual([{ urls: STUN }]);
  });

  it('resposta ruim ou lista vazia também cai no padrão', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false }));
    expect(await (await recarregar())()).toEqual([{ urls: STUN }]);

    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => ({ iceServers: [] }) }));
    expect(await (await recarregar())()).toEqual([{ urls: STUN }]);
  });
});

describe('criarPeer', () => {
  it('junta áudio e vídeo num transporte só', () => {
    criarPeer({ ice: [{ urls: 'turn:x' }] });

    // Sem max-bundle são duas negociações de ICE para a mesma conexão, e o
    // dobro de tempo até o primeiro quadro.
    expect(ultimoPeer.config.bundlePolicy).toBe('max-bundle');
    expect(ultimoPeer.config.iceServers).toEqual([{ urls: 'turn:x' }]);
  });

  it('sem lista, o STUN público', () => {
    criarPeer({});
    expect(ultimoPeer.config.iceServers).toEqual([{ urls: STUN }]);
  });

  it('repassa o candidato, e nunca o fim da lista', () => {
    const onIce = vi.fn();
    criarPeer({ onIce });

    ultimoPeer.disparar('icecandidate', { candidate: { toJSON: () => ({ candidate: 'a' }) } });
    // O nulo é o fim da lista, não um candidato: repassá-lo faria o outro lado
    // chamar addIceCandidate(null) e lançar.
    ultimoPeer.disparar('icecandidate', { candidate: null });

    expect(onIce).toHaveBeenCalledTimes(1);
    expect(onIce).toHaveBeenCalledWith({ candidate: 'a' });
  });

  it('avisa a mudança de estado da conexão', () => {
    const onEstado = vi.fn();
    criarPeer({ onEstado });

    ultimoPeer.connectionState = 'connected';
    ultimoPeer.disparar('connectionstatechange');

    expect(onEstado).toHaveBeenCalledWith('connected');
  });

  it('falha de ICE vira aviso mesmo sem connectionstatechange', () => {
    const onEstado = vi.fn();
    criarPeer({ onEstado });

    ultimoPeer.iceConnectionState = 'checking';
    ultimoPeer.disparar('iceconnectionstatechange');
    expect(onEstado).not.toHaveBeenCalled();

    // Nem todo navegador emite connectionstatechange em falha de ICE; sem esta
    // segunda porta, a tentativa morta ficaria pendurada até o prazo estourar.
    ultimoPeer.iceConnectionState = 'failed';
    ultimoPeer.disparar('iceconnectionstatechange');
    expect(onEstado).toHaveBeenCalledWith('failed');
  });

  it('sem onTrack não pendura ouvinte de faixa', () => {
    const onTrack = vi.fn();
    criarPeer({ onTrack });
    ultimoPeer.disparar('track', { streams: [] });
    expect(onTrack).toHaveBeenCalled();

    criarPeer({});
    expect(() => ultimoPeer.disparar('track', {})).not.toThrow();
  });
});

describe('ajustarEnvio', () => {
  function senderFalso(kind, params = {}) {
    return {
      track: { kind },
      getParameters: () => params,
      setParameters: vi.fn(() => Promise.resolve()),
    };
  }

  const com = (...senders) => ({ getSenders: () => senders });

  it('tela cede quadros antes de ceder resolução', async () => {
    const s = senderFalso('video', { encodings: [{}] });
    await ajustarEnvio(com(s), { bitrate: 3_000_000, fonte: 'tela', fps: 30 });

    // Texto ilegível é pior que texto que anda a 10 quadros.
    const p = s.setParameters.mock.calls[0][0];
    expect(p.degradationPreference).toBe('maintain-resolution');
    expect(p.encodings[0]).toEqual({ maxBitrate: 3_000_000, maxFramerate: 30 });
  });

  it('câmera cede resolução antes de ceder quadros', async () => {
    const s = senderFalso('video', { encodings: [{}] });
    await ajustarEnvio(com(s), { bitrate: 1, fonte: 'camera' });

    // Ninguém lê um rosto, e movimento picado incomoda mais que imagem macia.
    expect(s.setParameters.mock.calls[0][0].degradationPreference).toBe('maintain-framerate');
  });

  it('inventa o encoding que o navegador não trouxe', async () => {
    const semNada = senderFalso('video', {});
    const vazio = senderFalso('video', { encodings: [] });

    await ajustarEnvio(com(semNada, vazio), { bitrate: 500 });

    // Sem isto o ajuste se perderia em silêncio, que é o pior dos dois mundos.
    expect(semNada.setParameters.mock.calls[0][0].encodings[0].maxBitrate).toBe(500);
    expect(vazio.setParameters.mock.calls[0][0].encodings[0].maxBitrate).toBe(500);
  });

  it('áudio passa sem teto de vídeo', async () => {
    const s = senderFalso('audio', { encodings: [{}] });
    await ajustarEnvio(com(s), { bitrate: 3_000_000, fps: 30 });

    const p = s.setParameters.mock.calls[0][0];
    expect(p.degradationPreference).toBeUndefined();
    expect(p.encodings[0].maxBitrate).toBeUndefined();
  });

  it('sender sem faixa é pulado', async () => {
    const s = { track: null, getParameters: vi.fn(), setParameters: vi.fn() };
    await ajustarEnvio(com(s), { bitrate: 1 });
    expect(s.setParameters).not.toHaveBeenCalled();
  });

  it('navegador que recusa o ajuste transmite com o padrão dele', async () => {
    const s = senderFalso('video', { encodings: [{}] });
    s.setParameters = vi.fn(() => Promise.reject(new Error('não suportado')));

    // Pior, não quebrado: engolir aqui é o que mantém a transmissão de pé.
    await expect(ajustarEnvio(com(s), { bitrate: 1 })).resolves.toBeUndefined();
  });

  it('sem argumentos não escreve teto nenhum', async () => {
    const s = senderFalso('video', { encodings: [{}] });
    await ajustarEnvio(com(s));
    expect(s.setParameters.mock.calls[0][0].encodings[0]).toEqual({});
  });
});

describe('resumoPeer', () => {
  const stats = (lista) => ({
    getStats: () => Promise.resolve(new Map(lista.map((s) => [s.id, s]))),
  });

  it('lê o ida-e-volta do par que venceu', async () => {
    const r = await resumoPeer(
      stats([
        { id: 'l1', type: 'local-candidate', candidateType: 'srflx' },
        {
          id: 'p1',
          type: 'candidate-pair',
          state: 'succeeded',
          currentRoundTripTime: 0.0234,
          localCandidateId: 'l1',
        },
      ]),
    );

    expect(r).toEqual({ rtt: 23, relay: false });
  });

  it('acusa o caminho por TURN, que gasta banda do servidor', async () => {
    const r = await resumoPeer(
      stats([
        { id: 'l1', type: 'local-candidate', candidateType: 'relay' },
        {
          id: 'p1',
          type: 'candidate-pair',
          state: 'succeeded',
          currentRoundTripTime: 0.1,
          localCandidateId: 'l1',
        },
      ]),
    );

    expect(r).toEqual({ rtt: 100, relay: true });
  });

  it('ignora o par que não venceu', async () => {
    const r = await resumoPeer(
      stats([
        { id: 'p1', type: 'candidate-pair', state: 'failed', currentRoundTripTime: 9 },
        {
          id: 'p2',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: false,
          currentRoundTripTime: 9,
        },
      ]),
    );

    expect(r).toEqual({ rtt: null, relay: false });
  });

  it('getStats que explode apaga o diagnóstico, não a conexão', async () => {
    const r = await resumoPeer({ getStats: () => Promise.reject(new Error('antigo demais')) });
    expect(r).toEqual({ rtt: null, relay: false });
  });
});
