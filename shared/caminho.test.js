// @vitest-environment jsdom
/**
 * O caminho curto até o ar: por onde cada fonte liga, o que a aba faz com o
 * pedido, que clique abre o seletor, e o que fica lembrado de uma vez para a
 * outra.
 */
import { describe, expect, it } from 'vitest';
import { rotaDaFonte, pedidoDaFonte, cliqueComeca, sanearCamera, lembranca } from './caminho.js';

describe('rotaDaFonte', () => {
  it('fora do Discord a tela abre o seletor na própria página, com ou sem aba', () => {
    expect(rotaDaFonte({ fonte: 'tela', inDiscord: false, abaAberta: false })).toBe('aqui');
    // O caso que custava um clique e uma troca de aba.
    expect(rotaDaFonte({ fonte: 'tela', inDiscord: false, abaAberta: true })).toBe('aqui');
  });

  it('no Discord a tela tenta o iframe primeiro, e com a aba aberta vai direto ao link', () => {
    expect(rotaDaFonte({ fonte: 'tela', inDiscord: true, abaAberta: false })).toBe('aqui');
    expect(rotaDaFonte({ fonte: 'tela', inDiscord: true, abaAberta: true })).toBe('link');
  });

  it('a câmera nunca nasce na página da sala', () => {
    expect(rotaDaFonte({ fonte: 'camera', inDiscord: true, abaAberta: false })).toBe('link');
    // Do Discord não há como focar a aba que mora no navegador do sistema.
    expect(rotaDaFonte({ fonte: 'camera', inDiscord: true, abaAberta: true })).toBe('link');
    expect(rotaDaFonte({ fonte: 'camera', inDiscord: false, abaAberta: false })).toBe('link');
    expect(rotaDaFonte({ fonte: 'camera', inDiscord: false, abaAberta: true })).toBe('aba');
  });
});

describe('pedidoDaFonte', () => {
  it('a câmera vai ao ar sem prévia no caminho', () => {
    expect(pedidoDaFonte({ fonte: 'camera', ativo: false, indisponivel: false })).toBe('ligar');
  });

  it('a tela espera o gesto que o seletor exige', () => {
    expect(pedidoDaFonte({ fonte: 'tela', ativo: false, indisponivel: false })).toBe('chamar');
  });

  it('o que já está no ar, ou não existe aqui, não reage', () => {
    expect(pedidoDaFonte({ fonte: 'camera', ativo: true, indisponivel: false })).toBe('nada');
    expect(pedidoDaFonte({ fonte: 'tela', ativo: true, indisponivel: false })).toBe('nada');
    expect(pedidoDaFonte({ fonte: 'tela', ativo: false, indisponivel: true })).toBe('nada');
    expect(pedidoDaFonte({ fonte: 'microfone', ativo: false, indisponivel: false })).toBe('nada');
  });
});

describe('cliqueComeca', () => {
  function pagina() {
    document.body.innerHTML = `
      <main>
        <p id="texto">Tela</p>
        <label id="rotulo">Qualidade <select id="sel"><option>1</option></select></label>
        <button id="botao"><svg><path id="icone" /></svg></button>
        <ul role="menu"><li id="item">Câmera 1</li></ul>
      </main>`;
    return (id) => document.getElementById(id);
  }

  it('com a tela chamada, um clique em área sem controle abre o seletor', () => {
    const $ = pagina();
    expect(cliqueComeca({ chamando: true, ativo: false, alvo: $('texto') })).toBe(true);
    expect(cliqueComeca({ chamando: true, ativo: false, alvo: document.body })).toBe(true);
  });

  it('o que tem clique próprio continua fazendo o que faz', () => {
    const $ = pagina();
    for (const id of ['sel', 'rotulo', 'botao', 'icone', 'item']) {
      expect(cliqueComeca({ chamando: true, ativo: false, alvo: $(id) })).toBe(false);
    }
  });

  it('sem chamado, ou com a tela no ar, nenhum clique vira começar', () => {
    const $ = pagina();
    expect(cliqueComeca({ chamando: false, ativo: false, alvo: $('texto') })).toBe(false);
    expect(cliqueComeca({ chamando: true, ativo: true, alvo: $('texto') })).toBe(false);
  });

  it('do teclado, só Enter e espaço', () => {
    const $ = pagina();
    expect(
      cliqueComeca({ chamando: true, ativo: false, alvo: document.body, tecla: 'Enter' }),
    ).toBe(true);
    expect(cliqueComeca({ chamando: true, ativo: false, alvo: document.body, tecla: ' ' })).toBe(
      true,
    );
    expect(cliqueComeca({ chamando: true, ativo: false, alvo: document.body, tecla: 'a' })).toBe(
      false,
    );
    // Enter num select é escolher a opção, não começar.
    expect(cliqueComeca({ chamando: true, ativo: false, alvo: $('sel'), tecla: 'Enter' })).toBe(
      false,
    );
  });

  it('um alvo que não é elemento ainda conta como a página', () => {
    expect(cliqueComeca({ chamando: true, ativo: false, alvo: null })).toBe(true);
  });
});

describe('sanearCamera', () => {
  it('guarda o que é válido', () => {
    expect(
      sanearCamera({ dispositivo: 'abc', fundo: 'desfoque', cor: '#A0b1C2', janela: '70' }),
    ).toEqual({ dispositivo: 'abc', fundo: 'desfoque', cor: '#A0b1C2', janela: 70 });
  });

  it('descarta o que vier estragado, campo a campo', () => {
    expect(
      sanearCamera({ dispositivo: '', fundo: 'arco-íris', cor: 'red', janela: 10, gif: 'x.gif' }),
    ).toEqual({});
    expect(sanearCamera({ janela: 101 })).toEqual({});
    // O fundo de mídia depende de um arquivo que não sobrevive à aba.
    expect(sanearCamera({ fundo: 'midia' })).toEqual({});
    expect(sanearCamera({ janela: 'abc' })).toEqual({});
    expect(sanearCamera(null)).toEqual({});
    expect(sanearCamera('lixo')).toEqual({});
  });
});

describe('lembranca', () => {
  function armazenamentoFalso(inicial = {}) {
    const dados = { ...inicial };
    return {
      dados,
      getItem: (k) => (k in dados ? dados[k] : null),
      setItem: (k, v) => {
        dados[k] = String(v);
      },
    };
  }

  it('começa vazia e devolve o que foi guardado', () => {
    const a = armazenamentoFalso();
    const l = lembranca(a, 'cam', sanearCamera);
    expect(l.ler()).toEqual({});
    l.guardar({ dispositivo: 'usb' });
    l.guardar({ fundo: 'cor' });
    // Cada escolha soma à anterior em vez de apagá-la.
    expect(l.ler()).toEqual({ dispositivo: 'usb', fundo: 'cor' });
    expect(JSON.parse(a.dados.cam)).toEqual({ dispositivo: 'usb', fundo: 'cor' });
  });

  it('JSON corrompido vira vazio em vez de derrubar a página', () => {
    const l = lembranca(armazenamentoFalso({ cam: '{nao é json' }), 'cam', sanearCamera);
    expect(l.ler()).toEqual({});
  });

  it('o que foi gravado estragado sai saneado na leitura', () => {
    const a = armazenamentoFalso({ cam: JSON.stringify({ fundo: 'xadrez', cor: '#000000' }) });
    expect(lembranca(a, 'cam', sanearCamera).ler()).toEqual({ cor: '#000000' });
  });

  it('armazenamento que recusa gravar não impede a escolha de valer agora', () => {
    const recusa = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(lembranca(recusa, 'cam', sanearCamera).guardar({ fundo: 'cor' })).toEqual({
      fundo: 'cor',
    });
  });

  it('sem armazenamento nenhum, lê vazio e não quebra', () => {
    const l = lembranca(undefined, 'cam');
    expect(l.ler()).toEqual({});
    expect(l.guardar({ a: 1 })).toEqual({ a: 1 });
  });
});
