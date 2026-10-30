const {
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType
} = require("discord.js");

const PERSONAL_CHANNELS_CATEGORY_ID = "1565623831203287150";
const REQUIRED_ACTIVE_INSTANCES = 2;
const LOW_INSTANCES_TIMEOUT_MS = 45 * 60 * 1000;
const LOW_INSTANCES_WARNING_INTERVAL_MS = 10 * 60 * 1000;
const HEARTBEAT_SILENCE_TIMEOUT_MS = 40 * 60 * 1000;

const RIVALS_SESSIONS_KEY = "rivals_sessions";
const PERSONAL_STATE_KEY = "personal_channel_state";
const FARM_MODE_KEY = "system:farm_mode";

const crashTimers = new Map();
const USERS_CACHE = new Map();
const USERS_CACHE_TTL = 2 * 60 * 1000;
const MULTI_PC_CACHE = new Map();

// ================= REDIS HELPERS =================

const usersKey = (group) => `users:${group}`; const onlineKey = (group) => `online:${group}`;

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

async function isFarmModeActive(redis) {
  try {
    const val = await redis.get(FARM_MODE_KEY);
    return val === "true" || val === true || val === 1 || val === "1";
  } catch {
    return false;
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
      warningMsgIds: [],
      wasOnline: false,
      lastOnlineGroup: null,
      lastHeartbeatAt: 0
    });
  } catch {
    return {
      channelId: null,
      heartbeatMsgId: null,
      offlineMsgId: null,
      kickReasonMsgId: null,
      warningMsgIds: [],
      wasOnline: false,
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
  const mainId = normalizeId(userData?.main_id);
  const secId = normalizeId(userData?.sec_id);
  if (/^\d{16}$/.test(mainId)) ids.push(mainId);
  if (/^\d{16}$/.test(secId)) ids.push(secId);
  return [...new Set(ids)];
}

function isUserOnlineInGroup(userData, onlineIds) {
  const set = new Set(onlineIds.map(normalizeId));
  return getUserGameIds(userData).some((id) => set.has(id));
}

// ================= RIVALS 2.0 INTEGRATION =================

async function getAllRivalsSessions(redis) {
  try {
    const rawData = await redis.hgetall(RIVALS_SESSIONS_KEY);
    if (!rawData || typeof rawData !== "object") return [];
    const list = [];
    for (const raw of Object.values(rawData)) {
      const s = safeJsonParse(raw, null);
      if (s && s.id && Array.isArray(s.members)) list.push(s);
    }
    return list;
  } catch {
    return [];
  }
}

async function findRivalSessionByDiscordId(redis, discordId) {
  const sessions = await getAllRivalsSessions(redis);
  return sessions.find((s) => s.members.some((m) => String(m.discordId) === String(discordId))) || null;
}

async function removeUserFromRivalsSession(redis, client, discordId) {
  const session = await findRivalSessionByDiscordId(redis, discordId);
  if (!session) return false;

  const idx = session.members.findIndex((m) => String(m.discordId) === String(discordId));
  if (idx === -1) return false;

  const removedMember = session.members[idx];
  if (session.activeIndex === idx && removedMember?.gameId) {
    await redis.srem(onlineKey(session.targetGroup), normalizeId(removedMember.gameId));
  }

  session.members.splice(idx, 1);

  if (session.members.length === 0) {
    await redis.hdel(RIVALS_SESSIONS_KEY, session.id);
    return true;
  }

  session.activeIndex = 0;
  session.lastRotationAt = Date.now();
  session.ceded = {};
  if (session.members[0]?.gameId) {
    await redis.sadd(onlineKey(session.targetGroup), normalizeId(session.members[0].gameId));
  }

  await redis.hset(RIVALS_SESSIONS_KEY, { [session.id]: JSON.stringify(session) });

  try {
    const partner = await client.users.fetch(session.members[0].discordId);
    await partner.send(
      `⚠️ Your Rivals partner (<@${discordId}>) was set offline due to inactivity. You are now rerolling in **Solo Mode (1h ON, 1h OFF)**.`
    );
  } catch {}

  return true;
}

// ================= HEARTBEAT PARSERS & MULTI-PC FUSION =================

function getMessageText(message) {
  let content = message.content || "";
  if ((!content || content.trim() === "") && message.embeds?.length > 0) {
    const embed = message.embeds[0];
    content =
      embed.description ||
      embed.fields?.map((f) => `${f.name}\n${f.value}`).join("\n") ||
      "";
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
  const offlineMatch = text.match(/Offline:\s*([^\n\r]+)/i);

  const onlineRaw = onlineMatch
    ? onlineMatch[1].split(",").map((x) => x.trim()).filter(Boolean)
    : [];
  const offlineRaw = offlineMatch
    ? offlineMatch[1].split(",").map((x) => x.trim()).filter(Boolean)
    : [];

  const activeNumeric = onlineRaw.filter((x) => x.toLowerCase() !== "main" && x.toLowerCase() !== "none" && /^\d+$/.test(x));
  const offlineNumeric = offlineRaw.filter((x) => x.toLowerCase() !== "main" && x.toLowerCase() !== "none" && /^\d+$/.test(x));
  const mainOnline = onlineRaw.some((x) => x.toLowerCase() === "main");

  return {
    time: timeMatch?.[1]?.trim() || "0m",
    packs: Number(packsMatch?.[1] || 0),
    ppm: Number(avgMatch?.[1] || 0),
    type: typeMatch?.[1]?.trim() || "Standard",
    activeNumeric,
    offlineNumeric,
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
  const activeInstances = [];
  const offlineInstances = [];
  const activeSources = [];

  for (const [k, v] of userMap.entries()) {
    totalPacks += v.stats.packs;
    totalPPM += v.stats.ppm;
    if (v.stats.time && v.stats.time !== "0m") latestTime = v.stats.time;
    if (v.stats.mainOnline) mainOnline = true;
    activeSources.push(v.rawName);

    const prefix = userMap.size > 1 ? `${k}:#` : "#";
    v.stats.activeNumeric.forEach((inst) => activeInstances.push(`${prefix}${inst}`));
    v.stats.offlineNumeric.forEach((inst) => offlineInstances.push(`${prefix}${inst}`));
  }

  return {
    packs: totalPacks,
    ppm: Number(totalPPM.toFixed(2)),
    time: latestTime,
    type: typeStr,
    mainOnline,
    activeCount: activeInstances.length,
    offlineCount: offlineInstances.length,
    activeInstances,
    offlineInstances,
    sources: activeSources
  };
}

function getCurrentActiveInstancesForUser(discordId) {
  const userMap = MULTI_PC_CACHE.get(String(discordId));
  if (!userMap) return 0;
  const now = Date.now();
  let total = 0;
  for (const v of userMap.values()) {
    if (now - v.ts <= 25 * 60 * 1000) {
      total += v.stats.activeNumeric.length;
    }
  }
  return total;
}

// ================= PERSONAL HEARTBEAT EMBED DESIGN =================

function buildPrettyHeartbeatEmbed({
  userData,
  groupLabel,
  merged,
  isRival,
  farmMode
}) {
  const isHealthy = merged.activeCount >= REQUIRED_ACTIVE_INSTANCES;
  const color = farmMode ? 0xf1c40f : isHealthy ? 0x00f59b : 0xff9f43;

  const pcBadge =
    merged.sources.length > 1
      ? `🖥️ **Multi-PC Fusion:** \`${merged.sources.join(" + ")}\``
      : `💻 **Node:** \`${merged.sources[0] || userData.heartbeatName || userData.name}\``;

  const roleTag = isRival ? `${groupLabel} (🤝 Rivals Mode)` : groupLabel;
  const healthBadge = farmMode
    ? "🌾 FARM MODE (Protected)"
    : isHealthy
    ? "🟢 HEALTHY"
    : `⚠️ LOW INSTANCES (${merged.activeCount}/${REQUIRED_ACTIVE_INSTANCES})`;

  const activeListStr = merged.activeInstances.length
    ? merged.activeInstances.map((i) => `\`${i}\``).join(" ")
    : "`None`";

  const offlineListStr = merged.offlineInstances.length
    ? merged.offlineInstances.map((i) => `\`${i}\``).join(" ")
    : "`0`";

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`📡 PERSONAL TELEMETRY — ${(userData.name || "REROLLER").toUpperCase()}`)
    .setDescription(
      `> 🏷️ **Group:** **${roleTag}**  •  🛡️ **Status:** **${healthBadge}**\n` +
      `> ${pcBadge}  •  🔄 **Updated:** <t:${Math.floor(Date.now() / 1000)}:R>`
    )
    .addFields(
      {
        name: "⚡ Speed (PPM)",
        value: `\`${merged.ppm.toFixed(2)} PPM\``,
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
        name: `🟢 Active Instances (${merged.activeCount})`,
        value: activeListStr,
        inline: false
      },
      {
        name: `💤 Offline Instances (${merged.offlineCount})`,
        value: offlineListStr,
        inline: true
      },
      {
        name: "🎯 Injection / Main",
        value: `Main: ${merged.mainOnline ? "🟢 Online" : "⚪ Standby"} • \`${merged.type}\``,
        inline: true
      }
    )
    .setFooter({ text: "Live auto-overwriting panel • Keeps your personal channel clean" })
    .setTimestamp();
}

// ================= PERSONAL CHANNEL MANAGEMENT & CLEANUP =================

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
    permissionOverwrites: overwrites
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

  if (Array.isArray(state.warningMsgIds) && state.warningMsgIds.length > 0) {
    for (const wId of state.warningMsgIds) {
      const msg = await channel.messages.fetch(wId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    }
    state.warningMsgIds = [];
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

// ================= LOW INSTANCES COUNTDOWN (< 2 INSTANCES) =================

function cancelLowInstanceTimer(discordId) {
  const key = `low_inst:${discordId}`;
  const existing = crashTimers.get(key);
  if (existing) {
    clearInterval(existing.interval);
    clearTimeout(existing.timeout);
    crashTimers.delete(key);
    return true;
  }
  return false;
}

function cancelAllActiveTimers() {
  for (const [key, val] of crashTimers.entries()) {
    clearInterval(val.interval);
    clearTimeout(val.timeout);
    crashTimers.delete(key);
  }
}

async function startLowInstancesCountdown({
  redis,
  client,
  userChannel,
  userData,
  discordId,
  group,
  isRival
}) {
  const timerKey = `low_inst:${discordId}`;
  if (crashTimers.has(timerKey)) return;

  if (await isFarmModeActive(redis)) return;

  let elapsed = 0;
  const state = await getPersonalState(redis, discordId);

  const warnEmbed = new EmbedBuilder()
    .setColor(0xffa502)
    .setTitle("⚠️ LOW ACTIVE INSTANCES WARNING")
    .setDescription(
      `Hey <@${discordId}>, your bot is reporting **fewer than ${REQUIRED_ACTIVE_INSTANCES} active numeric instances**.\n\n` +
      `📌 **Minimum Requirement:** \`${REQUIRED_ACTIVE_INSTANCES} active instances\` (applies to all groups & Rivals).\n` +
      `⏳ **Time to fix:** \`45 minutes\` before being automatically set **OFFLINE**.`
    )
    .setTimestamp();

  const firstWarn = await userChannel.send({
    content: `<@${discordId}>`,
    embeds: [warnEmbed]
  }).catch(() => null);

  if (firstWarn) {
    state.warningMsgIds = state.warningMsgIds || [];
    state.warningMsgIds.push(firstWarn.id);
    await savePersonalState(redis, discordId, state);
  }

  const interval = setInterval(async () => {
    try {
      if (await isFarmModeActive(redis)) {
        cancelLowInstanceTimer(discordId);
        return;
      }

      const onlineIds = await loadOnlineIDs(redis, group);
      const rivalSession = isRival ? await findRivalSessionByDiscordId(redis, discordId) : null;
      const stillOnline = isRival ? Boolean(rivalSession) : isUserOnlineInGroup(userData, onlineIds);

      if (!stillOnline) {
        cancelLowInstanceTimer(discordId);
        return;
      }

      const activeNow = getCurrentActiveInstancesForUser(discordId);
      if (activeNow >= REQUIRED_ACTIVE_INSTANCES) {
        cancelLowInstanceTimer(discordId);
        const curState = await getPersonalState(redis, discordId);
        await clearTransientMessagesOnOnline(userChannel, curState);
        await savePersonalState(redis, discordId, curState);
        return;
      }

      elapsed += LOW_INSTANCES_WARNING_INTERVAL_MS;
      const remaining = Math.max(0, Math.ceil((LOW_INSTANCES_TIMEOUT_MS - elapsed) / 60000));
      if (remaining <= 0) return;

      const remEmbed = new EmbedBuilder()
        .setColor(0xffa502)
        .setDescription(
          `⏳ <@${discordId}> you are still below the minimum requirement (**${activeNow}/${REQUIRED_ACTIVE_INSTANCES} active instances**).\n` +
          `You will be set **OFFLINE** in **${remaining} minutes** if your instances are not recovered.`
        );

      const warnMsg = await userChannel.send({
        content: `<@${discordId}>`,
        embeds: [remEmbed]
      }).catch(() => null);

      if (warnMsg) {
        const curState = await getPersonalState(redis, discordId);
        curState.warningMsgIds = curState.warningMsgIds || [];
        curState.warningMsgIds.push(warnMsg.id);
        await savePersonalState(redis, discordId, curState);
      }
    } catch (e) {
      console.error("Error in low instance interval:", e);
    }
  }, LOW_INSTANCES_WARNING_INTERVAL_MS);

  const timeout = setTimeout(async () => {
    try {
      clearInterval(interval);
      crashTimers.delete(timerKey);

      if (await isFarmModeActive(redis)) return;

      const activeNow = getCurrentActiveInstancesForUser(discordId);
      if (activeNow >= REQUIRED_ACTIVE_INSTANCES) return;

      if (isRival) {
        await removeUserFromRivalsSession(redis, client, discordId);
      } else {
        await removeOnlineIDs(redis, group, getUserGameIds(userData));
      }

      const curState = await getPersonalState(redis, discordId);
      if (Array.isArray(curState.warningMsgIds)) {
        for (const wId of curState.warningMsgIds) {
          const m = await userChannel.messages.fetch(wId).catch(() => null);
          if (m) await m.delete().catch(() => {});
        }
        curState.warningMsgIds = [];
      }

      const kickEmbed = new EmbedBuilder()
        .setColor(0xff4757)
        .setTitle("🚨 AUTOMATICALLY SET OFFLINE")
        .setDescription(
          `<@${discordId}> you have been set **OFFLINE** in **${group.replace("_", " ")}**.\n\n` +
          `**Reason:** Fewer than **${REQUIRED_ACTIVE_INSTANCES} active instances** for 45 consecutive minutes.`
        )
        .setFooter({ text: "This message will be automatically removed once you go Online and send a Heartbeat." })
        .setTimestamp();

      const kickMsg = await userChannel.send({
        content: `<@${discordId}>`,
        embeds: [kickEmbed]
      }).catch(() => null);

      if (kickMsg) curState.kickReasonMsgId = kickMsg.id;
      curState.wasOnline = false;
      await sendLastOfflineCard(userChannel, curState, userData, group.replace("_", " "));
      await savePersonalState(redis, discordId, curState);
    } catch (e) {
      console.error("Error in low instance timeout:", e);
    }
  }, LOW_INSTANCES_TIMEOUT_MS);

  crashTimers.set(timerKey, { interval, timeout });
}

// ================= EXPORTED MODULE =================

module.exports = (client, options) => {
  const {
    GROUP_CONFIG,
    CHAMPION_ROLE_ID,
    redis,
    onFarmModeChanged
  } = options;

  client.once("ready", () => {
    console.log("✅ alerts.js 2.0 loaded (English UI + Personal Category + Multi-PC + Rivals + Farm Mode)");
    setInterval(scanOnlineStatusAndTimeouts, 3 * 60 * 1000);
  });

  async function scanOnlineStatusAndTimeouts() {
    try {
      const farmMode = await isFarmModeActive(redis);
      const now = Date.now();
      const guild = client.guilds.cache.first();
      if (!guild) return;

      const allStatesRaw = await redis.hgetall(PERSONAL_STATE_KEY).catch(() => ({}));
      const rivalsSessions = await getAllRivalsSessions(redis);
      const rivalsUsers = await loadUsers(redis, "Rivals");

      const currentlyOnlineUsers = new Map();

      for (const group of Object.keys(GROUP_CONFIG)) {
        const onlineIds = await loadOnlineIDs(redis, group);
        const users = await loadUsers(redis, group);
        for (const [discordId, uData] of Object.entries(users)) {
          if (isUserOnlineInGroup(uData, onlineIds)) {
            currentlyOnlineUsers.set(String(discordId), {
              userData: uData,
              group,
              isRival: false
            });
          }
        }
      }

      for (const sess of rivalsSessions) {
        for (const m of sess.members) {
          const uData = rivalsUsers[m.discordId] || {
            name: m.name,
            heartbeatName: m.heartbeatName || m.name,
            main_id: m.gameId
          };
          currentlyOnlineUsers.set(String(m.discordId), {
            userData: uData,
            group: sess.targetGroup,
            isRival: true
          });
        }
      }

      // 1. Detect users who transitioned from Online -> Offline to post their Last Connection card
      if (allStatesRaw && typeof allStatesRaw === "object") {
        for (const [discordId, rawState] of Object.entries(allStatesRaw)) {
          const state = safeJsonParse(rawState, null);
          if (!state || !state.wasOnline) continue;

          if (!currentlyOnlineUsers.has(String(discordId))) {
            cancelLowInstanceTimer(discordId);
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

      // 2. If Farm Mode is OFF, set users offline if they haven't sent any Heartbeat for 40 minutes
      if (!farmMode) {
        for (const [discordId, info] of currentlyOnlineUsers.entries()) {
          const state = await getPersonalState(redis, discordId);
          if (!state.lastHeartbeatAt) {
            state.lastHeartbeatAt = now;
            await savePersonalState(redis, discordId, state);
            continue;
          }

          if (now - state.lastHeartbeatAt >= HEARTBEAT_SILENCE_TIMEOUT_MS) {
            if (info.isRival) {
              await removeUserFromRivalsSession(redis, client, discordId);
            } else {
              await removeOnlineIDs(redis, info.group, getUserGameIds(info.userData));
            }

            cancelLowInstanceTimer(discordId);
            const member = await guild.members.fetch(discordId).catch(() => null);
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
      // --- A. FARM MODE COMMANDS FOR CHAMPIONS (!farm on / !farm off / !farm status) ---
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
                ? "🌾 **Farm Mode is currently ACTIVE.** No users will be kicked for low instances or heartbeat timeouts."
                : "🛡️ **Farm Mode is currently OFF.** Standard 2-instance minimum & 40m timeout rules are active."
            );
          }

          const enable = lower === "!farm on";
          await setFarmMode(redis, enable);
          if (enable) cancelAllActiveTimers();
          if (typeof onFarmModeChanged === "function") onFarmModeChanged().catch(() => {});

          const embed = new EmbedBuilder()
            .setColor(enable ? 0xf1c40f : 0x2ecc71)
            .setTitle(enable ? "🌾 FARM MODE ENABLED" : "🛡️ FARM MODE DISABLED")
            .setDescription(
              enable
                ? "All low-instance warnings and inactivity kick timers are now **paused**. Members can farm freely without being set offline."
                : "Automatic supervision has been restored (minimum **2 active instances** required per user)."
            )
            .setTimestamp();

          return message.reply({ embeds: [embed] });
        }
      }

      // --- B. INCOMING HEARTBEAT PROCESSING ---
      const group = Object.keys(GROUP_CONFIG).find(
        (g) => GROUP_CONFIG[g].heartbeatChannelId === message.channel.id
      );
      if (!group) return;

      const content = getMessageText(message);
      if (!content) return;

      const rawHbName = extractHeartbeatName(content);
      if (!rawHbName) return;

      const groupUsers = await loadUsers(redis, group);
      let matchedDiscordId = null;
      let matchedUserData = null;
      let isRival = false;

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

      if (!matchedDiscordId) {
        const rivalsUsers = await loadUsers(redis, "Rivals");
        for (const [uid, uData] of Object.entries(rivalsUsers)) {
          const candidates = [
            uData.name,
            uData.heartbeatName,
            uData.username,
            ...(Array.isArray(uData.aliases) ? uData.aliases : [])
          ].filter(Boolean);

          if (candidates.some((c) => namesMatchMultiPC(rawHbName, c))) {
            matchedDiscordId = uid;
            matchedUserData = uData;
            isRival = true;
            break;
          }
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
      const rivalSession = await findRivalSessionByDiscordId(redis, matchedDiscordId);
      const isCurrentlyOnline = Boolean(rivalSession) || isUserOnlineInGroup(matchedUserData, onlineIds);
      if (rivalSession) isRival = true;

      if (isCurrentlyOnline) {
        state.wasOnline = true;
        await clearTransientMessagesOnOnline(userChannel, state);
      }

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
        isRival,
        farmMode
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

      if (isCurrentlyOnline && !farmMode) {
        if (merged.activeCount < REQUIRED_ACTIVE_INSTANCES) {
          await startLowInstancesCountdown({
            redis,
            client,
            userChannel,
            userData: matchedUserData,
            discordId: matchedDiscordId,
            group: rivalSession ? rivalSession.targetGroup : group,
            isRival
          });
        } else {
          if (cancelLowInstanceTimer(matchedDiscordId)) {
            const updatedState = await getPersonalState(redis, matchedDiscordId);
            await clearTransientMessagesOnOnline(userChannel, updatedState);
            await savePersonalState(redis, discordId, updatedState);
          }
        }
      }
    } catch (err) {
      console.error("🔥 Error in alerts.js:", err);
    }
  });
};
