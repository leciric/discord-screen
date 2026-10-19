/**
 * O caminho mais curto entre "quero mostrar" e "estão vendo".
 *
 * Decisões pequenas, puras de propósito: quem as usa são a atividade e a aba de
 * captura, duas páginas sem teste de interface, e é aqui que cada clique a menos
 * fica provado. O navegador só exige duas coisas no caminho da tela — um gesto
 * do usuário na página que chama `getDisplayMedia`, e o seletor dele. Tudo o
 * mais que estiver entre o clique e o ar é escolha nossa, e cada escolha daqui
 * existe para não cobrar um clique que ninguém pediu.
 */

/**
 * Por onde ligar uma fonte, a partir da atividade ou da página da sala.
 *
 * - `aqui`: tenta capturar na própria página; se não der, cai para um link.
 * - `aba`:  a aba de captura já existe e é nossa — leva a pessoa até ela.
 * - `link`: abre a aba de captura (de novo, se preciso).
 *
 * A tela fora do Discord vai sempre por `aqui`, mesmo com a aba aberta: a
 * página da sala é top-level, então o seletor abre no mesmo clique. Mandar o
 * pedido para a aba custava uma troca de aba e mais um clique lá, só para
 * chegar ao mesmo seletor.
 *
 * Dentro do Discord, com a aba aberta, não adianta tentar o iframe — ele já
 * falhou da primeira vez — nem a aba existente, que mora em outro processo e não
 * pode ser trazida para a frente.
 *
 * @param {{ fonte: 'tela'|'camera', inDiscord: boolean, abaAberta: boolean }} p
 * @returns {'aqui'|'aba'|'link'}
 */
export function rotaDaFonte({ fonte, inDiscord, abaAberta }) {
  if (fonte === 'tela') {
    if (!inDiscord) return 'aqui';
    return abaAberta ? 'link' : 'aqui';
  }
  // A câmera nunca nasce na página da sala: o estúdio (fundo, GIF) mora na aba.
  if (inDiscord) return 'link';
  return abaAberta ? 'aba' : 'link';
}

/**
 * O que a aba de captura faz quando chega o pedido de uma fonte.
 *
 * - `ligar`:  vai ao ar sem esperar nada. É a câmera: `getUserMedia` não pede
 *   gesto, e o clique em "Ligar câmera" na atividade já foi a decisão.
 * - `chamar`: destaca a fonte e espera o clique, que é o gesto que o seletor de
 *   tela exige. Um clique em qualquer lugar da página serve — ver
 *   `cliqueComeca`.
 * - `nada`:   já está no ar, ou a fonte não existe neste navegador.
 *
 * @param {{ fonte: string, ativo: boolean, indisponivel: boolean }} p
 * @returns {'ligar'|'chamar'|'nada'}
 */
export function pedidoDaFonte({ fonte, ativo, indisponivel }) {
  if (ativo || indisponivel) return 'nada';
  if (fonte === 'camera') return 'ligar';
  if (fonte === 'tela') return 'chamar';
  return 'nada';
}

/** O que, dentro da página, tem clique próprio e não pode virar "começar". */
const COM_CLIQUE_PROPRIO = 'a, button, input, select, textarea, label, summary, [role="menu"]';

/**
 * Este clique (ou tecla) deve abrir o seletor de tela?
 *
 * Com a tela chamada e nada no ar, a página inteira vira o botão: a aba acabou
 * de abrir, a pessoa ainda está procurando onde clicar, e qualquer clique já é
 * o gesto que o navegador exige. O que tem clique próprio — um select de
 * qualidade, o menu de câmeras — continua fazendo o que faz.
 *
 * Teclado também conta: Enter ou espaço com o foco fora de um controle. Um
 * keydown é ativação do usuário como um clique.
 *
 * @param {{ chamando: boolean, ativo: boolean, alvo: Element|null, tecla?: string }} p
 */
export function cliqueComeca({ chamando, ativo, alvo, tecla }) {
  if (!chamando || ativo) return false;
  if (tecla !== undefined && tecla !== 'Enter' && tecla !== ' ') return false;
  if (!alvo?.closest) return true;
  return !alvo.closest(COM_CLIQUE_PROPRIO);
}

// ------------------------------------------------------------- lembranças

// Sem 'midia': o arquivo do fundo some com a aba, e lembrar só o tipo seria
// abrir a câmera com o campo de arquivo vazio esperando.
export const FUNDOS = ['nenhum', 'desfoque', 'cor'];
export const JANELA_MIN = 35;
export const JANELA_MAX = 100;

/**
 * As escolhas da câmera de uma vez para a outra, saneadas.
 *
 * Quem escolheu a webcam externa e o fundo desfocado uma vez não quer refazer
 * isso a cada "Ligar câmera" — e, sem prévia no caminho, refazer seria ir ao ar
 * com a câmera errada antes de conseguir trocar. O GIF não entra: um arquivo
 * escolhido não sobrevive à aba (nem o de fundo), e prometer que sim seria abrir a câmera
 * quando a pessoa esperava o GIF.
 *
 * O que vier estragado do localStorage cai fora em vez de quebrar a página: o
 * armazenamento é do navegador, e qualquer versão anterior pode ter deixado
 * qualquer coisa lá.
 */
export function sanearCamera(cru) {
  const c = cru && typeof cru === 'object' ? cru : {};
  const saida = {};
  if (typeof c.dispositivo === 'string' && c.dispositivo) saida.dispositivo = c.dispositivo;
  if (FUNDOS.includes(c.fundo)) saida.fundo = c.fundo;
  if (typeof c.cor === 'string' && /^#[0-9a-f]{6}$/i.test(c.cor)) saida.cor = c.cor;
  const janela = Number(c.janela);
  if (Number.isFinite(janela) && janela >= JANELA_MIN && janela <= JANELA_MAX) {
    saida.janela = Math.round(janela);
  }
  return saida;
}

/**
 * Lê e grava um objeto no armazenamento, sem deixar ele derrubar ninguém.
 *
 * Navegação privada e cota cheia jogam exceção no `setItem`; JSON corrompido
 * joga no `parse`. Nos dois casos a escolha vale só para esta sessão, que é o
 * melhor que dá.
 */
export function lembranca(armazenamento, chave, sanear = (x) => x) {
  return {
    ler() {
      try {
        return sanear(JSON.parse(armazenamento?.getItem(chave) ?? '{}'));
      } catch {
        return sanear({});
      }
    },
    guardar(parcial) {
      const junto = sanear({ ...this.ler(), ...parcial });
      try {
        armazenamento?.setItem(chave, JSON.stringify(junto));
      } catch {
        /* navegação privada: vale só para esta sessão */
      }
      return junto;
    },
  };
}
