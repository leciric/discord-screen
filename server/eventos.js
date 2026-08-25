/**
 * O que aconteceu, guardado para o painel poder mostrar.
 *
 * O servidor sempre falou pelo `console.log`, e isso resolve quem está com um
 * terminal aberto no VPS. Quem abre o painel de outro lugar não tem esse
 * terminal — e a pergunta "por que a tela daquela pessoa travou às 21h04" não
 * se responde com um número médio na tela.
 *
 * Então em vez de reescrever cada chamada de log, o console é derivado para cá.
 * Todo `[room abc] ...` que já existia aparece no painel sem que ninguém tenha
 * tocado no lugar onde ele é escrito, e o terminal continua recebendo tudo
 * exatamente como antes.
 *
 * O anel é de tamanho fixo porque memória de processo é o recurso que este
 * programa já gasta com vídeo: um log sem teto é um vazamento com data marcada.
 */

// Meia hora de conversa numa sala movimentada cabe aqui com folga, e 500 linhas
// de texto curto são algumas dezenas de KB.
const MAX = 500;

const anel = [];
let proximo = 1;

/** Onde o evento nasceu, para o painel poder filtrar. */
const ESCOPOS = new Set(['sala', 'transmissao', 'painel', 'sistema', 'rede']);

/**
 * @param {'info'|'aviso'|'erro'} nivel
 * @param {string} escopo   ver ESCOPOS; qualquer outro vira 'sistema'
 * @param {string} mensagem
 * @param {object} [dados]  campos estruturados, se houver
 */
export function registrar(nivel, escopo, mensagem, dados = null) {
  const evento = {
    id: proximo++,
    em: Date.now(),
    nivel: nivel === 'erro' || nivel === 'aviso' ? nivel : 'info',
    escopo: ESCOPOS.has(escopo) ? escopo : 'sistema',
    // Uma linha de log longa não ajuda ninguém e enche o anel mais depressa.
    mensagem: String(mensagem).slice(0, 400),
    dados: dados ?? undefined,
  };

  anel.push(evento);
  if (anel.length > MAX) anel.shift();
  return evento;
}

/**
 * Os eventos mais recentes, do mais novo para o mais velho.
 *
 * `desde` é o id da última linha que o painel já tem. Ele existe para a aba
 * aberta não rebaixar as mesmas quinhentas linhas a cada dois segundos — o
 * painel pede só o que nasceu depois.
 */
export function listar({ desde = 0, nivel = null, escopo = null, limite = 200 } = {}) {
  let saida = anel;
  if (desde > 0) saida = saida.filter((e) => e.id > desde);
  if (nivel) saida = saida.filter((e) => e.nivel === nivel);
  if (escopo) saida = saida.filter((e) => e.escopo === escopo);

  return {
    eventos: saida.slice(-limite),
    ultimoId: anel.length ? anel[anel.length - 1].id : 0,
    // Quantos o anel descartou desde que o processo subiu. Diferente de zero
    // significa que há buraco no que o painel mostra, e é honesto dizer.
    perdidos: Math.max(0, proximo - 1 - anel.length),
  };
}

export function limpar() {
  anel.length = 0;
}

/**
 * Deriva o console para o anel, sem tirar nada do terminal.
 *
 * O prefixo `[room abc]`, que já é a convenção do servidor, vira o escopo — daí
 * o painel conseguir filtrar "só o que é de sala" sem que nenhuma chamada de
 * log tenha sido reescrita.
 *
 * Idempotente por alvo: chamar duas vezes no mesmo console não empilha dois
 * espelhos — sem isso, cada linha apareceria duplicada no painel. O registro é
 * por objeto, e não uma bandeira única, porque a pergunta é "este console já
 * está derivado?", e uma bandeira global responderia "sim" para um console que
 * nunca foi tocado.
 */
const derivados = new WeakSet();

export function derivarConsole(alvo = console) {
  if (derivados.has(alvo)) return;
  derivados.add(alvo);

  for (const [metodo, nivel] of [
    ['log', 'info'],
    ['warn', 'aviso'],
    ['error', 'erro'],
  ]) {
    const original = alvo[metodo].bind(alvo);
    alvo[metodo] = (...args) => {
      original(...args);
      try {
        const texto = args.map(descrever).join(' ');
        registrar(nivel, escopoDe(texto), texto);
      } catch {
        // O espelho nunca pode derrubar quem estava só tentando logar.
      }
    };
  }
}

function descrever(valor) {
  if (typeof valor === 'string') return valor;
  if (valor instanceof Error) return valor.stack ?? valor.message;
  try {
    return JSON.stringify(valor);
  } catch {
    return String(valor);
  }
}

function escopoDe(texto) {
  if (texto.startsWith('[room ')) return 'sala';
  if (/^\[(encoder|decoder|audio|rtc)/.test(texto)) return 'transmissao';
  if (texto.startsWith('[painel')) return 'painel';
  return 'sistema';
}
