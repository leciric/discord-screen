/**
 * Configuração do pm2 no VPS.
 *
 * `.cjs` e não `.js` porque o `package.json` deste projeto declara
 * `"type": "module"`: num pacote ESM, um `ecosystem.config.js` com
 * `module.exports` morre com "module is not defined" antes de o pm2 chegar a
 * ler qualquer coisa. A extensão é o que devolve o arquivo ao CommonJS.
 *
 * O deploy é o `git push deploy main`, e quem chama isto é o hook
 * `post-receive` do repositório bare — veja infra/post-receive.
 */
module.exports = {
  apps: [
    {
      name: 'discord-screen',
      script: 'server/index.js',
      cwd: '/opt/discord-screen',

      // Um processo só, em fork. Não é economia: as salas, os tokens e a
      // lista de quem está assistindo vivem na memória do processo
      // (server/rooms.js), e o relay de vídeo é um WebSocket aberto entre
      // quem transmite e quem assiste. Em cluster mode o pm2 abriria um
      // worker por núcleo, cada um com o seu conjunto de salas — quem
      // transmite cairia num worker e quem assiste em outro, e a sala
      // simplesmente não existiria para o segundo.
      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,

      // O relay segura os quadros em memória enquanto os repassa. 1 GB é
      // folgado para o uso normal e ainda assim reinicia antes de o VPS
      // começar a usar swap.
      max_memory_restart: '1G',

      time: true,
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',

      // O resto da configuração vem do .env, que o servidor lê sozinho
      // (server/index.js chama o dotenv apontando para a raiz do projeto).
      // Ele não está no git — mora só no VPS, com chmod 600.
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
