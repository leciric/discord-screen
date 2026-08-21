# Hospedar num VPS

Este é o caminho recomendado para deixar a Sala de Tela no ar sem depender do
computador de ninguém. O programa é um relay de vídeo: a saída é
`bitrate × espectadores`, e isso não cabe bem em hospedagem compartilhada. Um
VPS pequeno — 1 vCPU, 2 GB, tráfego generoso — resolve por poucos euros ao mês.

O que **não** funciona bem, e por que este documento existe: PaaS com borda
própria (Square Cloud, e provavelmente outros) carimba
`X-Frame-Options: SAMEORIGIN` em toda resposta. O Discord embute a Activity num
iframe, o navegador obedece ao header, e o resultado é um retângulo branco sem
erro nenhum no log. Não há conserto pelo código: o proxy do Discord repassa
aquele header e substitui o nosso CSP pelo dele. Num VPS o problema não existe,
porque a borda é sua.

Assume Ubuntu 24.04. Em Debian é igual; em outras distribuições muda só o
gerenciador de pacotes.

## 1. Domínio

Um registro **A** apontando para o IP do VPS.

Se o domínio estiver na Cloudflare, deixe em **DNS only** (nuvem cinza). Não é
capricho: o proxy da Cloudflare no plano gratuito não é para tráfego de vídeo
(seção 2.8 dos termos deles), e ele acrescenta uma borda que você não controla
entre o Discord e o seu servidor — foi exatamente esse tipo de borda que
custou um dia de depuração.

## 2. Node

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node -v   # precisa ser 22 ou mais novo
```

Versão 22 ou superior porque o servidor usa `fetch` nativo e `--watch`.

## 3. Repositório de deploy

O código não é clonado do GitHub: ele chega por push. No servidor ficam duas
pastas — um repositório bare, que recebe o push, e a árvore de trabalho, que o
hook escreve.

```bash
sudo mkdir -p /opt/discord-screen.git /opt/discord-screen
sudo chown $USER:$USER /opt/discord-screen.git /opt/discord-screen
git init --bare -b main /opt/discord-screen.git
mkdir -p /opt/discord-screen/logs
```

O hook é o `infra/post-receive` deste repositório:

```bash
install -m 755 infra/post-receive /opt/discord-screen.git/hooks/post-receive
```

Ele precisa do bit de execução — um hook sem `+x` é ignorado em silêncio, e o
push parece ter dado certo sem nada acontecer do outro lado.

## 4. Configuração

O `.env` não vem no push (está no `.gitignore`), então ele é escrito uma vez, à
mão, no servidor:

```bash
cat > /opt/discord-screen/.env <<'EOF'
SESSION_SECRET=<hex de 64 caracteres>
PORT=31415
PUBLIC_ORIGIN=https://seu-dominio
NODE_ENV=production
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
EOF
chmod 600 /opt/discord-screen/.env
```

O segredo sai de `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

`PORT=31415` e não 80: quem atende na 80 e na 443 é o nginx, no passo 6. E o
`SESSION_SECRET` não é opcional aqui — com `NODE_ENV=production` o servidor
recusa subir sem ele, porque sem segredo os crachás de sala seriam forjáveis.

Use um segredo diferente do da sua máquina. Não é paranoia: são duas
instalações independentes, e um segredo vazado de um `.env` de
desenvolvimento não deveria valer como crachá em produção.

## 5. Serviço

O primeiro `git push deploy main` (veja "Atualizar", mais abaixo) já instala as
dependências, monta o site e sobe o processo no pm2. Depois disso, para o
processo voltar sozinho depois de um reboot:

```bash
pm2 save
pm2 startup      # e rode a linha que ele imprimir
```

## 6. nginx

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot
sudo cp infra/nginx/seesee.linting.dev.conf /etc/nginx/sites-available/seu-dominio
sudo ln -sf /etc/nginx/sites-available/seu-dominio /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

O certificado vem depois, porque o arquivo acima já aponta para ele e o nginx
não sobe com um `ssl_certificate` que não existe. A ordem que funciona é:
subir só o bloco da porta 80, pedir o certificado, e só então ligar o bloco
443.

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d seu-dominio
sudo nginx -t && sudo systemctl reload nginx
```

A renovação fica por conta do timer do systemd que o pacote instala
(`systemctl list-timers | grep certbot`). Ela usa a porta 80 — por isso o
bloco dela continua no ar depois que o HTTPS existe, redirecionando tudo que
não seja o desafio ACME.

O `proxy_read_timeout 1h` do bloco `/ws` não é exagero: uma transmissão fica
horas aberta e passa minutos sem tráfego quando a tela está parada. Com o
padrão de 60 segundos o nginx derruba o WebSocket no meio da apresentação, e o
sintoma é uma sala que congela sem erro nenhum.

## 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

A 31415 fica fechada de propósito: só o nginx fala com ela, pelo localhost.

## 8. Discord

No portal, em https://discord.com/developers/applications:

- **Activities → URL Mappings**: prefixo `/`, target `seu-dominio` (sem o `https://`)
- **OAuth2 → Redirects**: `https://seu-dominio/auth/callback`

Feche e reabra a Activity depois de salvar — o cliente do Discord guarda o
iframe e o mapeamento em cache.

## Atualizar: `git push deploy main`

O deploy é um push. Na sua máquina, uma vez:

```bash
git remote add deploy vps:/opt/discord-screen.git
```

O endereço é o apelido do `~/.ssh/config`, e não `ubuntu@ip`. Não é
preferência: com o IP cru o git abre o ssh sem a `IdentityFile` do apelido e a
conexão morre em `Permission denied (publickey)` — sem dizer que o problema era
a chave.

Daí em diante:

```bash
git push deploy main
```

O hook `post-receive` do repositório bare (versionado em `infra/post-receive`)
faz o resto: escreve a árvore em `/opt/discord-screen`, roda `npm ci`, monta o
site com o vite e recarrega o pm2. A saída de tudo isso volta pelo terminal do
push, então um deploy que falha falha à vista.

O `.env` não é tocado por nada disso: ele está no `.gitignore`, mora só no
servidor e o `git checkout -f` não mexe em arquivo que não rastreia.

### Por que pm2, e não o systemd

O VPS já roda outros processos por pm2, e um só lugar para olhar
(`pm2 list`, `pm2 logs`) vale mais do que a pureza de ter cada coisa no seu
próprio systemd. O `infra/sala-de-tela.service` continua no repositório para
quem preferir o contrário.

A configuração é o `ecosystem.config.cjs`, e a extensão `.cjs` é obrigatória:
o `package.json` declara `"type": "module"`, e num pacote ESM um
`ecosystem.config.js` com `module.exports` morre em "module is not defined"
antes de o pm2 ler o arquivo.

Um processo só, em modo fork. As salas, os tokens e a lista de espectadores
vivem na memória do processo — em cluster mode quem transmite cairia num
worker e quem assiste em outro, e a sala não existiria para o segundo.

## Desenvolver depois que a produção existe

Com o DNS apontando para o VPS, o túnel de endereço fixo da sua máquina deixa
de valer: `seesee.linting.dev` agora é o servidor, não o seu notebook. Para
desenvolver, use o túnel descartável:

```bash
npm run dev -- --rapido
```

Ou crie um segundo endereço só para isso — `npm run tunel:criar dev.seu-dominio` —
e aí `npm run dev` volta a ter endereço fixo, sem disputar com a produção.

## Quando algo der errado

```bash
pm2 logs discord-screen             # o servidor
pm2 describe discord-screen         # estado, reinícios, memória
sudo journalctl -u nginx -f         # o proxy
sudo tail -f /var/log/nginx/error.log
curl -sI https://seu-dominio | grep -i x-frame   # veja abaixo
```

Aquele `curl` é o teste que faltou fazer cedo demais neste projeto: se aparecer
um `x-frame-options: SAMEORIGIN`, a Activity vai abrir branca, e o problema
está em quem está na frente do servidor — não no código. O servidor manda um
`X-Frame-Options: ALLOWALL` de propósito, e o nginx desta configuração não
acrescenta nada por cima.
