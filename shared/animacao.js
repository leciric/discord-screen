/**
 * Um GIF pronto para ser desenhado num canvas, quadro a quadro.
 *
 * Existe porque a maneira óbvia não serve. Um `<img src="algo.gif">` anima
 * sozinho, e `drawImage` de um `<img>` copia o quadro que estiver aparecendo —
 * dois passos e nenhuma decodificação escrita à mão. Só que quem usa isto é a
 * aba de captura, e a aba de captura vive em segundo plano por definição: a
 * pessoa volta para o Discord e é lá que ela fica. Navegador em aba escondida
 * não pinta, e uma animação que não é pintada não avança — o GIF congelaria
 * no quadro em que estava quando a aba perdeu o foco, e do outro lado ficaria
 * uma "webcam" travada.
 *
 * Com o ImageDecoder o relógio é nosso. Nada aqui depende de a aba estar
 * visível, de rAF ou de o compositor ter algo a fazer.
 *
 * Os quadros são decodificados sob demanda, e não todos de uma vez. Um GIF de
 * 480×480 com cem quadros são noventa megabytes em RGBA — guardar tudo custaria
 * mais memória do que o resto do programa inteiro para mostrar uma imagem que
 * se repete.
 */

/**
 * Formatos que valem tentar como animação.
 *
 * PNG entra porque APNG se anuncia como image/png, e só o decodificador sabe
 * dizer se aquele arquivo tem um quadro ou oitenta.
 */
const ANIMAVEIS = ['image/gif', 'image/webp', 'image/apng', 'image/png', 'image/avif'];

/** Quanto tempo um quadro sem duração declarada fica na tela. */
const DURACAO_PADRAO_MS = 100;

/**
 * Carrega um arquivo de imagem, animado ou não.
 *
 * @param {Blob} arquivo
 * @returns {Promise<{
 *   largura: number,
 *   altura: number,
 *   animada: boolean,
 *   quadro(agoraMs: number): CanvasImageSource | null,
 *   parar(): void,
 * }>}
 */
export async function carregarAnimacao(arquivo) {
  const tipo = arquivo.type || 'image/gif';
  const dados = await arquivo.arrayBuffer();

  if (window.ImageDecoder && ANIMAVEIS.includes(tipo)) {
    try {
      const animada = await abrirAnimada(dados, tipo);
      if (animada) return animada;
    } catch {
      // Arquivo que o ImageDecoder recusa ainda pode ser uma imagem que o
      // resto do navegador abre. Cai para o caminho parado em vez de falhar.
    }
  }

  return abrirParada(dados, tipo);
}

/**
 * O caminho animado.
 *
 * Devolve `null` — e não um erro — quando o arquivo tem um quadro só: aí não há
 * animação nenhuma, e um ImageBitmap parado custa menos que um decodificador
 * vivo pelo resto da transmissão.
 */
async function abrirAnimada(dados, tipo) {
  if (!(await ImageDecoder.isTypeSupported(tipo))) return null;

  const decodificador = new ImageDecoder({ data: dados, type: tipo });
  await decodificador.tracks.ready;

  const faixa = decodificador.tracks.selectedTrack;
  const total = faixa?.frameCount ?? 1;
  if (total <= 1) {
    decodificador.close();
    return null;
  }

  // O primeiro quadro é aguardado aqui, e não no primeiro tick: quem chama
  // quer poder perguntar o tamanho e desenhar na mesma hora, e um `null` no
  // primeiro quadro apareceria como um piscar preto.
  const primeiro = (await decodificador.decode({ frameIndex: 0 })).image;

  let indice = 0;
  let atual = primeiro;
  // Null enquanto o primeiro tick não chega: a animação começa a contar quando
  // alguém começa a olhar, não quando o arquivo terminou de abrir.
  let expiraEm = null;
  let decodificando = false;
  let vivo = true;

  /**
   * O quadro a desenhar agora.
   *
   * A troca é assíncrona e o desenho não espera por ela: até o quadro seguinte
   * chegar, continua valendo o que está na tela. Um GIF que atrasa um
   * centésimo é indistinguível de um GIF; um GIF que pisca preto entre quadros
   * não é.
   */
  function quadro(agoraMs) {
    if (!vivo) return null;
    if (expiraEm === null) expiraEm = agoraMs + duracaoDe(atual);
    if (agoraMs < expiraEm || decodificando) return atual;

    decodificando = true;
    const proximo = (indice + 1) % total;

    decodificador
      .decode({ frameIndex: proximo })
      .then(({ image }) => {
        if (!vivo) return image.close();
        atual.close();
        atual = image;
        indice = proximo;
        // A partir de agora, e não do prazo anterior: o relógio da animação não
        // deve tentar recuperar o tempo que a decodificação levou, senão um
        // GIF pesado passa a correr em rajadas para "compensar".
        expiraEm = agoraMs + duracaoDe(image);
      })
      .catch(() => {
        // Quadro que não decodifica: fica o anterior e tenta o próximo no tick
        // seguinte. Um GIF meio corrompido vira um GIF com falhas, não uma
        // transmissão morta.
        expiraEm = agoraMs + DURACAO_PADRAO_MS;
      })
      .finally(() => {
        decodificando = false;
      });

    return atual;
  }

  return {
    largura: primeiro.displayWidth,
    altura: primeiro.displayHeight,
    animada: true,
    quadro,
    parar() {
      vivo = false;
      atual?.close();
      decodificador.close();
    },
  };
}

/** Imagem parada: um bitmap só, devolvido para sempre. */
async function abrirParada(dados, tipo) {
  const bitmap = await createImageBitmap(new Blob([dados], { type: tipo }));
  return {
    largura: bitmap.width,
    altura: bitmap.height,
    animada: false,
    quadro: () => bitmap,
    parar: () => bitmap.close(),
  };
}

/** A duração vem em microssegundos, e nem todo GIF a declara. */
function duracaoDe(quadro) {
  const us = quadro.duration ?? 0;
  // GIF com duração zero ou absurdamente curta é comum, e navegador nenhum a
  // respeita: abaixo de 20ms todos adotam um piso, senão a animação vira um
  // borrão de CPU. 50ms é o piso que Chrome e Firefox usam.
  const ms = us / 1000;
  return ms >= 20 ? ms : DURACAO_PADRAO_MS;
}
