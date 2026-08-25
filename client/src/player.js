/**
 * Player WebCodecs.
 *
 * Dentro da Activity não existe WebRTC, mas WebCodecs não é bloqueado por
 * Permissions Policy — então dá para decodificar quadro a quadro e desenhar
 * num canvas, sem passar por container nem por MediaSource.
 *
 * O canvas mantém SEMPRE o tamanho nativo do vídeo no buffer interno
 * (canvas.width/height). Isso dá a ele uma proporção intrínseca, e o CSS
 * apenas o limita com max-width/max-height — o navegador então reduz
 * preservando a proporção, por construção.
 *
 * Dimensionar o buffer pelo tamanho de exibição, como cheguei a tentar, faz a
 * proporção do vídeo passar a depender do formato do container e distorce a
 * imagem durante o redimensionamento.
 *
 * Os quadros NÃO são desenhados assim que chegam. Ver a nota em BUFFER_MS: sem
 * essa espera, a irregularidade da rede vira micro-travada mesmo quando não se
 * perde um quadro sequer.
 */

/**
 * Quanto tempo cada quadro espera antes de aparecer.
 *
 * Este é o remédio para a travadinha que acontece com a transmissão inteira
 * chegando: os quadros são capturados a cada 33 ms cravados, mas chegam a cada
 * 28, 41, 30, 37… O caminho de rede não é regular — TCP entrega em rajada, o
 * relay reparte entre vários espectadores, e o agendador do sistema atrasa uns
 * milissegundos aqui e ali. Desenhando na chegada, essa irregularidade toda vai
 * direto para a tela, e é exatamente ela que se vê como solavanco.
 *
 * Localmente a irregularidade é quase zero, e por isso a mesma transmissão que
 * é lisa na própria máquina fica picada quando passa por um servidor de
 * verdade. Não é banda, não é CPU e não é quadro perdido — é ritmo.
 *
 * Segurar os quadros e reproduzi-los no ritmo em que foram capturados devolve o
 * ritmo. O preço é este atraso, pago uma vez só: 80 ms é mais que a
 * irregularidade típica de uma rede ruim e menos do que qualquer pessoa percebe
 * assistindo alguém jogar. Quem precisa de menos atraso do que isso está
 * conversando, não assistindo — e aí a conversa é por voz do Discord.
 */
const BUFFER_MS = 80;

/**
 * Teto da fila. Além disso a espera deixou de ser buffer e virou atraso.
 *
 * Acontece quando a origem manda mais rápido do que o combinado, ou quando o
 * relógio das duas máquinas anda em velocidades diferentes. Preferir descartar
 * é o mesmo princípio do encoder: atraso acumulado nunca mais sai sozinho.
 */
const FILA_MAX = 12;

/**
 * Salto de relógio que denuncia origem nova, em vez de rede irregular.
 *
 * A referência de tempo traduz "capturado em tal instante" para "desenhar em
 * tal instante", e ela só vale enquanto o relógio da origem for o mesmo. Trocar
 * de tela, uma aba que dormiu e voltou, ou uma transmissão que recomeçou trazem
 * timestamps de outra régua — e o `broadcaster` já trata esse caso do lado de
 * lá, pelo mesmo motivo e com o mesmo nome (ver GRADE_PERDIDA).
 *
 * Aqui faltava, e faltava só para um dos lados. O salto para trás era visto
 * (`tsMs < ultimoTs`); o salto para a FRENTE não era visto por ninguém: os
 * quadros passavam a ser marcados para daqui a trinta segundos, a fila enchia e
 * esvaziava pelo teto sem nunca chegar a hora de nenhum deles, e a tela ficava
 * congelada para sempre — com o contador de quadros marcando zero, porque
 * nenhum era desenhado de fato. Era isso que aparecia como "travou" e como
 * "0 fps" ao mesmo tempo.
 *
 * Um segundo é mais que qualquer rajada de rede — uma fila inteira de FILA_MAX
 * quadros a 30 fps são 400 ms, e é ela que decide o maior adiantamento legítimo
 * — e é muito menos que qualquer troca de fonte de verdade.
 */
const SALTO_MS = 1000;

/**
 * Quantos quadros podem estar esperando decodificação antes de largarmos.
 *
 * Esta é a única fila do caminho que não tinha teto. O relay já descarta o que
 * não vaza (ver `atrasoRelayMs`), o encoder já descarta o que não cabe na fila
 * dele — e aqui, do lado de quem assiste, `decode()` era chamado para todo
 * pacote que chegasse, sem nunca perguntar se o decodificador estava dando
 * conta.
 *
 * Quando não está — 1080p em software, ou a mesma máquina codificando e
 * decodificando ao mesmo tempo, que é o caso de quem assiste a própria tela —
 * a fila interna cresce sozinha e não volta. Os quadros continuam saindo, em
 * ordem e com o ritmo certo entre eles, só que cada vez mais velhos: é
 * exatamente a queixa de "estou vendo o que fiz minutos atrás". Nada no player
 * media isso, porque a referência de tempo alinha o ritmo e não a idade.
 *
 * Seis quadros são um quinto de segundo a 30 fps: mais que a rajada de uma
 * troca de cena, menos do que se percebe. Passando disso, quadro largado é
 * quadro que não vai atrasar os próximos.
 */
const FILA_DECODE_MAX = 6;

/** De quanto em quanto tempo a espera é reavaliada, e sobre qual janela. */
const AJUSTE_MS = 2000;

/** Correção máxima por ajuste: acima disso a mudança de ritmo se vê. */
const PASSO_MAX_MS = 15;

export function createPlayer(canvas, { onError, onTamanho } = {}) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  let decoder = null;
  let needKeyframe = true;
  let lastLagMs = 0;
  let framesDrawn = 0;
  // Diagnóstico: quantas vezes a referência de tempo teve de ser refeita, e
  // quantos quadros foram largados por o decodificador não estar acompanhando.
  // Os dois são zero numa transmissão saudável, e é a subida deles que separa
  // "a rede está ruim" de "esta máquina não está dando conta".
  let ressincronizacoes = 0;
  let largadosNoDecode = 0;
  // Total de quadros desenhados desde o start. Separado de `framesDrawn`
  // porque aquele é zerado por quem lê (o painel mostra "por segundo"), e um
  // contador que zera não serve para o vigia perguntar "andou desde a última
  // vez que olhei?" — os dois leitores se roubariam.
  let desenhadosTotal = 0;

  // Quadros decodificados esperando a hora de aparecer, em ordem de exibição.
  const fila = [];
  // Instante local que corresponde ao timestamp zero da origem. É o que traduz
  // "capturado em tal momento" para "desenhar em tal momento".
  let base = null;
  let rafId = null;
  // Folga com que os quadros da janela atual chegaram: a menor delas é o que
  // sobra de margem antes de um quadro perder a própria hora, e o intervalo
  // entre a menor e a maior é a irregularidade que estamos combatendo.
  let folgaMin = Infinity;
  let folgaMax = -Infinity;
  let janelaAte = 0;
  let irregularidade = null;
  // Último timestamp de captura visto. Serve para detectar a origem recomeçando:
  // o tempo andando para trás invalida a referência.
  let ultimoTs = -Infinity;
  // Quem espera precisa saber quando a espera acabou: entre pedir para assistir
  // e o primeiro quadro cabe um keyframe inteiro de atraso, e o canvas preto
  // desse intervalo é idêntico a um travamento.
  let virgem = true;

  function start(rawConfig) {
    stop();

    if (!window.VideoDecoder) {
      onError?.('Este navegador não tem WebCodecs — não é possível assistir.');
      return false;
    }

    const config = deserialize(rawConfig);

    decoder = new VideoDecoder({
      output: draw,
      error: (err) => {
        // Erro de decodificação normalmente é fluxo fora de sincronia:
        // pedir um keyframe recupera sem derrubar a sessão.
        console.warn('[decoder]', err.message);
        needKeyframe = true;
      },
    });

    try {
      decoder.configure(config);
    } catch {
      onError?.(`Codec não suportado por este navegador: ${config.codec}`);
      decoder = null;
      return false;
    }

    needKeyframe = true;
    return true;
  }

  /** Quadro empacotado: [1B slot][1B tipo][8B timestamp][8B envio][payload] */
  function push(buffer) {
    if (!decoder || decoder.state !== 'configured') return;

    const view = new DataView(buffer);
    const isKeyframe = view.getUint8(1) === 1;

    // A fila do decodificador encheu: ele está mais devagar do que a chegada.
    // Largar aqui, inclusive keyframe, é o que impede o atraso de virar
    // permanente — ver FILA_DECODE_MAX. Pedir keyframe de volta não custa
    // protocolo nenhum: o transmissor manda um a cada KEYFRAME_EVERY_MS, e é o
    // primeiro que chegar depois de a fila drenar que devolve a imagem ao vivo.
    if (decoder.decodeQueueSize > FILA_DECODE_MAX) {
      largadosNoDecode++;
      needKeyframe = true;
      return;
    }

    // Decoder frio só aceita keyframe; deltas antes disso viram erro.
    if (needKeyframe && !isKeyframe) return;

    const timestamp = view.getFloat64(2);
    const sentAt = view.getFloat64(10);
    lastLagMs = Date.now() - sentAt;

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: isKeyframe ? 'key' : 'delta',
          timestamp,
          data: new Uint8Array(buffer, 18),
        }),
      );
      needKeyframe = false;
    } catch (err) {
      console.warn('[decode]', err.message);
      needKeyframe = true;
    }
  }

  /**
   * Um quadro decodificado entra na fila com a hora marcada para aparecer.
   *
   * A hora vem do timestamp da captura, e não do relógio de chegada: é assim
   * que o intervalo entre dois quadros na tela volta a ser o intervalo com que
   * eles foram capturados, independente de como a rede os entregou.
   */
  function draw(frame) {
    const agora = performance.now();
    const tsMs = (frame.timestamp ?? 0) / 1000;

    // Origem nova, ou timestamp que andou para trás (transmissão reiniciada):
    // não há o que traduzir a partir da referência antiga.
    if (base === null || tsMs < ultimoTs) reancorar(agora, tsMs);
    ultimoTs = tsMs;

    const exibirEm = base + tsMs;
    const folga = exibirEm - agora;

    // Fora da faixa, e para qualquer um dos dois lados: a referência não vale
    // mais, e insistir nela custa caro nas duas pontas.
    //
    // Atrasado (`folga` muito negativa) a rede engasgou e a referência ficou
    // otimista demais; reancorar custa um solavanco só, contra um quadro
    // atrasado a cada quadro se ela ficasse como está.
    //
    // Adiantado (`folga` muito positiva) o relógio da origem saltou para a
    // frente, e este é o lado que faltava: sem reancorar, o quadro fica marcado
    // para um instante que só chega daqui a muito tempo, a fila estoura pelo
    // teto antes disso e a tela congela sem nunca mais voltar. Ver SALTO_MS.
    if (folga < -BUFFER_MS || folga > BUFFER_MS + SALTO_MS) {
      ressincronizacoes++;
      esvaziar();
      reancorar(agora, tsMs);
      pintar(frame);
      return;
    }

    medir(agora, folga);

    fila.push({ frame, tsMs, exibirEm });

    // Fila estourada: o mais velho é o que menos importa, e segurá-lo é atraso.
    while (fila.length > FILA_MAX) fila.shift().frame.close();

    agendar();
  }

  /** Marca a referência de tempo a partir deste quadro. */
  function reancorar(agora, tsMs) {
    base = agora + BUFFER_MS - tsMs;
    folgaMin = Infinity;
    folgaMax = -Infinity;
    janelaAte = agora + AJUSTE_MS;
  }

  /**
   * Acompanha a folga e reajusta a espera de tempos em tempos.
   *
   * A referência de tempo envelhece: o relógio de quem transmite e o de quem
   * assiste nunca andam exatamente na mesma velocidade, e o desvio empurra a
   * fila para o vazio ou para o excesso. Corrigir pela MENOR folga da janela é
   * o que mantém a margem justa — a menor folga é a que quase perdeu a hora, e
   * é ela que decide se vai haver travada ou não.
   */
  function medir(agora, folga) {
    if (folga < folgaMin) folgaMin = folga;
    if (folga > folgaMax) folgaMax = folga;

    if (agora < janelaAte) return;

    // A distância entre o quadro mais folgado e o mais apertado da janela é,
    // literalmente, a irregularidade da entrega. É o número do diagnóstico.
    if (folgaMin !== Infinity) irregularidade = Math.round(folgaMax - folgaMin);

    const erro = folgaMin - BUFFER_MS;
    if (folgaMin !== Infinity && Math.abs(erro) > 5) {
      base -= Math.max(-PASSO_MAX_MS, Math.min(PASSO_MAX_MS, erro));
      for (const item of fila) item.exibirEm = base + item.tsMs;
    }

    folgaMin = Infinity;
    folgaMax = -Infinity;
    janelaAte = agora + AJUSTE_MS;
  }

  /**
   * Desenha o quadro cuja hora chegou, alinhado ao refresh da tela.
   *
   * Se mais de um venceu no mesmo intervalo, só o último vai para a tela: os
   * anteriores já são passado, e desenhá-los seria gastar GPU para exibir uma
   * imagem que some no mesmo quadro do monitor.
   */
  function passo() {
    rafId = null;
    const agora = performance.now();

    let escolhido = null;
    while (fila.length && fila[0].exibirEm <= agora) {
      escolhido?.frame.close();
      escolhido = fila.shift();
    }

    if (escolhido) pintar(escolhido.frame);
    if (fila.length) agendar();
  }

  function agendar() {
    rafId ??= requestAnimationFrame(passo);
  }

  function esvaziar() {
    while (fila.length) fila.shift().frame.close();
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function pintar(frame) {
    // Buffer no tamanho nativo do vídeo: é isso que define a proporção
    // intrínseca do elemento, e é o que impede o CSS de distorcer.
    let mudou = false;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      mudou = true;
    }

    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);

    // VideoFrame segura memória de GPU; sem close() a aba trava em segundos.
    frame.close();
    framesDrawn++;
    desenhadosTotal++;

    // Avisa no primeiro quadro e sempre que a resolução muda: quem desenha o
    // palco precisa das duas coisas — tirar o "conectando" e refazer a forma.
    if (virgem || mudou) {
      virgem = false;
      onTamanho?.();
    }
  }

  function stop() {
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close();
      } catch {
        // Fechar o que já se fechou sozinho lança; não há nada a desfazer.
      }
    }
    decoder = null;
    needKeyframe = true;
    lastLagMs = 0;
    esvaziar();
    base = null;
    ultimoTs = -Infinity;
    irregularidade = null;
    ressincronizacoes = 0;
    largadosNoDecode = 0;
    desenhadosTotal = 0;
    if (canvas.width && canvas.height) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  /** Atraso aproximado em ms. Exato na mesma máquina; entre máquinas, sujeito a desvio de relógio. */
  const getLag = () => lastLagMs;

  /**
   * O quanto a entrega chegou irregular na última janela, em ms.
   *
   * Este é o número que separa "a rede não dá conta" de "a rede dá conta, mas
   * entrega em rajada". Perto de zero e travando, o problema é outro; alto, e a
   * espera de BUFFER_MS é o que está segurando a imagem no lugar.
   */
  const getJitter = () => irregularidade;

  /** Resolução nativa do vídeo e tamanho de exibição — para diagnóstico. */
  function getSizes() {
    const rect = canvas.getBoundingClientRect();
    return {
      video: `${canvas.width}×${canvas.height}`,
      box: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
    };
  }

  function takeFrameCount() {
    const n = framesDrawn;
    framesDrawn = 0;
    return n;
  }

  /**
   * O estado interno que explica um travamento, para o diagnóstico e para o
   * relatório que vai ao painel.
   *
   * `fila` e `decode` são as duas filas do caminho de quem assiste; `resync` e
   * `largados` são o que elas já custaram. Numa transmissão saudável os quatro
   * ficam baixos e parados — é o movimento deles que aponta o culpado sem
   * precisar de ninguém com o devtools aberto na hora certa.
   */
  function getSaude() {
    return {
      desenhados: desenhadosTotal,
      fila: fila.length,
      decode: decoder?.decodeQueueSize ?? 0,
      resync: ressincronizacoes,
      largados: largadosNoDecode,
      lag: Math.max(0, Math.round(lastLagMs)),
      jitter: irregularidade,
      // Sem decodificador configurado não há imagem possível, e é um estado
      // que de fora não se distingue de "a rede não trouxe nada".
      decoder: decoder?.state ?? 'ausente',
    };
  }

  return { start, push, stop, getLag, getJitter, takeFrameCount, getSizes, getSaude };
}

function deserialize(c) {
  const out = {
    codec: c.codec,
    codedWidth: c.codedWidth,
    codedHeight: c.codedHeight,
    // Reduz o buffering interno do decoder — sem isso ele acumula alguns
    // quadros antes de emitir o primeiro.
    optimizeForLatency: true,
  };

  if (c.description) {
    const bin = atob(c.description);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out.description = bytes;
  }

  return out;
}
