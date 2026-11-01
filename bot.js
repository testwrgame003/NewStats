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
const PUBLIC_ALERTS_CHANNEL_ID = "1488766924321198080";
const GLOBAL_HEARTBEAT_CHANNEL_ID = "1492795826857054301";
const PERSONAL_CATEGORY_ID = "1565623831203287150";

const RIVALS_SESSIONS_KEY = "rivals_sessions";
const FARM_MODE_KEY = "system:farm_mode";

const GROUP_CONFIG = {
  Trainer: {
    label: "Trainer",
    color: 0x2ecc71,
    heartbeatChannelId: "1486243169422020648",
    panelChannelId: "1564890852310913034"
  },
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

const massivePpmCooldowns = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ================= REDIS KEYS & HELPERS =================

const usersKey = (group) => `users:${group}`; const onlineKey = (group) => `online:${group}`;
const liveStatsKey = (group) => `gp_live_stats:${group}`; const ppmHistoryKey = (group) => `ppm_history:${group}`;

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

async function isFarmModeActive() {
  try {
    const val = await redis.get(FARM_MODE_KEY);
    return val === "true" || val === true || val === 1 || val === "1";
  } catch {
    return false;
  }
}

async function getUsers(group) {
  try {
    const data = await redis.hgetall(usersKey(group));
    if (!data || typeof data !== "object") return {};
    const users = {};
    for (const discordId in data) {
      users[discordId] = safeJsonParse(data[discordId], {});
    }
    return users;
  } catch (err) {
    console.error(`❌ Error loading users for ${group}:`, err);
    return {};
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

async function getRivalsSessionsByGroup(targetGroup) {
  try {
    const rawData = await redis.hgetall(RIVALS_SESSIONS_KEY);
    if (!rawData || typeof rawData !== "object") return [];
    const sessions = [];
    for (const raw of Object.values(rawData)) {
      const s = safeJsonParse(raw, null);
      if (s && s.targetGroup === targetGroup && Array.isArray(s.members) && s.members.length > 0) {
        sessions.push(s);
      }
    }
    return sessions;
  } catch (err) {
    console.error("❌ Error loading Rivals sessions:", err);
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
  try {
    const data = await redis.get(ppmHistoryKey(group));
    return safeJsonParse(data, { history: [] });
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

// ================= FETCH MESSAGES & MULTI-PC PARSERS =================

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

function cleanList(str) {
  if (!str) return [];
  return str.split(",").map((x) => x.trim()).filter(Boolean);
}

function parseStats(content) {
  const text = String(content || "");
  const timeMatch = text.match(/Time:\s*([^\n\r]+?)\s+Packs:/i);
  const packsMatch = text.match(/Packs:\s*(\d+)/i);
  const avgMatch = text.match(/Avg:\s*([\d.]+)\s*packs?\s*\/?\s*min/i) || text.match(/Avg:\s*([\d.]+)/i);
  const onlineMatch = text.match(/Online:\s*([^\n\r]+)/i);
  const offlineMatch = text.match(/Offline:\s*([^\n\r]+)/i);

  return {
    time: timeMatch?.[1]?.trim() || "0m",
    packs: Number(packsMatch?.[1] || 0),
    ppm: Number(avgMatch?.[1] || 0),
    online: cleanList(onlineMatch?.[1]),
    offline: cleanList(offlineMatch?.[1])
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
    online: [],
    offline: [],
    pcCount: messages.length
  };

  for (const msg of messages) {
    const content = getMessageText(msg);
    const stats = parseStats(content);

    merged.ppm += Number(stats.ppm) || 0;
    merged.packs += Number(stats.packs) || 0;

    if (stats.time && stats.time !== "0" && stats.time !== "0m") {
      merged.time = stats.time;
    }
    if (Array.isArray(stats.online)) {
      merged.online.push(...stats.online);
    }
    if (Array.isArray(stats.offline) && !stats.offline.includes("none")) {
      merged.offline.push(...stats.offline);
    }
  }

  merged.ppm = Number(merged.ppm.toFixed(2));
  if (!merged.offline.length) merged.offline = ["none"];
  return merged;
}

// ================= VISUAL HELPERS & MASSIVE REROLL ALERT =================

function buildPowerBar(currentPPM, maxExpectedPPM = 120) {
  const length = 14;
  const ratio = Math.min(Math.max(currentPPM / maxExpectedPPM, 0), 1);
  const filled = Math.round(ratio * length);
  return "▰".repeat(filled) + "▱".repeat(length - filled);
}

function calculateGlobalStats(onlineStats) {
  let totalPPM = 0;
  let totalInstances = 0;
  let activeInstances = 0;
  let totalPacks = 0;

  for (const s of onlineStats) {
    totalPPM += Number(s.ppm) || 0;
    const onlineCount = s.online.filter((x) => x.toLowerCase() !== "main" && x.toLowerCase() !== "none").length;
    const offlineCount = s.offline.includes("none") ? 0 : s.offline.filter((x) => x.toLowerCase() !== "main").length;

    activeInstances += onlineCount;
    totalInstances += onlineCount + offlineCount;
    totalPacks += Number(s.packs) || 0;
  }

  const users = onlineStats.length;
  const efficiency = totalInstances > 0 ? Math.round((activeInstances / totalInstances) * 100) : 0;

  return {
    rawTotalPPM: totalPPM,
    totalPPM: totalPPM.toFixed(2),
    avgPPM: (users ? totalPPM / users : 0).toFixed(2),
    activeInstances,
    totalInstances,
    efficiency,
    instancesDisplay: `${activeInstances}/${totalInstances} (${efficiency}%)`,
    avgInstances: (users ? (activeInstances / users).toFixed(1) : "0.0"),
    totalPacks,
    users,
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
    .map((u) => `🔥 **${u.name}** — \`⚡ ${u.ppm.toFixed(2)} PPM\` (\`🖥️ ${u.activeInstances} active instances\`)`)
    .join("\n");

  const alertEmbed = new EmbedBuilder()
    .setColor(0xff2a85)
    .setTitle(`🚨 MASSIVE REROLL ACTIVATED IN ${config.label.toUpperCase()}! 🚨`)
    .setDescription(
      `Hight pack-opening speed has been detected right now!\n\n` +
      `${turboList}\n\n` +
      `⚡ **Jump in, set your account ONLINE, and join the God Pack wave!**`
    )
    .setTimestamp();

  const sent = await channel.send({ embeds: [alertEmbed] }).catch(() => null);
  if (sent) {
    setTimeout(() => sent.delete().catch(() => {}), 90 * 60 * 1000);
  }
}

// ================= PANEL GENERATOR (ONLINE USERS ONLY + GLOBAL STATS) =================

async function generatePanel(group, panelChannel) {
  const config = GROUP_CONFIG[group];
  const users = await getUsers(group);
  const rivalsUsers = await getUsers("Rivals");
  const onlineIds = new Set((await getOnlineIDs(group)).map(normalizeId));
  const rivalsSessions = await getRivalsSessionsByGroup(group);
  const farmMode = await isFarmModeActive();

  const heartbeatChannel = await client.channels.fetch(config.heartbeatChannelId).catch(() => null);
  const messages = heartbeatChannel ? await fetchMessagesByHours(heartbeatChannel, 4) : [];

  const onlineStats = [];
  const processedOnlineUsers = [];
  const highPpmUsers = [];
  const countedDiscordIds = new Set();

  // 1. Standard Group Online Users
  for (const [discordId, rawUser] of Object.entries(users)) {
    const mainId = normalizeId(rawUser.main_id);
    const secId = normalizeId(rawUser.sec_id);
    const isOnline = onlineIds.has(mainId) || (secId && onlineIds.has(secId));

    if (!isOnline) continue;

    const userMessages = findLastMessagesForUserMultiPC(messages, rawUser);
    const stats = userMessages.length
      ? mergeStatsFromMessages(userMessages)
      : { time: "0m", packs: 0, ppm: 0, online: [], offline: ["none"], pcCount: 0 };

    onlineStats.push(stats);
    countedDiscordIds.add(String(discordId));

    const activeInst = stats.online.filter((x) => x.toLowerCase() !== "main" && x.toLowerCase() !== "none").length;
    const offlineInst = stats.offline.includes("none") ? 0 : stats.offline.filter((x) => x.toLowerCase() !== "main").length;

    processedOnlineUsers.push({
      discordId,
      name: rawUser.name || "Unknown",
      stats,
      activeInst,
      offlineInst,
      isRival: false,
      rivalTag: ""
    });

    if (stats.ppm > MASSIVE_PPM_THRESHOLD) {
      highPpmUsers.push({
        discordId,
        name: rawUser.name || "Unknown",
        ppm: stats.ppm,
        activeInstances: activeInst
      });
    }
  }

  // 2. Rivals 2.0 Sessions Active in this Group
  for (const session of rivalsSessions) {
    for (let idx = 0; idx < session.members.length; idx++) {
      const member = session.members[idx];
      if (countedDiscordIds.has(String(member.discordId))) continue;

      const rivalUserData = rivalsUsers[member.discordId] || {
        name: member.name,
        heartbeatName: member.heartbeatName || member.name,
        main_id: member.gameId
      };

      const userMessages = findLastMessagesForUserMultiPC(messages, rivalUserData);
      const stats = userMessages.length
        ? mergeStatsFromMessages(userMessages)
        : { time: "0m", packs: 0, ppm: 0, online: [], offline: ["none"], pcCount: 0 };

      onlineStats.push(stats);
      countedDiscordIds.add(String(member.discordId));

      const activeInst = stats.online.filter((x) => x.toLowerCase() !== "main" && x.toLowerCase() !== "none").length;
      const offlineInst = stats.offline.includes("none") ? 0 : stats.offline.filter((x) => x.toLowerCase() !== "main").length;
      const isTurnActive = session.activeIndex === idx;

      processedOnlineUsers.push({
        discordId: member.discordId,
        name: rivalUserData.name || member.name || "Rival",
        stats,
        activeInst,
        offlineInst,
        isRival: true,
        rivalTag: isTurnActive ? "🤝 Rivals • 🟢 Active Turn" : "🤝 Rivals • ⏳ Standby"
      });

      if (stats.ppm > MASSIVE_PPM_THRESHOLD) {
        highPpmUsers.push({
          discordId: member.discordId,
          name: rivalUserData.name || member.name || "Rival",
          ppm: stats.ppm,
          activeInstances: activeInst
        });
      }
    }
  }

  // Trigger > 15 PPM alert in the stats channel
  if (panelChannel && highPpmUsers.length > 0) {
    await checkAndTriggerMassiveRerollAlert(group, panelChannel, highPpmUsers);
  }

  // Sort Online Users by Packs (Highest to Lowest)
  processedOnlineUsers.sort((a, b) => b.stats.packs - a.stats.packs || b.stats.ppm - a.stats.ppm);

  const onlineLines = processedOnlineUsers.map((u, index) => {
    const rankIcon = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "⚔️";
    const multiPcTag = u.stats.pcCount > 1 ? " `🖥️ 2-PC`" : "";
    const rivalBadge = u.isRival ? ` *(${u.rivalTag})*` : "";
    const turboIcon = u.stats.ppm > MASSIVE_PPM_THRESHOLD ? " 🔥" : "";

    return (
      `${rankIcon} **${u.name}**${multiPcTag}${rivalBadge}${turboIcon}\n` +
      `┗ ⚡ \`${u.stats.ppm.toFixed(2)} PPM\`  •  🀄 \`${u.stats.packs.toLocaleString()}\`  •  ⏱️ \`${u.stats.time}\`  •  🖥️ \`${u.activeInst}\`  •  💤 \`${u.offlineInst}\``
    );
  });

  const global = calculateGlobalStats(onlineStats);
  const gp = formatGPStats(await getLiveStats(group));
  const cachedAvgPPM = await refreshAveragePPM(group);
  const powerBar = buildPowerBar(global.rawTotalPPM, 120);

let tierBadge = "🟢 **STANDARD MODE**";
  if (global.rawTotalPPM >= 40) tierBadge = "🔥 **OVERDRIVE MODE**";
  else if (global.rawTotalPPM >= 30) tierBadge = "⚡ **HIGH SPEED REROLL**";
  else if (global.rawTotalPPM === 0) tierBadge = "💤 **IDLE / WAITING**";

  const farmBanner = farmMode
    ? "\n> 🌾 **FARM MODE ACTIVE:** *Inactivity & low-instance kick timers are paused by Champion.*\n"
    : "";

  // Embed 1: Online Users List ONLY (No Offline List)
  const usersEmbed = new EmbedBuilder()
    .setTitle(`🟢 Active Rerollers — ${config.label} (${processedOnlineUsers.length})`)
    .setColor(farmMode ? 0xf1c40f : 0x2ecc71)
    .setDescription(
      onlineLines.length > 0
        ? onlineLines.join("\n\n").slice(0, 4000)
        : "*⚫ No users currently online in this group.*"
    );

  // Embed 2: Global Telemetry Dashboard
  const globalEmbed = new EmbedBuilder()
    .setTitle(`📊 Global Telemetry — ${config.label}`) .setColor(farmMode ? 0xf1c40f : config.color) .setDescription( `${farmBanner}` +
      `# ⚡ ${global.totalPPM} PPM  •  ${tierBadge}\n` +
      `\`[${powerBar}]\`  *(12h Avg: **${cachedAvgPPM} PPM**)*\n` +
      `───────────────────────────────────────────────`
    )
    .addFields(
      {
        name: "👥 Online Users",
        value: `**${global.users}**`, inline: true }, { name: "🀄 Session Packs", value: `**${global.totalPacks.toLocaleString()}**`,
        inline: true
      },
      {
        name: "⚡ Avg PPM / User",
        value: `**${global.avgPPM}**`, inline: true }, { name: "🖥️ Active Instances", value: `**${global.instancesDisplay}**`,
        inline: true
      },
      {
        name: "📊 Avg Inst / User",
        value: `**${global.avgInstances}**`, inline: true }, { name: "🎯 Est. GP / Hour", value: `**${global.gpPerHour}**`,
        inline: true
      },
      {
        name: "⏱️ Est. Min / GP",
        value: `**${global.minutesToGP} min**`, inline: true }, { name: "🌟 GP Today", value: `**${gp.todayGP} GP**\n💖 **${gp.todayAlive} Alive** (\`${gp.todayRate}\%\`)`, inline: true }, { name: "💫 Total (5 Days)", value: `**${gp.totalGP} GP**\n💖 **${gp.totalAlive} Alive**`,
        inline: true
      },
      {
        name: "📅 Last 5 Days History",
        value: gp.historyText,
        inline: false
      }
    )
    .setFooter({ text: "Auto-updates every 10 mins • Multi-PC & Rivals 2.0 Enabled" })
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

// ================= LOAD ALERTS & RANKING MODULES =================

require("./alerts")(client, {
  GROUP_CONFIG,
  CHAMPION_ROLE_ID,
  PUBLIC_ALERTS_CHANNEL_ID,
  GLOBAL_HEARTBEAT_CHANNEL_ID,
  PERSONAL_CATEGORY_ID,
  redis,
  onFarmModeChanged: updateAllPanels
});

require("./ranking")(client, {
  GROUP_CONFIG,
  CHAMPION_ROLE_ID,
  GLOBAL_HEARTBEAT_CHANNEL_ID,
  redis
});

// ================= START =================

client.once("ready", async () => {
  console.log(`✅ Telemetry, Alerts & Ranking Bot connected as: ${client.user.tag}`);

  client.statsPanelMessages = new Map();
  client.lastTotalPPMByGroup = new Map();

  await updateAllPanels();
  await storeAllPPM();

  setInterval(updateAllPanels, UPDATE_PANEL_INTERVAL);
  setInterval(storeAllPPM, STORE_PPM_INTERVAL);
});

client.login(TOKEN);
