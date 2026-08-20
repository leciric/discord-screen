/**
 * A porta em que o servidor atende, quando ninguém escolheu outra.
 *
 * Mora aqui, e não repetida em cada arquivo, porque quem precisa concordar com
 * ela está espalhado: o servidor, o assistente de configuração, o túnel, o
 * proxy do Vite em desenvolvimento e o smoke test. Eram nove lugares com o
 * mesmo número escrito à mão — e trocar a porta significava achar os nove, o
 * que na prática significa esquecer um e passar a tarde atrás de um
 * "connection refused" que não explica nada.
 *
 * Por que 31415 e não 3000, 3001 ou 8080: essa faixa é o estacionamento de
 * todo mundo. Quem programa costuma ter dois ou três servidores de
 * desenvolvimento no ar, e este projeto não tem por que disputar a vaga.
 *
 * E por que não uma porta ainda maior: no Linux, o intervalo a partir de 32768
 * é o que o núcleo usa para a ponta de saída das conexões que a própria máquina
 * abre. Escolher lá em cima troca o conflito conhecido por um raro e
 * intermitente — o servidor sobe cem vezes e falha na centésima primeira,
 * porque naquele instante o número já estava tomado por um download.
 *
 * PORT no .env continua mandando mais que isto. Serviços de hospedagem impõem a
 * porta pela variável de ambiente (a Square Cloud exige a 80), e é assim que
 * eles continuam funcionando sem saber que este arquivo existe.
 */
export const PORTA_PADRAO = 31415;

/** Endereço local completo — o que se digita no navegador para testar. */
export const LOCAL_PADRAO = `http://localhost:${PORTA_PADRAO}`;

/** O mesmo endereço para o relay. Derivado, e não escrito de novo, porque as
 *  duas formas precisam apontar para a mesma porta sempre. */
export const LOCAL_WS_PADRAO = `ws://localhost:${PORTA_PADRAO}`;
