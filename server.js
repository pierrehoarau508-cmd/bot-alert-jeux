require('dotenv').config();

const {
  Client, GatewayIntentBits,
  REST, Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');

const https = require('https');

// ── Helper HTTP ─────────────────────────────────────────────────────
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ...options, timeout: 8000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Jeux Roblox ─────────────────────────────────────────────────────
const GAMES = {
  volleyball: { name: 'Volleyball Legends',          id: 6900168517,  icon: '🏐', color: 0x3498db },
  basketball: { name: 'Basketball Legends',          id: 4552731030,  icon: '🏀', color: 0xe67e22 },
  tsb       : { name: 'The Strongest Battlegrounds', id: 13772394625, icon: '💪', color: 0xe74c3c },
  jjk       : { name: 'Jujutsu Shenanigans',         id: 15108547472, icon: '⚡', color: 0x9b59b6 },
  reelseas  : { name: 'Reel Seas',                   id: 17355261493, icon: '🎣', color: 0x1abc9c },
};

// ── API Roblox ───────────────────────────────────────────────────────
async function getRobloxStats(gameId) {
  try {
    const [details, votes] = await Promise.all([
      fetchJSON(`https://games.roblox.com/v1/games?universeIds=${gameId}`),
      fetchJSON(`https://games.roblox.com/v1/games/votes?universeIds=${gameId}`),
    ]);
    const g = details?.data?.[0];
    const v = votes?.data?.[0];
    if (!g) return null;
    return {
      name      : g.name,
      playing   : g.playing?.toLocaleString('fr-FR') || '0',
      visits    : g.visits?.toLocaleString('fr-FR') || '0',
      favs      : g.favoritedCount?.toLocaleString('fr-FR') || '0',
      likes     : v?.upVotes?.toLocaleString('fr-FR') || '0',
      dislikes  : v?.downVotes?.toLocaleString('fr-FR') || '0',
      maxPlayers: g.maxPlayers || '?',
      updated   : g.updated ? new Date(g.updated).toLocaleDateString('fr-FR') : '?',
      created   : g.created ? new Date(g.created).toLocaleDateString('fr-FR') : '?',
      url       : `https://www.roblox.com/games/${g.rootPlaceId || gameId}`,
    };
  } catch { return null; }
}

// Derniers badges ajoutés = indicateur de mise à jour
async function getRecentBadges(gameId) {
  try {
    const data = await fetchJSON(
      `https://badges.roblox.com/v1/universes/${gameId}/badges?limit=10&sortOrder=Desc`
    );
    return (data?.data || []).slice(0, 5).map(b => ({
      name       : b.name,
      description: b.description?.slice(0, 80) || '',
      created    : new Date(b.created).toLocaleDateString('fr-FR'),
    }));
  } catch { return []; }
}

// Derniers jeux créés par le développeur (pour détecter mises à jour)
async function getGameUpdates(gameId) {
  try {
    // On récupère l'historique des versions du jeu via l'API place
    const info = await fetchJSON(`https://games.roblox.com/v1/games?universeIds=${gameId}`);
    const g = info?.data?.[0];
    if (!g) return null;
    return {
      updated    : g.updated,
      updatedStr : new Date(g.updated).toLocaleString('fr-FR'),
      description: g.description?.slice(0, 300) || 'Aucune description.',
    };
  } catch { return null; }
}

// Serveurs actifs (pour estimer la popularité)
async function getActiveServers(placeId) {
  try {
    const data = await fetchJSON(
      `https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=10`
    );
    const servers = data?.data || [];
    const total   = servers.reduce((sum, s) => sum + (s.playing || 0), 0);
    return { count: servers.length, players: total };
  } catch { return null; }
}

// Récupère le placeId racine depuis l'universeId
async function getRootPlaceId(universeId) {
  try {
    const data = await fetchJSON(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
    return data?.data?.[0]?.rootPlaceId || null;
  } catch { return null; }
}

// ── Suivi automatique (fil actu) ─────────────────────────────────────
// Stocke la dernière date de mise à jour connue pour chaque jeu
const lastKnownUpdate = {};
let   trackingChannel = null;

async function checkForUpdates(discordClient) {
  const channelId = process.env.NEWS_CHANNEL_ID;
  if (!channelId) return;

  try {
    trackingChannel = await discordClient.channels.fetch(channelId);
  } catch { return; }

  for (const [key, game] of Object.entries(GAMES)) {
    try {
      const update = await getGameUpdates(game.id);
      if (!update) continue;

      const prev = lastKnownUpdate[key];
      if (prev && prev !== update.updated) {
        // Nouvelle mise à jour détectée !
        const stats = await getRobloxStats(game.id);
        const embed = new EmbedBuilder()
          .setTitle(`${game.icon} Mise à jour — ${game.name}`)
          .setURL(`https://www.roblox.com/games/${game.id}`)
          .setDescription(`**Le jeu vient d'être mis à jour !**\n\n${update.description}`)
          .setColor(game.color)
          .addFields(
            { name: '🕐 Mis à jour le',   value: update.updatedStr,                    inline: true },
            { name: '👥 En jeu',           value: stats?.playing || '?',               inline: true },
          )
          .setFooter({ text: 'Roblox • Fil d\'actualité automatique' })
          .setTimestamp();

        await trackingChannel.send({ content: `🔔 **Nouvelle mise à jour détectée sur ${game.name} !**`, embeds: [embed] });
      }
      lastKnownUpdate[key] = update.updated;
    } catch { /* silencieux */ }
  }
}

// ── Jeux gratuits Epic Games ─────────────────────────────────────────
async function getEpicFreeGames() {
  try {
    const data = await fetchJSON(
      'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=fr&country=FR&allowCountries=FR'
    );
    const games = data?.data?.Catalog?.searchStore?.elements || [];
    return games
      .filter(g => g.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0]?.discountSetting?.discountPercentage === 0)
      .map(g => {
        const promo = g.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
        return {
          title: g.title,
          url  : `https://store.epicgames.com/fr/p/${g.catalogNs?.mappings?.[0]?.pageSlug || ''}`,
          end  : promo?.endDate ? new Date(promo.endDate).toLocaleDateString('fr-FR') : '?',
        };
      });
  } catch { return null; }
}

// ── Jeux gratuits Steam ──────────────────────────────────────────────
async function getSteamFreeGames() {
  try {
    const data = await fetchJSON('https://store.steampowered.com/api/featuredcategories/?cc=FR&l=french');
    return (data?.specials?.items || [])
      .filter(g => g.final_price === 0 && g.original_price > 0)
      .slice(0, 5)
      .map(g => ({ title: g.name, url: `https://store.steampowered.com/app/${g.id}` }));
  } catch { return null; }
}

// ── Bot Discord ──────────────────────────────────────────────────────
const CMDS = [
  new SlashCommandBuilder()
    .setName('roblox')
    .setDescription('🎮 Stats en temps réel d\'un jeu Roblox')
    .addStringOption(o => o.setName('jeu').setDescription('Quel jeu ?').setRequired(true)
      .addChoices(
        { name: '🏐 Volleyball Legends',          value: 'volleyball' },
        { name: '🏀 Basketball Legends',          value: 'basketball' },
        { name: '💪 The Strongest Battlegrounds', value: 'tsb'        },
        { name: '⚡ Jujutsu Shenanigans',          value: 'jjk'        },
        { name: '🎣 Reel Seas',                    value: 'reelseas'   },
      )),

  new SlashCommandBuilder()
    .setName('actu')
    .setDescription('📰 Dernières infos & badges d\'un jeu Roblox')
    .addStringOption(o => o.setName('jeu').setDescription('Quel jeu ?').setRequired(true)
      .addChoices(
        { name: '🏐 Volleyball Legends',          value: 'volleyball' },
        { name: '🏀 Basketball Legends',          value: 'basketball' },
        { name: '💪 The Strongest Battlegrounds', value: 'tsb'        },
        { name: '⚡ Jujutsu Shenanigans',          value: 'jjk'        },
        { name: '🎣 Reel Seas',                    value: 'reelseas'   },
      )),

  new SlashCommandBuilder()
    .setName('serveurs')
    .setDescription('🌐 Serveurs actifs d\'un jeu Roblox')
    .addStringOption(o => o.setName('jeu').setDescription('Quel jeu ?').setRequired(true)
      .addChoices(
        { name: '🏐 Volleyball Legends',          value: 'volleyball' },
        { name: '🏀 Basketball Legends',          value: 'basketball' },
        { name: '💪 The Strongest Battlegrounds', value: 'tsb'        },
        { name: '⚡ Jujutsu Shenanigans',          value: 'jjk'        },
        { name: '🎣 Reel Seas',                    value: 'reelseas'   },
      )),

  new SlashCommandBuilder()
    .setName('epicgames')
    .setDescription('🎁 Jeux gratuits Epic Games cette semaine'),

  new SlashCommandBuilder()
    .setName('steam')
    .setDescription('🎁 Jeux gratuits Steam en ce moment'),

  new SlashCommandBuilder()
    .setName('drops')
    .setDescription('🎁 Twitch Drops actifs')
    .addStringOption(o => o.setName('jeu').setDescription('Jeu').setRequired(true)
      .addChoices(
        { name: '🔫 Valorant',  value: 'valorant'  },
        { name: '⛏️ Minecraft', value: 'minecraft' },
      )),

  new SlashCommandBuilder()
    .setName('suivijeux')
    .setDescription('📡 Active/désactive le fil d\'actu automatique dans ce salon'),

].map(c => c.toJSON());

const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

discordClient.once('ready', async () => {
  console.log(`✅ Bot connecté : ${discordClient.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: CMDS }
    );
    console.log('✅ Commandes enregistrées');
  } catch(e) { console.error('❌ Commandes:', e.message); }

  // Initialise les dates connues au démarrage
  for (const [key, game] of Object.entries(GAMES)) {
    const u = await getGameUpdates(game.id).catch(() => null);
    if (u) lastKnownUpdate[key] = u.updated;
  }
  console.log('✅ Suivi des mises à jour initialisé');

  // Vérifie les mises à jour toutes les 10 minutes
  setInterval(() => checkForUpdates(discordClient), 10 * 60 * 1000);
});

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  // ── /roblox ────────────────────────────────────────────────────────
  if (cmd === 'roblox') {
    const key  = interaction.options.getString('jeu');
    const game = GAMES[key];
    await interaction.deferReply();

    const stats = await getRobloxStats(game.id);
    if (!stats) return interaction.editReply('❌ API Roblox indisponible. Réessaie plus tard.');

    await interaction.editReply({ embeds: [
      new EmbedBuilder()
        .setTitle(`${game.icon} ${stats.name}`)
        .setURL(stats.url)
        .setColor(game.color)
        .addFields(
          { name: '👥 En jeu',        value: stats.playing,          inline: true },
          { name: '🔢 Visites',        value: stats.visits,           inline: true },
          { name: '❤️ Favoris',        value: stats.favs,             inline: true },
          { name: '👍 Likes',          value: stats.likes,            inline: true },
          { name: '👎 Dislikes',       value: stats.dislikes,         inline: true },
          { name: '👤 Max joueurs',    value: String(stats.maxPlayers), inline: true },
          { name: '📅 Créé le',        value: stats.created,          inline: true },
          { name: '🔄 Dernière MAJ',   value: stats.updated,          inline: true },
        )
        .setFooter({ text: 'Roblox API • Données en temps réel' })
        .setTimestamp()
    ]});
  }

  // ── /actu ──────────────────────────────────────────────────────────
  if (cmd === 'actu') {
    const key  = interaction.options.getString('jeu');
    const game = GAMES[key];
    await interaction.deferReply();

    const [update, badges, stats] = await Promise.all([
      getGameUpdates(game.id),
      getRecentBadges(game.id),
      getRobloxStats(game.id),
    ]);

    const embed = new EmbedBuilder()
      .setTitle(`${game.icon} Actualité — ${game.name}`)
      .setURL(`https://www.roblox.com/games/${game.id}`)
      .setColor(game.color)
      .setFooter({ text: 'Roblox • Données en temps réel' })
      .setTimestamp();

    if (update) {
      embed.setDescription(`**📝 Description du jeu**\n${update.description}`);
      embed.addFields({ name: '🔄 Dernière mise à jour', value: update.updatedStr, inline: true });
    }

    if (stats) {
      embed.addFields(
        { name: '👥 En jeu', value: stats.playing, inline: true },
        { name: '🔢 Visites', value: stats.visits,  inline: true },
      );
    }

    if (badges.length > 0) {
      const badgeText = badges.map(b => `🏅 **${b.name}** *(ajouté le ${b.created})*\n${b.description}`).join('\n\n');
      embed.addFields({ name: '🏅 Derniers badges ajoutés', value: badgeText.slice(0, 1020) });
    }

    await interaction.editReply({ embeds: [embed] });
  }

  // ── /serveurs ──────────────────────────────────────────────────────
  if (cmd === 'serveurs') {
    const key  = interaction.options.getString('jeu');
    const game = GAMES[key];
    await interaction.deferReply();

    const placeId = await getRootPlaceId(game.id);
    if (!placeId) return interaction.editReply('❌ Impossible de récupérer les infos de serveur.');

    const servers = await getActiveServers(placeId);
    const stats   = await getRobloxStats(game.id);

    await interaction.editReply({ embeds: [
      new EmbedBuilder()
        .setTitle(`${game.icon} Serveurs — ${game.name}`)
        .setURL(`https://www.roblox.com/games/${placeId}`)
        .setColor(game.color)
        .addFields(
          { name: '🌐 Serveurs publics',  value: String(servers?.count || '?'), inline: true },
          { name: '👥 Joueurs en jeu',    value: stats?.playing || '?',         inline: true },
          { name: '👤 Max/serveur',       value: String(stats?.maxPlayers || '?'), inline: true },
        )
        .setFooter({ text: 'Roblox API • En temps réel' })
        .setTimestamp()
    ]});
  }

  // ── /epicgames ─────────────────────────────────────────────────────
  if (cmd === 'epicgames') {
    await interaction.deferReply();
    const games = await getEpicFreeGames();

    const embed = new EmbedBuilder()
      .setTitle('🎁 Jeux gratuits Epic Games')
      .setURL('https://store.epicgames.com/fr/free-games')
      .setColor(0x2d2d2d)
      .setFooter({ text: 'Epic Games Store' })
      .setTimestamp();

    if (!games || games.length === 0) {
      embed.setDescription('Aucun jeu gratuit cette semaine.\n[Voir sur Epic Games](https://store.epicgames.com/fr/free-games)');
    } else {
      embed.setDescription(games.map(g => `🎮 **[${g.title}](${g.url})**\n⏰ Jusqu'au ${g.end}`).join('\n\n'));
    }
    await interaction.editReply({ embeds: [embed] });
  }

  // ── /steam ─────────────────────────────────────────────────────────
  if (cmd === 'steam') {
    await interaction.deferReply();
    const games = await getSteamFreeGames();

    const embed = new EmbedBuilder()
      .setTitle('🎁 Jeux gratuits Steam')
      .setURL('https://store.steampowered.com/search/?maxprice=free&specials=1')
      .setColor(0x1b2838)
      .setFooter({ text: 'Steam Store' })
      .setTimestamp();

    if (!games || games.length === 0) {
      embed.setDescription('Aucun jeu temporairement gratuit.\n[Voir sur Steam](https://store.steampowered.com/search/?maxprice=free&specials=1)');
    } else {
      embed.setDescription(games.map(g => `🎮 **[${g.title}](${g.url})**`).join('\n'));
    }
    await interaction.editReply({ embeds: [embed] });
  }

  // ── /drops ─────────────────────────────────────────────────────────
  if (cmd === 'drops') {
    const jeu = interaction.options.getString('jeu');
    const infos = {
      valorant : {
        icon: '🔫', color: 0xff4655, name: 'Valorant',
        desc: `**Comment obtenir des drops Valorant :**\n1. Lie ton compte Twitch à ton compte Riot sur [account.riotgames.com](https://account.riotgames.com)\n2. Regarde un streamer Valorant avec drops activés sur Twitch\n3. Récupère tes drops sur [twitch.tv/drops](https://www.twitch.tv/drops/campaigns)\n\n🔴 **[Voir les drops actifs](https://www.twitch.tv/drops/campaigns)**`,
      },
      minecraft: {
        icon: '⛏️', color: 0x5d8a3c, name: 'Minecraft',
        desc: `**Comment obtenir des drops Minecraft :**\n1. Lie ton compte Twitch à ton compte Microsoft/Xbox\n2. Regarde des streams Minecraft avec drops activés\n3. Récupère tes drops sur [twitch.tv/drops](https://www.twitch.tv/drops/campaigns)\n\n🔴 **[Voir les drops actifs](https://www.twitch.tv/drops/campaigns)**`,
      },
    };
    const d = infos[jeu];
    await interaction.reply({ embeds: [
      new EmbedBuilder()
        .setTitle(`${d.icon} Twitch Drops — ${d.name}`)
        .setURL('https://www.twitch.tv/drops/campaigns')
        .setDescription(d.desc)
        .setColor(d.color)
        .setFooter({ text: 'Twitch Drops' })
        .setTimestamp()
    ]});
  }

  // ── /suivijeux ─────────────────────────────────────────────────────
  if (cmd === 'suivijeux') {
    const channelId = interaction.channelId;
    // Met à jour NEWS_CHANNEL_ID dynamiquement en mémoire
    process.env.NEWS_CHANNEL_ID = channelId;
    // Initialise le suivi
    await checkForUpdates(discordClient);
    await interaction.reply({ embeds: [
      new EmbedBuilder()
        .setTitle('📡 Fil d\'actualité activé !')
        .setDescription(`Ce salon recevra automatiquement les notifications de mise à jour pour :\n\n🏐 Volleyball Legends\n🏀 Basketball Legends\n💪 The Strongest Battlegrounds\n⚡ Jujutsu Shenanigans\n🎣 Reel Seas\n\n⏰ Vérification toutes les **10 minutes**`)
        .setColor(0x2ecc71)
        .setFooter({ text: 'Bot GameInfo • Suivi automatique' })
        .setTimestamp()
    ]});
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN manquant dans .env');
  process.exit(1);
}

discordClient.login(process.env.DISCORD_TOKEN)
  .catch(e => { console.error('❌ Login:', e.message); process.exit(1); });
