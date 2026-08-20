/**
 * Anotações sobre a tela: laser e caneta.
 *
 * Módulo compartilhado entre a Activity (quem assiste desenha) e a página de
 * captura externa (quem transmite vê o que desenharam). Uma implementação só —
 * duas cópias divergiriam na primeira correção, exatamente como no broadcaster.
 *
 * As coordenadas viajam normalizadas ao quadro do vídeo, nunca em pixels de
 * tela: cada pessoa assiste num tamanho diferente, com zoom diferente, e um
 * traço em pixels chegaria torto em todo mundo menos em quem desenhou.
 *
 * Inteiros de 0 a GRADE em vez de fração: em JSON, `2047` ocupa quatro bytes e
 * `0.4998779296875` ocupa dezesseis. Num traço de duzentos pontos a diferença
 * é a linha chegar junto com a mão ou depois dela.
 */

/** Resolução da grade normalizada. 4095 dá precisão de sub-pixel até 4K. */
export const GRADE = 4095;

/**
 * Espessuras, na mesma grade das coordenadas.
 *
 * Espessura relativa ao vídeo, e não em pixels de tela, porque o traço é
 * conteúdo: quem dá zoom quer ver o traço crescer junto com o que ele circulou,
 * não uma linha fina passeando por cima de uma imagem ampliada.
 */
export const ESPESSURAS = { fino: 5, medio: 10, grossa: 18 };

/** Cores da paleta. Escolhidas para aparecer tanto em fundo claro quanto escuro. */
export const CORES = ['#ff4d4f', '#ffd23f', '#4ade80', '#38bdf8', '#c084fc', '#ffffff'];

// Ponteiro parado some sozinho: laser esquecido no canto da tela vira sujeira
// permanente na imagem de todo mundo.
const LASER_VIDA_MS = 1600;
const LASER_SUMICO_MS = 450;
// Rabo de cometa: o suficiente para o olho seguir o movimento, curto o
// bastante para não virar rabisco.
const LASER_RASTRO_MS = 240;
// Raio em pixels de tela, não da grade: o laser é ponteiro, não conteúdo, e
// precisa ter o mesmo tamanho aparente com ou sem zoom.
const LASER_RAIO = 7;

const agora = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Camada de desenho sobre um vídeo.
 *
 * @param {HTMLCanvasElement} canvas  sobreposto ao vídeo, do tamanho da caixa
 * @param {object} opts
 * @param {() => ({x:number,y:number,w:number,h:number,boxW:number,boxH:number}|null)} opts.vista
 *   retângulo, em pixels CSS dentro da caixa, onde a imagem do vídeo está
 *   desenhada neste instante — já com zoom e deslocamento aplicados. Devolver
 *   null suspende a pintura (vídeo ainda sem tamanho, caixa fora de tela).
 */
export function criarCamada(canvas, { vista }) {
  const ctx = canvas.getContext('2d');

  // Ordem de inserção importa: "desfazer" tira o último traço de quem pediu, e
  // Map preserva a ordem de inserção por especificação.
  const tracos = new Map(); // id -> { uid, name, color, width, pts }
  const lasers = new Map(); // uid -> { name, color, trilha: [{x,y,t}] }

  let sujo = true;
  let quadro = null;
  // Escondido é só aqui: o estado continua chegando e sendo guardado, então
  // voltar a mostrar traz tudo de volta sem pedir nada a ninguém.
  let visivel = true;

  // ------------------------------------------------------------------ estado

  /**
   * Aplica um evento, venha ele do relay ou do eco local de quem desenhou.
   *
   * O eco local existe porque a volta pelo servidor é visível na ponta do
   * lápis: o traço apareceria alguns quadros atrás da mão.
   */
  function aplicar({ uid, name, ev }) {
    if (!ev || !uid) return;

    switch (ev.k) {
      case 'p': {
        const laser = lasers.get(uid) ?? { name, color: ev.c, trilha: [] };
        laser.name = name ?? laser.name;
        laser.color = ev.c ?? laser.color;
        laser.trilha.push({ x: ev.x, y: ev.y, t: agora() });
        // A trilha é podada na pintura; aqui só se evita ela crescer sem teto
        // enquanto a aba está em segundo plano e não há rAF para podar.
        if (laser.trilha.length > 64) laser.trilha.splice(0, laser.trilha.length - 64);
        lasers.set(uid, laser);
        break;
      }
      case 'po':
        lasers.delete(uid);
        break;
      case 's':
        tracos.set(chave(uid, ev.id), {
          uid,
          name,
          color: ev.c,
          width: ev.w,
          pts: [...(ev.pts ?? [])],
        });
        podar();
        break;
      case 'a': {
        const traco = tracos.get(chave(uid, ev.id));
        if (traco) traco.pts.push(...(ev.pts ?? []));
        break;
      }
      case 'e':
        // O fim do traço não muda o desenho; existe para o servidor saber que
        // aquele id não recebe mais nada.
        break;
      case 'u': {
        const ultimo = [...tracos.entries()].filter(([, t]) => t.uid === uid).pop();
        if (ultimo) tracos.delete(ultimo[0]);
        break;
      }
      case 'c':
        for (const [id, t] of tracos) if (t.uid === uid) tracos.delete(id);
        break;
      case 'ca':
        tracos.clear();
        break;
      default:
        return;
    }

    marcar();
  }

  /** Estado completo, para quem chega no meio. */
  function sincronizar(lista) {
    tracos.clear();
    for (const t of lista ?? []) {
      tracos.set(t.id, {
        uid: t.uid,
        name: t.name,
        color: t.color,
        width: t.width,
        pts: [...(t.pts ?? [])],
      });
    }
    marcar();
  }

  function limpar() {
    tracos.clear();
    lasers.clear();
    marcar();
  }

  const chave = (uid, id) => `${uid}:${id}`;

  // Teto de memória: sem ele, uma sala aberta o dia inteiro acumula traço até o
  // navegador engasgar. Os mais antigos saem primeiro.
  const MAX_TRACOS = 400;
  function podar() {
    while (tracos.size > MAX_TRACOS) tracos.delete(tracos.keys().next().value);
  }

  // ----------------------------------------------------------------- pintura

  function marcar() {
    sujo = true;
    if (quadro === null && typeof requestAnimationFrame === 'function') {
      quadro = requestAnimationFrame(pintar);
    }
  }

  function pintar() {
    quadro = null;

    if (!visivel) {
      // Uma limpada e pronto: nada de agendar o quadro seguinte enquanto
      // estiver escondido, senão o laser de outra pessoa manteria um laço de
      // animação vivo desenhando o que ninguém vê.
      if (canvas.width) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const v = vista();
    if (!v || !v.boxW || !v.boxH) {
      // Sem caixa não há o que pintar, mas o estado continua vivo: quando o
      // tile voltar ao palco, uma marcação nova traz tudo de volta.
      sujo = true;
      return;
    }

    // Teto em 2 porque acima disso o ganho é invisível e a área a pintar
    // quadruplica — em tela cheia 4K isso já custa quadro.
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(v.boxW * dpr));
    const ch = Math.max(1, Math.round(v.boxH * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.boxW, v.boxH);

    const px = (x) => v.x + (x / GRADE) * v.w;
    const py = (y) => v.y + (y / GRADE) * v.h;

    for (const traco of tracos.values()) desenharTraco(traco, px, py, v);

    const t = agora();
    let animando = false;
    for (const [uid, laser] of lasers) {
      if (desenharLaser(laser, px, py, t, v)) animando = true;
      else lasers.delete(uid);
    }

    sujo = false;
    // Laser vivo se move e desbota sozinho: enquanto houver um, o próximo
    // quadro já está pedido. Traço parado não redesenha nada.
    if (animando) marcar();
  }

  function desenharTraco(traco, px, py, v) {
    const pts = traco.pts;
    if (pts.length < 2) return;

    // Mínimo de 1,2px: numa miniatura da lateral um traço fino some, e some
    // justamente a informação de que alguém desenhou ali.
    ctx.lineWidth = Math.max(1.2, (traco.width / GRADE) * v.w);
    ctx.strokeStyle = traco.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Sombra por baixo: o desenho precisa aparecer tanto sobre um editor escuro
    // quanto sobre uma planilha branca, e nenhuma cor sozinha resolve as duas.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = ctx.lineWidth * 0.9;

    ctx.beginPath();

    if (pts.length === 2) {
      // Um ponto só: um toque, não um traço. Vira bolinha, senão nada aparece.
      ctx.arc(px(pts[0]), py(pts[1]), ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = traco.color;
      ctx.fill();
      ctx.shadowBlur = 0;
      return;
    }

    ctx.moveTo(px(pts[0]), py(pts[1]));
    // Curva por ponto médio: liga os pontos por quadráticas cujo controle é o
    // próprio ponto capturado. Sai suave sem precisar guardar tangente nenhuma,
    // e é o que separa um traço de mão de uma linha quebrada em zigue-zague.
    for (let i = 2; i < pts.length - 2; i += 2) {
      const x1 = px(pts[i]);
      const y1 = py(pts[i + 1]);
      const x2 = px(pts[i + 2]);
      const y2 = py(pts[i + 3]);
      ctx.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
    }
    ctx.lineTo(px(pts[pts.length - 2]), py(pts[pts.length - 1]));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /** @returns {boolean} o laser ainda está vivo. */
  function desenharLaser(laser, px, py, t, v) {
    const trilha = laser.trilha;
    const ultimo = trilha[trilha.length - 1];
    if (!ultimo) return false;

    const idade = t - ultimo.t;
    if (idade > LASER_VIDA_MS + LASER_SUMICO_MS) return false;

    // Desbota nos últimos instantes em vez de sumir de uma vez: um ponto que
    // pisca fora chama mais atenção do que um que se apaga.
    const alfa = idade <= LASER_VIDA_MS ? 1 : 1 - (idade - LASER_VIDA_MS) / LASER_SUMICO_MS;

    const cor = laser.color ?? '#ff4d4f';
    const x = px(ultimo.x);
    const y = py(ultimo.y);

    // Rabo de cometa, só com o que é recente.
    const recentes = trilha.filter((p) => t - p.t < LASER_RASTRO_MS);
    if (recentes.length > 1) {
      ctx.save();
      ctx.globalAlpha = alfa * 0.55;
      ctx.strokeStyle = cor;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 1; i < recentes.length; i++) {
        const idadeSeg = t - recentes[i].t;
        ctx.globalAlpha = alfa * 0.5 * (1 - idadeSeg / LASER_RASTRO_MS);
        ctx.lineWidth = LASER_RAIO * 1.5 * (i / recentes.length);
        ctx.beginPath();
        ctx.moveTo(px(recentes[i - 1].x), py(recentes[i - 1].y));
        ctx.lineTo(px(recentes[i].x), py(recentes[i].y));
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = alfa;

    // Halo, disco e núcleo branco: é o que faz um ponto de 7px ser achado numa
    // tela cheia de conteúdo. Um círculo chapado se perde no primeiro fundo
    // colorido parecido.
    const halo = ctx.createRadialGradient(x, y, 0, x, y, LASER_RAIO * 3);
    halo.addColorStop(0, cor);
    halo.addColorStop(1, 'transparent');
    ctx.globalAlpha = alfa * 0.35;
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, LASER_RAIO * 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = alfa;
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.arc(x, y, LASER_RAIO, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.beginPath();
    ctx.arc(x, y, LASER_RAIO * 0.42, 0, Math.PI * 2);
    ctx.fill();

    if (laser.name) etiqueta(laser.name, x, y, cor, alfa, v);

    ctx.restore();
    return true;
  }

  /**
   * Nome de quem aponta. Sem ele, três lasers na tela são três pontos anônimos.
   *
   * A etiqueta é presa dentro da caixa visível: apontar para o rodapé da tela
   * jogava o nome para baixo da borda, e o que aparecia era meia etiqueta
   * cortada — ou nada. Encostou no fim, ela passa para cima do ponto; encostou
   * na lateral, escorrega para dentro.
   */
  function etiqueta(nome, x, y, cor, alfa, v) {
    ctx.font = '600 11.5px "gg sans", "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'top';

    const largura = ctx.measureText(nome).width + 12;
    const altura = 18;
    const folga = LASER_RAIO * 2.4;

    // Abaixo do ponto por padrão; acima quando lá embaixo não cabe.
    let topo = y + folga;
    if (topo + altura > v.boxH - 2) topo = y - folga - altura;
    topo = Math.max(2, Math.min(v.boxH - altura - 2, topo));

    let esquerda = x - largura / 2;
    esquerda = Math.max(2, Math.min(v.boxW - largura - 2, esquerda));

    ctx.globalAlpha = alfa * 0.8;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.beginPath();
    ctx.roundRect(esquerda, topo, largura, altura, 9);
    ctx.fill();

    ctx.globalAlpha = alfa;
    ctx.fillStyle = cor;
    ctx.textAlign = 'left';
    ctx.fillText(nome, esquerda + 6, topo + 3.5);
  }

  function parar() {
    if (quadro !== null) cancelAnimationFrame(quadro);
    quadro = null;
    tracos.clear();
    lasers.clear();
  }

  /**
   * O estado atual, no mesmo formato que `sincronizar` recebe.
   *
   * Serve para semear uma segunda camada com o que já está na tela — a janela
   * flutuante nasce no meio da conversa e precisa começar de onde a primeira
   * está, não em branco.
   */
  function instantaneo() {
    return [...tracos.entries()].map(([id, t]) => ({ id, ...t, pts: [...t.pts] }));
  }

  /** Mostra ou esconde tudo, sem perder nada do que está guardado. */
  function mostrar(sim) {
    if (visivel === sim) return;
    visivel = sim;
    marcar();
  }

  return {
    aplicar,
    sincronizar,
    instantaneo,
    mostrar,
    limpar,
    parar,
    /** Repinta na próxima oportunidade — a caixa mudou de tamanho, zoom ou lugar. */
    repintar: marcar,
    vazio: () => tracos.size === 0 && lasers.size === 0,
  };
}

/**
 * Retângulo que uma imagem `vw×vh` ocupa dentro de uma caixa `bw×bh` com
 * `object-fit: contain`.
 *
 * É a mesma conta que o navegador faz para posicionar o canvas do vídeo, e
 * precisa ser refeita aqui porque só ela diz onde a imagem realmente está —
 * sem isso, um traço feito sobre a imagem cairia na tarja preta do outro lado.
 */
export function conter(bw, bh, vw, vh) {
  if (!vw || !vh || !bw || !bh) return { x: 0, y: 0, w: bw, h: bh };
  const escala = Math.min(bw / vw, bh / vh);
  const w = vw * escala;
  const h = vh * escala;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

/** Converte um ponto da caixa (px CSS) para a grade normalizada do vídeo. */
export function paraGrade(bx, by, v) {
  if (!v?.w || !v?.h) return null;
  const x = Math.round(((bx - v.x) / v.w) * GRADE);
  const y = Math.round(((by - v.y) / v.h) * GRADE);
  return {
    x: Math.min(GRADE, Math.max(0, x)),
    y: Math.min(GRADE, Math.max(0, y)),
    dentro: x >= 0 && x <= GRADE && y >= 0 && y <= GRADE,
  };
}
