/**
 * O mesmo servidor, agora com tudo configurado: aplicação do Discord, token de
 * bot e painel administrativo ligado.
 *
 * Arquivo separado do `index.test.js` porque essas decisões são tomadas no
 * corpo do módulo, uma vez: com o painel ligado ou desligado, é outro servidor.
 * O endereço público é https aqui de propósito — é o que faz o cookie de sessão
 * sair com `Secure`, e isso não dá para testar na mesma instância que o testa
 * sem.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '123456789012345678';
const SEGUNDO = '222222222222222222';
const OUTRO = '987654321098765432';

// Dois IDs separados por vírgula: o painel costuma ter mais de um dono, e por
// muito tempo só o primeiro entrava.
process.env.DISCORD_ADMIN_ID = `${ADMIN}, ${SEGUNDO}`;
process.env.DISCORD_CLIENT_ID = '111111111111111111';
process.env.DISCORD_CLIENT_SECRET = 'segredo-da-aplicacao';
process.env.DISCORD_BOT_TOKEN = 'token-do-bot';
process.env.PUBLIC_ORIGIN = 'https://exemplo.test';
// A página de estado com a porta fechada: entra quem tem conta do Discord E
// está neste servidor. É a configuração de quem publicou o endereço.
process.env.DISCORD_GUILD_ID = '555555555555555555';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const fetchReal = globalThis.fetch;
const { server, wss } = await import('./index.js');
const { signToken } = await import('./tokens.js');
if (!server.listening) await new Promise((pronto) => server.once('listening', pronto));
const base = `http://127.0.0.1:${server.address().port}`;

/** Rotas externas fingidas, na ordem em que foram registradas. */
let externas = [];
const finge = (padrao, responder) => externas.push([padrao, responder]);

vi.stubGlobal('fetch', async (url, init) => {
  const alvo = String(url);
  for (const [padrao, responder] of externas) {
    const bate = padrao instanceof RegExp ? padrao.test(alvo) : alvo.startsWith(padrao);
    if (bate) return responder(alvo, init);
  }
  if (alvo.startsWith(base)) return fetchReal(url, init);
  throw new Error(`chamada externa não prevista: ${alvo}`);
});

const json = (corpo, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

const post = (caminho, corpo, init = {}) =>
  fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo ?? {}),
    redirect: 'manual',
    ...init,
  });

const get = (caminho, init) => fetch(`${base}${caminho}`, { redirect: 'manual', ...init });

const comoAdmin = (uid = ADMIN) => ({
  Cookie: `discord_screen_admin=${signToken({ scope: 'admin', uid, name: 'Admin' }, 3600)}`,
});

/** O perfil que o Discord devolveria para o access_token deste teste. */
const perfil =
  (id, extra = {}) =>
  () =>
    json({ id, global_name: 'Alice', ...extra });

beforeEach(() => {
  externas = [];
});

afterAll(async () => {
  wss.close();
  await new Promise((pronto) => server.close(pronto));
});

describe('/api/token', () => {
  it('troca o código pelo access_token, sem o secret sair daqui', async () => {
    let corpoEnviado = null;
    finge('https://discord.com/api/oauth2/token', (_url, init) => {
      corpoEnviado = String(init.body);
      return json({ access_token: 'tok', refresh_token: 'nao-deveria-vazar' });
    });

    const resposta = await post('/api/token', { code: 'abc' });

    expect(await resposta.json()).toEqual({ access_token: 'tok' });
    expect(corpoEnviado).toContain('client_secret=segredo-da-aplicacao');
  });

  it('recusa quando a atividade é de outra aplicação', async () => {
    const resposta = await post('/api/token', { code: 'abc', client_id: '222222222222222222' });

    expect(resposta.status).toBe(409);
    expect((await resposta.json()).error).toMatch(/precisam ser a mesma/);
  });

  it('repassa o motivo do Discord, que separa secret errado de código usado', async () => {
    finge('https://discord.com/api/oauth2/token', () =>
      json({ error: 'invalid_client', error_description: 'client credentials invalid' }),
    );

    const resposta = await post('/api/token', { code: 'abc' });

    expect(resposta.status).toBe(401);
    expect((await resposta.json()).error).toContain('client credentials invalid');
  });

  it('culpa o Discord quando a troca do codigo explode', async () => {
    finge('https://discord.com/api/oauth2/token', () => {
      throw new Error('rede fora');
    });

    const resposta = await post('/api/token', { code: 'abc' });

    expect(resposta.status).toBe(502);
    expect((await resposta.json()).error).toMatch(/Tente de novo/);
  });
});

describe('presença na call, confirmada pelo bot', () => {
  const GUILD = '100000000000000001';
  const CANAL = '200000000000000001';

  function comVoz(resposta, guild = GUILD) {
    finge(new RegExp(`/guilds/${guild}/voice-states/`), resposta);
    finge(new RegExp(`/guilds/${guild}$`), () => json({ name: 'Servidor' }));
    finge('https://discord.com/api/users/@me', perfil(ADMIN));
  }

  const abrir = (guild = GUILD, channel = CANAL) =>
    post('/api/session', {
      access_token: 'tok',
      instance_id: 'i',
      guild_id: guild,
      channel_id: channel,
    });

  it('carimba a call no token quando o Discord confirma', async () => {
    comVoz(() => json({ channel_id: CANAL }));

    const corpo = await (await abrir()).json();

    expect(corpo.call).toBe(CANAL);
    expect(corpo.guildName).toBe('Servidor');
  });

  it('barra quem não está na call', async () => {
    const guild = '100000000000000002';
    comVoz(() => json({ channel_id: 'outro-canal' }), guild);

    const resposta = await abrir(guild);

    expect(resposta.status).toBe(403);
    expect((await resposta.json()).error).toMatch(/Entre na call/);
  });

  it('404 sem estado de voz é ausência: barra', async () => {
    const guild = '100000000000000003';
    comVoz(() => json({ code: 10026 }, 404), guild);

    expect((await abrir(guild)).status).toBe(403);
  });

  it('mas "bot fora do servidor" não é ausência: deixa entrar sem confirmar', async () => {
    const guild = '100000000000000004';
    comVoz(() => json({ code: 10004 }, 404), guild);

    const corpo = await (await abrir(guild)).json();

    expect(corpo.call).toBeNull();
    expect(corpo.guild).toBe(guild);
  });

  it('erro do Discord não tranca todo mundo para fora', async () => {
    const guild = '100000000000000005';
    comVoz(() => json({}, 500), guild);

    const corpo = await (await abrir(guild)).json();

    expect(corpo.call).toBeNull();
  });

  it('falha de rede também não tranca', async () => {
    const guild = '100000000000000006';
    comVoz(() => {
      throw new Error('sem resposta');
    }, guild);

    expect((await abrir(guild)).status).toBe(200);
  });
});

describe('nome do servidor', () => {
  it('é perguntado uma vez e guardado por uma hora', async () => {
    const guild = '300000000000000001';
    let idas = 0;
    finge(new RegExp(`/guilds/${guild}/voice-states/`), () => json({ channel_id: 'x' }));
    finge(new RegExp(`/guilds/${guild}$`), () => {
      idas++;
      return json({ name: 'Servidor' });
    });
    finge('https://discord.com/api/users/@me', perfil(ADMIN));

    const abrir = () =>
      post('/api/session', { access_token: 'tok', instance_id: 'i', guild_id: guild });
    await abrir();
    await abrir();

    expect(idas).toBe(1);
  });

  it('vira null quando o bot não enxerga o servidor', async () => {
    const guild = '300000000000000002';
    finge(new RegExp(`/guilds/${guild}$`), () => json({ message: 'Unknown Guild' }, 403));
    finge('https://discord.com/api/users/@me', perfil(ADMIN));

    const corpo = await (
      await post('/api/session', { access_token: 'tok', instance_id: 'i', guild_id: guild })
    ).json();

    expect(corpo.guildName).toBeNull();
  });

  it('vira null quando a chamada falha', async () => {
    const guild = '300000000000000003';
    finge(new RegExp(`/guilds/${guild}$`), () => {
      throw new Error('sem resposta');
    });
    finge('https://discord.com/api/users/@me', perfil(ADMIN));

    const corpo = await (
      await post('/api/session', { access_token: 'tok', instance_id: 'i', guild_id: guild })
    ).json();

    expect(corpo.guildName).toBeNull();
  });
});

describe('login administrativo', () => {
  it('manda ao Discord com um state assinado', async () => {
    const destino = new URL((await get('/admin/auth/login')).headers.get('location'));

    expect(destino.hostname).toBe('discord.com');
    expect(destino.searchParams.get('redirect_uri')).toBe('https://exemplo.test/auth/callback');
    expect(destino.searchParams.get('state')).toBeTruthy();
  });

  const stateAdmin = () => signToken({ scope: 'oauth-state', target: 'admin' }, 600);

  it('recusa uma conta que não é a do painel', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    finge('https://discord.com/api/users/@me', perfil(OUTRO));

    const resposta = await get(`/auth/callback?code=abc&state=${stateAdmin()}`);

    expect(resposta.headers.get('location')).toBe('/admin?error=forbidden');
  });

  it('emite o cookie de sessão, marcado Secure em https', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    finge('https://discord.com/api/users/@me', perfil(ADMIN));

    const resposta = await get(`/auth/callback?code=abc&state=${stateAdmin()}`);
    const cookie = resposta.headers.get('set-cookie');

    expect(resposta.headers.get('location')).toBe('/admin');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('erros do fluxo voltam para o painel, não para a página inicial', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ error: 'invalid_grant' }));

    const resposta = await get(`/auth/callback?code=abc&state=${stateAdmin()}`);

    expect(resposta.headers.get('location')).toBe('/admin?error=troca_falhou');
  });

  it('perfil que não vem também volta para o painel', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    finge('https://discord.com/api/users/@me', () => json({}));

    const resposta = await get(`/auth/callback?code=abc&state=${stateAdmin()}`);

    expect(resposta.headers.get('location')).toBe('/admin?error=perfil_falhou');
  });
});

describe('/api/admin/me', () => {
  it('recusa sem cookie', async () => {
    const resposta = await get('/api/admin/me');

    expect(resposta.status).toBe(401);
    expect(await resposta.json()).toMatchObject({ configured: true });
  });

  it('recusa a sessão de outra conta do Discord', async () => {
    expect((await get('/api/admin/me', { headers: comoAdmin(OUTRO) })).status).toBe(401);
  });

  it('aceita o segundo ID da lista, não só o primeiro', async () => {
    const resposta = await get('/api/admin/me', { headers: comoAdmin(SEGUNDO) });

    expect(resposta.status).toBe(200);
    expect((await resposta.json()).user.id).toBe(SEGUNDO);
  });

  it('recusa um cookie que não é sessão de painel', async () => {
    const disfarce = signToken({ scope: 'identity', uid: ADMIN }, 600);

    const resposta = await get('/api/admin/me', {
      headers: { Cookie: `discord_screen_admin=${disfarce}` },
    });

    expect(resposta.status).toBe(401);
  });

  it('identifica quem está no painel', async () => {
    const corpo = await (await get('/api/admin/me', { headers: comoAdmin() })).json();

    expect(corpo).toMatchObject({ configured: true, user: { id: ADMIN, name: 'Admin' } });
  });

  it('atravessa um cabeçalho com vários cookies', async () => {
    const { Cookie } = comoAdmin();

    const resposta = await get('/api/admin/me', {
      headers: { Cookie: `outro=1; ${Cookie}; mais=2` },
    });

    expect(resposta.status).toBe(200);
  });

  it('ignora um cookie sem valor', async () => {
    expect((await get('/api/admin/me', { headers: { Cookie: 'sozinho' } })).status).toBe(401);
  });
});

describe('/api/admin/metrics', () => {
  it('recusa sem sessão, e não deixa a resposta ser cacheada', async () => {
    const resposta = await get('/api/admin/metrics');

    expect(resposta.status).toBe(401);
    expect(resposta.headers.get('cache-control')).toBe('no-store');
  });

  it('entrega o painel inteiro, sem o segredo de sessão dentro', async () => {
    const resposta = await get('/api/admin/metrics', { headers: comoAdmin() });
    const painel = await resposta.json();

    expect(painel.configuration).toMatchObject({
      environment: 'test',
      adminIds: [ADMIN, SEGUNDO],
      botConfigured: true,
      sessionSecretConfigured: true,
      publicOrigin: 'https://exemplo.test',
    });
    expect(painel.summary).toHaveProperty('connections');
    expect(painel.system).toHaveProperty('platform');
    expect(JSON.stringify(painel)).not.toContain(process.env.SESSION_SECRET);
  });

  /**
   * O painel so sabia o que o servidor mandou. Todo problema deste programa
   * mora depois do ultimo byte entregue — no relogio do player, na fila do
   * decodificador, na CPU de quem assiste —, e esta e a unica parte da
   * resposta que olha para la.
   */
  it('leva junto como esta a imagem de quem assiste', async () => {
    const painel = await (await get('/api/admin/metrics', { headers: comoAdmin() })).json();

    expect(painel.clientes).toHaveProperty('espectadores');
    expect(painel.clientes).toHaveProperty('resumo');
    expect(Array.isArray(painel.clientes.espectadores)).toBe(true);
  });
});

describe('/api/admin/logs', () => {
  it('exige sessão de admin, como o resto do painel', async () => {
    expect((await get('/api/admin/logs')).status).toBe(401);
  });

  it('entrega o que o servidor registrou, com o id da última linha', async () => {
    const corpo = await (await get('/api/admin/logs', { headers: comoAdmin() })).json();

    expect(Array.isArray(corpo.eventos)).toBe(true);
    expect(corpo).toHaveProperty('ultimoId');
    // `desde` existe para a aba aberta não rebaixar as mesmas linhas a cada
    // dois segundos: pedir a partir da última já vista devolve nada.
    const seguinte = await (
      await get(`/api/admin/logs?desde=${corpo.ultimoId}`, { headers: comoAdmin() })
    ).json();
    expect(seguinte.eventos).toEqual([]);
  });
});

describe('/api/admin/tuning', () => {
  it('exige sessão de admin', async () => {
    expect((await post('/api/admin/tuning', { atrasoRelayMs: 700 })).status).toBe(401);
  });

  it('aplica o que cabe no limite e recusa o resto em silêncio', async () => {
    const corpo = await (
      await post(
        '/api/admin/tuning',
        // O segundo está abaixo do mínimo: aceitá-lo viraria um laço de
        // keyframe, que é o remédio entupindo o cano que ele deveria limpar.
        { atrasoRelayMs: 700, keyframeIntervaloMs: 5 },
        { headers: { 'Content-Type': 'application/json', ...comoAdmin() } },
      )
    ).json();

    expect(Object.keys(corpo.aplicadas)).toEqual(['atrasoRelayMs']);
    expect(corpo.ajustes.atrasoRelayMs).toBe(700);
    expect(corpo.ajustes.keyframeIntervaloMs).toBe(1000);

    // Devolve ao padrão para não contaminar os testes seguintes.
    await post(
      '/api/admin/tuning',
      { atrasoRelayMs: 500 },
      { headers: { 'Content-Type': 'application/json', ...comoAdmin() } },
    );
  });
});

describe('/api/admin/acoes', () => {
  it('exige sessão de admin', async () => {
    expect((await post('/api/admin/acoes/keyframe', { room: 'x' })).status).toBe(401);
  });

  it('recusa sala que não existe, em vez de fingir que fez', async () => {
    const resposta = await post(
      '/api/admin/acoes/keyframe',
      { room: 'nao-existe' },
      { headers: { 'Content-Type': 'application/json', ...comoAdmin() } },
    );

    expect(resposta.status).toBe(404);
  });

  /**
   * O link de assistir, que é a resposta para "estão reclamando de uma tela e
   * eu não estou no canal de voz".
   *
   * A sala da call não tem convite — o `/convite/:sala` é recusado para ela —,
   * então quem administra a máquina era justamente quem não conseguia olhar a
   * imagem de que estavam reclamando.
   */
  describe('ingresso', () => {
    it('devolve um link que entra na sala, carimbado com quem pediu', async () => {
      const dono = await (await post('/api/session-dev', { instance_id: 'i', name: 'Leo' })).json();
      const sala = await (
        await post('/api/rooms/create', { identity: dono.identity, name: 'Sala' })
      ).json();

      const corpo = await (
        await post(
          '/api/admin/acoes/ingresso',
          { room: sala.roomId },
          { headers: { 'Content-Type': 'application/json', ...comoAdmin() } },
        )
      ).json();

      const url = new URL(corpo.url);
      expect(url.origin).toBe('https://exemplo.test');
      expect(url.pathname).toBe('/');

      // O ingresso é o mesmo token de espectador que a atividade produz, e o
      // `/api/rooms/open` o aceita — é isso que faz o link funcionar.
      const aberta = await (
        await post('/api/rooms/open', { token: url.searchParams.get('t') })
      ).json();
      expect(aberta.roomId).toBe(sala.roomId);

      // Carimbado com quem pediu: repassar o link faria a outra pessoa aparecer
      // na sala com o nome de quem está no painel, e isso precisa ser sabido.
      const [carga] = url.searchParams.get('t').split('.');
      const payload = JSON.parse(Buffer.from(carga, 'base64url').toString());
      expect(payload).toMatchObject({ room: sala.roomId, name: 'Admin', role: 'viewer' });
    });

    it('exige sessão de admin como todas as outras', async () => {
      expect((await post('/api/admin/acoes/ingresso', { room: 'x' })).status).toBe(401);
    });
  });
});

describe('/api/config', () => {
  it('entrega o Client ID, que é público, e nunca o secret', async () => {
    const corpo = await (await get('/api/config')).json();

    expect(corpo.clientId).toBe('111111111111111111');
    expect(JSON.stringify(corpo)).not.toContain('segredo-da-aplicacao');
  });
});

describe('/api/admin/logout', () => {
  it('apaga o cookie, também marcado Secure em https', async () => {
    const cookie = (await post('/api/admin/logout')).headers.get('set-cookie');

    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Secure');
  });
});

/**
 * A porta da página de estado.
 *
 * Ela mostra nome e foto de quem está online agora, e por isso não é aberta: a
 * conta prova quem é, e a lista de servidores do Discord prova que é gente da
 * casa. As duas provas vêm do Discord — nada disso é enviado pelo navegador, e
 * o que o navegador enviasse não valeria nada.
 */
describe('página de estado', () => {
  const GUILD = '555555555555555555';
  const stateStatus = (voltar = null) =>
    signToken({ scope: 'oauth-state', target: 'servidor', voltar }, 600);

  const comoVisitante = (extra = {}) => ({
    Cookie: `discord_screen_status=${signToken(
      { scope: 'status', uid: '4', name: 'Vera', guild: GUILD, guildName: 'Casa', ...extra },
      3600,
    )}`,
  });

  it('pede o escopo de guilds no login, que é o que permite a checagem', async () => {
    const destino = new URL((await get('/servidor/auth/login')).headers.get('location'));

    expect(destino.hostname).toBe('discord.com');
    expect(destino.searchParams.get('scope')).toBe('identify guilds');
  });

  it('deixa entrar quem está no servidor, e emite o cookie', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    finge('https://discord.com/api/users/@me/guilds', () => json([{ id: GUILD, name: 'Casa' }]));
    finge('https://discord.com/api/users/@me', perfil(OUTRO));

    const resposta = await get(`/auth/callback?code=abc&state=${stateStatus()}`);

    expect(resposta.headers.get('location')).toBe('/servidor');
    expect(resposta.headers.get('set-cookie')).toContain('discord_screen_status=');
    expect(resposta.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('recusa quem tem conta mas não está no servidor', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    finge('https://discord.com/api/users/@me/guilds', () => json([{ id: '9', name: 'Outra' }]));
    finge('https://discord.com/api/users/@me', perfil(OUTRO));

    const resposta = await get(`/auth/callback?code=abc&state=${stateStatus()}`);

    expect(resposta.headers.get('location')).toBe('/servidor?error=fora');
    expect(resposta.headers.get('set-cookie')).toBeNull();
  });

  it('volta para onde o convite apontava, e só para dentro deste site', async () => {
    finge('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    finge('https://discord.com/api/users/@me/guilds', () => json([{ id: GUILD }]));
    finge('https://discord.com/api/users/@me', perfil(OUTRO));

    const dentro = await get(`/auth/callback?code=abc&state=${stateStatus('/?sala=abc')}`);
    expect(dentro.headers.get('location')).toBe('/?sala=abc');

    // "//outro.site" é URL absoluta para o navegador: sem a recusa, este
    // parâmetro seria um redirect aberto com o nosso domínio na barra.
    const fora = await get(`/auth/callback?code=abc&state=${stateStatus('//outro.site')}`);
    expect(fora.headers.get('location')).toBe('/servidor');
  });

  it('não conta nada a quem não entrou', async () => {
    const resposta = await get('/api/publico');

    expect(resposta.status).toBe(401);
    expect(await resposta.json()).toMatchObject({ error: 'login_required' });
  });

  it('conta o que está acontecendo a quem entrou', async () => {
    const resposta = await get('/api/publico', { headers: comoVisitante() });

    expect(resposta.status).toBe(200);
    const corpo = await resposta.json();
    expect(corpo.ok).toBe(true);
    expect(Array.isArray(corpo.salas)).toBe(true);
    expect(corpo.resumo).toHaveProperty('pessoas');
  });

  it('aceita o cookie do painel: quem administra já provou mais do que isto', async () => {
    expect((await get('/api/publico', { headers: comoAdmin() })).status).toBe(200);
  });

  it('diz quem está olhando, para a página desenhar o cabeçalho', async () => {
    const corpo = await (await get('/api/servidor/me', { headers: comoVisitante() })).json();

    expect(corpo).toMatchObject({ ligado: true, aberto: false, servidor: 'Casa' });
    expect(corpo.user.name).toBe('Vera');
  });

  it('sem sessão, diz o que falta em vez de só recusar', async () => {
    const resposta = await get('/api/servidor/me');

    expect(resposta.status).toBe(401);
    expect(await resposta.json()).toMatchObject({
      error: 'login_required',
      aplicacao: true,
      exigeServidor: true,
    });
  });

  it('o logout apaga o cookie', async () => {
    const resposta = await post('/api/servidor/logout');

    expect(resposta.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  /**
   * Entrar, pelo navegador, numa sala que nasceu no Discord.
   *
   * A página lista essas salas e nunca publica o id delas — ele é derivado do
   * canal de voz e não é nosso para publicar. O que ela publica é a chave
   * opaca, e é dela que sai o ingresso: a porta desta rota é a porta desta
   * página, e nada além dela.
   */
  describe('/api/publico/entrar', () => {
    /** Uma sala nascida "no Discord", que é a que não tem id publicado. */
    async function salaDoDiscord({ nome = 'Sala do canal', password = null } = {}) {
      const dono = await (
        await post('/api/session-dev', { instance_id: 'canal-9', name: 'Leo' })
      ).json();
      const sala = await (
        await post('/api/rooms/create', { identity: dono.identity, name: nome, password })
      ).json();

      // O `/api/publico` guarda a resposta por um segundo — duas travessias
      // das salas por segundo seria o custo de nada. Uma sala criada agora
      // aparece na volta seguinte, e é isso que este laço espera.
      let publica = null;
      for (let i = 0; i < 20 && !publica; i++) {
        const estado = await (await get('/api/publico', { headers: comoVisitante() })).json();
        publica = estado.salas.find((s) => s.nome === nome) ?? null;
        if (!publica) await new Promise((pronto) => setTimeout(pronto, 100));
      }
      return { ...sala, publica };
    }

    it('a sala do Discord aparece sem id e marcada como "abre por ingresso"', async () => {
      const { publica } = await salaDoDiscord({ nome: 'Sem id' });

      expect(publica.id).toBe(null);
      expect(publica.entravel).toBe(false);
      expect(publica.porIngresso).toBe(true);
      expect(publica.chave).toMatch(/^[0-9a-f]{12}$/);
    });

    it('troca a chave por um link que entra na sala', async () => {
      const { roomId, publica } = await salaDoDiscord({ nome: 'Com ingresso' });

      const corpo = await (
        await post(
          '/api/publico/entrar',
          { chave: publica.chave },
          { headers: { 'Content-Type': 'application/json', ...comoVisitante() } },
        )
      ).json();

      const url = new URL(corpo.url);
      const aberta = await (
        await post('/api/rooms/open', { token: url.searchParams.get('t') })
      ).json();
      expect(aberta.roomId).toBe(roomId);
    });

    it('sem passar pela porta desta página, não sai ingresso nenhum', async () => {
      const { publica } = await salaDoDiscord({ nome: 'Sem sessao' });

      const resposta = await post('/api/publico/entrar', { chave: publica.chave });

      expect(resposta.status).toBe(401);
      expect(await resposta.json()).toMatchObject({ error: 'login_required' });
    });

    it('a senha da sala continua valendo, que é a única escolhida pelo dono', async () => {
      const { publica } = await salaDoDiscord({ nome: 'Trancada', password: 'abc123' });

      const errada = await post(
        '/api/publico/entrar',
        { chave: publica.chave, senha: 'nope' },
        { headers: { 'Content-Type': 'application/json', ...comoVisitante() } },
      );
      expect(errada.status).toBe(403);

      const certa = await post(
        '/api/publico/entrar',
        { chave: publica.chave, senha: 'abc123' },
        { headers: { 'Content-Type': 'application/json', ...comoVisitante() } },
      );
      expect(certa.status).toBe(200);
    });

    it('chave que não é de sala nenhuma não vira ingresso', async () => {
      for (const chave of ['0'.repeat(12), '../../etc', '', null, 42]) {
        const resposta = await post(
          '/api/publico/entrar',
          { chave },
          { headers: { 'Content-Type': 'application/json', ...comoVisitante() } },
        );
        expect(resposta.status).toBe(404);
      }
    });
  });
});

/**
 * O convite: o link que se cola no Discord para quem não consegue entrar por lá.
 */
describe('/convite', () => {
  const comoVisitante = {
    Cookie: `discord_screen_status=${signToken({ scope: 'status', uid: '4', name: 'Vera' }, 3600)}`,
  };

  it('leva direto à sala quem já entrou', async () => {
    const resposta = await get('/convite/abc123', { headers: comoVisitante });

    expect(resposta.headers.get('location')).toBe('/?sala=abc123');
  });

  it('manda ao login quem não entrou, guardando a sala para depois', async () => {
    const resposta = await get('/convite/abc123');

    expect(resposta.headers.get('location')).toBe(
      '/servidor/auth/login?voltar=%2F%3Fsala%3Dabc123',
    );
  });

  it('recusa um id que não tem cara de sala, antes de virar destino', async () => {
    // O id vira o destino de um redirecionamento: o que não cabe no alfabeto
    // de uma sala não chega a virar Location nenhum.
    expect((await get('/convite/abc%20def')).status).toBe(400);
    expect((await get('/convite/%3Cscript%3E')).status).toBe(400);
  });
});
