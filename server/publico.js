/**
 * O que está acontecendo no servidor, para quem não é dono dele.
 *
 * O painel administrativo responde "o que está quebrado" e pede login. Esta
 * página responde outra pergunta, e é de todo mundo: *tem gente aí?* Sem ela, o
 * site só mostra as salas do próprio lobby — quem abre o endereço não faz ideia
 * se há alguém do outro lado, e sala vazia num site que parece morto é o
 * suficiente para a pessoa fechar a aba.
 *
 * Duas linhas separam este módulo do `admin.js`, e as duas são de propósito:
 *
 * 1. **Nada aqui é número de diagnóstico.** Fila, descarte, ping, teto,
 *    memória: são as coisas que dizem *como* o servidor está indo, e são
 *    justamente as que não interessam a quem só quer entrar. O que sai daqui é
 *    quem está, onde, e fazendo o quê.
 *
 * 2. **Nada aqui é identificador que sirva de porta.** O id de uma sala é a
 *    chave de entrada dela, e só acompanha as salas em que essa entrada existe
 *    de fato — as do site. A sala de uma call do Discord aparece na lista (ela
 *    faz parte do que está acontecendo), mas sem o id, que é derivado do id do
 *    canal de voz e não é nosso para publicar.
 *
 * O que sobra é uma lista de nomes e avatares que as pessoas já mostram umas às
 * outras dentro da sala. Ainda assim é público, e quem hospeda pode não querer:
 * `PUBLIC_STATUS=off` desliga a página e a rota juntas.
 */

import crypto from 'node:crypto';

/**
 * Um apelido opaco e estável para cada sala e cada pessoa.
 *
 * A página precisa de uma chave por linha — para saber que o cartão que estava
 * ali é o mesmo depois do próximo refresh — e a chave óbvia seria o id. Só que
 * o id da sala é a senha da porta e o id da pessoa é a conta dela no Discord,
 * e nenhum dos dois precisa atravessar para uma página que só desenha nomes.
 *
 * O sal é sorteado por processo: as chaves valem enquanto a aba está aberta, e
 * não seguem ninguém entre reinícios do servidor — que é exatamente o alcance
 * que elas precisam ter.
 */
const SAL = crypto.randomBytes(16);

export function chaveDe(valor) {
  return crypto.createHash('sha256').update(SAL).update(String(valor)).digest('hex').slice(0, 12);
}

/**
 * A pessoa, como ela aparece para os outros.
 *
 * O avatar vai como URL montada aqui, e não como par id+hash: quem desenha não
 * tem o que decidir sobre isso, e montar do lado de lá seria espalhar o formato
 * da rota do avatar por mais um arquivo.
 */
function pessoaPublica(user) {
  return {
    chave: chaveDe(user.id),
    nome: user.name,
    avatar: user.avatar ? `/api/avatar/${user.id}/${user.avatar}` : null,
    // Convidado é quem entrou sem conta do Discord. Vale dizer: metade das
    // salas de teste é gente sem login, e sem esta marca a lista sugere um
    // movimento de contas reais que não existe.
    convidado: String(user.id).startsWith('guest-'),
    transmitindo: Boolean(user.broadcasting),
    assistindo: Array.isArray(user.watching) ? user.watching.length : 0,
  };
}

/**
 * Por que esta sala não abre daqui.
 *
 * A resposta honesta importa mais do que esconder a sala: quem vê "Sala da
 * call" com cinco pessoas dentro e um botão morto conclui que o site está
 * quebrado. Quem lê "esta é a sala de uma call — entre pelo Discord" entende
 * que a porta é outra, e é a porta certa.
 */
function motivoDeNaoEntrar(room, instanciaWeb) {
  if (room.isCall) return 'call';
  if (room.instance !== instanciaWeb) return 'discord';
  return null;
}

function salaPublica(room, instanciaWeb) {
  const motivo = motivoDeNaoEntrar(room, instanciaWeb);
  const pessoas = room.users.map(pessoaPublica);

  return {
    chave: chaveDe(room.id),
    // Só a sala em que a entrada existe leva o id. Ver a nota no topo.
    id: motivo === null ? room.id : null,
    nome: room.name,
    dono: room.ownerName ?? null,
    servidor: room.guildName ?? null,
    doDiscord: motivo !== null,
    isCall: Boolean(room.isCall),
    trancada: Boolean(room.locked),
    criadaEm: room.createdAt,
    entravel: motivo === null,
    motivo,
    pessoas,
    telas: room.streams.map((stream) => ({
      quem: stream.userName,
      fonte: stream.fonte === 'camera' ? 'camera' : 'tela',
      desde: stream.startedAt,
      // Resolução é a única coisa técnica que sobrou, e ela fica porque
      // responde uma pergunta de quem vai assistir, não de quem vai consertar:
      // vale a pena abrir isto no celular?
      resolucao: stream.width && stream.height ? `${stream.width}×${stream.height}` : null,
      assistindo: stream.watchers,
    })),
  };
}

/**
 * O estado do servidor em uma resposta, sem nada que peça login para ser visto.
 *
 * `roomState` é o mesmo `adminStats()` que alimenta o painel — de propósito:
 * duas travessias das salas por segundo para montar duas verdades diferentes é
 * como as duas passam a discordar. O que separa as páginas é a projeção, feita
 * aqui, e não a origem do número.
 */
export function montarEstadoPublico({ roomState, instanciaWeb = 'web' }) {
  const salas = roomState.rooms
    .map((room) => salaPublica(room, instanciaWeb))
    // Sala vazia e sem nada no ar não é notícia, mas some da lista só depois de
    // fechar sozinha — então a ordem resolve: quem tem gente e tela primeiro.
    .sort(
      (a, b) =>
        b.telas.length - a.telas.length ||
        b.pessoas.length - a.pessoas.length ||
        a.criadaEm - b.criadaEm,
    );

  // A mesma pessoa em duas salas é uma pessoa. O painel faz a mesma conta pelo
  // mesmo motivo — sem ela, "12 online" seria o número de abas abertas.
  const porPessoa = new Map();
  for (const sala of salas) {
    for (const pessoa of sala.pessoas) {
      const antes = porPessoa.get(pessoa.chave);
      if (!antes) {
        porPessoa.set(pessoa.chave, { ...pessoa, salas: 1 });
        continue;
      }
      antes.salas++;
      antes.transmitindo ||= pessoa.transmitindo;
      antes.assistindo += pessoa.assistindo;
    }
  }

  const pessoas = [...porPessoa.values()].sort(
    (a, b) => Number(b.transmitindo) - Number(a.transmitindo) || a.nome.localeCompare(b.nome),
  );

  const telas = salas.reduce((soma, sala) => soma + sala.telas.length, 0);

  return {
    ok: true,
    em: Date.now(),
    noArDesde: roomState.startedAt,
    resumo: {
      pessoas: pessoas.length,
      salas: salas.length,
      abertas: salas.filter((s) => s.entravel).length,
      telas,
      assistindo: salas.reduce(
        (soma, sala) => soma + sala.telas.reduce((n, tela) => n + tela.assistindo, 0),
        0,
      ),
      servidores: new Set(salas.map((s) => s.servidor).filter(Boolean)).size,
    },
    // Banda agregada do processo, sem abrir por sala: é o "está pesado agora?"
    // que faz a página parecer viva, e não um número que aponte para ninguém.
    banda: {
      recebido: roomState.traffic.receivedBytesPerSecond,
      enviado: roomState.traffic.transmittedBytesPerSecond,
    },
    salas,
    pessoas,
  };
}
