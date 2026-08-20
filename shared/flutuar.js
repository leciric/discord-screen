/**
 * Janela flutuante com a tela e as marcações, por cima dos outros programas.
 *
 * Resolve o pedido mais óbvio de quem compartilha: "meu amigo desenhou na minha
 * tela, quero ver sem voltar para o Discord". Página nenhuma consegue pintar no
 * seu desktop — é uma fronteira do navegador, não uma limitação deste programa
 * —, mas o Picture-in-Picture abre uma janela de verdade, do sistema, que fica
 * acima de tudo e não some quando você clica no editor. É o mais perto que dá
 * para chegar sem instalar um aplicativo.
 *
 * O truque é o canvas de mistura: o PiP só sabe exibir um vídeo, então imagem e
 * traços são desenhados juntos num canvas, e é a captura DESSE canvas que vira
 * o vídeo flutuante. É também o que faz isto funcionar em qualquer navegador
 * com PiP, e não só nos que têm a API de PiP com documento.
 *
 * Uma ressalva honesta: compartilhando a TELA INTEIRA, esta janela também é
 * parte da tela, então ela aparece dentro de si mesma. Compartilhando uma
 * janela só, isso não acontece.
 */
import { criarCamada } from './anotacoes.js';

// A janela flutuante é pequena; compor em 4K para exibir em 400px seria gastar
// GPU para jogar fora. 1280 de largura mantém texto de código legível quando
// alguém aumenta a janela.
const LARGURA_MAX = 1280;

// A imagem pode ficar parada por minutos, mas o laser não: quem compõe é o
// relógio, não a chegada de quadros. 30 por segundo é suave e barato.
const FPS = 30;

/** Este navegador consegue abrir a janela flutuante? */
export const flutuarDisponivel = () =>
  typeof document !== 'undefined' && document.pictureInPictureEnabled === true;

/**
 * @param {object} opts
 * @param {() => (CanvasImageSource|null)} opts.fonte  o que desenhar embaixo —
 *   o <video> da captura, para quem transmite, ou o canvas do decodificador,
 *   para quem assiste
 * @param {() => ({w:number,h:number})} opts.dim  tamanho nativo dessa imagem
 * @param {(motivo?:string)=>void} [opts.aoFechar]
 */
export function criarFlutuante({ fonte, dim, aoFechar }) {
  const mistura = document.createElement('canvas');
  const ctx = mistura.getContext('2d', { alpha: false });

  // Fora do fluxo mas no DOM: um <video> solto não é reproduzido em alguns
  // navegadores, e display:none chega a pausá-lo — o mesmo cuidado que a
  // captura via <video> já toma no broadcaster.
  const saida = document.createElement('video');
  saida.muted = true;
  saida.playsInline = true;
  Object.assign(saida.style, {
    position: 'fixed',
    left: '-9999px',
    width: '2px',
    height: '2px',
    opacity: '0',
    pointerEvents: 'none',
  });

  // A camada desta janela é uma segunda instância, e não a mesma da página: ali
  // o desenho é pintado no tamanho da tela e com o zoom de quem assiste
  // aplicado, e aqui ele precisa sair no tamanho do quadro. Mesmo estado, duas
  // superfícies — por isso `aplicar` e `sincronizar` são repassados aos dois.
  const traços = document.createElement('canvas');
  const camada = criarCamada(traços, {
    vista: () =>
      mistura.width
        ? { boxW: mistura.width, boxH: mistura.height, x: 0, y: 0, w: mistura.width, h: mistura.height }
        : null,
  });

  let laço = null;
  let ultimoEm = 0;
  let aberta = false;

  function ajustarTamanho() {
    const { w, h } = dim();
    if (!w || !h) return false;

    const escala = Math.min(1, LARGURA_MAX / w);
    const lw = Math.max(2, Math.round(w * escala));
    const lh = Math.max(2, Math.round(h * escala));
    if (mistura.width !== lw || mistura.height !== lh) {
      mistura.width = lw;
      mistura.height = lh;
      camada.repintar();
    }
    return true;
  }

  function compor(agora) {
    laço = requestAnimationFrame(compor);
    if (agora - ultimoEm < 1000 / FPS - 1) return;
    ultimoEm = agora;

    if (!ajustarTamanho()) return;

    const img = fonte();
    if (img) {
      try {
        ctx.drawImage(img, 0, 0, mistura.width, mistura.height);
      } catch {
        // Canvas ainda sem conteúdo, ou vídeo entre quadros: pula esta volta.
      }
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, mistura.width, mistura.height);
    }

    // Os traços vêm de um canvas próprio, e não pintados aqui, porque a camada
    // limpa a superfície inteira a cada quadro — pintar no mesmo canvas
    // apagaria a imagem que acabou de ser desenhada embaixo.
    if (traços.width) {
      ctx.drawImage(traços, 0, 0, mistura.width, mistura.height);
    }
  }

  /** Precisa vir de um gesto do usuário, como qualquer PiP. */
  async function abrir() {
    if (aberta) return true;
    if (!flutuarDisponivel()) {
      throw new Error('Este navegador não abre janela flutuante (Picture-in-Picture).');
    }

    if (!ajustarTamanho()) throw new Error('A imagem ainda não chegou. Tente de novo em um instante.');

    document.body.append(saida);
    laço = requestAnimationFrame(compor);

    saida.srcObject = mistura.captureStream(FPS);
    await saida.play();
    await saida.requestPictureInPicture();

    aberta = true;
    saida.addEventListener('leavepictureinpicture', () => fechar(), { once: true });
    return true;
  }

  function fechar() {
    if (!aberta && !laço) return;
    aberta = false;

    cancelAnimationFrame(laço);
    laço = null;

    if (document.pictureInPictureElement === saida) {
      document.exitPictureInPicture().catch(() => {});
    }
    saida.srcObject = null;
    saida.remove();
    aoFechar?.();
  }

  return {
    abrir,
    fechar,
    estaAberta: () => aberta,
    /** Espelha o que a camada da página recebe. */
    aplicar: (msg) => camada.aplicar(msg),
    sincronizar: (tracos) => camada.sincronizar(tracos),
    // Esconder os traços é uma escolha de quem assiste, e vale para as duas
    // superfícies: seria estranho apagá-los do palco e continuar vendo-os na
    // janela que está por cima de tudo.
    mostrar: (sim) => camada.mostrar(sim),
    limpar: () => camada.limpar(),
    parar: () => {
      fechar();
      camada.parar();
    },
  };
}
