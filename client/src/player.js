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

/**
 * Atraso a partir do qual não vale mais a pena continuar de onde se está.
 *
 * Existe porque há uma fila neste caminho que NINGUÉM consegue ver, e ela é
 * real — medida, não suposta. O freio do relay decide pelo `bufferedAmount` do
 * socket daquele espectador, e `bufferedAmount` só conta o que ainda não foi
 * entregue ao sistema operacional. Medindo com um espectador que não lê nada:
 * o servidor já tinha mandado 3,1 MB quando o `bufferedAmount` ainda marcava
 * 0,5 MB — quase 2,6 MB estavam no buffer do kernel e na rede, invisíveis.
 *
 * A 4 Mb/s isso são uns cinco segundos de vídeo que o teto de meio segundo do
 * relay não tem como enxergar: ele acha que está tudo bem, e quem assiste está
 * cinco segundos no passado. Numa rede de verdade, com mais latência, a janela
 * é maior.
 *
 * Como o servidor não pode ver, quem vê é quem recebe: o carimbo de envio vem
 * dentro de cada pacote, e a distância entre ele e o relógio de agora é o
 * atraso real. Passando disso, o certo é pular para o vivo — largar o que está
 * na fila e pedir a imagem de novo — em vez de reproduzir o passado com um
 * ritmo lindo.
 *
 * Três segundos: muito acima dos 80 ms de buffer somados a qualquer rede ruim,
 * e bem abaixo do que alguém tolera antes de chamar de travado.
 */
const ATRASO_MAX_MS = 3000;

/**
 * Por quanto tempo o atraso precisa se manter antes de valer o solavanco.
 *
 * Um pico isolado não deveria custar um solavanco: pode ser uma rajada que a
 * fila absorve sozinha no quadro seguinte. Exigir persistência é o que separa
 * isso de fila que cresce de verdade.
 *
 * O desvio de relógio entre as duas máquinas não é problema deste número — ver
 * `piso`, que resolve isso medindo o atraso contra o próprio mínimo, e não
 * contra zero. O que ESTE número garante é outro: que o preço de um pulo seja
 * pago no máximo uma vez por incidente. Isso depende de `jaPulou` — sem ele, o
 * mesmo atraso que acabou de pular reabriria o cronômetro no pacote seguinte e
 * pularia de novo a cada ATRASO_PERSISTE_MS, para sempre. `jaPulou` só solta
 * quando o atraso medido realmente cai abaixo do teto pelo menos uma vez.
 */
const ATRASO_PERSISTE_MS = 4000;

/**
 * De quanto em quanto tempo o piso do atraso (ver `piso`) é esquecido e
 * reaprendido do zero.
 *
 * O piso só sabe descer: é um mínimo, e mínimo histórico nunca sobe sozinho.
 * Mas o desvio de relógio entre as duas máquinas não é fixo — cada uma anda num
 * ritmo levemente diferente, e a diferença cresce devagar, minuto a minuto. Sem
 * esquecer o piso de vez em quando, esse desvio se acumularia para sempre em
 * cima de uma referência velha, e uma sessão comprida o bastante cruzaria
 * ATRASO_MAX_MS sozinha, sem nenhum quadro atrasado de verdade.
 *
 * Um minuto é raro o bastante para o mínimo da janela continuar sendo o de uma
 * janela de verdade — um pico de rede isolado não vira piso, porque o próximo
 * pacote bom da mesma janela corrige de volta — e frequente o bastante para o
 * desvio de relógio nunca chegar perto dos 3 s de ATRASO_MAX_MS antes de ser
 * corrigido.
 *
 * O preço deste número: qualquer acúmulo mais lento que ele — um desvio que
 * cresce menos de ATRASO_MAX_MS por PISO_JANELA_MS, uns 50 ms por segundo — é
 * reaprendido como novo piso a cada janela e nunca dispara, mesmo que seja
 * atraso de verdade e não desvio de relógio. É um limite aceitável (bem melhor
 * que o laço infinito que existia antes desta janela) porque nenhuma rede real
 * cresce tão devagar e por tanto tempo sem estabilizar ou piorar de vez — mas
 * quem for mexer neste número precisa saber que é essa a troca que ele faz.
 */
const PISO_JANELA_MS = 60_000;

export function createPlayer(canvas, { onError, onTamanho, onAtrasado } = {}) {
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
  // Desde quando o atraso está acima do teto. `null` enquanto está sob controle.
  // Ver ATRASO_MAX_MS: é o relógio que decide quando pular para o vivo.
  let atrasadoDesde = null;
  // Já pulou por causa deste atraso, e está esperando ele cair pelo menos uma
  // vez antes de valer a pena rearmar `atrasadoDesde`. Ver ATRASO_PERSISTE_MS.
  // Nome deliberadamente diferente de `s.travado`, em main.js — aquele é "a
  // imagem parou de chegar", este é "já pulou por este atraso": são estados
  // diferentes, em arquivos que se leem juntos.
  let jaPulou = false;
  // Menor `Date.now() - sentAt` visto desde a última vez que o relógio da
  // origem foi detectado como outro — ver os dois `piso = Infinity` em draw(),
  // mais abaixo: timestamp andando para trás e salto para a frente (SALTO_MS).
  // Nem "engasgo de rede" (a outra metade daquele mesmo `if`) nem o pulo da
  // própria vigiarAtraso resetam o piso — de propósito: nenhum dos dois muda o
  // desvio de relógio entre as duas máquinas, e é exatamente numa fila
  // crescendo de verdade (que aparece como rede engasgada) que o piso precisa
  // continuar valendo para o atraso ser visto.
  //
  // Por construção esse mínimo é o desvio de relógio com quem transmite somado
  // à menor latência que aquele caminho já entregou: não existe leitura mais
  // baixa que essa sem a fila estar artificialmente vazia. Medir o atraso
  // contra este piso, e não contra zero, é o que separa "os dois relógios não
  // batem" de "a fila está crescendo de verdade" — um desvio constante nunca
  // aparece acima do próprio piso.
  let piso = Infinity;
  // Quando o piso acima expira e é reaprendido do zero. Ver PISO_JANELA_MS.
  let pisoJanelaAte = 0;
  // Quantas vezes já se pulou para o vivo. Sobe junto de "a rede daquela pessoa
  // não está entregando no ritmo", e é o número que separa isso de tudo o mais.
  let pulosParaOVivo = 0;
  // Total de quadros desenhados desde o start. Separado de `framesDrawn`
  // porque aquele é zerado por quem lê (o painel mostra "por segundo"), e um
  // contador que zera não serve para o vigia perguntar "andou desde a última
  // vez que olhei?" — os dois leitores se roubariam.
  let desenhadosTotal = 0;
  // O codec que este player tentou montar. Guardado mesmo — sobretudo — quando
  // o `configure` falha: "sem decodificador" sem dizer de quê manda quem
  // investiga adivinhar, e foi exatamente o que aconteceu na primeira vez.
  let codecTentado = null;

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
    codecTentado = config.codec ?? null;

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
    vigiarAtraso();

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
   * Ficou longe demais do vivo? Então pula, em vez de reproduzir o passado.
   *
   * Este é o único lugar do caminho que consegue ver o atraso de ponta a ponta.
   * O relay decide pelo `bufferedAmount`, que não enxerga o que já foi entregue
   * ao kernel — e são segundos de vídeo. Quem recebe tem o carimbo de envio
   * dentro do pacote, e daqui a conta fecha — contra `piso`, e não contra zero,
   * porque o carimbo vem do relógio de OUTRA máquina: um espectador com o
   * relógio adiantado não pode ler atraso nenhum só por isso.
   *
   * O pulo é o mesmo remédio do resto do arquivo: larga a fila e esquece a
   * referência de tempo. O primeiro quadro que chegar depois disso reancora
   * tudo, e a imagem volta ao presente com um solavanco só — que é muito melhor
   * do que um minuto de passado perfeitamente cadenciado.
   */
  function vigiarAtraso() {
    const agora = Date.now();

    // A janela do piso venceu: reaprende do zero. Ver PISO_JANELA_MS.
    if (agora > pisoJanelaAte) {
      piso = Infinity;
      pisoJanelaAte = agora + PISO_JANELA_MS;
    }
    if (lastLagMs < piso) piso = lastLagMs;

    const atraso = lastLagMs - piso;

    if (atraso <= ATRASO_MAX_MS) {
      atrasadoDesde = null;
      jaPulou = false;
      return;
    }

    // Já pulou por este mesmo atraso; só destrava quando ele cair de verdade,
    // no bloco acima. Sem isto, o pacote seguinte reabriria o cronômetro e
    // pularia de novo a cada ATRASO_PERSISTE_MS, para sempre — ver a nota lá.
    if (jaPulou) return;

    atrasadoDesde ??= agora;
    if (agora - atrasadoDesde < ATRASO_PERSISTE_MS) return;

    jaPulou = true;
    pulosParaOVivo++;
    esvaziar();
    base = null;
    ultimoTs = -Infinity;
    // Sem keyframe o decodificador não tem de onde recomeçar: a cadeia de
    // referência ficou toda na fila que acabou de ser jogada fora.
    needKeyframe = true;
    // Quem chamou decide como pedir a imagem de novo — o player não conhece
    // sala, slot nem socket, e não vai passar a conhecer por causa disto.
    onAtrasado?.(Math.round(lastLagMs));
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
    // Timestamp andando para trás é transmissão nova de verdade — pode estar em
    // outra máquina, com outro desvio de relógio, e o piso do atraso (ver
    // `piso`, em vigiarAtraso) não vale mais. `base === null` sozinho NÃO entra
    // aqui: é também o que o próprio pulo de vigiarAtraso força, e ali o piso
    // deve sobreviver de propósito — é ele que garante que o mesmo atraso não
    // pule de novo assim que a referência de tempo for refeita.
    if (tsMs < ultimoTs) piso = Infinity;
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
      // Só o lado adiantado é desvio de relógio de verdade: o relógio da
      // origem saltou para a frente (ver SALTO_MS, acima), e o piso velho não
      // vale mais. O lado atrasado é rede engasgada — o desvio entre as duas
      // máquinas não muda porque um pacote chegou tarde, e é exatamente isto
      // que uma fila crescendo de verdade produz: `folga` bem negativa.
      // Resetar o piso aqui cegaria o detector no momento em que ele mais
      // precisa enxergar — ver a nota em `piso`, acima.
      if (folga > BUFFER_MS + SALTO_MS) piso = Infinity;
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
    pulosParaOVivo = 0;
    atrasadoDesde = null;
    jaPulou = false;
    piso = Infinity;
    pisoJanelaAte = 0;
    // `codecTentado` NÃO é zerado aqui de propósito: `start()` chama `stop()`
    // antes de tentar, e zerar apagaria justamente o nome do codec que acabou
    // de ser recusado — que é a única informação útil nesse momento.
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
      codec: codecTentado,
      desenhados: desenhadosTotal,
      pulos: pulosParaOVivo,
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
