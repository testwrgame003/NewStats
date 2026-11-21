const {
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType
} = require("discord.js");

// ================= GLOBAL CONFIGURATION =================
const ENABLE_DOUBLE_REROLL_ALERTS = false; // 🛑 Cambia a true para REACTIVAR la detección de Double Reroll

const PERSONAL_CHANNELS_CATEGORY_ID = "1565623831203287150";
const HEARTBEAT_SILENCE_TIMEOUT_MS = 40 * 60 * 1000;
const ONLINE_GRACE_PERIOD_MS = 15 * 60 * 1000;

const PERSONAL_STATE_KEY = "personal_channel_state";
const FARM_MODE_KEY = "system:farm_mode";

// Cachés en memoria para minimizar comandos a Upstash
const USERS_CACHE = new Map();
const USERS_CACHE_TTL = 15 * 60 * 1000; // 15 minutos

const ONLINE_CACHE = new Map();
const ONLINE_CACHE_TTL = 2 * 60 * 1000; // 2 minutos

let FARM_MODE_CACHE = { ts: 0, val: false };
const FARM_MODE_TTL = 5 * 60 * 1000; // 5 minutos

const PERSONAL_STATE_CACHE = new Map();
let personalStateHydrated = false;

const MULTI_PC_CACHE = new Map();

// ================= REDIS HELPERS =================

const usersKey = (group) => `users:${group}`;
const onlineKey = (group) => `online:${group}`;

function safeJsonParse(value, fallback = {}) {
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

function normalizeName(value) {
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

function namesMatchMultiPC(heartbeatName, registeredName) {
  const hb = normalizeName(heartbeatName);
  const reg = normalizeName(registeredName);
  if (!hb || !reg) return false;
  if (hb === reg) return true;

  const hbBase = stripSecondPcSuffix(hb);
  const regBase = stripSecondPcSuffix(reg);
  if (hbBase === reg || hb === regBase || (hbBase.length >= 3 && hbBase === regBase)) {
    return true;
  }
  return false;
}

function hasLegendRole(member, legendRoleId) {
  if (!member?.roles?.cache) return false;
  if (legendRoleId && member.roles.cache.has(legendRoleId)) return true;
  return member.roles.cache.some((r) => r.name.trim().toLowerCase() === "legend");
}

async function isFarmModeActive(redis, force = false) {
  const now = Date.now();
  if (!force && now - FARM_MODE_CACHE.ts < FARM_MODE_TTL) {
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

async function setFarmMode(redis, enabled) {
  await redis.set(FARM_MODE_KEY, enabled ? "true" : "false");
  FARM_MODE_CACHE = { ts: Date.now(), val: Boolean(enabled) };
}

function defaultPersonalState() {
  return {
    channelId: null,
    heartbeatMsgId: null,
    offlineMsgId: null,
    kickReasonMsgId: null,
    wasOnline: false,
    onlineSince: 0,
    lastOnlineGroup: null,
    lastHeartbeatAt: 0
  };
}

async function hydratePersonalStates(redis) {
  if (personalStateHydrated) return;
  try {
    const allRaw = await redis.hgetall(PERSONAL_STATE_KEY);
    if (allRaw && typeof allRaw === "object") {
      for (const [uid, raw] of Object.entries(allRaw)) {
        PERSONAL_STATE_CACHE.set(String(uid), { ...defaultPersonalState(), ...safeJsonParse(raw, {}) });
      }
    }
    personalStateHydrated = true;
  } catch (err) {
    console.error("Error hydrating personal states:", err);
  }
}

async function getPersonalState(redis, discordId) {
  await hydratePersonalStates(redis);
  const key = String(discordId);
  if (!PERSONAL_STATE_CACHE.has(key)) {
    PERSONAL_STATE_CACHE.set(key, defaultPersonalState());
  }
  return PERSONAL_STATE_CACHE.get(key);
}

async function savePersonalState(redis, discordId, state) {
  const key = String(discordId);
  PERSONAL_STATE_CACHE.set(key, state);
  try {
    await redis.hset(PERSONAL_STATE_KEY, { [key]: JSON.stringify(state) });
  } catch (err) {
    console.error("Error saving personal state:", err);
  }
}

async function loadUsers(redis, group) {
  const now = Date.now();
  const cached = USERS_CACHE.get(group);
  if (cached && now - cached.ts < USERS_CACHE_TTL) return cached.data;

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
}

async function loadOnlineIDs(redis, group, force = false) {
  const now = Date.now();
  const cached = ONLINE_CACHE.get(group);
  if (!force && cached && now - cached.ts < ONLINE_CACHE_TTL) return cached.data;

  const ids = await redis.smembers(onlineKey(group));
  const clean = Array.isArray(ids) ? ids.map(normalizeId).filter((x) => /^\d{16}$/.test(x)) : [];
  ONLINE_CACHE.set(group, { ts: now, data: clean });
  return clean;
}

async function removeOnlineIDs(redis, group, ids) {
  const cleanIds = ids.map(normalizeId).filter((x) => /^\d{16}$/.test(x));
  if (!cleanIds.length) return;
  await redis.srem(onlineKey(group), ...cleanIds);
  const cached = ONLINE_CACHE.get(group);
  if (cached) {
    const removeSet = new Set(cleanIds);
    cached.data = cached.data.filter((id) => !removeSet.has(id));
  }
}

function getUserGameIds(userData) {
  const ids = [];
  const mainId = normalizeId(userData?.main_id || userData?.gameId);
  const secId = normalizeId(userData?.sec_id);
  if (/^\d{16}$/.test(mainId)) ids.push(mainId);
  if (/^\d{16}$/.test(secId)) ids.push(secId);
  return [...new Set(ids)];
}

function isUserOnlineInGroup(userData, onlineIds) {
  const set = new Set(onlineIds.map(normalizeId));
  return getUserGameIds(userData).some((id) => set.has(id));
}

async function findUserByGameId(redis, GROUP_CONFIG, targetGameId) {
  const cleanTarget = normalizeId(targetGameId);
  if (!/^\d{16}$/.test(cleanTarget)) return null;

  for (const group of Object.keys(GROUP_CONFIG)) {
    const users = await loadUsers(redis, group);
    for (const [discordId, uData] of Object.entries(users)) {
      const gameIds = getUserGameIds(uData);
      if (gameIds.includes(cleanTarget)) {
        return { discordId, userData: uData, group };
      }
    }
  }
  return null;
}

// ================= HEARTBEAT PARSERS =================

function getMessageText(message) {
  let content = message.content || "";
  if ((!content || content.trim() === "") && message.embeds?.length > 0) {
    const embed = message.embeds[0];
    content =
      (embed.title ? `${embed.title}\n` : "") +
      (embed.description || "") +
      (embed.fields?.map((f) => `\n${f.name}\n${f.value}`).join("\n") || "");
  }
  return String(content || "").replace(/```/g, "").trim();
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

function parseSingleHeartbeat(content) {
  const text = String(content || "");
  const timeMatch = text.match(/Time:\s*([^\n\r]+?)\s+Packs:/i);
  const packsMatch = text.match(/Packs:\s*(\d+)/i);
  const avgMatch = text.match(/Avg:\s*([\d.]+)\s*packs?\s*\/?\s*min/i) || text.match(/Avg:\s*([\d.]+)/i);
  const typeMatch = text.match(/Type:\s*([^\n\r]+)/i);
  const onlineMatch = text.match(/Online:\s*([^\n\r]+)/i);

  const onlineRaw = onlineMatch
    ? onlineMatch[1].split(",").map((x) => x.trim()).filter(Boolean)
    : [];
  const mainOnline = onlineRaw.some((x) => x.toLowerCase() === "main");
  const activeNumericCount = onlineRaw.filter((x) => /^\d+$/.test(x)).length;

  return {
    time: timeMatch?.[1]?.trim() || "0m",
    packs: Number(packsMatch?.[1] || 0),
    ppm: Number(avgMatch?.[1] || 0),
    type: typeMatch?.[1]?.trim() || "Headless",
    mainOnline,
    activeNumericCount
  };
}

function updateAndMergeUserMultiPC(discordId, rawHbName, registeredUserData, content) {
  const now = Date.now();
  if (!MULTI_PC_CACHE.has(discordId)) {
    MULTI_PC_CACHE.set(discordId, new Map());
  }
  const userMap = MULTI_PC_CACHE.get(discordId);

  const normHb = normalizeName(rawHbName);
  const regCandidates = [
    registeredUserData.name,
    registeredUserData.heartbeatName,
    ...(Array.isArray(registeredUserData.aliases) ? registeredUserData.aliases : [])
  ].filter(Boolean);

  const isPC2 =
    /[-_\s]*2$/.test(normHb) &&
    !regCandidates.some((c) => normalizeName(c) === normHb);

  const slotKey = isPC2 ? "PC2" : "PC1";
  const parsed = parseSingleHeartbeat(content);

  userMap.set(slotKey, {
    rawName: rawHbName,
    stats: parsed,
    content,
    ts: now
  });

  for (const [k, v] of userMap.entries()) {
    if (now - v.ts > 25 * 60 * 1000) {
      userMap.delete(k);
    }
  }

  let totalPacks = 0;
  let totalPPM = 0;
  let totalNumericInstances = 0;
  let latestTime = parsed.time;
  let typeStr = parsed.type;
  let mainOnline = false;
  const activeSources = [];

  for (const [, v] of userMap.entries()) {
    totalPacks += v.stats.packs;
    totalPPM += v.stats.ppm;
    totalNumericInstances += v.stats.activeNumericCount;
    if (v.stats.time && v.stats.time !== "0m") latestTime = v.stats.time;
    if (v.stats.mainOnline) mainOnline = true;
    activeSources.push(v.rawName);
  }

  return {
    packs: totalPacks,
    ppm: Number(totalPPM.toFixed(2)),
    activeNumericInstances: totalNumericInstances,
    time: latestTime,
    type: typeStr,
    mainOnline,
    sources: activeSources
  };
}

// ================= PERSONAL HEARTBEAT EMBED DESIGN =================

function buildPrettyHeartbeatEmbed({
  userData,
  groupLabel,
  merged,
  farmMode,
  shareMode
}) {
  const color = farmMode ? 0xf1c40f : shareMode === "proxies" ? 0x9b59b6 : 0x00f59b;

  const pcBadge =
    merged.sources.length > 1
      ? `🖥️ **Multi-Node:** \`${merged.sources.join(" + ")}\``
      : `💻 **Node:** \`${merged.sources[0] || userData.heartbeatName || userData.name}\``;

  let statusBadge = "🟢 ACTIVE (HEADLESS)";
  if (farmMode) statusBadge = "🌾 FARM MODE";
  else if (shareMode === "proxies") statusBadge = "🟣 SHARING PROXIES";
  else if (shareMode === "accounts") statusBadge = "🟢 SHARING ACCOUNTS";

  const modeValue =
    shareMode === "proxies"
      ? "`Sharing Proxies`"
      : shareMode === "accounts"
      ? "`Sharing Accounts`"
      : `\`${merged.ppm.toFixed(2)} PPM\``;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`📡 PERSONAL TELEMETRY — ${(userData.name || "REROLLER").toUpperCase()}`)
    .setDescription(
      `> 🏷️ **Group:** **${groupLabel}**  •  🛡️ **Status:** **${statusBadge}**\n` +
      `> ${pcBadge}  •  🔄 **Updated:** <t:${Math.floor(Date.now() / 1000)}:R>`
    )
    .addFields(
      {
        name: shareMode ? "🔗 Sharing Mode" : "⚡ Speed (PPM)",
        value: modeValue,
        inline: true
      },
      {
        name: "🀄 Opened Packs",
        value: `\`${merged.packs.toLocaleString()} Packs\``,
        inline: true
      },
      {
        name: "⏱️ Active Time",
        value: `\`${merged.time}\``,
        inline: true
      },
      {
        name: "🎯 Injection / Main",
        value: `Main: ${merged.mainOnline ? "🟢 Online" : "⚪ Standby"} • \`${merged.type}\``,
        inline: false
      }
    )
    .setFooter({ text: "Live Headless Telemetry • Keeps your personal channel clean" })
    .setTimestamp();
}

// ================= PERSONAL CHANNEL MANAGEMENT =================

async function getOrCreatePersonalChannel({
  guild,
  member,
  userData,
  discordId,
  championRoleId,
  state
}) {
  if (!guild) return null;

  if (state?.channelId) {
    const existing =
      guild.channels.cache.get(state.channelId) ||
      (await guild.channels.fetch(state.channelId).catch(() => null));
    if (existing) {
      if (String(existing.parentId) !== String(PERSONAL_CHANNELS_CATEGORY_ID)) {
        await existing.setParent(PERSONAL_CHANNELS_CATEGORY_ID, { lockPermissions: false }).catch(() => {});
      }
      return existing;
    }
  }

  await guild.channels.fetch().catch(() => {});
  const topicTag = `user:${discordId}`;

  const safeName =
    String(userData.heartbeatName || userData.name || member?.user?.username || "user")
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 75) || "user";

  const desiredName = `personal-${safeName}`;

  let userChannel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.topic === topicTag
  );

  if (!userChannel) {
    const possible = guild.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText && c.name.startsWith("personal-")
    );
    for (const ch of possible.values()) {
      const perm = ch.permissionOverwrites.cache.get(String(discordId));
      if (perm && perm.allow.has(PermissionFlagsBits.ViewChannel)) {
        userChannel = ch;
        await userChannel.setTopic(topicTag).catch(() => {});
        break;
      }
    }
  }

  const overwrites = [
    {
      id: guild.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: String(discordId),
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];

  const botRole = guild.roles.cache.find((r) => r.name.toLowerCase().includes("bot"));
  if (botRole) {
    overwrites.push({
      id: botRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

  if (championRoleId && guild.roles.cache.has(championRoleId)) {
    overwrites.push({
      id: championRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

  if (userChannel) {
    if (String(userChannel.parentId) !== String(PERSONAL_CHANNELS_CATEGORY_ID)) {
      await userChannel.setParent(PERSONAL_CHANNELS_CATEGORY_ID, { lockPermissions: false }).catch(() => {});
    }
    return userChannel;
  }

  userChannel = await guild.channels.create({
    name: desiredName,
    type: ChannelType.GuildText,
    topic: topicTag,
    parent: PERSONAL_CHANNELS_CATEGORY_ID,
    permissionOverwrites: overwrites,
    defaultMessageNotifications: 2
  }).catch((err) => {
    console.error("Error creating personal channel:", err);
    return null;
  });

  return userChannel;
}

async function clearTransientMessagesOnOnline(channel, state) {
  if (!channel || !state) return false;
  let changed = false;

  if (state.offlineMsgId) {
    const msg = await channel.messages.fetch(state.offlineMsgId).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
    state.offlineMsgId = null;
    changed = true;
  }

  if (state.kickReasonMsgId) {
    const msg = await channel.messages.fetch(state.kickReasonMsgId).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
    state.kickReasonMsgId = null;
    changed = true;
  }

  return changed;
}

async function sendLastOfflineCard(channel, state, userData, groupLabel) {
  if (!channel || state.offlineMsgId) return;

  const nowUnix = Math.floor(Date.now() / 1000);
  const lastHbUnix = state.lastHeartbeatAt ? Math.floor(state.lastHeartbeatAt / 1000) : nowUnix;

  const offlineEmbed = new EmbedBuilder()
    .setColor(0x576574)
    .setTitle(`🔴 USER OFFLINE — ${userData.name || "Reroller"}`)
    .setDescription(
      `User is currently offline in **${groupLabel}**.\n\n` +
      `🕒 **Disconnected At:** <t:${nowUnix}:F> (<t:${nowUnix}:R>)\n` +
      `📡 **Last Heartbeat Received:** <t:${lastHbUnix}:R>`
    )
    .setFooter({ text: "Activity tracker for Champions • Auto-deletes when user goes back Online" })
    .setTimestamp();

  const sent = await channel.send({ embeds: [offlineEmbed] }).catch(() => null);
  if (sent) {
    state.offlineMsgId = sent.id;
  }
}

// ================= EXPORTED MODULE =================

module.exports = (client, options) => {
  const {
    GROUP_CONFIG,
    CHAMPION_ROLE_ID,
    LEGEND_ROLE_ID,
    redis,
    onFarmModeChanged
  } = options;

  client.once("ready", async () => {
    console.log("✅ alerts.js 3.1 loaded (Low-Redis Optimized)");
    await hydratePersonalStates(redis);
    // Escaneo cada 5 minutos (en vez de 3 min)
    setInterval(scanOnlineStatusAndTimeouts, 5 * 60 * 1000);
  });

  async function scanOnlineStatusAndTimeouts() {
    try {
      await hydratePersonalStates(redis);
      const farmMode = await isFarmModeActive(redis);
      const now = Date.now();
      const guild = client.guilds.cache.first();
      if (!guild) return;

      const currentlyOnlineUsers = new Map();

      for (const group of Object.keys(GROUP_CONFIG)) {
        const onlineIds = await loadOnlineIDs(redis, group, true);
        const users = await loadUsers(redis, group);
        for (const [discordId, uData] of Object.entries(users)) {
          if (isUserOnlineInGroup(uData, onlineIds)) {
            currentlyOnlineUsers.set(String(discordId), {
              userData: uData,
              group
            });
          }
        }
      }

      // 1. Detect users who transitioned Online -> Offline (usando caché en memoria)
      for (const [discordId, state] of PERSONAL_STATE_CACHE.entries()) {
        if (!state || !state.wasOnline) continue;

        if (!currentlyOnlineUsers.has(String(discordId))) {
          state.wasOnline = false;
          const ch = state.channelId
            ? guild.channels.cache.get(state.channelId) || (await guild.channels.fetch(state.channelId).catch(() => null))
            : null;

          if (ch) {
            const gLabel = (state.lastOnlineGroup || "Group").replace("_", " ");
            await sendLastOfflineCard(ch, state, { name: state.userName || "Reroller" }, gLabel);
          }
          await savePersonalState(redis, discordId, state);
        }
      }

      // 2. Timeout de 40 min sin heartbeat (respetando rol Legend)
      if (!farmMode) {
        for (const [discordId, info] of currentlyOnlineUsers.entries()) {
          const member =
            guild.members.cache.get(String(discordId)) ||
            (await guild.members.fetch(String(discordId)).catch(() => null));

          if (hasLegendRole(member, LEGEND_ROLE_ID)) {
            continue;
          }

          const state = await getPersonalState(redis, discordId);
          if (!state.lastHeartbeatAt) {
            if (!state.onlineSince) {
              state.onlineSince = now;
              state.lastHeartbeatAt = now;
            }
            continue;
          }

          const timeSinceOnline = now - (state.onlineSince || now);
          if (timeSinceOnline < ONLINE_GRACE_PERIOD_MS) {
            continue;
          }

          if (now - state.lastHeartbeatAt >= HEARTBEAT_SILENCE_TIMEOUT_MS) {
            await removeOnlineIDs(redis, info.group, getUserGameIds(info.userData));

            const ch = await getOrCreatePersonalChannel({
              guild,
              member,
              userData: info.userData,
              discordId,
              championRoleId: CHAMPION_ROLE_ID,
              state
            });

            if (ch) {
              const kickEmbed = new EmbedBuilder()
                .setColor(0xff4757)
                .setTitle("🚨 SET OFFLINE DUE TO HEARTBEAT INACTIVITY")
                .setDescription(
                  `<@${discordId}> you have been automatically set **OFFLINE**.\n` +
                  `**Reason:** No Heartbeat signal received for over **40 minutes**.`
                )
                .setFooter({ text: "This message will be automatically removed once you go Online and send a Heartbeat." })
                .setTimestamp();

              const kMsg = await ch.send({ content: `<@${discordId}>`, embeds: [kickEmbed] }).catch(() => null);
              if (kMsg) state.kickReasonMsgId = kMsg.id;
              await sendLastOfflineCard(ch, state, info.userData, info.group.replace("_", " "));
            }

            state.wasOnline = false;
            await savePersonalState(redis, discordId, state);
          }
        }
      }
    } catch (err) {
      console.error("Error in scanOnlineStatusAndTimeouts:", err);
    }
  }

  client.on("messageCreate", async (message) => {
    try {
      if (message.author.id === client.user.id) return;

      const rawText = getMessageText(message);

      // --- A. DETECTOR DE "Possible double reroll" ---
      if (ENABLE_DOUBLE_REROLL_ALERTS && rawText && /possible\s+double\s+reroll/i.test(rawText)) {
        const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const firstLine = lines[0] || rawText;

        const idMatch = firstLine.match(/(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}|\b\d{16}\b)/);
        if (idMatch) {
          const rawFormattedId = idMatch[1];
          const cleanGameId = normalizeId(rawFormattedId);

          const foundOwner = await findUserByGameId(redis, GROUP_CONFIG, cleanGameId);
          if (foundOwner && message.guild) {
            const { discordId, userData } = foundOwner;
            const member = await message.guild.members.fetch(discordId).catch(() => null);
            const state = await getPersonalState(redis, discordId);

            const userChannel = await getOrCreatePersonalChannel({
              guild: message.guild,
              member,
              userData,
              discordId,
              championRoleId: CHAMPION_ROLE_ID,
              state
            });

            if (userChannel) {
              if (state.channelId !== userChannel.id) {
                state.channelId = userChannel.id;
                await savePersonalState(redis, discordId, state);
              }

              const doubleRerollEmbed = new EmbedBuilder()
                .setColor(0xffa502)
                .setTitle("⚠️ POSSIBLE DOUBLE REROLL / FULL FRIEND LIST")
                .setDescription(rawText)
                .addFields(
                  { name: "👤 User", value: `<@${discordId}>`, inline: true },
                  { name: "🎮 Main ID", value: `\`${rawFormattedId}\``, inline: true }
                )
                .setFooter({ text: "Please clean your friend list in-game so farm hosts can add you." })
                .setTimestamp();

              await userChannel.send({
                content: `<@${discordId}> ⚠️ **Attention required regarding your Main account (\`${rawFormattedId}\`):**`,
                embeds: [doubleRerollEmbed]
              }).catch((err) => console.error("Error forwarding double reroll alert:", err));
            }
          }
        }
        return;
      }

      // --- B. FARM MODE COMMANDS FOR CHAMPIONS ---
      if (!message.author.bot && message.content) {
        const lower = message.content.trim().toLowerCase();
        if (lower === "!farm on" || lower === "!farm off" || lower === "!farm status") {
          const isChamp =
            message.member?.roles?.cache?.has(CHAMPION_ROLE_ID) ||
            message.member?.roles?.cache?.some((r) => r.name === "Champion");

          if (!isChamp) {
            return message.reply("❌ Only users with the **Champion** role can toggle Farm Mode.");
          }

          if (lower === "!farm status") {
            const active = await isFarmModeActive(redis, true);
            return message.reply(
              active
                ? "🌾 **Farm Mode is currently ACTIVE.** No users will be kicked for heartbeat timeouts."
                : "🛡️ **Farm Mode is currently OFF.** Standard 40m heartbeat timeout rule is active."
            );
          }

          const enable = lower === "!farm on";
          await setFarmMode(redis, enable);
          if (typeof onFarmModeChanged === "function") onFarmModeChanged().catch(() => {});

          const embed = new EmbedBuilder()
            .setColor(enable ? 0xf1c40f : 0x2ecc71)
            .setTitle(enable ? "🌾 FARM MODE ENABLED" : "🛡️ FARM MODE DISABLED")
            .setDescription(
              enable
                ? "Inactivity kick timers are now **paused**. Members can farm freely without being set offline."
                : "Automatic heartbeat supervision has been restored."
            )
            .setTimestamp();

          return message.reply({ embeds: [embed] });
        }
      }

      // --- C. INCOMING HEARTBEAT PROCESSING ---
      const group = Object.keys(GROUP_CONFIG).find(
        (g) => GROUP_CONFIG[g].heartbeatChannelId === message.channel.id
      );
      if (!group) return;

      const content = rawText;
      if (!content) return;

      const rawHbName = extractHeartbeatName(content);
      if (!rawHbName) return;

      const groupUsers = await loadUsers(redis, group);
      let matchedDiscordId = null;
      let matchedUserData = null;

      for (const [uid, uData] of Object.entries(groupUsers)) {
        const candidates = [
          uData.name,
          uData.heartbeatName,
          uData.username,
          ...(Array.isArray(uData.aliases) ? uData.aliases : [])
        ].filter(Boolean);

        if (candidates.some((c) => namesMatchMultiPC(rawHbName, c))) {
          matchedDiscordId = uid;
          matchedUserData = uData;
          break;
        }
      }

      if (!matchedDiscordId || !matchedUserData) return;

      const guild = message.guild;
      if (!guild) return;

      const member =
        guild.members.cache.get(matchedDiscordId) ||
        (await guild.members.fetch(matchedDiscordId).catch(() => null));
      const state = await getPersonalState(redis, matchedDiscordId);
      const farmMode = await isFarmModeActive(redis);

      const userChannel = await getOrCreatePersonalChannel({
        guild,
        member,
        userData: matchedUserData,
        discordId: matchedDiscordId,
        championRoleId: CHAMPION_ROLE_ID,
        state
      });

      if (!userChannel) return;

      let stateNeedsSave = false;
      if (state.channelId !== userChannel.id) {
        state.channelId = userChannel.id;
        stateNeedsSave = true;
      }
      if (state.userName !== (matchedUserData.name || "Reroller")) {
        state.userName = matchedUserData.name || "Reroller";
        stateNeedsSave = true;
      }
      if (state.lastOnlineGroup !== group) {
        state.lastOnlineGroup = group;
        stateNeedsSave = true;
      }

      // Actualizado en memoria (no requiere escribir a Redis en cada heartbeat)
      state.lastHeartbeatAt = Date.now();

      const onlineIds = await loadOnlineIDs(redis, group);
      const isCurrentlyOnline = isUserOnlineInGroup(matchedUserData, onlineIds);

      if (isCurrentlyOnline) {
        if (!state.wasOnline) {
          state.onlineSince = Date.now();
          state.wasOnline = true;
          stateNeedsSave = true;
        }
        const cleared = await clearTransientMessagesOnOnline(userChannel, state);
        if (cleared) stateNeedsSave = true;
      }

      const merged = updateAndMergeUserMultiPC(
        matchedDiscordId,
        rawHbName,
        matchedUserData,
        content
      );

      const isLegendProxy = hasLegendRole(member, LEGEND_ROLE_ID);
      const isAccountSharing = !isLegendProxy && merged.ppm <= 0 && merged.activeNumericInstances === 0;
      const shareMode = isLegendProxy ? "proxies" : isAccountSharing ? "accounts" : null;

      const prettyEmbed = buildPrettyHeartbeatEmbed({
        userData: matchedUserData,
        groupLabel: GROUP_CONFIG[group]?.label || group,
        merged,
        farmMode,
        shareMode
      });

      let hbMsg = null;
      if (state.heartbeatMsgId) {
        hbMsg = await userChannel.messages.fetch(state.heartbeatMsgId).catch(() => null);
      }

      if (hbMsg) {
        await hbMsg.edit({ content: "", embeds: [prettyEmbed] }).catch(() => {});
      } else {
        const recent = await userChannel.messages.fetch({ limit: 15 }).catch(() => null);
        const existingBotHb = recent?.find(
          (m) =>
            m.author.id === client.user.id &&
            m.embeds[0]?.title?.startsWith("📡 PERSONAL TELEMETRY")
        );
        if (existingBotHb) {
          await existingBotHb.edit({ content: "", embeds: [prettyEmbed] }).catch(() => {});
          state.heartbeatMsgId = existingBotHb.id;
          stateNeedsSave = true;
        } else {
          const sent = await userChannel.send({ embeds: [prettyEmbed] }).catch(() => null);
          if (sent) {
            state.heartbeatMsgId = sent.id;
            stateNeedsSave = true;
          }
        }
      }

      // Solo guardamos en Redis si hubo un cambio estructural real
      if (stateNeedsSave) {
        await savePersonalState(redis, matchedDiscordId, state);
      }
    } catch (err) {
      console.error("🔥 Error in alerts.js:", err);
    }
  });
};
