/**
 * A página pública de estado.
 *
 * Duas regras, as mesmas do painel:
 *
 * - **textContent, nunca innerHTML, em tudo que veio do servidor.** Nome de
 *   sala e de pessoa são texto que outra gente escolhe. O único HTML montado
 *   aqui é o dos ícones, escrito neste arquivo.
 * - **O que é normal em zero não aparece.** Um número que fica zero o tempo
 *   todo ensina a não olhar para ele.
 *
 * O laço para quando a aba sai de vista: uma aba esquecida aberta de um dia
 * para o outro pediria isto vinte mil vezes sem ninguém olhando.
 *
 * E antes de tudo isso vem a porta: a página só desenha depois que o servidor
 * confirma quem está olhando. A confirmação é dele, nunca daqui — este arquivo
 * só sabe desenhar as duas telas que a resposta manda desenhar.
 */

const $ = (id) => document.getElementById(id);
const INTERVALO_MS = 4000;

let timer = null;
let carregando = false;

const el = (tag, classe, texto) => {
  const node = document.createElement(tag);
  if (classe) node.className = classe;
  if (texto !== undefined) node.textContent = texto;
  return node;
};

function texto(id, valor) {
  const node = $(id);
  if (node) node.textContent = valor;
}

/** Ícone inline. O `d` é sempre uma constante deste arquivo, nunca do servidor. */
function icone(d, classe = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (classe) svg.setAttribute('class', classe);
  for (const parte of [].concat(d)) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', parte);
    svg.append(path);
  }
  return svg;
}

const ICONE = {
  cadeado: ['M7 11V8a5 5 0 0 1 10 0v3', 'M5 11h14v9H5z'],
  tela: ['M3 5h18v11H3z', 'M8 20h8'],
  camera: ['M15 9.5 21 6v12l-6-3.5', 'M3 6h12v12H3z'],
  discord: ['M8 12h.01M16 12h.01', 'M5 18 4 8a16 16 0 0 1 16 0l-1 10a12 12 0 0 1-14 0z'],
  link: [
    'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1',
    'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  ],
};

// ------------------------------------------------------------------ formato

function taxa(bytesPorSegundo) {
  if (!Number.isFinite(bytesPorSegundo)) return '—';
  const bits = bytesPorSegundo * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;
  return `${Math.round(bits)} b/s`;
}

function duracao(segundos) {
  if (!Number.isFinite(segundos)) return '—';
  const total = Math.max(0, Math.floor(segundos));
  const dias = Math.floor(total / 86400);
  const horas = Math.floor((total % 86400) / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  if (dias) return `${dias}d ${horas}h`;
  if (horas) return `${horas}h ${minutos}min`;
  if (minutos) return `${minutos}min`;
  return `${total}s`;
}

const desde = (ms) => (Number.isFinite(ms) ? duracao((Date.now() - ms) / 1000) : '—');

/** Plural sem gambiarra de string: "1 sala" e "3 salas". */
const conta = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;

/**
 * As iniciais de quem não tem foto.
 *
 * Uma bolinha vazia no meio de uma fileira de avatares parece falha de
 * carregamento; com a letra dentro, parece o que é — alguém sem foto.
 */
function iniciais(nome) {
  const partes = String(nome ?? '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function avatar(pessoa, classe = '') {
  const nome = pessoa.nome ?? '?';
  if (pessoa.avatar) {
    const img = document.createElement('img');
    img.className = `av ${classe} ${pessoa.transmitindo ? 'transmitindo' : ''}`.trim();
    img.src = pessoa.avatar;
    img.alt = '';
    img.loading = 'lazy';
    // A CDN do Discord pode devolver 404 para um hash trocado no meio da
    // sessão. Sem isto sobra o ícone de imagem quebrada, que parece defeito da
    // página; com isto vira a bolinha com as iniciais, que é o mesmo que
    // acontece com quem nunca teve foto.
    img.addEventListener('error', () =>
      img.replaceWith(bolinha(nome, classe, pessoa.transmitindo)),
    );
    return img;
  }
  return bolinha(nome, classe, pessoa.transmitindo);
}

function bolinha(nome, classe, transmitindo) {
  return el(`div`, `av ${classe} ${transmitindo ? 'transmitindo' : ''}`.trim(), iniciais(nome));
}

// ------------------------------------------------------------------ copiar

function aviso(mensagem, tom = '') {
  const node = el('div', `toast ${tom}`.trim(), mensagem);
  $('avisos').append(node);
  setTimeout(() => node.remove(), 3200);
}

/**
 * Copia um link e diz que copiou.
 *
 * `navigator.clipboard` não existe fora de https (nem em http://ip:porta, que é
 * como muita gente abre isto na rede de casa). Sem o caminho de reserva, o
 * botão principal desta página não faria nada justamente ali — e um botão que
 * não faz nada não tem como ser diagnosticado por quem clicou.
 */
async function copiar(texto, recado = 'Link copiado') {
  try {
    await navigator.clipboard.writeText(texto);
    aviso(recado, 'bom');
    return;
  } catch {
    // Cai para o modo antigo, abaixo.
  }

  try {
    const campo = document.createElement('textarea');
    campo.value = texto;
    campo.setAttribute('readonly', '');
    campo.style.position = 'fixed';
    campo.style.opacity = '0';
    document.body.append(campo);
    campo.select();
    document.execCommand('copy');
    campo.remove();
    aviso(recado, 'bom');
  } catch {
    aviso('Não deu para copiar. O link está na barra de endereço.', 'ruim');
  }
}

const linkDaSala = (sala) => `${location.origin}/convite/${encodeURIComponent(sala.id)}`;

$('copiarPagina').addEventListener('click', () =>
  copiar(`${location.origin}/servidor`, 'Link desta página copiado'),
);

// -------------------------------------------------------------------- ciclo

function vivo(ok, mensagem) {
  const node = $('vivo');
  node.className = ok ? 'vivo' : 'vivo morto';
  node.replaceChildren(el('i'), document.createTextNode(` ${mensagem}`));
}

async function carregar() {
  if (carregando) return;
  carregando = true;
  try {
    const resposta = await fetch('/api/publico', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    // 404 aqui não é erro de rede: é quem hospeda tendo desligado a página.
    // Dizer isso poupa quem abriu o endereço de procurar defeito onde não há.
    if (resposta.status === 404) {
      pararLaco();
      vivo(false, 'desligada');
      mostrarAviso(
        'Esta página está desligada neste servidor. Quem hospeda pode ligá-la de volta com PUBLIC_STATUS=on.',
      );
      return;
    }

    // A sessão dura oito horas. Quando vence no meio do uso, a porta volta —
    // em vez de a página piscar um erro que ninguém sabe resolver.
    if (resposta.status === 401) {
      pararLaco();
      mostrarPortao({ error: 'login_required', aplicacao: true, exigeServidor: true });
      return;
    }

    if (!resposta.ok) throw new Error(`o servidor respondeu ${resposta.status}`);

    desenhar(await resposta.json());
    vivo(true, 'ao vivo');
    $('aviso').hidden = true;
  } catch (erro) {
    vivo(false, 'sem conexão');
    mostrarAviso(`Não deu para atualizar agora: ${erro.message}. Tentando de novo…`);
  } finally {
    carregando = false;
  }
}

function mostrarAviso(mensagem) {
  $('aviso').textContent = mensagem;
  $('aviso').hidden = false;
}

// ------------------------------------------------------------------ desenho

function desenhar(dados) {
  const { resumo, banda } = dados;

  // Cada linha de baixo fala do número de cima dela, e de mais nada: quatro
  // cartões que se explicam entre si é o jeito de nenhum deles ser lido.
  const mostrando = dados.pessoas.filter((p) => p.transmitindo).length;

  texto('numPessoas', String(resumo.pessoas));
  texto(
    'subPessoas',
    mostrando ? `${conta(mostrando, 'está', 'estão')} mostrando a tela` : 'ninguém transmitindo',
  );

  texto('numSalas', String(resumo.salas));
  texto(
    'subSalas',
    resumo.abertas === resumo.salas
      ? 'todas abrem pelo navegador'
      : `${resumo.abertas} abrem pelo navegador`,
  );

  texto('numTelas', String(resumo.telas));
  texto(
    'subTelas',
    resumo.assistindo ? conta(resumo.assistindo, 'pessoa vendo', 'pessoas vendo') : 'ninguém vendo',
  );

  texto('numBanda', taxa(banda.enviado));
  texto('subBanda', `↓ ${taxa(banda.recebido)} de quem transmite`);

  texto('noAr', `no ar há ${desde(dados.noArDesde)}`);
  texto('contaSalas', String(dados.salas.length));
  texto('contaPessoas', String(dados.pessoas.length));

  desenharSalas(dados.salas);
  desenharPessoas(dados.pessoas);
}

function desenharSalas(salas) {
  $('salasVazio').hidden = salas.length > 0;
  $('salas').replaceChildren(...salas.map(cartaoDeSala));
}

function cartaoDeSala(sala) {
  const card = el('article', `sala${sala.telas.length ? ' ao-vivo' : ''}`);

  const topo = el('div', 'sala-topo');
  const titulo = el('div');
  titulo.append(el('div', 'sala-nome', sala.nome));
  titulo.append(
    el(
      'div',
      'sala-dono',
      [sala.dono ? `por ${sala.dono}` : null, `aberta há ${desde(sala.criadaEm)}`]
        .filter(Boolean)
        .join(' · '),
    ),
  );
  topo.append(titulo);
  card.append(topo);

  const selos = el('div', 'selos');
  if (sala.telas.length) {
    const live = el('span', 'selo live');
    live.append(el('i'), document.createTextNode('AO VIVO'));
    selos.append(live);
  }
  if (sala.trancada) selos.append(selo('com senha', ICONE.cadeado));
  if (sala.servidor) selos.append(selo(sala.servidor, ICONE.discord, 'discord'));
  else if (sala.doDiscord) selos.append(selo('no Discord', ICONE.discord, 'discord'));
  if (selos.childElementCount) card.append(selos);

  if (sala.telas.length) {
    const telas = el('div', 'telas');
    for (const tela of sala.telas) {
      const linha = el('div', 'tela');
      linha.append(icone(tela.fonte === 'camera' ? ICONE.camera : ICONE.tela));
      linha.append(el('span', 'tela-quem', tela.quem));
      linha.append(
        el(
          'span',
          'tela-meta',
          [
            tela.resolucao,
            tela.assistindo ? conta(tela.assistindo, 'assistindo', 'assistindo') : null,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      );
      telas.append(linha);
    }
    card.append(telas);
  }

  card.append(quemEsta(sala.pessoas));
  card.append(entrada(sala));
  return card;
}

function selo(rotulo, desenho, classe = '') {
  const s = el('span', `selo ${classe}`.trim());
  if (desenho) s.append(icone(desenho));
  s.append(document.createTextNode(rotulo));
  return s;
}

/**
 * Quem está dentro, em pilha de avatares.
 *
 * Seis é onde a pilha para: a partir daí ela vira uma faixa cinza sem
 * informação nenhuma, e o "+4" diz mais do que a sétima bolinha diria.
 */
function quemEsta(pessoas) {
  const caixa = el('div', 'dentro');

  if (!pessoas.length) {
    caixa.append(el('span', 'pessoa-faz', 'vazia agora'));
    return caixa;
  }

  const pilha = el('div', 'pilha');
  for (const pessoa of pessoas.slice(0, 6)) pilha.append(avatar(pessoa));
  if (pessoas.length > 6) pilha.append(el('div', 'av', `+${pessoas.length - 6}`));
  caixa.append(pilha);

  const nomes = pessoas.slice(0, 3).map((p) => p.nome);
  caixa.append(
    el(
      'span',
      'dentro-nomes',
      pessoas.length > 3 ? `${nomes.join(', ')} e mais ${pessoas.length - 3}` : nomes.join(', '),
    ),
  );

  return caixa;
}

/**
 * O botão de entrar — ou a explicação de por que ele não existe aqui.
 *
 * A sala de uma call do Discord não abre pelo site: quem manda nela é a
 * presença no canal de voz, e o servidor recusaria a entrada de qualquer jeito.
 * Um botão morto faria a página parecer quebrada; a frase faz a pessoa procurar
 * a porta certa.
 */
function entrada(sala) {
  const fim = el('div', 'sala-fim');

  if (sala.entravel && sala.id) {
    const link = el('a', 'btn btn-brand', sala.trancada ? 'Entrar com a senha' : 'Entrar');
    link.href = `/?sala=${encodeURIComponent(sala.id)}`;
    fim.append(link);

    // O convite é para colar no Discord: quem receber e não tiver entrado
    // ainda passa pelo login e cai nesta sala, não numa lista para procurar.
    const convite = el('button', 'btn icone-so');
    convite.title = 'Copiar o convite desta sala';
    convite.setAttribute('aria-label', 'Copiar o convite desta sala');
    convite.append(icone(ICONE.link, 'ic'));
    convite.addEventListener('click', () => copiar(linkDaSala(sala), 'Convite copiado'));
    fim.append(convite);
    return fim;
  }

  fim.append(
    el(
      'span',
      'porque',
      sala.isCall
        ? 'Sala de uma call: abre pela atividade do Discord, dentro do canal de voz.'
        : 'Criada dentro do Discord: abre pela atividade, no canal de voz de onde ela nasceu.',
    ),
  );
  return fim;
}

function desenharPessoas(pessoas) {
  $('pessoasVazio').hidden = pessoas.length > 0;

  $('pessoas').replaceChildren(
    ...pessoas.map((pessoa) => {
      const linha = el('div', 'pessoa');
      linha.append(avatar(pessoa, 'grande'));

      const caixa = el('div');
      caixa.append(el('div', 'pessoa-nome', pessoa.nome));

      const faz = pessoa.transmitindo
        ? 'mostrando a tela'
        : pessoa.assistindo
          ? conta(pessoa.assistindo, 'tela assistindo', 'telas assistindo')
          : pessoa.convidado
            ? 'entrou sem conta'
            : 'na sala';
      caixa.append(el('div', `pessoa-faz${pessoa.transmitindo ? ' no-ar' : ''}`, faz));

      linha.append(caixa);
      return linha;
    }),
  );
}

// --------------------------------------------------------------------- laço

function comecarLaco() {
  if (timer) return;
  timer = setInterval(carregar, INTERVALO_MS);
}

function pararLaco() {
  clearInterval(timer);
  timer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || $('pagina').hidden) return pararLaco();
  carregar();
  comecarLaco();
});

// -------------------------------------------------------------------- porta

/**
 * O que dizer quando a entrada não aconteceu.
 *
 * Cada caso tem um conserto diferente, e um "não foi possível entrar" genérico
 * manda todo mundo para o mesmo lugar: tentar de novo, que é justamente o que
 * não resolve nenhum deles.
 */
const RECADOS = {
  fora: {
    titulo: 'Você não está no nosso servidor',
    texto:
      'Sua conta entrou, mas ela não participa do servidor do Discord que abre esta página. Peça o convite a quem cuida dele e tente de novo — o resto do site continua aberto para você.',
  },
  desligado: {
    titulo: 'Página desligada',
    texto: 'Quem hospeda este servidor desligou a página de estado.',
  },
  sem_aplicacao: {
    titulo: 'Login do Discord não configurado',
    texto:
      'Este servidor está sem DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET, então não há como entrar com o Discord.',
  },
  sem_codigo: { titulo: null, texto: 'O Discord voltou sem o código da entrada. Tente de novo.' },
  troca_falhou: { titulo: null, texto: 'O Discord recusou a troca do código. Tente de novo.' },
  perfil_falhou: { titulo: null, texto: 'O Discord não devolveu o seu perfil. Tente de novo.' },
  interno: { titulo: null, texto: 'Alguma coisa quebrou no meio da entrada. Tente de novo.' },
};

function mostrarPortao(info = {}) {
  $('carregando').hidden = true;
  $('pagina').hidden = true;
  $('portao').hidden = false;

  const erro = new URLSearchParams(location.search).get('error');
  const recado = erro ? (RECADOS[erro] ?? RECADOS.interno) : null;

  if (recado) {
    if (recado.titulo) texto('portaoTitulo', recado.titulo);
    $('portaoErro').textContent = recado.texto;
    $('portaoErro').hidden = false;
  }

  if (info.error === 'desligado' || erro === 'desligado' || info.aplicacao === false) {
    $('portaoEntrar').hidden = true;
    if (info.aplicacao === false && !recado) {
      $('portaoErro').textContent = RECADOS.sem_aplicacao.texto;
      $('portaoErro').hidden = false;
    }
    return;
  }

  if (info.exigeServidor === false) {
    texto(
      'portaoTexto',
      'Esta página mostra as salas abertas e quem está dentro delas. Entre com o Discord para ver.',
    );
  }
}

function mostrarPagina(quem) {
  $('carregando').hidden = true;
  $('portao').hidden = true;
  $('pagina').hidden = false;

  // O erro na barra de endereço já foi contado na porta; deixá-lo ali faria a
  // próxima recarga mostrar de novo um problema que não existe mais.
  if (location.search) history.replaceState(null, '', location.pathname);

  if (quem) {
    $('euCaixa').hidden = false;
    texto('euNome', quem.name);
    texto('euIniciais', iniciais(quem.name));
    if (quem.avatar) {
      const img = $('euAvatar');
      img.src = `/api/avatar/${quem.id}/${quem.avatar}`;
      img.hidden = false;
      $('euIniciais').hidden = true;
      img.addEventListener('error', () => {
        img.hidden = true;
        $('euIniciais').hidden = false;
      });
    }
  }

  carregar();
  comecarLaco();
}

$('euSair').addEventListener('click', async () => {
  await fetch('/api/servidor/logout', { method: 'POST' }).catch(() => null);
  location.href = '/servidor';
});

async function abrir() {
  try {
    const resposta = await fetch('/api/servidor/me', { cache: 'no-store' });
    const corpo = await resposta.json().catch(() => ({}));

    if (!resposta.ok) return mostrarPortao(corpo);
    mostrarPagina(corpo.user);
  } catch {
    // Servidor fora do ar no arranque: a porta com o recado é melhor do que uma
    // página vazia que fica atualizando para sempre.
    mostrarPortao({ error: 'interno' });
    $('portaoErro').textContent = 'O servidor não respondeu. Tente de novo em alguns segundos.';
    $('portaoErro').hidden = false;
  }
}

abrir();
