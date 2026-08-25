![Como não compartilhar tela no Discord](como-nao-compartilhar-tela-no-discord-banner.png)

# Sala de Tela

Mostre sua tela para quem está na mesma call do Discord.
Uma pessoa compartilha, todo mundo assiste sem sair do Discord.

Também funciona como site normal, fora do Discord, com salas que você cria e
compartilha por link.

---

## O que você precisa antes

**1. Node.js** — é o programa que faz tudo isso rodar.

Baixe em [nodejs.org](https://nodejs.org), escolha a versão **LTS** e instale
clicando em avançar até o fim. Não precisa configurar nada.

**2. Google Chrome, Edge, Brave ou Opera** — só para quem vai _mostrar_ a tela.
Para _assistir_, qualquer navegador serve.

> Não funciona no celular para compartilhar. Celular não deixa nenhum site
> capturar a tela. Assistir pelo celular também costuma falhar.

---

## Ligar tudo (um comando)

**1.** Baixe este projeto e descompacte numa pasta.

**2.** Abra a pasta, clique na barra de endereço do explorador de arquivos,
digite `cmd` e aperte Enter. Vai abrir uma janela preta — é ali que você digita
os comandos.

**3.** Digite, um de cada vez, esperando cada um terminar:

```
npm install
npm run start:fast
```

E pronto. Esse segundo comando faz tudo sozinho: se faltar alguma configuração
ele pergunta na hora, depois monta o site, abre o endereço público e liga o
servidor. **Uma janela só.**

Na primeira vez ele baixa o `cloudflared` (uns 50 MB) e guarda em `.cache/`
dentro da pasta do projeto. Você não instala nada à mão.

Para desligar, aperte `Ctrl + C` na janela preta. Isso derruba tudo junto.

Depois da primeira vez, quando já estiver tudo configurado, `npm run
start:direto` faz o mesmo sem parar para perguntar nada: monta o site, sobe o
túnel e liga o servidor.

### Só quero testar no navegador

Se ele perguntar como você quer usar, escolha a opção **sem Discord**. Aí é só
abrir <http://localhost:31415> em duas janelas, criar uma sala numa, entrar pela
outra e clicar em **Compartilhar tela** — você vê sua própria tela chegando do
outro lado.

---

## Usar dentro do Discord

O Discord exige que você registre o programa no site dele. É uma vez só.

Quando o `npm run start:fast` pedir, ele vai te dizer exatamente onde achar cada
valor no site do Discord, e no fim mostra **as coisas para colar lá**, já
preenchidas com os seus dados. Faça o que ele mandar.

Depois, no Discord: entre num canal de voz, clique no **foguete** 🚀 na barra de
baixo e escolha a atividade.

Dentro do Discord não existe lista de salas: quem abre a atividade cai direto na
sala daquela call, junto com o resto do pessoal que está lá.

### O endereço que muda toda vez

Por padrão o endereço público é descartável: **ele muda toda vez que você
desliga e liga o programa**. E aí a atividade para de abrir, até você ir no site
do Discord trocar o _Target_ pelo endereço novo.

Para acabar com isso de vez, rode **uma única vez**:

```
npm run tunel:criar
```

Ele abre o login da Cloudflare no navegador, cria um endereço fixo, aponta o DNS
e já deixa tudo escrito na configuração. Depois disso o endereço nunca mais
muda, e você não mexe no site do Discord de novo.

> Precisa de um domínio seu já na Cloudflare. Se não tiver, siga com o
> descartável mesmo — só lembre de atualizar o _Target_ quando reiniciar.

---

## Painel administrativo

O painel mostra em tempo real pessoas e servidores conectados, salas,
transmissões, banda usada pelo relay, ping, descartes, CPU, memória, disco e
informações do processo/container.

Para ligar, rode `npm run configurar` e responda a pergunta **"Seu ID do
Discord"**, no passo 1. Um traço (`-`) desliga o painel de novo.

O que ele pede é o ID da **sua conta**, não o Client ID da aplicação — os dois
são números parecidos. Ative o modo de desenvolvedor no Discord (Configurações →
Avançado), clique com o botão direito na sua conta e use **Copiar ID do
usuário**. Se preferir editar à mão, é esta linha no `.env`:

```env
DISCORD_ADMIN_ID=123456789012345678
```

Mais de uma pessoa administrando? Separe os IDs por vírgula:

```env
DISCORD_ADMIN_ID=123456789012345678,987654321098765432
```

O `SESSION_SECRET` é outra variável, e é dela o aviso de "mínimo 32”: o ID do
Discord tem 18 dígitos e está certo assim.

Reinicie o servidor e abra `https://seu-dominio.com/admin`. O painel pede login
pelo Discord e o backend compara a conta confirmada pelo próprio Discord com o
ID acima. Os endpoints não aceitam um ID enviado pelo navegador e não expõem
Client Secret, Bot Token ou Session Secret.

No Linux, o painel também lê `/proc`, cgroups e o sistema de arquivos para
mostrar tráfego de rede do host/container e limites do container. No Windows,
CPU, memória, disco e todas as métricas da aplicação funcionam; apenas os
contadores globais de rede da máquina ficam indisponíveis.

O nome de um servidor é resolvido com o Bot Token. Quando o bot não estiver
naquele servidor, o painel mostra o Guild ID sem impedir as outras métricas.

---

## Apontar, desenhar e dar zoom na tela

Quem assiste não fica só olhando. Passando o mouse sobre a tela em destaque
aparece uma barrinha no alto, com o que dá para fazer:

| Ferramenta   | Atalho | O que faz                                                                                              |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------ |
| **Mover**    | `V`    | Arrasta a imagem depois de ampliada.                                                                   |
| **Laser**    | `L`    | Um ponto luminoso com o seu nome, que todo mundo vê seguir o seu mouse. Some sozinho quando você para. |
| **Desenhar** | `C`    | Risca por cima da tela. O traço fica lá até alguém apagar.                                             |

E ao lado: o **olho** (`O`), que esconde todos os desenhos — **só para você**,
para dar uma olhada limpa no que está embaixo; ninguém mais perde nada, e o que
desenharem enquanto estiver escondido aparece quando você abrir o olho de novo.
Depois: desfazer o seu último traço (`Ctrl+Z`), apagar tudo o que **você**
desenhou, mandar a tela para uma janela flutuante (logo abaixo), e o zoom —
`+`, `−` e `0` para voltar ao normal.

**Zoom** também pela roda do mouse (ou dois dedos, no touch). Ele aproxima onde
o cursor está, não o centro. Duplo clique volta ao tamanho normal.

O zoom é **só seu**: ampliar aqui não mexe na tela de mais ninguém. Já o laser e
o desenho são de todo mundo.

### E quem está mostrando a tela?

Vê tudo, e também desenha. A tela dele aparece no palco assim que ele começa a
transmitir, sem precisar pedir para assistir — a imagem vem direto da captura,
não pela internet, então não gasta banda nem chega atrasada. As marcações dos
outros aparecem por cima dela, e a mesma barra de ferramentas está lá para ele
responder: circular, apontar, apagar.

Quando a captura roda numa aba separada (que é o caminho quando o Discord não
deixa capturar dentro da atividade), as marcações também aparecem sobre o vídeo
daquela aba, com uma linha dizendo quem está marcando.

### Ver as marcações sem voltar para o Discord

O caso real: você está compartilhando, alguém circula uma linha do seu código, e
você está no editor — com o Discord atrás de tudo.

Para isso existe o botão **"Manter numa janela por cima de tudo"**, na barra da
tela (e **"Ver por cima de tudo"**, na aba de captura). Ele abre uma janelinha
do próprio sistema, daquelas de vídeo flutuante, que **fica acima dos outros
programas**: a sua tela dentro dela, e o que estiverem desenhando por cima. Você
continua trabalhando e vê a seta aparecer no canto.

Dá para arrastar e redimensionar a janela como qualquer outra, e o mesmo botão a
fecha.

> **O que não dá:** desenhar direto no seu desktop, por cima dos programas de
> verdade. Nenhuma página da web consegue pintar fora da própria janela — é uma
> trava do navegador, não uma escolha deste programa. Só um aplicativo instalado
> faria isso, e a janela flutuante é o mais perto que se chega sem instalar
> nada.

> Compartilhando a **tela inteira**, a janela flutuante faz parte da tela e
> aparece dentro de si mesma, em miniatura. Compartilhando **uma janela só**,
> isso não acontece.

> O botão só aparece onde o navegador oferece o recurso. Dentro do Discord a
> permissão depende do cliente; se ele não estiver lá, a aba de captura tem o
> mesmo botão.

Quem chega no meio encontra o que já está desenhado. Quem está mostrando a tela,
e quem criou a sala, ganham um botão a mais na barra: **limpar os desenhos de
todo mundo**. Trocar a tela compartilhada também limpa.

> Numa janela bem estreita a barra encolhe e a paleta de cores sai de cena — a
> cor que estava escolhida continua valendo.

---

## Quadro branco

O botão do quadrinho na barra de baixo — ou a tecla **Q** — troca as telas por
uma folha em branco. Todo mundo na sala desenha nela ao mesmo tempo, com as
mesmas ferramentas da tela: caneta, laser, cores, espessura, desfazer.

A folha é a mesma para todo mundo. Quem está no celular deitado e quem está num
monitor largo veem o traço no mesmo lugar — a folha tem proporção fixa, e é ela
que serve de referência, não o tamanho da janela de cada um.

Quem chega no meio encontra o que já está desenhado. **Q** de novo, ou Esc,
volta para as telas — e o que estava no quadro continua lá.

> Enquanto o quadro está aberto você não baixa a tela de ninguém. É de
> propósito: você não está olhando para ela, e a banda faz falta em outro lugar.
> Ao voltar, o que estiver no ar volta sozinho.

Quem criou a sala tem o botão de **limpar o quadro de todo mundo**. Apagar o que
você mesmo desenhou não pede permissão a ninguém.

---

## Compartilhando com som

O som é sempre pedido — não há nada para ligar antes. Na janela que o navegador
abre, **escolha uma aba** e marque a caixinha de áudio que aparece lá embaixo.

### Por que só aba?

Se você escolher a tela inteira, o computador entrega **todo** o som que está
tocando — inclusive o do Discord. Aí todo mundo na call escuta a própria voz de
volta, com atraso. É insuportável em segundos.

Nenhum navegador consegue tirar um programa específico dessa captura: o som vem
misturado, é tudo ou nada. Por isso, na tela inteira o navegador nem oferece a
caixinha de áudio: a transmissão vai **sem som**.

### Quero mostrar a tela inteira E ter som

Dá. Clique na engrenagem e escolha **"Som de uma aba ou janela"**. O vídeo continua
sendo a tela inteira, e o som passa a vir da aba que você escolher — que é a
única fonte que não carrega o Discord junto.

Serve para YouTube, Twitch, jogo de navegador. Para um jogo instalado, cujo som
não está em aba nenhuma, não tem como — nem aqui nem em qualquer outro site.

Quem assiste passa o mouse no alto-falante da barra de baixo para ajustar o
volume, ou clica nele para silenciar.

> Som funciona no Chrome, Edge, Brave e Opera.

---

## Câmera: fundo e GIF

A câmera tem botão próprio na barra de baixo, ao lado do de compartilhar tela.
Ela abre na mesma aba de transmissão, e é lá que ficam os dois ajustes abaixo —
os dois valem **na hora**, com a câmera já no ar, sem derrubar quem assiste.

### Esconder o que está atrás de você

No campo **Fundo**:

- **Como está** — a câmera crua.
- **Desfocar** — borra o que está atrás.
- **Cor sólida** — cobre com a cor que você escolher.
- **Imagem ou GIF** — cobre com um arquivo do seu computador.

Duas coisas diferentes acontecem aqui, e vale saber qual você está usando.

Alguns sistemas (Windows Studio Effects, macOS recente) sabem separar você da
parede de verdade, e o navegador oferece isso como um botão. Onde esse recurso
existe, **Desfocar** usa ele, e a página diz isso na notinha embaixo — é o
resultado bom, igual ao do Zoom.

Onde ele não existe — Linux e boa parte dos computadores —, não dá para separar
pessoa de parede sem baixar um modelo de reconhecimento de vários megabytes, e
este programa não baixa nada. O que ele faz é geometria: mostra um **oval no
meio do quadro** e cobre todo o resto com o fundo escolhido. O cursor **Tamanho
do recorte** ajusta esse oval. Funciona bem se você estiver centralizado, e a
página avisa que é isso que está acontecendo, em vez de deixar você descobrir
ao vivo.

### Um GIF no lugar da câmera

No campo **Imagem**, escolha **GIF ou imagem** e selecione um arquivo. Ele entra
no lugar da webcam: para quem está na sala, aparece como a sua câmera, com o
rótulo "Câmera" e tudo. A webcam nem chega a ser ligada — nada de luzinha acesa.

Serve GIF, WebP animado, APNG, PNG e JPEG. O arquivo não sai do seu computador
como arquivo: ele é desenhado quadro a quadro e vai pela transmissão como
vídeo, igual à câmera.

> A animação continua rodando com a aba de transmissão em segundo plano, que é
> onde ela vai ficar enquanto você volta para o Discord.

---

## Deu errado?

**A atividade não abre, ou fica só um retângulo branco**
O endereço público mudou. Vá no site do Discord em **Activities → URL Mappings**
e troque o _Target_ pelo endereço que aparece na janela preta. Para isso não
acontecer nunca mais, rode `npm run tunel:criar`.

**"A porta 31415 já está sendo usada"**
Tem outra janela do programa aberta. Feche a outra e tente de novo.

**O botão de compartilhar abre uma aba e não acontece nada**
Essa aba precisa continuar aberta enquanto você transmite. Pode voltar para o
Discord normalmente, só não feche a aba.

**A transmissão parou sozinha dizendo que eu "saí da atividade"**
Você fechou a atividade, saiu do canal de voz ou perdeu a conexão com o Discord.
A aba de captura é uma janela comum do navegador e não fica sabendo de nada
disso sozinha — antes, ela continuava mandando a sua tela para uma sala que você
já tinha deixado. Agora o servidor percebe e encerra a captura por você, uns
quinze segundos depois. Recarregar a atividade não conta: esses segundos existem
justamente para um F5 não custar a transmissão.

**"npm não é reconhecido como um comando"**
O Node.js não foi instalado, ou a janela preta foi aberta antes da instalação.
Feche a janela, abra de novo e tente outra vez.

**Não sai som**
Abra o botão ⓘ na barra de baixo e olhe a linha **Som**. Ela diz em qual dos
casos você está: sem áudio na transmissão, esperando o áudio, silenciado aí, ou
tocando.

**A minha tela trava para as outras pessoas, ou aparece atrasada**
Quase sempre é a sua internet de subida não comportando a qualidade escolhida —
o plano de casa costuma subir bem menos do que baixa. Quando isso acontece, a
aba de captura avisa: _"Sua conexão não está dando conta de subir X Mb/s"_.
Baixe a qualidade ou a taxa de quadros na engrenagem e o aviso some.

Se o aviso não aparece e mesmo assim uma pessoa específica vê a tela travando,
é a internet **dela**. Cada pessoa recebe no seu ritmo, então uma travando não
significa nada sobre as outras.

**Quero mudar alguma configuração**
Rode `npm run configurar`. Ele lembra do que você já respondeu — é só apertar
Enter no que não mudou.

**A "Sala da call" não confere quem está no canal de voz**
Isso é opcional e só importa se você quer garantir que apenas quem está na call
consiga entrar. Precisa criar um bot no site do Discord e colar o token dele em
`DISCORD_BOT_TOKEN`, dentro do arquivo `.env`. Sem isso tudo funciona igual.

---

## Deixar no ar direto (sem seu computador ligado)

Você precisa de uma hospedagem que rode Node.js. Lá dentro:

1. Coloque o projeto e rode `npm install`.
2. Crie o arquivo `.env` com `npm run configurar`.
3. Troque, dentro do `.env`:
   - `NODE_ENV` para `production`
   - `PUBLIC_ORIGIN` para o endereço do seu site (ex: `https://tela.seusite.com`)
4. Rode `npm start`.

No site do Discord, troque o _Target_ e o _Redirect_ pelo endereço do seu site.
Aí nenhum túnel é necessário.

---

## Comandos, resumidos

| Comando                | Para quê                                                   |
| ---------------------- | ---------------------------------------------------------- |
| `npm install`          | Baixa o que o programa precisa. Só na primeira vez.        |
| `npm run start:fast`   | **Liga tudo.** Configura se faltar, e sobe numa janela só. |
| `npm run start:direto` | O mesmo, sem o menu: monta o site e sobe direto.           |
| `npm run tunel:criar`  | Uma vez só: cria um endereço fixo, que não muda mais.      |
| `npm run configurar`   | Refaz as perguntas da configuração.                        |
| `npm run smoke`        | Confere se está tudo funcionando por dentro.               |

Para quem mexe no código:

| Comando              | Para quê                                                        |
| -------------------- | --------------------------------------------------------------- |
| `npm run dev`        | Site, servidor e túnel juntos, remontando a cada arquivo salvo. |
| `npm run dev:rapido` | O mesmo, mas com endereço descartável e sem tocar no `.env`.    |
| `npm start`          | Monta o site e sobe só o servidor, sem túnel.                   |
| `npm run tunel`      | Só o túnel, numa janela separada.                               |

---

## O que ainda não dá

- **Compartilhar do celular.** Nenhum navegador de celular permite.
- **Separar você do fundo em qualquer computador.** Onde o sistema não oferece
  isso pronto, o que existe aqui é o recorte oval (veja "Câmera: fundo e GIF").
  Fazer de verdade exigiria baixar um modelo de reconhecimento, e este programa
  não baixa nada.
- **Som de programa instalado** em tela cheia. Só som de aba (veja acima).
- **Muita gente ao mesmo tempo.** Cada pessoa assistindo consome a qualidade
  escolhida, inteira. Em 2,5 Mb/s, cinco pessoas já são 12,5 Mb/s de subida; em
  8 Mb/s, são 40.
- **60 fps em qualquer computador.** Se o navegador não tiver codificação por
  hardware, ele não dá conta de 60 quadros em tela grande e entrega menos. A
  página de captura avisa quando isso acontece.
- **Mais de 4 telas ao mesmo tempo** na mesma sala.

Se você mexe em código e quer entender as decisões por trás disso,
veja [docs/como-funciona.md](docs/como-funciona.md).
