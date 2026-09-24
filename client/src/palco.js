/**
 * Quem está no palco: uma tela, ou duas lado a lado.
 *
 * O estado é um par — `ativo`, a tela em destaque, e `lado`, a que divide o
 * palco com ela, ou null — e mora fora do main.js porque as regras dele são o
 * que mais fácil se quebra sem ninguém ver: uma transmissão acaba no meio da
 * divisão, a tela do lado é promovida, alguém para de assistir uma das duas. Em
 * todos esses casos o palco precisa cair de pé, numa tela só, e não num painel
 * vazio ao lado de outro.
 *
 * Nada aqui toca DOM nem socket. As funções recebem o estado e devolvem outro,
 * e quem aplica o resultado — pedir para assistir, largar, redesenhar — é o
 * main.js.
 */

/** O palco vazio: sem transmissão, nada em destaque. */
export const PALCO_VAZIO = Object.freeze({ ativo: null, lado: null });

/** As telas no palco, na ordem em que aparecem: a do destaque primeiro. */
export const telasNoPalco = ({ ativo, lado }) => [ativo, lado].filter((slot) => slot !== null);

export const dividido = (palco) => palco.ativo !== null && palco.lado !== null;

/**
 * Acerta o palco com as transmissões que existem agora.
 *
 * `slots` é a lista das transmissões no ar, na ordem do grid. A tela em
 * destaque que sumiu dá o lugar à do lado, se houver — quem estava olhando duas
 * continua olhando a que sobrou, e não uma terceira escolhida pela ordem —, e
 * só sem nenhuma das duas o destaque cai na primeira da lista. A do lado que
 * sumiu, ou que virou a mesma do destaque, simplesmente sai: o palco volta a
 * ser de uma tela só.
 */
export function acertarPalco(palco, slots) {
  const existe = (slot) => slot !== null && slots.includes(slot);

  let ativo = existe(palco.ativo) ? palco.ativo : null;
  let lado = existe(palco.lado) ? palco.lado : null;

  if (ativo === null) {
    ativo = lado ?? slots[0] ?? null;
    lado = null;
  }
  if (lado === ativo) lado = null;

  return { ativo, lado };
}

/**
 * Põe `slot` do lado da tela em destaque.
 *
 * Já dividido, ele toma o lugar da que estava do lado — a do destaque é a que a
 * pessoa escolheu primeiro, e não sai por causa de um clique numa miniatura.
 * Pedir para dividir com a própria tela em destaque não muda nada: não existe
 * lado a lado de uma tela com ela mesma, e o canvas é um só.
 */
export function porDoLado(palco, slot) {
  if (slot === null || palco.ativo === null || slot === palco.ativo) return palco;
  return { ativo: palco.ativo, lado: slot };
}

/**
 * Tira `slot` do palco dividido. A outra tela fica sozinha no destaque.
 *
 * Serve também para quando a tela sai por outro caminho — parou de ser
 * assistida, a transmissão fechou —, e por isso aceita qualquer slot: um que
 * não está no palco não muda nada.
 */
export function tirarDoPalco(palco, slot) {
  if (slot === palco.lado) return { ativo: palco.ativo, lado: null };
  if (slot === palco.ativo) return { ativo: palco.lado, lado: null };
  return palco;
}

/**
 * Promove `slot` ao destaque, como o clique numa miniatura da lateral.
 *
 * Dividido, a miniatura clicada toma o lugar da tela em destaque e a do lado
 * fica onde está. Se a clicada for justamente a do lado, as duas trocam de
 * lugar — nenhuma sai do palco.
 */
export function promover(palco, slot) {
  if (slot === palco.lado) return { ativo: slot, lado: palco.ativo };
  return { ativo: slot, lado: palco.lado };
}

/**
 * O que parar de assistir depois de uma mudança no palco.
 *
 * `emprestadas` são as telas que só começaram a ser assistidas para ocupar o
 * lado do palco: a pessoa pediu para ver duas ao mesmo tempo, não para baixar
 * aquela tela para sempre. Quando uma delas sai do palco, ela volta ao que era
 * antes — um convite na lateral, sem gastar banda nem decodificador. As que já
 * estavam sendo assistidas antes de dividir continuam, como qualquer miniatura.
 */
export function aLargar(palco, emprestadas) {
  const noPalco = telasNoPalco(palco);
  return [...emprestadas].filter((slot) => !noPalco.includes(slot));
}
