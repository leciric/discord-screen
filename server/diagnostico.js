/**
 * Como está indo a imagem do lado de quem assiste — visto daqui.
 *
 * O servidor sempre soube o que mandou. Nunca soube o que chegou, e é lá que os
 * três problemas deste programa moram: a tela congelada, a tela atrasada em
 * minutos, e o tile eterno em "Conectando…". Todos os três acontecem depois do
 * último byte que este processo entregou — no relógio do player, na fila do
 * decodificador, na CPU de quem está assistindo — e nenhum deixa rastro aqui.
 *
 * O que existia para investigar era pedir para a pessoa abrir o console. Isso
 * só funciona com a pessoa presente, avisada, e no exato momento em que o
 * problema está acontecendo — ou seja, quase nunca. E quando não funciona, a
 * resposta para "por que travou às 21h04" continua sendo um encolher de ombros.
 *
 * Então quem assiste manda um boletim curto de tempos em tempos, e este módulo
 * guarda o ÚLTIMO de cada um. Duas decisões que valem a explicação:
 *
 * 1. Último, e não histórico. O painel quer responder "como está agora", e um
 *    log de tudo enche o anel de eventos com centenas de linhas idênticas por
 *    minuto — o histórico que importa some no meio do que não importa.
 *
 * 2. O log recebe só as MUDANÇAS de estado. "Fulano travou" e "fulano
 *    voltou" são as duas linhas que alguém vai querer ler amanhã; "fulano
 *    continua bem" repetido trezentas vezes não é informação, é ruído com
 *    carimbo de hora.
 *
 * O diagnóstico é derivado aqui, e não mandado pronto pelo cliente, porque
 * "travado" é a comparação entre dois boletins: o contador de quadros desenhados
 * não andou de um para o outro. O cliente não precisa saber disso, e a conta
 * feita de um lado só é a que não mente quando o outro lado é que está parado.
 */

import { registrar } from './eventos.js';

/**
 * Quanto tempo um boletim vale antes de o dono ser dado por ido.
 *
 * Quem fecha a aba não se despede: a última coisa que se sabe dele é o boletim
 * de quinze segundos atrás. Mantê-lo na tabela para sempre encheria o painel de
 * gente que não está mais lá, e é o tipo de mentira que faz alguém investigar
 * um travamento que já acabou junto com a sessão.
 */
const VALIDADE_MS = 45_000;

/**
 * Atraso a partir do qual a imagem deixou de ser "ao vivo".
 *
 * Dois segundos são muito mais que os 80 ms de buffer do player somados a
 * qualquer rede ruim. Passando disso não é irregularidade, é fila em algum
 * lugar — e a queixa que nasce daí é "estou vendo o que fiz minutos atrás".
 */
const ATRASO_ALTO_MS = 2000;

/** Fila de decodificação que já é sintoma, e não respiro. Ver FILA_DECODE_MAX. */
const DECODE_FUNDO = 6;

const relatos = new Map();

const chave = (sala, peer, slot) => `${sala}|${peer}|${slot}`;

/**
 * Em que pé está esta tela, para esta pessoa, agora.
 *
 * A ordem importa: é uma escada do pior para o menos pior, e o primeiro que
 * bater é o que vale. Alguém sem decodificador também está com zero quadro por
 * segundo, e chamar isso de "travado" mandaria quem investiga procurar a rede
 * quando o problema é que o codec não subiu.
 */
function classificar(anterior, atual) {
  if (atual.decoder && atual.decoder !== 'configured') return 'sem-decodificador';

  // Nunca desenhou um quadro sequer: é o tile eterno em "Conectando…", que de
  // fora não se distingue de uma tela preta que já esteve viva.
  if (atual.desenhados === 0) return 'sem-imagem';

  // O contador não andou de um boletim para o outro. Este é o travamento de
  // verdade: chegando bytes ou não, nada foi para a tela nesse intervalo.
  if (anterior && atual.desenhados === anterior.desenhados) return 'travado';

  if (atual.lag > ATRASO_ALTO_MS || atual.decode > DECODE_FUNDO) return 'atrasado';

  return 'ok';
}

/**
 * Guarda o boletim e devolve o estado dele.
 *
 * `dados` vem do navegador e não é confiável: só campos numéricos conhecidos
 * atravessam, cada um limitado. Não é hipótese de ataque, é higiene — o que
 * entra aqui vai parar num log que alguém vai ler, e um campo de texto livre
 * vindo do cliente é como esse log deixa de ser legível.
 */
export function registrarRelato({ sala, peer, slot, nome = null, via = 'relay', saude = {} }) {
  const agora = Date.now();
  const k = chave(sala, peer, slot);
  const anterior = relatos.get(k);

  const atual = {
    sala,
    peer,
    slot,
    // O nome é só para o painel não mostrar `p7`, e vem limitado pelo mesmo
    // motivo que todo texto de cliente vem.
    nome: typeof nome === 'string' ? nome.slice(0, 32) : null,
    via: via === 'rtc' ? 'rtc' : 'relay',
    desenhados: inteiro(saude.desenhados),
    fila: inteiro(saude.fila),
    decode: inteiro(saude.decode),
    resync: inteiro(saude.resync),
    largados: inteiro(saude.largados),
    lag: inteiro(saude.lag),
    jitter: saude.jitter === null || saude.jitter === undefined ? null : inteiro(saude.jitter),
    decoder: typeof saude.decoder === 'string' ? saude.decoder.slice(0, 20) : null,
    // Qual codec aquele navegador tentou montar. Sem isto, "sem-decodificador"
    // manda quem investiga adivinhar entre H.264, VP9 e VP8 — e a resposta
    // muda completamente o que se conserta.
    codec: typeof saude.codec === 'string' ? saude.codec.slice(0, 32) : null,
    em: agora,
  };

  atual.estado = classificar(anterior, atual);
  // Quadros por segundo medidos entre dois boletins, que é a única forma de
  // saber a taxa de quem está do outro lado sem confiar no que ele diz.
  const dt = anterior ? (agora - anterior.em) / 1000 : 0;
  atual.fps =
    dt > 0.5 ? Math.max(0, Math.round((atual.desenhados - anterior.desenhados) / dt)) : null;

  relatos.set(k, atual);

  // Só a mudança vira linha de log. Ver a nota no topo.
  if (!anterior || anterior.estado !== atual.estado) {
    const quem = atual.nome ?? atual.peer;
    const nivel = atual.estado === 'ok' ? 'info' : 'aviso';
    // O codec entra no texto, e não só nos dados: quem lê o log corrido precisa
    // ver "sem-decodificador (vp09…)" sem ter de abrir a linha.
    const porque = atual.codec ? ` (${atual.codec})` : '';
    registrar(nivel, 'cliente', `[room ${sala}] ${quem} · tela ${slot}: ${atual.estado}${porque}`, {
      codec: atual.codec,
      via: atual.via,
      fps: atual.fps,
      lag: atual.lag,
      decode: atual.decode,
      resync: atual.resync,
      largados: atual.largados,
      decoder: atual.decoder,
    });
  }

  return atual;
}

function inteiro(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // Um teto generoso: o que passa disso é erro de quem mandou, e deixar entrar
  // faria a soma do painel virar um número sem sentido.
  return Math.max(0, Math.min(1e9, Math.round(n)));
}

/** Esquece quem parou de dar notícia. Chamado antes de toda leitura. */
function expirar(agora = Date.now()) {
  for (const [k, r] of relatos) {
    if (agora - r.em > VALIDADE_MS) relatos.delete(k);
  }
}

/**
 * O que está acontecendo agora, do mais preocupante para o menos.
 *
 * A ordem é a do painel: quem está com problema aparece em cima, porque é a
 * única linha que alguém abre o painel para ver.
 */
export function relatorio({ sala = null } = {}) {
  expirar();
  // `sem-decodificador` vem na frente de tudo: quem travou já viu alguma coisa,
  // quem não montou o decodificador não vê nada e não vai ver — e o conserto
  // dele é outro (é o codec escolhido lá na origem, não a rede daqui).
  const peso = { 'sem-decodificador': 0, travado: 1, 'sem-imagem': 2, atrasado: 3, ok: 4 };
  const lista = [...relatos.values()]
    .filter((r) => !sala || r.sala === sala)
    .sort((a, b) => (peso[a.estado] ?? 9) - (peso[b.estado] ?? 9) || b.em - a.em);

  return {
    espectadores: lista,
    resumo: lista.reduce((acc, r) => {
      acc[r.estado] = (acc[r.estado] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/** Some com o que era de uma sala que acabou. */
export function limparSala(sala) {
  for (const [k, r] of relatos) {
    if (r.sala === sala) relatos.delete(k);
  }
}

/** Só para o teste: devolve a tabela ao estado de processo recém-subido. */
export function limpar() {
  relatos.clear();
}
