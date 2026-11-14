const {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} = require("discord.js");
const { Redis } = require("@upstash/redis");

// Motor OCR para leer los nombres directamente de la imagen del Host (farm-4.jpg)
let Tesseract = null;
try {
  Tesseract = require("tesseract.js");
} catch {
  console.warn("⚠️ 'tesseract.js' no está instalado. Agrégalo a tu package.json o ejecuta 'npm install tesseract.js'.");
}

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

// ID del canal donde se publica la imagen del Host (farm-4.jpg)
const FARM_HOST_CHANNEL_ID = process.env.FARM_HOST_CHANNEL_ID || PUBLIC_ALERTS_CHANNEL_ID;

const FARM_MODE_KEY = "system:farm_mode";
const SHARING_USERS_KEY = "active_sharing_users";

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
const SCAN_SHARING_INTERVAL = 20 * 60 * 1000;
const MASSIVE_PPM_THRESHOLD = 15.0;
const MASSIVE_ALERT_COOLDOWN = 2 * 60 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 30 * 60 * 1000;
const ZEKROM_HOST_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos máximo para considerar activo a Zekrom-Host

const massivePpmCooldowns = new Map();
const activeSharingUsersMap = new Map();
const ocrImageCache = new Map();

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

// Verifica si un miembro tiene el rol "Legend" (Sharing Proxies)
function hasLegendRole(member) {
  if (!member?.roles?.cache) return false;
  if (LEGEND_ROLE_ID && member.roles.cache.has(LEGEND_ROLE_ID)) return true;
  return member.roles.cache.some((r) => r.name.trim().toLowerCase() === "legend");
}

// ================= FUZZY NAME MATCHING & OCR IMAGE HOST SCANNER =================

function cleanNameForComparison(str) {
  return String(str || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[*_`~|>@#]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function simplifyRootName(str) {
  const cleaned = cleanNameForComparison(str);
  const collapsed = cleaned.replace(/(.)\1+/g, "$1");
  const stripped = collapsed.replace(/(?:[p_-]?\d{1,4}|[_-]?(?:main|alt|bot|host|gp|pc\d*))$/i, "");
  return stripped.length >= 2 ? stripped : collapsed;
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
  if (rootA && rootB && rootA === rootB && rootA.length >= 2) {
    return 0.96;
  }

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 2 && (longer.startsWith(shorter) || longer.includes(shorter))) {
    const ratio = shorter.length / longer.length;
    if (ratio >= 0.50) return 0.90;
  }
  if (rootA.length >= 2 && rootB.length >= 2 && (rootA.includes(rootB) || rootB.includes(rootA))) {
    return 0.88;
  }

  const maxLen = Math.max(a.length, b.length);
  const dist = levenshteinDistance(a, b);
  const scoreFull = 1 - dist / maxLen;

  const maxRootLen = Math.max(rootA.length, rootB.length);
  const distRoot = levenshteinDistance(rootA, rootB);
  const scoreRoot = maxRootLen > 0 ? 1 - distRoot / maxRootLen : 0;

  return Math.max(scoreFull, scoreRoot);
}

function extractImageUrlsFromMessage(msg) {
  if (!msg) return [];
  const urls = [];

  if (msg.attachments?.size > 0) {
    for (const att of msg.attachments.values()) {
      const ct = (att.contentType || "").toLowerCase();
      const fn = (att.name || "").toLowerCase();
      if (ct.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(fn)) {
        urls.push(att.url);
      }
    }
  }

  if (Array.isArray(msg.embeds)) {
    for (const emb of msg.embeds) {
      if (emb.image?.url) urls.push(emb.image.url);
      if (emb.thumbnail?.url) urls.push(emb.thumbnail.url);
    }
  }

  return urls;
}

function parseOcrTextFromFarmImage(ocrText) {
  if (!ocrText) return [];
  const text = String(ocrText);

  if (!/god\s*pack\s*farm|members\s*online|dual\s*fusion|own\s*accounts|opened\s*\/\s*total|left\s*now/i.test(text)) {
    return [];
  }

  let hostName = "Farm Host";
  const hostMatch = text.match(/Host\s+([a-zA-Z0-9_-]+)/i);
  if (hostMatch) hostName = hostMatch[1].trim();

  const entries = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const ignoreWords = new Set([
    "membersonline",
    "members",
    "online",
    "opened",
    "total",
    "left",
    "leftnow",
    "accounts",
    "godpackfarm",
    "dualfusion",
    "megamewtwox",
    "host",
    "pocket",
    "pokemon",
    "tradingcardgame"
  ]);

  let insideTable = false;

  for (const line of lines) {
    if (/members\s*online/i.test(line)) {
      insideTable = true;
      continue;
    }
    if (/^total\b/i.test(line)) {
      break;
    }

    const rowMatch = line.match(/^\s*(\d{1,2})\s+([^\d\s|—–\-]+(?:\s+[^\d\s|—–\-]+)?)/);
    if (rowMatch) {
      const rankNum = Number(rowMatch[1]);
      const rawCandidate = rowMatch[2].replace(/[|—–\-_]+$/g, "").trim();
      const cleanCand = cleanNameForComparison(rawCandidate);

      if (rankNum >= 1 && rankNum <= 50 && cleanCand.length >= 2 && !ignoreWords.has(cleanCand)) {
        entries.push({
          hostName,
          mentionedDiscordId: null,
          rawName: rawCandidate,
          ready: 0,
          total: 0
        });
        continue;
      }
    }

    if (insideTable) {
      const tokens = line.split(/\s+/);
      const firstWord = tokens[0]?.replace(/^\d+/, "").trim();
      const cleanFirst = cleanNameForComparison(firstWord);
      const hasNumbersAtEnd = /\d+\s*$/.test(line);

      if (
        firstWord &&
        cleanFirst.length >= 2 &&
        !ignoreWords.has(cleanFirst) &&
        !/^\d+$/.test(cleanFirst) &&
        hasNumbersAtEnd
      ) {
        entries.push({
          hostName,
          mentionedDiscordId: null,
          rawName: firstWord,
          ready: 0,
          total: 0
        });
      }
    }
  }

  return entries;
}

async function extractEntriesFromFarmImage(imageUrl) {
  if (!Tesseract || !imageUrl) return [];

  if (ocrImageCache.has(imageUrl)) {
    return ocrImageCache.get(imageUrl);
  }

  try {
    const { data } = await Tesseract.recognize(imageUrl, "eng");
    const parsed = parseOcrTextFromFarmImage(data?.text || "");

    if (ocrImageCache.size > 40) {
      const oldestKey = ocrImageCache.keys().next().value;
      ocrImageCache.delete(oldestKey);
    }
    ocrImageCache.set(imageUrl, parsed);
    return parsed;
  } catch (err) {
    console.error("❌ Error ejecutando OCR en imagen del Host:", err.message);
    return [];
  }
}

function parseFarmHostPanelMessage(msg) {
  if (!msg) return [];
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
      const footerText = emb.footer?.text || "";
      blocks.push({ title, text: `${title}\n${desc}\n${fieldsText}\n${footerText}` });
    }
  }

  for (const block of blocks) {
    if (!/gp\s*farm\s*host|monitor\s*link|shared\s*accounts|own\s*accounts|members\s*online/i.test(block.text)) continue;

    let hostName = "Farm Host";
    const hostMatch =
      block.title.match(/([a-zA-Z0-9_-]+)\s*[—–\-]+\s*GP\s*farm\s*host/i) ||
      block.text.match(/([a-zA-Z0-9_-]+)\s*[—–\-]+\s*GP\s*farm\s*host/i) ||
      block.text.match(/Host\s+([a-zA-Z0-9_-]+)/i);
    if (hostMatch) hostName = hostMatch[1].trim();

    const lines = block.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/monitor\s*link\s*on/i.test(line) || /ready\s*=\s*can\s*open/i.test(line)) continue;

      const isGreen =
        /^[\s>*\-•]*(?:🟢|🟩|:green_circle:|<a?:[a-z0-9_]*green[a-z0-9_]*:\d+>)/i.test(line);

      if (!isGreen) continue;

      const rest = line
        .replace(/^[\s>*\-•]*(?:🟢|🟩|:green_circle:|<a?:[a-z0-9_]+:\d+>)[\s*]*/i, "")
        .trim();

      let mentionedDiscordId = null;
      const mentionMatch = rest.match(/<@!?(\d{17,20})>/);
      if (mentionMatch) {
        mentionedDiscordId = mentionMatch[1];
      }

      const parts = rest.split(/\s*(?:[—–\-]+)\s*(?=\**\d+\s*\/)/);
      const rawUserPart = (parts[0] || rest.split(/\s+[—–\-]\s+/)[0] || "")
        .replace(/<@!?\d{17,20}>/g, "")
        .replace(/[*_`~]/g, "")
        .replace(/^@+/, "")
        .trim();

      let ready = 0;
      let total = 0;
      const countMatch = rest.replace(/\*/g, "").match(/(\d+)\s*\/\s*(\d+)/);
      if (countMatch) {
        ready = Number(countMatch[1]) || 0;
        total = Number(countMatch[2]) || 0;
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

    if (FARM_HOST_CHANNEL_ID) {
      const ch = await client.channels.fetch(FARM_HOST_CHANNEL_ID).catch(() => null);
      if (ch && ch.isTextBased()) candidateChannels.set(ch.id, ch);
    }

    const guild = client.guilds.cache.first();
    if (guild) {
      await guild.members.fetch().catch(() => {});
      for (const ch of guild.channels.cache.values()) {
        if (
          ch.isTextBased() &&
          !ch.name.startsWith("personal-") &&
          /farm|host|share|sharing|arcade|zekrom|monitor|status|alert/i.test(ch.name)
        ) {
          candidateChannels.set(ch.id, ch);
        }
      }
    }

    const latestHostEntries = new Map();

    for (const ch of candidateChannels.values()) {
      const msgs = await ch.messages.fetch({ limit: 15 }).catch(() => null);
      if (!msgs) continue;

      const sortedMsgs = Array.from(msgs.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      for (const msg of sortedMsgs) {
        let parsed = parseFarmHostPanelMessage(msg);

        if (parsed.length === 0) {
          const imgUrls = extractImageUrlsFromMessage(msg);
          for (const url of imgUrls) {
            const ocrEntries = await extractEntriesFromFarmImage(url);
            if (ocrEntries.length > 0) {
              parsed.push(...ocrEntries);
            }
          }
        }

        if (parsed.length > 0) {
          for (const item of parsed) {
            const hKey = item.hostName.toLowerCase();
            if (!latestHostEntries.has(hKey)) {
              latestHostEntries.set(hKey, { msgId: msg.id, ts: msg.createdTimestamp, list: [] });
            }
            if (latestHostEntries.get(hKey).msgId === msg.id) {
              latestHostEntries.get(hKey).list.push(item);
            }
          }
        }
      }

      if (latestHostEntries.size > 0 && ch.id === FARM_HOST_CHANNEL_ID) break;
    }

    const detectedEntries = [];
    for (const hostGroup of latestHostEntries.values()) {
      detectedEntries.push(...hostGroup.list);
    }

    const allRegisteredUsers = new Map();
    const allPossibleRedisGroups = ["Elite_Four", "Gym_Leader", "Rivals", "Trainer"];

    for (const grp of allPossibleRedisGroups) {
      const gUsers = await getUsers(grp);
      for (const [uid, uData] of Object.entries(gUsers)) {
        const existing = allRegisteredUsers.get(String(uid)) || {};
        const member = guild?.members?.cache?.get(String(uid));
        const extraAliases = member
          ? [member.displayName, member.user.username, member.user.globalName].filter(Boolean)
          : [];
        allRegisteredUsers.set(String(uid), {
          ...uData,
          ...existing,
          aliases: [
            ...(Array.isArray(uData.aliases) ? uData.aliases : []),
            ...(Array.isArray(existing.aliases) ? existing.aliases : []),
            ...extraAliases
          ]
        });
      }
    }

    const newSharingMap = new Map();

    for (const entry of detectedEntries) {
      let matchedDiscordId = null;
      const searchNames = [];

      if (entry.rawName) searchNames.push(entry.rawName);

      if (entry.mentionedDiscordId) {
        if (allRegisteredUsers.has(String(entry.mentionedDiscordId))) {
          matchedDiscordId = String(entry.mentionedDiscordId);
        } else if (guild) {
          const mentionedMember =
            guild.members.cache.get(String(entry.mentionedDiscordId)) ||
            (await guild.members.fetch(String(entry.mentionedDiscordId)).catch(() => null));
          if (mentionedMember) {
            searchNames.push(
              mentionedMember.displayName,
              mentionedMember.user.username,
              mentionedMember.user.globalName
            );
          }
        }
      }

      if (!matchedDiscordId) {
        let bestUid = null;
        let bestScore = 0;

        for (const sName of searchNames.filter(Boolean)) {
          for (const [uid, uData] of allRegisteredUsers.entries()) {
            const candidates = getUserNameCandidates(uData);
            for (const cand of candidates) {
              const score = calculateNameSimilarity(sName, cand);
              if (score >= 0.72 && score > bestScore) {
                bestScore = score;
                bestUid = String(uid);
              }
            }
          }
        }

        if (bestUid) {
          matchedDiscordId = bestUid;
        } else if (entry.mentionedDiscordId) {
          matchedDiscordId = String(entry.mentionedDiscordId);
        }
      }

      if (matchedDiscordId) {
        const current = newSharingMap.get(matchedDiscordId) || {
          type: "accounts",
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

    if (guild) {
      for (const [uid] of allRegisteredUsers.entries()) {
        const member = guild.members.cache.get(String(uid));
        if (member && hasLegendRole(member) && !newSharingMap.has(String(uid))) {
          newSharingMap.set(String(uid), {
            type: "proxies",
            hosts: ["Legend Proxy Node"],
            ready: 0,
            total: 0
          });
        }
      }
    }

    activeSharingUsersMap.clear();
    const redisPayload = {};
    for (const [uid, info] of newSharingMap.entries()) {
      activeSharingUsersMap.set(uid, info);
      redisPayload[uid] = info;
    }

    await redis.set(SHARING_USERS_KEY, JSON.stringify(redisPayload)).catch(() => {});
    console.log(
      `🔄 [Host Image & Text Scanner] Entries parsed: ${detectedEntries.length} | Matched sharing users: ${activeSharingUsersMap.size}`,
      Array.from(activeSharingUsersMap.keys())
    );
  } catch (err) {
    console.error("❌ Error scanning GP Farm Host panel:", err);
  }
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

  return {
    time: timeMatch?.[1]?.trim() || "0m",
    packs: Number(packsMatch?.[1] || 0),
    ppm: Number(avgMatch?.[1] || 0)
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
 * Si tiene más de 15 minutos de antigüedad (ZEKROM_HOST_TIMEOUT_MS), se considera OFFLINE (retorna null).
 */
function findZekromHostStats(messages, now) {
  if (!messages || !Array.isArray(messages)) return null;

  for (const msg of messages) {
    const content = getMessageText(msg);
    if (!content) continue;

    const rawHbName = extractHeartbeatName(content);
    const normHbName = normalizeHeartbeatName(rawHbName);

    if (normHbName === "zekrom-host" || normHbName === "zekromhost" || normHbName === "zekrom host") {
      // Si el último heartbeat de Zekrom-Host tiene más de 15 minutos, ya está OFFLINE
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

// ================= PANEL GENERATOR (ZEKROM-HOST + SHARING ACCOUNTS / PROXIES) =================

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

  // Detectar si llegó un heartbeat de "Zekrom-Host" en los últimos 15 minutos
  const zekromStats = findZekromHostStats(messages, now);

  let lastStopData = {};
  try {
    const rawStops = await redis.hgetall("last_stopppm");
    if (rawStops && typeof rawStops === "object") lastStopData = rawStops;
  } catch (err) {}

  for (const [discordId, rawUser] of Object.entries(users)) {
    const mainId = normalizeId(rawUser.main_id);
    const secId = normalizeId(rawUser.sec_id);
    const isOnline = onlineIds.has(mainId) || (secId && onlineIds.has(secId));

    if (!isOnline) continue;

    // Si este usuario tenía configurado "Zekrom-Host" como su heartbeatName, lo saltamos de la lista normal
    // porque Zekrom-Host se evalúa con su regla exclusiva de 15 minutos arriba
    const isZekromUser = getUserNameCandidates(rawUser).some((c) => {
      const n = normalizeHeartbeatName(c);
      return n === "zekrom-host" || n === "zekromhost" || n === "zekrom host";
    });
    if (isZekromUser) continue;

    // Verificar si el usuario tiene el rol Legend -> Sharing Proxies
    const member =
      guild?.members?.cache?.get(String(discordId)) ||
      (guild ? await guild.members.fetch(String(discordId)).catch(() => null) : null);
    const isLegendProxy = hasLegendRole(member);

    // Verificar si salió en la imagen del Host -> Sharing Accounts
    const hostShareInfo = activeSharingUsersMap.get(String(discordId)) || null;
    const isAccountSharing = Boolean(hostShareInfo && hostShareInfo.type === "accounts");

    let shareMode = null; // "proxies" | "accounts" | null
    if (isLegendProxy) {
      shareMode = "proxies";
      sharingProxiesCount++;
    } else if (isAccountSharing) {
      shareMode = "accounts";
      sharingAccountsCount++;
    }

    const userMessages = findLastMessagesForUserMultiPC(messages, rawUser);
    const userLastStop = Number(lastStopData[discordId]) || 0;

    const validMessages = userMessages.filter(
      (msg) =>
        now - msg.createdTimestamp <= HEARTBEAT_TIMEOUT_MS &&
        msg.createdTimestamp > userLastStop
    );

    const stats =
      !shareMode && validMessages.length
        ? mergeStatsFromMessages(validMessages)
        : { time: "0m", packs: 0, ppm: 0, pcCount: 0 };

    onlineStats.push(stats);

    processedOnlineUsers.push({
      discordId,
      name: rawUser.name || "Unknown",
      stats,
      shareMode,
      hostShareInfo
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

  // Ordenar: primero los usuarios con packs/PPM, luego Sharing Proxies y Sharing Accounts
  processedOnlineUsers.sort((a, b) => {
    const aIsSharing = Boolean(a.shareMode);
    const bIsSharing = Boolean(b.shareMode);
    if (aIsSharing !== bIsSharing) return aIsSharing ? 1 : -1;
    return b.stats.packs - a.stats.packs || b.stats.ppm - a.stats.ppm;
  });

  const onlineLines = [];

  // Si hay un heartbeat de Zekrom-Host de hace <= 15 minutos, mostrar Zekrom host running y su PPM
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
    .setFooter({ text: "Auto-updates every 5 mins • Headless System (Zekrom-Host 15m Timeout & OCR Sharing)" })
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

// ================= COMANDOS DE CHAMPION & ACTUALIZACIÓN EN TIEMPO REAL DEL HOST =================

async function handlePossibleHostPanelUpdate(msg) {
  try {
    if (!msg) return;
    const textParsed = parseFarmHostPanelMessage(msg);
    const hasImages = extractImageUrlsFromMessage(msg).length > 0;

    if (textParsed.length > 0 || (hasImages && msg.channel?.id === FARM_HOST_CHANNEL_ID)) {
      await scanFarmHostSharingPanel();
      await updateAllPanels();
    }
  } catch (e) {}
}

client.on("messageCreate", async (message) => {
  handlePossibleHostPanelUpdate(message);

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

client.on("messageUpdate", (_oldMsg, newMsg) => {
  handlePossibleHostPanelUpdate(newMsg);
});

// ================= LOAD ALERTS MODULE =================

require("./alerts")(client, {
  GROUP_CONFIG,
  CHAMPION_ROLE_ID,
  LEGEND_ROLE_ID,
  PUBLIC_ALERTS_CHANNEL_ID,
  FARM_HOST_CHANNEL_ID,
  GLOBAL_HEARTBEAT_CHANNEL_ID,
  PERSONAL_CATEGORY_ID,
  redis,
  onFarmModeChanged: updateAllPanels
});

// ================= START =================

client.once("ready", async () => {
  console.log(`✅ Headless Telemetry & Alerts Bot connected as: ${client.user.tag}`);

  client.statsPanelMessages = new Map();
  client.lastTotalPPMByGroup = new Map();

  await scanFarmHostSharingPanel();
  await updateAllPanels();
  await storeAllPPM();

  setInterval(async () => {
    await scanFarmHostSharingPanel();
    await updateAllPanels();
  }, SCAN_SHARING_INTERVAL);

  setInterval(updateAllPanels, UPDATE_PANEL_INTERVAL);
  setInterval(storeAllPPM, STORE_PPM_INTERVAL);
});

client.login(TOKEN);
