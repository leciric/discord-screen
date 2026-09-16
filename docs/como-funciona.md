# Como funciona (para quem mexe no código)

Este arquivo existe só para explicar as decisões que não se adivinham lendo o
código. Para instalar e usar, veja o [README](../README.md).

## Por que a tela é capturada numa aba separada

Duas restrições do Discord definiram o desenho inteiro:

1. **A atividade roda num iframe de outro domínio.** Nesse contexto o navegador
   nega `getDisplayMedia()` — a função que pede a tela — a menos que o Discord
   marque o iframe com `allow="display-capture"`, o que ele não faz.
2. **WebRTC não existe em atividades.** A documentação do Discord diz que só
   WebSocket é suportado. Sem P2P, sem SFU.

Então a captura acontece **fora** do sandbox, numa aba normal do navegador, e os
quadros vão por WebSocket para o servidor, que os repassa para quem assiste:

```
QUEM MOSTRA                        SERVIDOR              QUEM ASSISTE
aba normal do navegador                                  atividade (iframe)
  getDisplayMedia  ✅                                          │
  VideoEncoder                                                 │
  └──── WebSocket binário ────►  repassa sem                   │
                                 abrir o quadro ───────────────►
                                                          VideoDecoder → canvas
```

Quem assiste nunca sai do Discord. Só quem mostra passa por uma aba.

Se um dia o Discord conceder `display-capture`, o botão **"Testar captura no
iframe"** (no painel de detalhes) passa a funcionar — e aí a aba externa pode
sumir. A atividade já tenta capturar internamente antes de cair para a aba.

## Por que WebCodecs e não MediaRecorder

A primeira versão usava `MediaRecorder` + Media Source Extensions e ficava em
~3 segundos de atraso. O formato de container impõe um piso: o pedaço só sai
depois de fechado, e o player precisa acumular buffer para não engasgar.

WebCodecs elimina os dois. Cada quadro é codificado, enviado e desenhado
individualmente, sem container. E, ao contrário de `display-capture`, WebCodecs
não é bloqueado dentro do iframe.

## Keyframe sob demanda

Quem chega no meio de uma transmissão não consegue decodificar nada até receber
um quadro completo. Em vez de guardar um antigo, o servidor **pede um novo** ao
transmissor quando alguém começa a assistir — a tela aparece em ~1 quadro.

O servidor também barra quadros incompletos para quem ainda não recebeu um
completo: alimentar um decodificador frio com eles só produz erro.

## Assistir é opt-in

O servidor não manda os quadros de uma tela para ninguém que não tenha pedido
explicitamente. É o que segura a banda: filtrar só na exibição gastaria a mesma
saída de rede. Por isso cada tela aparece primeiro como um convite
("Assistir tela") em vez de já começar a tocar.

Com uma exceção, e ela é sobre a diferença entre economia e atrito: quando há
**uma única** transmissão de outra pessoa na sala, o cliente pede sozinho. A
escolha precisa ter mais de uma opção para ser escolha — com uma tela só no ar,
o convite é um clique cobrado para chegar ao único lugar aonde dava para ir, e
quem entrou numa sala com uma tela no ar entrou para vê-la.

A partir da segunda o convite volta, porque aí a pergunta existe: baixar as duas
custa o dobro. Fechar uma tela de propósito também a mantém fechada — sem essa
marca, o botão de parar de assistir reabriria o que acabou de fechar no render
seguinte. A própria transmissão nunca abre sozinha: ela já é mostrada pela
prévia local, sem passar pela rede.

## Salas

- **No Discord:** não há lista. A atividade entra direto na sala daquela call.
  Com `DISCORD_BOT_TOKEN` configurado, o servidor confirma com o Discord quem
  está no canal de voz; sem ele, o escopo é a instância da atividade.
- **No site:** não existe call para herdar, então a lista de salas é a única
  forma de as pessoas se encontrarem. Salas podem ter senha.

Salas vivem em memória e fecham sozinhas 12 segundos depois de esvaziar — a
carência existe porque recarregar a página desconecta e reconecta.

## Som

O áudio vai pelo mesmo socket e pelo mesmo cabeçalho do vídeo, distinguido só
pelo byte de tipo. Opus a 96 kbps, capturado junto com a tela por
`getDisplayMedia({ audio: { systemAudio: 'include' } })`.

**O som só sai de aba.** Compartilhar a tela inteira entrega a mistura do
sistema, com a saída do Discord dentro — e a call inteira passa a se ouvir de
volta. Não existe API para tirar um processo dessa mistura: o áudio é capturado
por processo e a relação com uma janela não é um-para-um. O que dá para saber é
o `displaySurface` escolhido, e isso basta — `browser` significa som daquela
aba só. Nos outros casos a faixa é parada antes de sair da máquina.

Junto vai `restrictOwnAudio` quando o navegador suporta: ele tira da captura o
que a própria página está tocando, senão quem transmite enquanto assiste devolve
o som da outra tela para a sala, em laço.

Três coisas que o desenho assume:

- **Áudio não tem keyframe.** Cada pacote Opus se decodifica sozinho, então ele
  não passa pelo bloqueio que barra vídeo sem ponto de partida. Se passasse,
  quem entra no meio ficaria mudo até o próximo keyframe.
- **Buraco em áudio é audível.** Um quadro de vídeo perdido não se nota; um
  intervalo sem amostra é um estalo. Por isso a reprodução mantém um colchão de
  80 ms — o som toca um pouco atrás do vivo, e essa folga absorve o solavanco
  da rede. Passando de 320 ms acumulados, corta e volta ao vivo: atraso somado
  não se recupera sozinho.
- **Sincronia é aceitável, não exata.** O vídeo é desenhado assim que chega; o
  som carrega o colchão. A diferença fica em algumas dezenas de milissegundos,
  abaixo do que se percebe em tela de computador. Casar os dois exigiria
  atrasar o vídeo até o áudio — mais latência para resolver um problema que não
  aparece fora de rosto falando.

A reprodução agenda cada pedaço num `AudioBufferSourceNode`, sem AudioWorklet.
O worklet daria precisão por amostra, mas exige um arquivo carregado por URL, e
dentro da atividade toda URL passa pelo proxy do Discord — um caminho a mais
para dar errado, em troca de precisão que pacotes de 20 ms não pedem.

## Protocolo

Cada pacote trafega como binário puro:

```
[1B slot][1B tipo: 1=vídeo completo 2=vídeo parcial 3=som][8B tempo][8B relógio][payload]
```

O `slot` é o número do transmissor, carimbado na origem: o servidor repassa o
buffer sem tocar nele, e quem assiste sabe para qual decodificador mandar. Até
4 transmissores por sala.

O relógio de envio serve só para medir atraso. É exato na mesma máquina; entre
máquinas diferentes, aproximado.

Controle vai em JSON: `start`, `config`, `audio-config`, `stop`, `rtc`
(transmissor → servidor); `watch`, `unwatch`, `keyframe`, `rename`,
`stop-broadcast`, `ann`, `quadro`, `rtc`, `rtc-ativo` (espectador → servidor);
`state`, `stream-start`, `config`, `audio-config`, `stream-stop`,
`need-keyframe`, `stop-request`, `rtc-want`, `rtc`, `rtc-bye`, `chunks`, `ann`,
`ann-sync`, `quadro`, `quadro-sync`, `error` (servidor → clientes).

`keyframe` pede o próximo keyframe sem soltar o `watch`: é o caminho barato de
`unwatch`+`watch` para quem só precisa de um ponto de partida novo, sem pagar a
renegociação de WebRTC que largar o slot custaria.

As anotações (`ann`) carregam coordenadas normalizadas ao quadro, em inteiros de
0 a 4095 — não em pixels de tela. Cada pessoa assiste num tamanho e num zoom
diferentes, e um traço em pixels chegaria torto em todo mundo menos em quem
desenhou. O servidor guarda os traços de cada transmissão para mandar em
`ann-sync` a quem chega no meio; o laser não é guardado, ele se refaz no quadro
seguinte.

## O quadro branco

O mesmo desenho das anotações, sem uma tela por baixo. A máquina é a mesma —
mesma validação, mesmos tetos, mesma grade de 0 a 4095 —, e as diferenças são
duas, e são elas que decidem se é um quadro ou um mal-entendido:

- **Pertence à sala, não a uma transmissão.** As anotações moram no `entry` do
  transmissor porque só existem sobre a tela de alguém, e somem com ela. O
  quadro é da sala: ele continua lá quando ninguém está mostrando nada, que é
  exatamente quando ele serve para alguma coisa.
- **Vai para todo mundo, sem opt-in.** Assistir é opt-in porque quadro de vídeo
  custa megabits. Um traço custa dezenas de bytes, e um quadro que só metade da
  sala vê não é um quadro.

A folha tem **proporção fixa** e é centrada na caixa, com o mesmo `conter()` que
posiciona o vídeo. Isso não é estética: as coordenadas viajam normalizadas à
folha, e normalizar contra a janela de cada um faria o mesmo traço chegar
espremido em quem está deitado no celular e esticado em quem está no ultrawide.
Com a folha fixa, todo mundo aponta para o mesmo lugar.

A camada do quadro nasce com a sessão e nunca morre, mesmo com o quadro fechado:
o estado chega pelo socket o tempo todo, e abrir precisa mostrar o que já está
lá em vez de uma folha em branco que só se enche no traço seguinte. Pintar,
porém, ela só pinta quando a caixa tem tamanho — fechada, o `vista()` devolve
null e a camada suspende sozinha.

Estar no quadro **desliga o `autoAssistir`**. Quem está desenhando não está
olhando tela nenhuma, e baixar megabits para um canvas que ninguém vê é a única
coisa pior do que não baixá-los. Voltar religa o que estiver no ar.

Apagar o desenho de todo mundo é de quem criou a sala. Cada um limpa o seu e
desfaz o último sem pedir permissão a ninguém — é o mesmo desenho da tela, com o
dono da transmissão trocado pelo dono da sala, porque aqui não há transmissão
para ter dono.

## WebRTC por cima do relay

O relay acima é o piso, e continua sendo o caminho de todo mundo no primeiro
segundo. Por cima dele, cada espectador ganha uma tentativa de conexão direta
com quem transmite.

A diferença que importa não é o número de saltos — é o transporte. O WebSocket
anda sobre TCP, e TCP não sabe descartar um quadro atrasado: quando a rede
aperta, ele entrega tudo, em ordem, mais tarde. A imagem não fica pior, ela
fica no passado, e o que se vê é a transmissão andando aos saltos. O WebRTC
anda sobre SRTP/UDP: abaixa o bitrate sozinho quando detecta perda, repõe
pacote perdido com NACK e, no limite, deixa o quadro velho para trás. Ele
degrada a qualidade em vez de degradar o tempo.

Como funciona a troca:

1. Alguém pede `watch`. O relay começa a entregar na hora, como sempre fez, e
   o servidor manda um `rtc-want` ao transmissor com o nome daquele espectador.
2. O transmissor abre um `RTCPeerConnection`, pendura as faixas do stream que
   já está capturando e manda a oferta. Quem tem a mídia é quem oferece.
3. Offer, answer e candidatos ICE viajam como envelopes opacos pelo mesmo
   socket do relay — ele já existe e já está autenticado.
4. Quando o primeiro quadro **aparece de fato** no `<video>` do espectador — e
   não quando a conexão diz "connected" —, ele avisa `rtc-ativo`. Só então o
   servidor para de mandar os bytes daquela tela para ele.
5. Se todo mundo que assiste chegou nesse ponto, o servidor manda `chunks:
false` e o transmissor para de codificar para o relay: aqueles quadros não
   teriam para onde ir, e a subida dele agora é disputada pelas conexões
   diretas.

E quando não fecha — NAT simétrico sem TURN, sandbox que bloqueia, rede
corporativa — nada acontece. Passados 8 segundos sem quadro, ou na primeira
falha de ICE, o espectador desiste em silêncio e segue no relay, que nunca foi
desligado para ele. É por isso que o WebCodecs não saiu do código: ele é o que
garante que ninguém fica sem imagem por causa de um roteador.

`TURN_URL`, `TURN_USER` e `TURN_PASS` no `.env` (opcionais) alimentam o
`/api/ice`. Sem eles fica só o STUN público, que resolve a maioria das casas
mas não quem está atrás de CGNAT. Um TURN encaminha o vídeo de verdade — custa
banda, e por isso é escolha de quem hospeda, não padrão.

## Fila é atraso, e atraso não sai sozinho

Este é o problema que mais aparece de fora como "travou" e "está atrasado", e
ele tem sempre a mesma forma: alguém aceitou guardar bytes que não conseguia
entregar.

`WebSocket.send` nunca recusa. O que a rede não leva vira fila dentro do
navegador, e TCP entrega em ordem — então o quadro novo fica atrás de todos os
velhos. A imagem não fica pior, ela fica no passado, e como o encoder continua
produzindo no bitrate combinado, a fila só cresce. É isso que se vê quando
alguém troca de página e a tela nova demora segundos para aparecer do outro
lado: o quadro em que a página mudou está no fim de uma fila.

Pior: essa fila é **gulosa**. Ela divide a subida de quem transmite com as
conexões WebRTC dos espectadores diretos, e o controle de congestionamento do
WebRTC cede espaço para quem não cede. Uma fila de WebSocket sem freio faz os
espectadores de WebRTC travarem — e eles são justamente os que deveriam estar
melhor.

Por isso existem dois freios, e os dois são medidos em **tempo**, não em bytes:

- **Na subida de quem transmite** (`ATRASO_REDE_MS`, no broadcaster). Passando
  de meio segundo de vídeo esperando no socket, o quadro é largado antes de
  entrar no encoder — poupa CPU e não acrescenta atraso. Sair do afogamento
  exige a fila cair pela metade, senão ela volta em dois quadros, e o primeiro
  quadro que volta é sempre keyframe: os deltas largados quebraram a cadeia de
  referência de todo mundo que estava no relay.
- **Na saída para cada espectador** (`ATRASO_RELAY_MS`, no servidor). O teto
  antigo era fixo em 2 MB, e 2 MB protegem a memória sem proteger o tempo: num
  stream de 2,5 Mb/s são seis segundos e meio de vídeo esperando na fila de uma
  pessoa. Agora o teto é meio segundo da taxa medida daquela transmissão, com o
  teto de memória de 2 MB continuando por cima como último freio.

E o keyframe de recuperação só é pedido **depois** de a fila daquele espectador
drenar. Antes disso ele era pedido na hora, e o resultado era um ciclo: manda o
quadro mais caro que existe pelo cano que acabou de entupir, ele chega tarde ou
é descartado, pede de novo um segundo depois. O ciclo travava a tela de quem
estava apertado e, como o keyframe vai para a sala inteira, gastava a banda de
todo mundo para isso. Agora quem afogou sai do fluxo até conseguir receber.

### A terceira fila, do lado de quem assiste

As duas de cima eram as filas conhecidas. Havia uma terceira sem freio nenhum,
e ela é a que explica a queixa mais estranha das três: "estou vendo o que fiz
minutos atrás".

O `player` chamava `decoder.decode()` para todo pacote que chegasse, sem nunca
perguntar se o decodificador estava dando conta. Quando não está — 1080p em
software, ou a mesma máquina codificando e decodificando ao mesmo tempo, que é
o caso de quem assiste a própria tela — a fila interna do `VideoDecoder` cresce
sozinha e não volta. Os quadros continuam saindo em ordem e com o ritmo certo
entre eles, só que cada vez mais velhos.

E nada media isso, porque a referência de tempo do player alinha o **ritmo**, e
não a **idade**: um quadro que chega dois minutos atrasado é reancorado e
desenhado na hora, liso, como se fosse ao vivo. Hoje `FILA_DECODE_MAX` põe o
mesmo freio das outras duas — largar é o que impede o atraso de virar
permanente — e `getSaude()` expõe a fila para o painel.

### O relógio da origem, e o lado que faltava

O player traduz "capturado em tal instante" para "desenhar em tal instante", e
essa tradução só vale enquanto o relógio da origem for o mesmo. Trocar de tela,
uma aba que dormiu e voltou, ou uma transmissão que recomeçou trazem timestamps
de outra régua.

O salto para trás sempre foi tratado. O salto **para a frente** não era tratado
por ninguém: os quadros passavam a ser marcados para daqui a trinta segundos, a
fila enchia e esvaziava pelo teto sem nunca chegar a hora de nenhum deles, e a
tela ficava congelada para sempre. Os dois sintomas que chegavam eram "travou"
e "o painel mostra 0 fps", e pareciam problemas diferentes — são o mesmo, e o
0 fps era literal: nenhum quadro era desenhado.

Pior, do lado de quem assistia isso era indistinguível de "ainda conectando": o
tile mostrava a rodinha até o primeiro quadro, e o primeiro quadro nunca vinha.
Hoje `SALTO_MS` reancora nos dois sentidos, e o vigia do tile troca a rodinha
por "a imagem parou de chegar" com um botão que larga e pede de novo.

## A senha da sala não é recuperável

Vale dizer com todas as letras, porque é a primeira coisa que se procura no
painel e não está lá: a senha de uma sala é guardada como `scrypt` sobre um sal
aleatório (`hashPassword`), e o valor em claro não fica em lugar nenhum depois
de definido — nem em memória, nem em log, nem em resposta de API. `stats`,
`adminStats`, `listRooms` e o `roomState` devolvem no máximo `locked: true`.

Com uma exceção que o painel agora oferece: o **código sorteado**. Quando é
este servidor que sorteia o valor, ele fica guardado legível ao lado do hash e
o painel o mostra — porque hash de senha existe por causa de **reuso** (alguém
escolhe aqui a mesma senha do e-mail), e um código sorteado não é de ninguém,
não se repete em lugar nenhum e vale para uma sala que morre quando esvazia. É
a natureza do código de uma reunião, que todo serviço de chamada mostra a quem
organiza. Senha digitada a dedo continua só como hash e continua impossível de
mostrar: ela pode ser a senha de outra coisa, e não é nossa para revelar.

Então "esqueci a senha da sala" não tem resposta do tipo "consulte aqui". Tem
duas: sortear um código (que o painel mostra), ou **substituir**. O painel, em cada sala, tem um campo
de senha com "Definir" e "Remover" — `trocarSenhaPeloPainel`, que não passa pelo
dono de propósito, porque quem esqueceu a senha costuma não estar por perto e a
sala da call nem dono tem (`ownerId: null`). Remover também zera o castigo de
tentativas: continuar bloqueado por uma senha que não existe mais seria absurdo.

E a sala da call **nunca** tem senha. O id dela é `atividade-<instância>` ou
`call-<canal>`, ela nasce em `ensureCallRoom` sem senha e com dono nulo, e o
`join` dela nem chega a olhar senha — a porta é estar no canal de voz. Um link
`/?sala=atividade-…` no site é recusado por isso, e não por falta de senha: a
forma de abrir uma sala da call no site é o ingresso (`?t=…`) que a atividade
emite, via `/api/rooms/open`.

## Diagnosticar depois, e não durante

O servidor sempre soube o que mandou e nunca soube o que chegou. Todos os
problemas acima moram **depois** do último byte que o relay entregou — no
relógio do player, na fila do decodificador, na CPU de quem assiste — e a única
ferramenta que existia era pedir para a pessoa abrir o console. Isso exige a
pessoa presente, avisada, e no exato instante em que o problema acontece: ou
seja, quase nunca.

Agora quem assiste manda um boletim curto a cada cinco segundos para
`POST /api/diag`, autenticado pelo mesmo token de sala que abre o WebSocket.
`server/diagnostico.js` guarda o **último** de cada um e deriva o estado:

| estado              | o que quer dizer                                              |
| ------------------- | ------------------------------------------------------------- |
| `ok`                | desenhando quadros, no tempo                                  |
| `atrasado`          | a imagem anda, mas é velha — fila de decode funda ou lag alto |
| `travado`           | o contador de quadros não andou entre dois boletins           |
| `sem-imagem`        | nunca desenhou nada: é o tile eterno em "Conectando…"         |
| `sem-decodificador` | o codec não subiu naquela máquina — a linha diz qual          |

Duas decisões que valem a explicação: o **último** boletim, e não o histórico,
porque o painel responde "como está agora"; e só as **mudanças** de estado
viram linha de log, porque "fulano continua bem" repetido trezentas vezes por
minuto não é informação, é ruído com carimbo de hora.

"Travado" é derivado no servidor, e não mandado pronto pelo cliente, porque é a
comparação entre dois boletins — a conta feita de um lado só é a que não mente
quando o outro lado é que está parado.

O painel mostra tudo isso em **Diagnóstico → A imagem de quem assiste**, e as
telas paradas e atrasadas viram sinais na mesma aba. As colunas são o
diagnóstico inteiro: `fps` diz se a imagem anda; `atraso` diz se ela é de agora
ou de minutos atrás; `decode` diz se aquela máquina está dando conta; `resync`
diz quantas vezes o relógio da origem saltou; `largados` diz quanto foi jogado
fora para o atraso não virar permanente.

Dentro da atividade, **Ctrl+Shift+D** mostra os mesmos números para a própria
tela.

## Detalhes que não são acidentais

- **`latencyMode: 'realtime'`** no codificador e **`optimizeForLatency: true`**
  no decodificador. Sem eles, ambos acumulam quadros antes de emitir — comprime
  melhor, mas é atraso que nunca mais sai.
- **`frame.close()`** depois de desenhar. `VideoFrame` segura memória de GPU;
  sem isso a aba trava em segundos.
- **Descartar quadro quando a fila do codificador passa de 2, e só voltar a
  aceitar quando ela desce a 1.** Fila vira atraso permanente, e a histerese é o
  que separa uma taxa menor de uma taxa que balança: com a carga em cima do
  limite, um limiar seco faz o encoder aceitar, atrasar, descartar e alcançar a
  cada quadro — não se vê "menos quadros", vê-se tranco.
- **O ritmo é medido contra uma grade ideal, não contra o último quadro
  aceito.** Contra o último aceito, um quadro atrasado leva a régua junto e a
  taxa escorrega para baixo sozinha. A tolerância é meio intervalo, que é a
  maior que ainda escolhe um quadro só por marca — já foi 15% do intervalo, e a
  60 fps isso era menos que o tremor da própria captura: o freio derrubava
  quadro bom ao acaso e a taxa virava cara ou coroa entre 60 e 30.
- **`track.contentHint = 'text'`.** Avisa que é tela, não vídeo — mantém texto
  nítido em vez de suavizar bordas.
- **`cursor: 'always'` em toda captura de tela.** Captura de aba no Chromium vem
  sem ponteiro quando ninguém pede, e quem assiste vê o texto sendo apontado sem
  ver a mão que aponta. É constraint básica, não `exact`: onde o navegador não a
  conhece ela é ignorada em silêncio, e onde o sistema não entrega o ponteiro o
  resultado é o de antes — daí "sempre que der", e não "sempre".
- **O nível do H.264 é derivado do quadro, não fixo.** Os dois últimos dígitos
  do nome do codec são o nível, e ele é um contrato sobre tamanho de quadro e
  macroblocos por segundo. Este arquivo pedia `1E` — nível 3.0, que aguenta
  720×576 — desde sempre, e uma tela 1080p tem cinco vezes isso: o navegador
  recusava a configuração inteira e a escolha caía em VP8, que a 1080p não tem
  encoder por hardware em máquina nenhuma comum. Compartilhamento de tela nunca
  codificou em H.264 nesta base; só a câmera, que captura pequeno o bastante
  para caber. Agora `nivelH264` escolhe o menor nível que aguenta o quadro e a
  taxa, e o `syncSize` acompanha quando a janela capturada muda de tamanho no
  meio da transmissão.
- **Hardware por fora de tudo, na escolha de codec.** O bug do nível não apagava
  a imagem: ele fazia a tela inteira passar a codificar na CPU, o que funciona —
  mal, pela metade da taxa — e não deixava rastro. Hoje `pickConfig` pergunta
  primeiro com `hardwareAcceleration: 'prefer-hardware'` para todos os codecs, e
  só depois sem preferência. Isso garante a preferência de verdade (hardware em
  qualquer codec vale mais que software no codec preferido, porque é a CPU que
  decide se a captura acompanha) e, sobretudo, dá uma **resposta**: se a
  primeira passada não achar nada, sabe-se que aquela máquina vai codificar em
  software, e isso vira aviso na aba de captura e linha no log do servidor em
  vez de mistério. A pergunta discrimina de verdade — no Chromium sem GPU,
  `prefer-hardware` é recusado para avc1, vp9, vp8 e av1, enquanto
  `no-preference` aceita os quatro.
- **A ordem dos codecs, e o VP9 que era código morto.** H.264 primeiro porque
  quase sempre tem encoder por hardware. Depois **VP9**, e só então VP8 — a
  ordem entre os dois estava invertida, e invertida ela nunca chegava no VP9:
  VP8 não tem nível no nome do codec, então é aceito em qualquer resolução, e
  sendo o primeiro dos dois vencia sempre. Para tela a ordem certa é essa, VP9
  comprime bem melhor que VP8 no mesmo bitrate e a diferença é maior justamente
  em texto e bordas duras, que são o pior caso do VP8. O nível do VP9 também
  passou a ser derivado (`nivelVP9`): o nome pedido era `vp09.00.10.08`, nível
  1.0, uns 256×144 — o mesmo erro do H.264 escrito no outro codec. Esse não
  estava custando nada porque o Chromium não valida nível de VP9 contra a
  resolução, ao contrário do H.264; era uma bomba que não tinha explodido, e
  bastaria um navegador que levasse o próprio nome de codec a sério.
- **Backpressure no relay, medido em tempo.** Ver a seção "Fila é atraso" acima.
  O teto de 2 MB continua existindo — ele é o freio de memória, sem o qual um
  espectador que parou de vazar derruba o processo. Mas quem decide o descarte
  no dia a dia é o freio de latência, que é outro problema.
- **A troca de transporte é decidida pelo primeiro quadro, não pelo
  `connectionState`.** Um peer "connected" que não entrega nada é
  indistinguível de um travamento — e desligar o relay confiando nele deixaria
  a tela preta com a conexão reportando sucesso.
- **`degradationPreference`.** Tela usa `maintain-resolution`: texto ilegível é
  pior que texto a 10 quadros. Câmera usa `maintain-framerate`, porque ninguém
  lê um rosto e movimento picado incomoda mais que imagem macia.
- **`/.proxy/`** em todo fetch e WebSocket feito de dentro da atividade — é
  assim que o Discord roteia para o seu servidor.
- **Transmissão sem dono na sala é encerrada.** A aba de captura tem conexão
  própria e não sabe nada do Discord: fechar a atividade ou sair do canal de voz
  não chega até ela, e a tela seguia indo para uma sala já abandonada. Quem
  percebe é o servidor, pela ausência de qualquer conexão de espectador daquele
  dono. Há quinze segundos de carência porque recarregar a atividade desconecta
  e reconecta — sem eles, um F5 derrubaria a transmissão. O relógio começa no
  instante da desconexão, não na varredura seguinte. `BROADCAST_ORPHAN_MS`
  encurta a carência; existe para o teste não esperar quinze segundos parado.
- **Client ID vem do servidor, não do build.** Embutir no bundle obrigava a
  rebuildar a cada troca de credencial, e esquecer disso não dava erro: a
  atividade abria e só quebrava no login.

## O painel

O painel responde quatro perguntas, uma por aba: está funcionando, quem está
usando, o que está estranho, e o que dá para fazer sem subir um deploy.

**Diagnóstico** é a aba que existe por causa de um problema concreto: o servidor
sempre falou por `console.log`, e isso resolve para quem está com um terminal
aberto no VPS. Quem abre o painel de outro lugar não tem esse terminal, e "por
que a tela daquela pessoa travou às 21h04" não se responde com uma média na
tela. Em vez de reescrever cada chamada de log, o `eventos.js` **deriva o
console** para um anel de tamanho fixo — todo `[room abc] …` que já existia
aparece no painel sem que ninguém tenha tocado onde ele é escrito, e o terminal
continua recebendo tudo igual. O anel tem teto porque log sem teto é vazamento
com data marcada, e o que ele descartou é dito, não escondido.

Ao lado do log ficam os **sinais**: o que está fora do normal agora, com o que
fazer a respeito. Os números todos já estão nas outras abas, e ninguém olha para
trinta deles ao mesmo tempo procurando o que mudou.

**Ajustes** deixa mexer nos números do relay com o servidor no ar. O valor disso
é o intervalo: quando uma sala começa a travar, descobrir qual número está
errado e poder testar outro custa um deploy inteiro, e o problema costuma passar
antes. Só entra ali o que tem efeito imediato e reversível — teto de fila,
intervalo de keyframe e as duas carências. Tetos de memória de anotação ficam de
fora porque mexer neles com gente dentro deixa estado inconsistente, e isso não
é ajuste, é bug guiado. `LIMITES` não é enfeite: é o que impede um zero digitado
com pressa de virar um laço de keyframe.

As **ações** da aba de Salas são cinco, e todas passam pelo mesmo teste: são
reversíveis por natureza — a pior custa a alguém apertar "compartilhar" de novo
— e todas respondem com o número do que fizeram. Um botão que responde "ok"
tanto quando agiu quanto quando não achou nada é um botão que ensina a não
confiar nele.

O detalhe de cada transmissão traz o par que explica travamento: a **taxa** que
ela está entregando e o **teto de fila** que decide o descarte, com a fila de
cada espectador ao lado. Espectador marcado como _afogado_ é uma tela parada com
o servidor sabendo por quê.

A forma da tela é a do Discord, e isso é decisão, não estética: sala é canal,
quem está dentro é lista de membros, guild é ícone na barra da esquerda. Quem
abre este painel passa o dia dentro do Discord, e uma gramática própria é uma
gramática a aprender na noite em que alguma coisa quebrou. O filtro por guild
recalcula gente, sala e banda a partir das salas que sobraram — só CPU, memória
e disco continuam sendo da máquina, e a barra de cima diz isso, porque um número
que não obedece ao filtro sem avisar é uma conclusão errada esperando acontecer.

Três coisas existem só para encurtar investigação: o **json-cru**, que é a
resposta de `/api/admin/metrics` colorida e filtrável — antes, a pergunta que a
tela não respondia mandava abrir o DevTools num painel que já tinha o dado na
mão; o **copiar/baixar** do JSON e do log, que é o que se manda para outra
pessoa investigar junto (e vai sempre sem o filtro de guild, porque recorte
invisível dentro de um anexo é pior do que anexo nenhum); e o **Ctrl+K**, porque
teclar o nome da sala sempre foi mais rápido do que caçar a linha dela numa
lista que se mexe sozinha.

## A página do servidor

`/servidor` responde outra pergunta, e ela é de quem usa: _tem gente aí?_ O
lobby do site só mostra as salas da própria instância, e quem abre o endereço
sozinho não tem como saber que o resto existe.

O que separa esta página do painel não é a origem do número — os dois comem do
mesmo `adminStats()`, de propósito, porque duas travessias das salas montando
duas verdades é como as duas passam a discordar. O que separa é a **projeção**,
que mora em `publico.js` e deixa de fora duas classes inteiras de coisa:

1. **Número de diagnóstico.** Fila, descarte, ping, teto, memória: são o _como
   está indo_, e quem só quer entrar numa sala não tem o que fazer com eles. O
   teste dessa projeção é escrito ao contrário — ele procura os campos que não
   podem estar lá.
2. **Identificador que sirva de porta.** O id de uma sala é a chave de entrada
   dela, e não sai daqui para sala nascida no Discord: o dela é derivado do id
   do canal de voz e não é nosso para publicar. Cada linha leva no lugar uma
   chave opaca, salgada por processo, que serve para a página saber que o cartão
   é o mesmo depois do refresh.

Essas duas exclusões chegaram a valer por uma terceira, que não era da mesma
família e vinha junto de carona: **se dava para entrar**. Sem id publicado, sem
botão — e o resultado, num servidor cujas salas nascem todas na atividade, era
uma página inteira de frases explicando que a porta era outra. A frase estava
certa sobre o mecanismo e errada sobre quem a lia: quem vê "3 telas no ar" quer
olhar, não ser informado.

Hoje as duas perguntas são separadas. O id continua sem sair (`id: null`), e a
sala ganha `porIngresso: true`; o botão manda a **chave** ao
`POST /api/publico/entrar`, que percorre os ids abertos derivando a chave de
cada um até achar o dono dela — uma volta por sala aberta, que é o preço de o id
não circular. O que volta é um `?t=<ingresso>`, o mesmo token de espectador que
o botão "Assistir no site" da atividade produz, e daí para a frente o caminho é
o `/api/rooms/open` que já existia.

Duas coisas ficam de fora dessa troca, e as duas de propósito. A **senha** da
sala continua sendo cobrada: é a única coisa que o dono escolheu a dedo para
manter alguém do lado de fora, e seria estranho um ingresso assinado aqui passar
por cima dela. E a **porta é a desta página, e nada além dela** — quem passa
pelo `/api/publico` para ver a sala listada passa pelo `entrar` para entrar
nela. Com `PUBLIC_STATUS=aberto` isso quer dizer qualquer pessoa com o endereço:
publicar a página passou a publicar a entrada junto, e quem hospeda precisa
saber disso na hora de escolher o modo.

A porta é o login do Discord, e a razão é o conteúdo: nome e foto de quem está
online agora são da turma do servidor, não do endereço inteiro da internet. Com
`DISCORD_GUILD_ID` preenchido, o login pede também o escopo `guilds` e a
resposta do Discord decide quem passa — a checagem acontece uma vez, no login, e
vale as oito horas do cookie. Consultar o Discord a cada leitura seria uma
chamada externa a cada quatro segundos por aba aberta, e o preço disso é maior
do que o de alguém continuar vendo a lista até a sessão vencer depois de sair do
servidor.

`/convite/:sala` é a mesma porta com um destino específico. Ele existe por um
caso que não tinha resposta: alguém está mostrando a tela pela atividade, e a
pessoa que precisa ver não consegue entrar por lá. Quem já entrou vai direto
para a sala; quem não entrou passa pelo login e **volta para ela** — o destino
viaja assinado dentro do `state` do OAuth, e só caminho deste site é aceito de
volta, senão o parâmetro seria um redirect aberto com o nosso domínio na barra.

`PUBLIC_STATUS=off` desliga a página e a rota juntas; `aberto` dispensa o login,
que é o modo de quem está testando na própria máquina. A rota tem um segundo de
cache compartilhado, porque ela é a única sem porteiro que varre todas as salas.

No painel administrativo o mesmo ingresso existe como a ação `ingresso`, e ele
está lá pelo caso simétrico: a sala de uma call não tem convite, então quem
administra a máquina era exatamente quem não conseguia olhar a tela de que
estavam reclamando sem entrar no canal de voz. O link entra na sala **como quem
pediu** — o nome vai carimbado dentro dele —, o que faz dele um link para olhar
e não para distribuir.

### A lista não se refaz debaixo da mão de ninguém

As duas listas de sala do projeto — a desta página e a do lobby — se refaziam
inteiras a cada volta do laço, com `replaceChildren`. Isso não é cosmético. Um
clique humano leva uns 100 ms entre apertar e soltar, e quando a troca cai nesse
meio o `mousedown` e o `mouseup` acontecem em nós diferentes: o navegador
dispara o `click` no ancestral comum, que não é o botão. O clique não acontece,
sem erro nenhum, e a página ganha fama de não abrir sala. Com o campo de senha
na linha ficaria pior — o que estava sendo digitado sumia no meio.

Havia meia guarda contra isso no lobby, escrita com esse motivo: ela cobria o
modal aberto e deixava passar o caso comum, que é o cursor parado sobre o cartão
esperando a hora de clicar. Agora os dados continuam chegando no ritmo de
sempre e é a **pintura** que espera: enquanto o ponteiro está sobre a lista, ou
o foco está dentro dela, a última resposta fica guardada e entra assim que a mão
sai. Ninguém olha uma lista parada por engano — ou está mexendo nela, e aí é
justamente isso que não pode se mover.

## Estrutura

```
server/
  index.js        HTTP + WebSocket, login do Discord, emissão de tokens
  rooms.js        salas e repasse dos quadros
  tokens.js       tokens assinados (sem biblioteca externa)
  eventos.js      anel de log que alimenta o painel (deriva o console)
  publico.js      a projeção pública: o que /servidor pode mostrar, e o que não
  public/share.*  a aba de captura, que roda FORA do Discord
  public/admin.*  o painel: visão geral, salas, pessoas, diagnóstico, ajustes
  public/servidor.* a página de estado para quem usa, com os links de convite
client/
  src/main.js     interface da sala e conexão
  src/player.js   decodifica os quadros e desenha no canvas
  src/audio.js    decodifica o som e agenda a reprodução
shared/
  broadcaster.js  captura + codificação, usada pela aba e pela atividade
  rtc.js          conexão direta por WebRTC, por cima do relay
  estudio.js      a câmera antes do encoder: fundo trocado, ou um GIF no lugar
  animacao.js     GIF decodificado quadro a quadro, com relógio próprio
  anotacoes.js    estado e desenho do laser e da caneta — e do quadro branco
  flutuar.js      a janela por cima de tudo (composição + Picture-in-Picture)
  porta.js        a porta padrão, num lugar só
scripts/
  configurar.mjs  assistente de configuração
  tunel.mjs       sobe o túnel e grava o endereço no .env
  smoke.mjs       teste do servidor ponta a ponta, sem navegador
```

## A câmera virtual

Entre a webcam e o encoder existe um canvas. Ele resolve duas coisas que são a
mesma coisa por dentro: trocar o fundo, e trocar a câmera inteira por um GIF —
nos dois casos o que sai é uma faixa de vídeo, e o resto do programa não
distingue uma da outra.

Três decisões que não são acidentais:

**`captureStream(0)`, e não `captureStream(fps)`.** Com zero, o único jeito de
sair um quadro é pedindo (`requestFrame`). É isso que permite trocar a taxa com
a transmissão no ar sem refazer a faixa, e garante que todo quadro entregue
acabou de ser desenhado.

**O relógio mora num Worker.** `requestAnimationFrame` congela em aba escondida
e `setInterval` na página é afunilado para um disparo por segundo. Os dois são
fatais aqui: a aba de captura existe justamente para ficar em segundo plano
enquanto a pessoa volta para o Discord. Dentro de um Worker o afunilamento não
se aplica. É o mesmo motivo pelo qual o GIF é decodificado pelo `ImageDecoder`,
com índice de quadro nosso, em vez de por um `<img>` que anima sozinho — um
`<img>` em aba escondida não é pintado, e o que não é pintado não avança.

**O estúdio não é dono de nada que recebe.** Nem do MediaStream da câmera nem
da animação: um GIF pode ser a entrada agora e o fundo daqui a pouco, e fechar
o que se recebe apagaria imagem que quem chamou ainda está usando.

Sobre o fundo, sem prometer o que não se cumpre: separar pessoa de parede exige
um modelo de segmentação. Onde o sistema oferece isso pronto — a constraint
`backgroundBlur` —, é ela que vale. Onde não oferece, o que existe é um recorte
oval no meio do quadro, montado num canvas à parte e colado inteiro com
`destination-in`: um `clip()` cortaria na unha, e a emenda dura entre rosto e
fundo é o que denuncia o truque. A interface diz qual dos dois está no ar.

## Testes

```
npm start        # numa janela
npm run smoke    # noutra
```

Cobre autenticação, senha de sala e bloqueio por tentativas, a máquina de
estados do keyframe, "assistir é opt-in", vários transmissores sem misturar os
streams, e isolamento entre salas e instâncias.

## Rodando enquanto mexe no código

`npm start` reconstrói o site a cada execução. Para recarregar sozinho a cada
salvamento, use `npm run dev` — ele sobe o servidor na 31415 e o site na 5173,
e é a 5173 que você abre.
