const {
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType
} = require("discord.js");

// ================= GLOBAL CONFIGURATION =================
const ENABLE_DOUBLE_REROLL_ALERTS = false; // 🛑 Cambia a true para REACTIVAR la detección de Double Reroll

const PERSONAL_CHANNELS_CATEGORY_ID = "1565623831203287150";
const HEARTBEAT_SILENCE_TIMEOUT_MS = 40 * 60 * 1000;
const ONLINE_GRACE_PERIOD_MS = 15 * 60 * 1000; // 15 minutos de gracia para el primer heartbeat

const PERSONAL_STATE_KEY = "personal_channel_state";
const FARM_MODE_KEY = "system:farm_mode";
const SHARING_USERS_KEY = "active_sharing_users";

const USERS_CACHE = new Map();
const USERS_CACHE_TTL = 2 * 60 * 1000;
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

async function isFarmModeActive(redis) {
  try {
    const val = await redis.get(FARM_MODE_KEY);
    return val === "true" || val === true || val === 1 || val === "1";
  } catch {
    return false;
  }
}

async function getActiveSharingUsers(redis) {
  try {
    const raw = await redis.get(SHARING_USERS_KEY);
    return safeJsonParse(raw, {});
  } catch {
    return {};
  }
}

async function setFarmMode(redis, enabled) {
  await redis.set(FARM_MODE_KEY, enabled ? "true" : "false");
}

async function getPersonalState(redis, discordId) {
  try {
    const raw = await redis.hget(PERSONAL_STATE_KEY, String(discordId));
    return safeJsonParse(raw, {
      channelId: null,
      heartbeatMsgId: null,
      offlineMsgId: null,
      kickReasonMsgId: null,
      wasOnline: false,
      onlineSince: 0,
      lastOnlineGroup: null,
      lastHeartbeatAt: 0
    });
  } catch {
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
}

async function savePersonalState(redis, discordId, state) {
  try {
    await redis.hset(PERSONAL_STATE_KEY, { [String(discordId)]: JSON.stringify(state) });
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

async function loadOnlineIDs(redis, group) {
  const ids = await redis.smembers(onlineKey(group));
  if (!Array.isArray(ids)) return [];
  return ids.map(normalizeId).filter((x) => /^\d{16}$/.test(x));
}

async function removeOnlineIDs(redis, group, ids) {
  const cleanIds = ids.map(normalizeId).filter((x) => /^\d{16}$/.test(x));
  if (!cleanIds.length) return;
  await redis.srem(onlineKey(group), ...cleanIds);
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

// ================= HEARTBEAT PARSERS (HEADLESS MODE) =================

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

  return {
    time: timeMatch?.[1]?.trim() || "0m",
    packs: Number(packsMatch?.[1] || 0),
    ppm: Number(avgMatch?.[1] || 0),
    type: typeMatch?.[1]?.trim() || "Headless",
    mainOnline
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
  let latestTime = parsed.time;
  let typeStr = parsed.type;
  let mainOnline = false;
  const activeSources = [];

  for (const [, v] of userMap.entries()) {
    totalPacks += v.stats.packs;
    totalPPM += v.stats.ppm;
    if (v.stats.time && v.stats.time !== "0m") latestTime = v.stats.time;
    if (v.stats.mainOnline) mainOnline = true;
    activeSources.push(v.rawName);
  }

  return {
    packs: totalPacks,
    ppm: Number(totalPPM.toFixed(2)),
    time: latestTime,
    type: typeStr,
    mainOnline,
    sources: activeSources
  };
}

// ================= PERSONAL HEARTBEAT EMBED DESIGN (HEADLESS) =================

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

// ================= PERSONAL CHANNEL MANAGEMENT & SILENT PERMISSIONS =================

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

  client.once("ready", () => {
    console.log("✅ alerts.js 3.0 loaded (Headless Mode • No Instances/Duos • Accounts & Proxies Sharing)");
    setInterval(scanOnlineStatusAndTimeouts, 3 * 60 * 1000);
  });

  async function scanOnlineStatusAndTimeouts() {
    try {
      const farmMode = await isFarmModeActive(redis);
      const sharingUsers = await getActiveSharingUsers(redis);
      const now = Date.now();
      const guild = client.guilds.cache.first();
      if (!guild) return;

      const allStatesRaw = await redis.hgetall(PERSONAL_STATE_KEY).catch(() => ({}));
      const currentlyOnlineUsers = new Map();

      for (const group of Object.keys(GROUP_CONFIG)) {
        const onlineIds = await loadOnlineIDs(redis, group);
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

      // 1. Detect users who transitioned Online -> Offline
      if (allStatesRaw && typeof allStatesRaw === "object") {
        for (const [discordId, rawState] of Object.entries(allStatesRaw)) {
          const state = safeJsonParse(rawState, null);
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
      }

      // 2. Timeout de 40 min sin heartbeat (respetando usuarios en Sharing Accounts o Legend Sharing Proxies)
      if (!farmMode) {
        for (const [discordId, info] of currentlyOnlineUsers.entries()) {
          const member =
            guild.members.cache.get(String(discordId)) ||
            (await guild.members.fetch(String(discordId)).catch(() => null));

          if (sharingUsers[String(discordId)] || hasLegendRole(member, LEGEND_ROLE_ID)) {
            continue;
          }

          const state = await getPersonalState(redis, discordId);
          if (!state.lastHeartbeatAt) {
            if (!state.onlineSince) {
              state.onlineSince = now;
              state.lastHeartbeatAt = now;
              await savePersonalState(redis, discordId, state);
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

      // --- B. FARM MODE COMMANDS FOR CHAMPIONS (!farm on / !farm off / !farm status) ---
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
            const active = await isFarmModeActive(redis);
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

      const member = await guild.members.fetch(matchedDiscordId).catch(() => null);
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

      state.channelId = userChannel.id;
      state.userName = matchedUserData.name || "Reroller";
      state.lastHeartbeatAt = Date.now();
      state.lastOnlineGroup = group;

      const onlineIds = await loadOnlineIDs(redis, group);
      const isCurrentlyOnline = isUserOnlineInGroup(matchedUserData, onlineIds);

      if (isCurrentlyOnline) {
        if (!state.wasOnline) {
          state.onlineSince = Date.now();
        }
        state.wasOnline = true;
        await clearTransientMessagesOnOnline(userChannel, state);
      }

      const sharingUsers = await getActiveSharingUsers(redis);
      const isLegendProxy = hasLegendRole(member, LEGEND_ROLE_ID);
      const isAccountSharing = Boolean(sharingUsers[String(matchedDiscordId)]?.type === "accounts");
      const shareMode = isLegendProxy ? "proxies" : isAccountSharing ? "accounts" : null;

      const merged = updateAndMergeUserMultiPC(
        matchedDiscordId,
        rawHbName,
        matchedUserData,
        content
      );

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
        } else {
          const sent = await userChannel.send({ embeds: [prettyEmbed] }).catch(() => null);
          if (sent) state.heartbeatMsgId = sent.id;
        }
      }

      await savePersonalState(redis, matchedDiscordId, state);
    } catch (err) {
      console.error("🔥 Error in alerts.js:", err);
    }
  });
};
