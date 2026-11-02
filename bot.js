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

// ID del canal donde está el panel "GP farm host" y llegan los logs de "Possible double reroll"
// Si tienes un ID específico ponlo aquí o en tu .env como FARM_HOST_CHANNEL_ID
const FARM_HOST_CHANNEL_ID = process.env.FARM_HOST_CHANNEL_ID || PUBLIC_ALERTS_CHANNEL_ID;

const RIVALS_SESSIONS_KEY = "rivals_sessions";
const FARM_MODE_KEY = "system:farm_mode";
const SHARING_USERS_KEY = "active_sharing_users";

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
const SCAN_SHARING_INTERVAL = 20 * 60 * 1000; // Escaneo del panel GP farm host cada 20 minutos
const MASSIVE_PPM_THRESHOLD = 15.0;
const MASSIVE_ALERT_COOLDOWN = 2 * 60 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 30 * 60 * 1000;

const massivePpmCooldowns = new Map();
// Mapa en memoria de discordId -> { hosts: ["Arcade", "wR98"], ready: 1628, total: 2608 }
const activeSharingUsersMap = new Map();

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

// ================= FUZZY NAME MATCHING & GP FARM HOST SCANNER =================

function cleanNameForComparison(str) {
  return String(str || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[*_`~|>@#]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

// Reduce letras repetidas (ej. "creeeder" -> "creder") y quita sufijos cortos como p1, 91, etc.
function simplifyRootName(str) {
  const cleaned = cleanNameForComparison(str);
  const collapsed = cleaned.replace(/(.)\1+/g, "$1");
  const stripped = collapsed.replace(/[p_-]?\d{1,3}$/i, "");
  return stripped.length >= 3 ? stripped : collapsed;
}

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

function calculateNameSimilarity(rawA, rawB) {
  const a = cleanNameForComparison(rawA);
  const b = cleanNameForComparison(rawB);
  if (!a || !b) return 0;
  if (a === b) return 1.0;

  const rootA = simplifyRootName(a);
  const rootB = simplifyRootName(b);
  if (rootA && rootB && rootA === rootB && rootA.length >= 3) {
    return 0.95;
  }

  // Si uno empieza o contiene al otro (ej: "creederp1" y "creeder" o "creeeder91" y "creeder")
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 3 && (longer.startsWith(shorter) || longer.includes(shorter))) {
    const ratio = shorter.length / longer.length;
    if (ratio >= 0.60) return 0.88;
  }
  if (rootA.length >= 3 && rootB.length >= 3 && (rootA.includes(rootB) || rootB.includes(rootA))) {
    return 0.86;
  }

  const maxLen = Math.max(a.length, b.length);
  const dist = levenshteinDistance(a, b);
  const scoreFull = 1 - dist / maxLen;

  const maxRootLen = Math.max(rootA.length, rootB.length);
  const distRoot = levenshteinDistance(rootA, rootB);
  const scoreRoot = maxRootLen > 0 ? 1 - distRoot / maxRootLen : 0;

  return Math.max(scoreFull, scoreRoot);
}

function isFuzzyUserMatch(panelName, userData, threshold = 0.78) {
  const candidates = getUserNameCandidates(userData);
  for (const cand of candidates) {
    if (calculateNameSimilarity(panelName, cand) >= threshold) {
      return true;
    }
  }
  return false;
}

function parseFarmHostPanelMessage(msg) {
  const entries = [];
  const blocks = [];

  if (msg.content) {
    blocks.push({ title: "GP Farm Host", text: msg.content });
  }
  if (Array.isArray(msg.embeds)) {
    for (const emb of msg.embeds) {
      const title = emb.title || emb.author?.name || "";
      const desc = emb.description || "";
      const fieldsText = Array.isArray(emb.fields)
        ? emb.fields.map((f) => `${f.name}\n${f.value}`).join("\n")
        : "";
      blocks.push({ title, text: `${title}\n${desc}\n${fieldsText}` });
    }
  }

  for (const block of blocks) {
    if (!/gp\s*farm\s*host|monitor\s*link\s*on|shared\s*accounts/i.test(block.text)) continue;

    let hostName = "Farm Host";
    const hostMatch = block.title.match(/([a-zA-Z0-9_-]+)\s*[—\-]\s*GP\s*farm\s*host/i) ||
                      block.text.match(/([a-zA-Z0-9_-]+)\s*[—\-]\s*GP\s*farm\s*host/i);
    if (hostMatch) hostName = hostMatch[1].trim();

    const lines = block.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const isGreen =
        line.startsWith("🟢") ||
        line.startsWith(":green_circle:") ||
        /^<a?:green[a-z0-9_]*:\d+>/i.test(line);

      if (!isGreen) continue;

      let rest = line
        .replace(/^(?:🟢|:green_circle:|<a?:[a-z0-9_]+:\d+>)\s*/i, "")
        .trim();

      let mentionedDiscordId = null;
      const mentionMatch = rest.match(/^<@!?(\d{17,20})>/);
      if (mentionMatch) {
        mentionedDiscordId = mentionMatch[1];
      }

      // Extraer el nombre antes del guion "— 905/1285"
      const parts = rest.split(/\s+[—–\-]\s+/);
      let rawUserPart = (parts[0] || "").replace(/^@+/, "").trim();
      let ready = 0;
      let total = 0;

      if (parts[1]) {
        const countMatch = parts[1].replace(/\*/g, "").match(/(\d+)\s*\/\s*(\d+)/);
        if (countMatch) {
          ready = Number(countMatch[1]) || 0;
          total = Number(countMatch[2]) || 0;
        }
      }

      entries.push({
        hostName,
        mentionedDiscordId,
        rawName: rawUserPart,
        ready,
        total
      });
    }
  }

  return entries;
}

async function scanFarmHostSharingPanel() {
  try {
    const candidateChannels = new Map();

    // 1. Canal configurado directamente
    if (FARM_HOST_CHANNEL_ID) {
      const ch = await client.channels.fetch(FARM_HOST_CHANNEL_ID).catch(() => null);
      if (ch && ch.isTextBased()) candidateChannels.set(ch.id, ch);
    }

    // 2. Búsqueda de respaldo en los canales de texto del servidor por si está en otro canal
    const guild = client.guilds.cache.first();
    if (guild) {
      for (const ch of guild.channels.cache.values()) {
        if (
          ch.isTextBased() &&
          /farm|host|share|sharing|arcade|monitor|status|panel|alert/i.test(ch.name)
        ) {
          candidateChannels.set(ch.id, ch);
        }
      }
    }

    const greenEntries = [];

    for (const ch of candidateChannels.values()) {
      const msgs = await ch.messages.fetch({ limit: 35 }).catch(() => null);
      if (!msgs) continue;

      for (const msg of msgs.values()) {
        const parsed = parseFarmHostPanelMessage(msg);
        if (parsed.length > 0) {
          greenEntries.push(...parsed);
        }
      }
      // Si ya encontramos el panel en el canal principal, no hace falta seguir buscando
      if (greenEntries.length > 0 && ch.id === FARM_HOST_CHANNEL_ID) break;
    }

    // Cargar todos los usuarios registrados (Elite_Four, Rivals, Gym_Leader, Trainer)
    const allRegisteredUsers = new Map();
    const groupsToLoad = ["Elite_Four", "Rivals", "Gym_Leader", "Trainer"];

    for (const grp of groupsToLoad) {
      const gUsers = await getUsers(grp);
      for (const [uid, uData] of Object.entries(gUsers)) {
        if (!allRegisteredUsers.has(String(uid))) {
          allRegisteredUsers.set(String(uid), uData);
        } else {
          const existing = allRegisteredUsers.get(String(uid));
          allRegisteredUsers.set(String(uid), { ...uData, ...existing });
        }
      }
    }

    // También incluir miembros de sesiones activas de Rivals
    for (const grp of Object.keys(GROUP_CONFIG)) {
      const sessions = await getRivalsSessionsByGroup(grp);
      for (const s of sessions) {
        for (const m of s.members || []) {
          if (m.discordId && !allRegisteredUsers.has(String(m.discordId))) {
            allRegisteredUsers.set(String(m.discordId), {
              name: m.name,
              heartbeatName: m.heartbeatName || m.name
            });
          }
        }
      }
    }

    const newSharingMap = new Map();

    for (const entry of greenEntries) {
      let matchedDiscordId = null;

      // A. Si el panel tenía mención directa <@ID>
      if (entry.mentionedDiscordId && allRegisteredUsers.has(String(entry.mentionedDiscordId))) {
        matchedDiscordId = String(entry.mentionedDiscordId);
      } else if (entry.mentionedDiscordId && guild) {
        // Si es una mención pero necesitamos su nombre de usuario de Discord para comparar con los registros
        const member =
          guild.members.cache.get(entry.mentionedDiscordId) ||
          (await guild.members.fetch(entry.mentionedDiscordId).catch(() => null));
        if (member) {
          const memberNames = [member.displayName, member.user.username, member.user.globalName].filter(Boolean);
          for (const [uid, uData] of allRegisteredUsers.entries()) {
            if (memberNames.some((mName) => isFuzzyUserMatch(mName, uData, 0.78))) {
              matchedDiscordId = String(uid);
              break;
            }
          }
        }
      }

      // B. Comparación difusa por nombre visible (@creeeder91 vs creeder, @HT vs HT, etc.)
      if (!matchedDiscordId && entry.rawName && !entry.rawName.startsWith("<@")) {
        let bestUid = null;
        let bestScore = 0;

        for (const [uid, uData] of allRegisteredUsers.entries()) {
          const candidates = getUserNameCandidates(uData);
          for (const cand of candidates) {
            const score = calculateNameSimilarity(entry.rawName, cand);
            if (score >= 0.78 && score > bestScore) {
              bestScore = score;
              bestUid = String(uid);
            }
          }
        }

        if (bestUid) {
          matchedDiscordId = bestUid;
        }
      }

      if (matchedDiscordId) {
        const current = newSharingMap.get(matchedDiscordId) || {
          hosts: [],
          ready: 0,
          total: 0
        };
        if (!current.hosts.includes(entry.hostName)) {
          current.hosts.push(entry.hostName);
        }
        current.ready += entry.ready;
        current.total += entry.total;
        newSharingMap.set(matchedDiscordId, current);
      }
    }

    activeSharingUsersMap.clear();
    const redisPayload = {};
    for (const [uid, info] of newSharingMap.entries()) {
      activeSharingUsersMap.set(uid, info);
      redisPayload[uid] = info;
    }

    await redis.set(SHARING_USERS_KEY, JSON.stringify(redisPayload)).catch(() => {});
    console.log(`🔄 [Farm Host Scanner] Active sharing users detected (🟢): ${activeSharingUsersMap.size}`);
  } catch (err) {
    console.error("❌ Error scanning GP Farm Host panel:", err);
  }
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
  
  const now = Date.now();

  let lastStopData = {};
  try {
    const rawStops = await redis.hgetall("last_stopppm");
    if (rawStops && typeof rawStops === "object") lastStopData = rawStops;
  } catch (err) {}

  // 1. Standard Group Online Users
  for (const [discordId, rawUser] of Object.entries(users)) {
    const mainId = normalizeId(rawUser.main_id);
    const secId = normalizeId(rawUser.sec_id);
    const isOnline = onlineIds.has(mainId) || (secId && onlineIds.has(secId));

    if (!isOnline) continue;

    const sharingInfo = activeSharingUsersMap.get(String(discordId)) || null;
    const isSharing = Boolean(sharingInfo);

    const userMessages = findLastMessagesForUserMultiPC(messages, rawUser);
    const userLastStop = Number(lastStopData[discordId]) || 0;
    
    const validMessages = userMessages.filter(msg => 
      (now - msg.createdTimestamp) <= HEARTBEAT_TIMEOUT_MS &&
      msg.createdTimestamp > userLastStop
    );

    const stats = (!isSharing && validMessages.length)
      ? mergeStatsFromMessages(validMessages)
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
      rivalTag: "",
      isSharing,
      sharingInfo
    });

    if (!isSharing && stats.ppm > MASSIVE_PPM_THRESHOLD) {
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

      const sharingInfo = activeSharingUsersMap.get(String(member.discordId)) || null;
      const isSharing = Boolean(sharingInfo);

      const userMessages = findLastMessagesForUserMultiPC(messages, rivalUserData);
      const userLastStop = Number(lastStopData[member.discordId]) || 0;
      
      const validMessages = userMessages.filter(msg => 
        (now - msg.createdTimestamp) <= HEARTBEAT_TIMEOUT_MS &&
        msg.createdTimestamp > userLastStop
      );

      const stats = (!isSharing && validMessages.length)
        ? mergeStatsFromMessages(validMessages)
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
        rivalTag: isTurnActive ? "🤝 Rivals • 🟢 Active Turn" : "🤝 Rivals • ⏳ Standby",
        isSharing,
        sharingInfo
      });

      if (!isSharing && stats.ppm > MASSIVE_PPM_THRESHOLD) {
        highPpmUsers.push({
          discordId: member.discordId,
          name: rivalUserData.name || member.name || "Rival",
          ppm: stats.ppm,
          activeInstances: activeInst
        });
      }
    }
  }

  if (panelChannel && highPpmUsers.length > 0) {
    await checkAndTriggerMassiveRerollAlert(group, panelChannel, highPpmUsers);
  }

  // Ordenar: primero los usuarios con packs/PPM más altos, luego los que están en modo Sharing
  processedOnlineUsers.sort((a, b) => {
    if (a.isSharing !== b.isSharing) return a.isSharing ? 1 : -1;
    return b.stats.packs - a.stats.packs || b.stats.ppm - a.stats.ppm;
  });

  const onlineLines = processedOnlineUsers.map((u, index) => {
    const rankIcon = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "⚔️";
    const rivalBadge = u.isRival ? ` *(${u.rivalTag})*` : "";

    // Si el usuario tiene el círculo verde en el panel de GP Farm Host (Sharing)
    if (u.isSharing) {
      return (
        `🎲 **${u.name}**${rivalBadge} \`🟢 SHARING\`\n` +
        `┗ 🔗 \`Account Sharing Active\`  •  🖥️ \`GP Farm Host (Monitor Link ON)\``
      );
    }

    const multiPcTag = u.stats.pcCount > 1 ? " `🖥️ 2-PC`" : "";
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

  const usersEmbed = new EmbedBuilder()
    .setTitle(`🟢 Active Rerollers — ${config.label} (${processedOnlineUsers.length})`)
    .setColor(farmMode ? 0xf1c40f : 0x2ecc71)
    .setDescription(
      onlineLines.length > 0
        ? onlineLines.join("\n\n").slice(0, 4000)
        : "*⚫ No users currently online in this group.*"
    );

  const globalEmbed = new EmbedBuilder()
    .setTitle(`📊 Global Telemetry — ${config.label}`)
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
      { name: "🖥️ Active Instances", value: `**${global.instancesDisplay}**`, inline: true },
      { name: "📊 Avg Inst / User", value: `**${global.avgInstances}**`, inline: true },
      { name: "🎯 Est. GP / Hour", value: `**${global.gpPerHour}**`, inline: true },
      { name: "⏱️ Est. Min / GP", value: `**${global.minutesToGP} min**`, inline: true },
      { name: "🌟 GP Today", value: `**${gp.todayGP} GP**\n💖 **${gp.todayAlive} Alive** (\`${gp.todayRate}%\`)`, inline: true },
      { name: "💫 Total (5 Days)", value: `**${gp.totalGP} GP**\n💖 **${gp.totalAlive} Alive**`, inline: true },
      { name: "📅 Last 5 Days History", value: gp.historyText, inline: false }
    )
    .setFooter({ text: "Auto-updates every 5 mins • Multi-PC, Rivals 2.0 & Account Sharing Enabled" })
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
      await redis.hset("last_stopppm", { [targetUser.id]: Date.now() });
      
      await message.reply(`✅ El PPM y las instancias de **${targetUser.username}** han sido forzados a **0**.\n*(Sus reportes anteriores han sido invalidados. Si envía un nuevo heartbeat, el panel volverá a contar desde cero).*`);
      
      updateAllPanels();
    } catch (err) {
      console.error("Error al usar !stopppm:", err);
      message.reply("❌ Ocurrió un error al intentar detener el PPM.");
    }
  }
});

// ================= LOAD ALERTS & RANKING MODULES =================

require("./alerts")(client, {
  GROUP_CONFIG,
  CHAMPION_ROLE_ID,
  PUBLIC_ALERTS_CHANNEL_ID,
  FARM_HOST_CHANNEL_ID,
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

  // Escaneo inicial del panel de GP Farm Host (Sharing) y actualización de paneles
  await scanFarmHostSharingPanel();
  await updateAllPanels();
  await storeAllPPM();

  // Escanear el panel de GP Farm Host cada 20 minutos
  setInterval(async () => {
    await scanFarmHostSharingPanel();
    await updateAllPanels();
  }, SCAN_SHARING_INTERVAL);

  setInterval(updateAllPanels, UPDATE_PANEL_INTERVAL);
  setInterval(storeAllPPM, STORE_PPM_INTERVAL);
});

client.login(TOKEN);
