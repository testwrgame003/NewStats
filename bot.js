const {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} = require("discord.js");
const { Redis } = require("@upstash/redis");

const TOKEN = process.env.LATIOS_TOKEN || process.env.DISCORD_TOKEN || process.env.TOKEN;

if (!TOKEN) {
  console.error("❌ Missing Bot Token (LATIOS_TOKEN / DISCORD_TOKEN)");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

// ================= GLOBAL CONFIGURATION =================

const CHAMPION_ROLE_ID = "1486206362332434634";
const LEGEND_ROLE_ID = "1564892157922254889";
const PUBLIC_ALERTS_CHANNEL_ID = "1488766924321198080";
const GLOBAL_HEARTBEAT_CHANNEL_ID = "1492795826857054301";
const PERSONAL_CATEGORY_ID = "1565623831203287150";

const FARM_MODE_KEY = "system:farm_mode";

// Solo Elite Four y Gym Leader
const GROUP_CONFIG = {
  Gym_Leader: {
    label: "Gym Leader",
    color: 0x3498db,
    heartbeatChannelId: "1491238609578360833",
    panelChannelId: "1495594175058673736"
  },
  Elite_Four: {
    label: "Elite Four",
    color: 0x9b59b6,
    heartbeatChannelId: "1483616146996465735",
    panelChannelId: "1488126321786753156"
  }
};

const UPDATE_PANEL_INTERVAL = 5 * 60 * 1000;
const STORE_PPM_INTERVAL = 60 * 60 * 1000;
const MASSIVE_PPM_THRESHOLD = 15.0;
const MASSIVE_ALERT_COOLDOWN = 2 * 60 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 30 * 60 * 1000;
const ZEKROM_HOST_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos máximo para Zekrom-Host

const massivePpmCooldowns = new Map();

// Cachés en memoria para ahorrar comandos de Upstash
const USERS_CACHE = new Map();
const USERS_CACHE_TTL = 15 * 60 * 1000; // 15 min
let FARM_MODE_CACHE = { ts: 0, val: false };
let STOP_PPM_CACHE = { ts: 0, data: {} };
const PPM_HISTORY_CACHE = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ================= REDIS KEYS & HELPERS =================

const usersKey = (group) => `users:${group}`;
const onlineKey = (group) => `online:${group}`;
const liveStatsKey = (group) => `gp_live_stats:${group}`;
const ppmHistoryKey = (group) => `ppm_history:${group}`;

function safeJsonParse(value, fallback) {
  try {
    if (!value) return fallback;
    if (typeof value === "object") return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeId(id) {
  return String(id || "").replace(/\D/g, "");
}

async function isFarmModeActive(force = false) {
  const now = Date.now();
  if (!force && now - FARM_MODE_CACHE.ts < 5 * 60 * 1000) {
    return FARM_MODE_CACHE.val;
  }
  try {
    const val = await redis.get(FARM_MODE_KEY);
    const active = val === "true" || val === true || val === 1 || val === "1";
    FARM_MODE_CACHE = { ts: now, val: active };
    return active;
  } catch {
    return FARM_MODE_CACHE.val;
  }
}

async function getStopPpmData(force = false) {
  const now = Date.now();
  if (!force && now - STOP_PPM_CACHE.ts < 5 * 60 * 1000) {
    return STOP_PPM_CACHE.data;
  }
  try {
    const rawStops = await redis.hgetall("last_stopppm");
    const data = rawStops && typeof rawStops === "object" ? rawStops : {};
    STOP_PPM_CACHE = { ts: now, data };
    return data;
  } catch {
    return STOP_PPM_CACHE.data;
  }
}

async function getUsers(group) {
  const now = Date.now();
  const cached = USERS_CACHE.get(group);
  if (cached && now - cached.ts < USERS_CACHE_TTL) return cached.data;

  try {
    const data = await redis.hgetall(usersKey(group));
    if (!data || typeof data !== "object") {
      USERS_CACHE.set(group, { ts: now, data: {} });
      return {};
    }
    const users = {};
    for (const discordId in data) {
      users[discordId] = safeJsonParse(data[discordId], {});
    }
    USERS_CACHE.set(group, { ts: now, data: users });
    return users;
  } catch (err) {
    console.error(`❌ Error loading users for ${group}:`, err);
    return cached?.data || {};
  }
}

async function getOnlineIDs(group) {
  try {
    const ids = await redis.smembers(onlineKey(group));
    if (!Array.isArray(ids)) return [];
    return ids.map(normalizeId).filter((x) => /^\d{16}$/.test(x));
  } catch (err) {
    console.error(`❌ Error loading online IDs for ${group}:`, err);
    return [];
  }
}

async function getLiveStats(group) {
  try {
    const data = await redis.get(liveStatsKey(group));
    return safeJsonParse(data, {
      totalGP: 0,
      totalAlive: 0,
      currentDay: null,
      daily: { gp: 0, alive: 0 },
      history: [],
      processedMessages: []
    });
  } catch {
    return {
      totalGP: 0,
      totalAlive: 0,
      currentDay: null,
      daily: { gp: 0, alive: 0 },
      history: [],
      processedMessages: []
    };
  }
}

async function getPPMHistory(group) {
  if (PPM_HISTORY_CACHE.has(group)) {
    return PPM_HISTORY_CACHE.get(group);
  }
  try {
    const data = await redis.get(ppmHistoryKey(group));
    const parsed = safeJsonParse(data, { history: [] });
    PPM_HISTORY_CACHE.set(group, parsed);
    return parsed;
  } catch {
    return { history: [] };
  }
}

async function storePPM(group, value) {
  try {
    const data = await getPPMHistory(group);
    data.history.push({
      timestamp: Date.now(),
      ppm: Number(value) || 0
    });
    if (data.history.length > 24) {
      data.history = data.history.slice(-24);
    }
    PPM_HISTORY_CACHE.set(group, data);
    await redis.set(ppmHistoryKey(group), JSON.stringify(data));
  } catch (err) {
    console.error(`❌ Error storing PPM for ${group}:`, err);
  }
}

async function refreshAveragePPM(group) {
  const data = await getPPMHistory(group);
  const values = data.history.map((x) => Number(x.ppm)).filter((x) => x > 0);
  if (!values.length) return "0.00";
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return avg.toFixed(2);
}

// Verifica si un miembro tiene el rol "Legend" (Sharing Proxies)
function hasLegendRole(member) {
  if (!member?.roles?.cache) return false;
  if (LEGEND_ROLE_ID && member.roles.cache.has(LEGEND_ROLE_ID)) return true;
  return member.roles.cache.some((r) => r.name.trim().toLowerCase() === "legend");
}

// ================= FETCH MESSAGES & HEARTBEAT PARSERS =================

async function fetchMessagesByHours(channel, hours) {
  const all = [];
  let lastId = null;
  const limit = Date.now() - hours * 60 * 60 * 1000;

  while (true) {
    const msgs = await channel.messages.fetch({
      limit: 100,
      before: lastId || undefined
    }).catch(() => null);

    if (!msgs || !msgs.size) break;

    for (const msg of msgs.values()) {
      if (msg.createdTimestamp < limit) {
        return all.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      }
      all.push(msg);
    }

    lastId = msgs.last()?.id;
    if (!lastId || all.length >= 400) break;
  }

  return all.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
}

function parseStats(content) {
  const text = String(content || "");
  const timeMatch = text.match(/Time:\s*([^\n\r]+?)\s+Packs:/i);
  const packsMatch = text.match(/Packs:\s*(\d+)/i);
  const avgMatch = text.match(/Avg:\s*([\d.]+)\s*packs?\s*\/?\s*min/i) || text.match(/Avg:\s*([\d.]+)/i);
  const onlineMatch = text.match(/Online:\s*([^\n\r]+)/i);

  const onlineRaw = onlineMatch
    ? onlineMatch[1].split(",").map((x) => x.trim()).filter(Boolean)
    : [];
  const activeNumericInstances = onlineRaw.filter((x) => /^\d+$/.test(x)).length;

  return {
    time: timeMatch?.[1]?.trim() || "0m",
    packs: Number(packsMatch?.[1] || 0),
    ppm: Number(avgMatch?.[1] || 0),
    activeNumericInstances
  };
}

function getMessageText(msg) {
  let content = msg?.content || "";
  if ((!content || content.trim() === "") && msg?.embeds?.length > 0) {
    content =
      msg.embeds[0].description ||
      msg.embeds[0].fields?.map((f) => `${f.name}\n${f.value}`).join("\n") ||
      "";
  }
  return String(content || "").replace(/```/g, "").trim();
}

function normalizeHeartbeatName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[*_`~|>]/g, "")
    .replace(/^@+/, "")
    .replace(/[:：]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripSecondPcSuffix(normName) {
  return normName.replace(/[-_\s]*2$/, "").trim();
}

function extractHeartbeatName(content) {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (!lines.length) return "";
  let firstLine = lines[0].replace(/[*_`~]/g, "").trim();
  const mentionName = firstLine.match(/^@([^\s]+)/);
  if (mentionName) return mentionName[1];
  return firstLine.replace(/[:：]+$/g, "").trim();
}

/**
 * Busca el último heartbeat de "Zekrom-Host".
 * Si tiene más de 15 minutos de antigüedad, se considera OFFLINE (retorna null).
 */
function findZekromHostStats(messages, now) {
  if (!messages || !Array.isArray(messages)) return null;

  for (const msg of messages) {
    const content = getMessageText(msg);
    if (!content) continue;

    const rawHbName = extractHeartbeatName(content);
    const normHbName = normalizeHeartbeatName(rawHbName);

    if (normHbName === "zekrom-host" || normHbName === "zekromhost" || normHbName === "zekrom host") {
      if (now - msg.createdTimestamp > ZEKROM_HOST_TIMEOUT_MS) {
        return null;
      }
      return parseStats(content);
    }
  }
  return null;
}

function namesMatchMultiPC(heartbeatName, registeredName) {
  const hb = normalizeHeartbeatName(heartbeatName);
  const reg = normalizeHeartbeatName(registeredName);
  if (!hb || !reg) return false;
  if (hb === reg) return true;

  const hbBase = stripSecondPcSuffix(hb);
  const regBase = stripSecondPcSuffix(reg);
  return hbBase === reg || hb === regBase || (hbBase.length >= 3 && hbBase === regBase);
}

function getUserNameCandidates(userData) {
  return [
    userData.name,
    userData.heartbeatName,
    userData.username,
    userData.displayName,
    userData.display_name,
    ...(Array.isArray(userData.aliases) ? userData.aliases : [])
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

function findLastMessagesForUserMultiPC(messages, userData) {
  if (!messages || !Array.isArray(messages)) return [];
  const candidates = getUserNameCandidates(userData);
  const foundBySlot = new Map();

  for (const msg of messages) {
    const content = getMessageText(msg);
    if (!content) continue;

    const rawHbName = extractHeartbeatName(content);
    const normHbName = normalizeHeartbeatName(rawHbName);
    if (!normHbName) continue;

    for (const candidate of candidates) {
      if (namesMatchMultiPC(rawHbName, candidate)) {
        const isPC2 = /[-_\s]*2$/.test(normHbName) && !/[-_\s]*2$/.test(normalizeHeartbeatName(candidate));
        const slotKey = isPC2 ? "PC2" : "PC1";
        if (!foundBySlot.has(slotKey)) {
          foundBySlot.set(slotKey, msg);
        }
        break;
      }
    }
  }

  return Array.from(foundBySlot.values());
}

function mergeStatsFromMessages(messages) {
  const merged = {
    time: "0m",
    packs: 0,
    ppm: 0,
    activeNumericInstances: 0,
    pcCount: messages.length
  };

  for (const msg of messages) {
    const content = getMessageText(msg);
    const stats = parseStats(content);

    merged.ppm += Number(stats.ppm) || 0;
    merged.packs += Number(stats.packs) || 0;
    merged.activeNumericInstances += Number(stats.activeNumericInstances) || 0;

    if (stats.time && stats.time !== "0" && stats.time !== "0m") {
      merged.time = stats.time;
    }
  }

  merged.ppm = Number(merged.ppm.toFixed(2));
  return merged;
}

// ================= VISUAL HELPERS & MASSIVE REROLL ALERT =================

function buildPowerBar(currentPPM, maxExpectedPPM = 120) {
  const length = 14;
  const ratio = Math.min(Math.max(currentPPM / maxExpectedPPM, 0), 1);
  const filled = Math.round(ratio * length);
  return "▰".repeat(filled) + "▱".repeat(length - filled);
}

function calculateGlobalStats(onlineStats, sharingAccountsCount, sharingProxiesCount, zekromStats = null) {
  let totalPPM = 0;
  let totalPacks = 0;

  for (const s of onlineStats) {
    totalPPM += Number(s.ppm) || 0;
    totalPacks += Number(s.packs) || 0;
  }

  if (zekromStats) {
    totalPPM += Number(zekromStats.ppm) || 0;
    totalPacks += Number(zekromStats.packs) || 0;
  }

  const users = onlineStats.length;

  return {
    rawTotalPPM: totalPPM,
    totalPPM: totalPPM.toFixed(2),
    avgPPM: (users ? totalPPM / users : 0).toFixed(2),
    totalPacks,
    users,
    sharingAccountsCount,
    sharingProxiesCount,
    minutesToGP: totalPPM > 0 ? (2000 / totalPPM).toFixed(1) : "∞",
    gpPerHour: totalPPM > 0 ? (60 / (2000 / totalPPM)).toFixed(2) : "0.00"
  };
}

function formatGPStats(stats) {
  const todayGP = stats.daily?.gp || 0;
  const todayAlive = stats.daily?.alive || 0;
  const history = stats.history || [];

  let totalGP = todayGP;
  let totalAlive = todayAlive;

  for (const day of history) {
    totalGP += day.gp || 0;
    totalAlive += day.alive || 0;
  }

  const formatDate = (dateStr) => {
    const parts = String(dateStr || "").split("-");
    if (parts.length === 3) return `${parts[1]}/${parts[2]}`;
    return dateStr || "??/??";
  };

  const last5 = history.slice(0, 5);
  const historyText = last5
    .map((d) => {
      const rate = d.gp > 0 ? Math.round((d.alive / d.gp) * 100) : 0;
      return `📅 \`${formatDate(d.date)}\`  ➔  🌟 **${d.gp} GP**  •  💖 **${d.alive} Alive** (\`${rate}%\`)`;
    })
    .join("\n");

  const todayRate = todayGP > 0 ? Math.round((todayAlive / todayGP) * 100) : 0;

  return {
    todayGP,
    todayAlive,
    todayRate,
    totalGP,
    totalAlive,
    historyText: historyText || "*No history recorded yet*"
  };
}

async function checkAndTriggerMassiveRerollAlert(group, channel, highPpmUsers) {
  if (!channel || !highPpmUsers.length) return;
  const now = Date.now();
  const triggered = [];

  for (const u of highPpmUsers) {
    const key = `${group}:${u.discordId}`;
    const lastAlert = massivePpmCooldowns.get(key) || 0;
    if (now - lastAlert >= MASSIVE_ALERT_COOLDOWN) {
      massivePpmCooldowns.set(key, now);
      triggered.push(u);
    }
  }

  if (!triggered.length) return;

  const config = GROUP_CONFIG[group];
  const turboList = triggered
    .map((u) => `🔥 **${u.name}** — \`⚡ ${u.ppm.toFixed(2)} PPM\``)
    .join("\n");

  const alertEmbed = new EmbedBuilder()
    .setColor(0xff2a85)
    .setTitle(`🚨 MASSIVE REROLL ACTIVATED IN ${config.label.toUpperCase()}! 🚨`)
    .setDescription(
      `High pack-opening speed has been detected right now!\n\n` +
      `${turboList}\n\n` +
      `⚡ **Jump in, set your account ONLINE, and join the God Pack wave!**`
    )
    .setTimestamp();

  const sent = await channel.send({ embeds: [alertEmbed] }).catch(() => null);
  if (sent) {
    setTimeout(() => sent.delete().catch(() => {}), 90 * 60 * 1000);
  }
}

// ================= PANEL GENERATOR (ZEKROM-HOST + 0 PPM/INST = SHARING ACCOUNTS + LEGEND = PROXIES) =================

async function generatePanel(group, panelChannel) {
  const config = GROUP_CONFIG[group];
  const users = await getUsers(group);
  const onlineIds = new Set((await getOnlineIDs(group)).map(normalizeId));
  const farmMode = await isFarmModeActive();

  const guild = panelChannel?.guild || client.guilds.cache.first();
  const heartbeatChannel = await client.channels.fetch(config.heartbeatChannelId).catch(() => null);
  const messages = heartbeatChannel ? await fetchMessagesByHours(heartbeatChannel, 4) : [];

  const onlineStats = [];
  const processedOnlineUsers = [];
  const highPpmUsers = [];
  let sharingAccountsCount = 0;
  let sharingProxiesCount = 0;

  const now = Date.now();
  const zekromStats = findZekromHostStats(messages, now);
  const lastStopData = await getStopPpmData();

  for (const [discordId, rawUser] of Object.entries(users)) {
    const mainId = normalizeId(rawUser.main_id);
    const secId = normalizeId(rawUser.sec_id);
    const isOnline = onlineIds.has(mainId) || (secId && onlineIds.has(secId));

    if (!isOnline) continue;

    // Excluir si el usuario tiene Zekrom-Host como nombre (se muestra arriba con su regla de 15m)
    const isZekromUser = getUserNameCandidates(rawUser).some((c) => {
      const n = normalizeHeartbeatName(c);
      return n === "zekrom-host" || n === "zekromhost" || n === "zekrom host";
    });
    if (isZekromUser) continue;

    // 1. Verificar rol Legend -> SIEMPRE Sharing Proxies
    const member =
      guild?.members?.cache?.get(String(discordId)) ||
      (guild ? await guild.members.fetch(String(discordId)).catch(() => null) : null);
    const isLegendProxy = hasLegendRole(member);

    // 2. Calcular stats del heartbeat
    const userMessages = findLastMessagesForUserMultiPC(messages, rawUser);
    const userLastStop = Number(lastStopData[discordId]) || 0;

    const validMessages = userMessages.filter(
      (msg) =>
        now - msg.createdTimestamp <= HEARTBEAT_TIMEOUT_MS &&
        msg.createdTimestamp > userLastStop
    );

    const rawStats = validMessages.length
      ? mergeStatsFromMessages(validMessages)
      : { time: "0m", packs: 0, ppm: 0, activeNumericInstances: 0, pcCount: 0 };

    // 3. Regla de Sharing:
    // - Si tiene rol Legend -> Sharing Proxies
    // - Si NO es Legend y tiene 0 PPM y 0 instancias numéricas -> Sharing Accounts
    // - Si tiene > 0 PPM o > 0 instancias numéricas -> Muestra sus stats normales
    let shareMode = null;
    if (isLegendProxy) {
      shareMode = "proxies";
      sharingProxiesCount++;
    } else if (rawStats.ppm <= 0 && rawStats.activeNumericInstances === 0) {
      shareMode = "accounts";
      sharingAccountsCount++;
    }

    const stats = shareMode
      ? { time: "0m", packs: 0, ppm: 0, activeNumericInstances: 0, pcCount: 0 }
      : rawStats;

    onlineStats.push(stats);

    processedOnlineUsers.push({
      discordId,
      name: rawUser.name || "Unknown",
      stats,
      shareMode
    });

    if (!shareMode && stats.ppm > MASSIVE_PPM_THRESHOLD) {
      highPpmUsers.push({
        discordId,
        name: rawUser.name || "Unknown",
        ppm: stats.ppm
      });
    }
  }

  if (panelChannel && highPpmUsers.length > 0) {
    await checkAndTriggerMassiveRerollAlert(group, panelChannel, highPpmUsers);
  }

  // Ordenar: primero usuarios con PPM/Packs, luego Sharing Proxies y Sharing Accounts
  processedOnlineUsers.sort((a, b) => {
    const aIsSharing = Boolean(a.shareMode);
    const bIsSharing = Boolean(b.shareMode);
    if (aIsSharing !== bIsSharing) return aIsSharing ? 1 : -1;
    return b.stats.packs - a.stats.packs || b.stats.ppm - a.stats.ppm;
  });

  const onlineLines = [];

  if (zekromStats) {
    onlineLines.push(`⚡ **Zekrom host running** • \`${zekromStats.ppm.toFixed(2)} PPM\``);
  }

  for (const u of processedOnlineUsers) {
    if (u.shareMode === "proxies") {
      onlineLines.push(
        `🌐 **${u.name}** \`🟣 SHARING PROXIES\`\n` +
        `┗ 🔗 \`Sharing Proxies\``
      );
      continue;
    }

    if (u.shareMode === "accounts") {
      onlineLines.push(
        `🎲 **${u.name}** \`🟢 SHARING ACCOUNTS\`\n` +
        `┗ 🔗 \`Sharing Accounts\``
      );
      continue;
    }

    const multiPcTag = u.stats.pcCount > 1 ? " `🖥️ 2-Nodes`" : "";
    const turboIcon = u.stats.ppm > MASSIVE_PPM_THRESHOLD ? " 🔥" : "";

    onlineLines.push(
      `⚡ **${u.name}**${multiPcTag}${turboIcon}\n` +
      `┗ ⚡ \`${u.stats.ppm.toFixed(2)} PPM\`  •  🀄 \`${u.stats.packs.toLocaleString()} Packs\`  •  ⏱️ \`${u.stats.time}\``
    );
  }

  const global = calculateGlobalStats(onlineStats, sharingAccountsCount, sharingProxiesCount, zekromStats);
  const gp = formatGPStats(await getLiveStats(group));
  const cachedAvgPPM = await refreshAveragePPM(group);
  const powerBar = buildPowerBar(global.rawTotalPPM, 120);

  let tierBadge = "🟢 **STANDARD MODE**";
  if (global.rawTotalPPM >= 40) tierBadge = "🔥 **OVERDRIVE MODE**";
  else if (global.rawTotalPPM >= 30) tierBadge = "⚡ **HIGH SPEED REROLL**";
  else if (global.rawTotalPPM === 0 && (sharingAccountsCount > 0 || sharingProxiesCount > 0)) {
    tierBadge = "🎲 **HOST & PROXY SHARING ACTIVE**";
  } else if (global.rawTotalPPM === 0) {
    tierBadge = "💤 **IDLE / WAITING**";
  }

  const farmBanner = farmMode
    ? "\n> 🌾 **FARM MODE ACTIVE:** *Inactivity kick timers are paused by Champion.*\n"
    : "";

  const usersEmbed = new EmbedBuilder()
    .setTitle(`🟢 Active Rerollers — ${config.label} (${processedOnlineUsers.length})`)
    .setColor(farmMode ? 0xf1c40f : 0x2ecc71)
    .setDescription(
      onlineLines.length > 0
        ? onlineLines.join("\n\n").slice(0, 4000)
        : "*⚫ No users currently online in this group.*"
    );

  const globalEmbed = new EmbedBuilder()
    .setTitle(`📊 Global Headless Telemetry — ${config.label}`)
    .setColor(farmMode ? 0xf1c40f : config.color)
    .setDescription(
      `${farmBanner}` +
      `# ⚡ ${global.totalPPM} PPM  •  ${tierBadge}\n` +
      `\`[${powerBar}]\`  *(12h Avg: **${cachedAvgPPM} PPM**)*\n` +
      `───────────────────────────────────────────────`
    )
    .addFields(
      { name: "👥 Online Users", value: `**${global.users}**`, inline: true },
      { name: "🀄 Session Packs", value: `**${global.totalPacks.toLocaleString()}**`, inline: true },
      { name: "⚡ Avg PPM / User", value: `**${global.avgPPM}**`, inline: true },
      { name: "🎲 Sharing Accounts", value: `**${global.sharingAccountsCount}**`, inline: true },
      { name: "🌐 Sharing Proxies", value: `**${global.sharingProxiesCount}**`, inline: true },
      { name: "🎯 Est. GP / Hour", value: `**${global.gpPerHour}**`, inline: true },
      { name: "⏱️ Est. Min / GP", value: `**${global.minutesToGP} min**`, inline: true },
      { name: "🌟 GP Today", value: `**${gp.todayGP} GP**\n💖 **${gp.todayAlive} Alive** (\`${gp.todayRate}%\`)`, inline: true },
      { name: "💫 Total (5 Days)", value: `**${gp.totalGP} GP**\n💖 **${gp.totalAlive} Alive**`, inline: true },
      { name: "📅 Last 5 Days History", value: gp.historyText, inline: false }
    )
    .setFooter({ text: "Auto-updates every 5 mins • Headless System (Low-Redis Optimized)" })
    .setTimestamp();

  return {
    embeds: [usersEmbed, globalEmbed],
    rawTotalPPM: global.rawTotalPPM
  };
}

async function upsertPanel(group) {
  const config = GROUP_CONFIG[group];
  if (!config.panelChannelId) return;

  const channel = await client.channels.fetch(config.panelChannelId).catch(() => null);
  if (!channel) return;

  const result = await generatePanel(group, channel);

  if (!client.statsPanelMessages) client.statsPanelMessages = new Map();

  const currentMessageId = client.statsPanelMessages.get(group);
  let panelMessage = null;

  if (currentMessageId) {
    panelMessage = await channel.messages.fetch(currentMessageId).catch(() => null);
  }

  if (!panelMessage) {
    const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
    if (messages) {
      panelMessage = messages.find(
        (msg) =>
          msg.author.id === client.user.id &&
          msg.embeds.length > 0 &&
          msg.embeds.some((e) => e.title?.includes(config.label))
      );
    }
  }

  if (panelMessage) {
    await panelMessage.edit({ embeds: result.embeds }).catch(() => {});
  } else {
    panelMessage = await channel.send({ embeds: result.embeds }).catch(() => null);
  }

  if (panelMessage) {
    client.statsPanelMessages.set(group, panelMessage.id);
  }
  client.lastTotalPPMByGroup.set(group, result.rawTotalPPM);
}

async function updateAllPanels() {
  for (const group of Object.keys(GROUP_CONFIG)) {
    try {
      await upsertPanel(group);
    } catch (err) {
      console.error(`❌ Error updating panel for ${group}:`, err);
    }
  }
}

async function storeAllPPM() {
  for (const group of Object.keys(GROUP_CONFIG)) {
    try {
      const value = client.lastTotalPPMByGroup.get(group) || 0;
      await storePPM(group, value);
    } catch (err) {
      console.error(`❌ Error storing PPM for ${group}:`, err);
    }
  }
}

// ================= COMANDOS DE CHAMPION =================

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content.toLowerCase().startsWith("!stopppm")) {
    if (!message.member?.roles.cache.has(CHAMPION_ROLE_ID)) {
      return message.reply("❌ No tienes permisos de Champion para usar este comando.");
    }

    const targetUser = message.mentions.users.first();
    if (!targetUser) {
      return message.reply("⚠️ Debes mencionar al usuario cuyo PPM quieres detener. Ejemplo: `!stopppm @usuario`");
    }

    try {
      const ts = Date.now();
      await redis.hset("last_stopppm", { [targetUser.id]: ts });
      STOP_PPM_CACHE.data[targetUser.id] = ts;

      await message.reply(
        `✅ El PPM de **${targetUser.username}** ha sido forzado a **0**.\n*(Sus reportes anteriores han sido invalidados. Si envía un nuevo heartbeat, el panel volverá a contar desde cero).*`
      );

      updateAllPanels();
    } catch (err) {
      console.error("Error al usar !stopppm:", err);
      message.reply("❌ Ocurrió un error al intentar detener el PPM.");
    }
  }
});

// ================= LOAD ALERTS MODULE =================

require("./alerts")(client, {
  GROUP_CONFIG,
  CHAMPION_ROLE_ID,
  LEGEND_ROLE_ID,
  PUBLIC_ALERTS_CHANNEL_ID,
  GLOBAL_HEARTBEAT_CHANNEL_ID,
  PERSONAL_CATEGORY_ID,
  redis,
  onFarmModeChanged: () => {
    FARM_MODE_CACHE.ts = 0;
    return updateAllPanels();
  }
});

// ================= START =================

client.once("ready", async () => {
  console.log(`✅ Headless Telemetry & Alerts Bot (Optimized) connected as: ${client.user.tag}`);

  client.statsPanelMessages = new Map();
  client.lastTotalPPMByGroup = new Map();

  await updateAllPanels();
  await storeAllPPM();

  setInterval(updateAllPanels, UPDATE_PANEL_INTERVAL);
  setInterval(storeAllPPM, STORE_PPM_INTERVAL);
});

client.login(TOKEN);
