const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} = require("discord.js");

const RANKING_CHANNEL_ID = process.env.RANKING_CHANNEL_ID;
const RIVALS_SESSIONS_KEY = "rivals_sessions";

const BASE_XP_PER_MINUTE = 0.25;
const XP_PER_GP_BONUS = 175;
const XP_PER_LEVEL = 250;

const TRACKING_CYCLE_MS = 5 * 60 * 1000;
const RANKING_UPDATE_MS = 15 * 60 * 1000;

function safeParse(data, fallback = {}) {
  try {
    if (!data) return fallback;
    if (typeof data === "object") return data;
    return JSON.parse(data);
  } catch {
    return fallback;
  }
}

function normalizeId(id) {
  return String(id || "").trim().replace(/\D/g, "");
}

function getUserLevel(totalXP) {
  return Math.floor((Number(totalXP) || 0) / XP_PER_LEVEL) + 1;
}

function buildXpBar(totalXP, size = 8) {
  const intoLevel = (Number(totalXP) || 0) % XP_PER_LEVEL;
  const ratio = Math.min(Math.max(intoLevel / XP_PER_LEVEL, 0), 1);
  const filled = Math.round(ratio * size);
  return "▰".repeat(filled) + "▱".repeat(size - filled);
}

function getRankTitle(level) {
  if (level >= 50) return "👑 Grand Master";
  if (level >= 35) return "💎 Mythic Reroller";
  if (level >= 25) return "🔥 Legend";
  if (level >= 15) return "⚡ Veteran";
  if (level >= 8) return "🌟 Striker";
  return "🌱 Challenger";
}

function formatCompactNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.floor(n));
}

function formatDurationCompact(totalMinutes) {
  const minutes = Number(totalMinutes) || 0;
  if (minutes >= 1440) return `${(minutes / 1440).toFixed(1)}d`;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${Math.floor(minutes)}m`;
}

module.exports = (client, options) => {
  const { GROUP_CONFIG, CHAMPION_ROLE_ID, redis } = options;

  let trackingData = {};
  let liveSessions = {};
  let rankingMsgId = null;
  let currentSortBy = "xp"; // "xp" | "gp" | "packs"
  let lastCycleTs = Date.now();
  let lastUpdateTs = 0;

  async function loadAllRegisteredUsers() {
    const allUsers = {};
    const idToDiscordMap = {};
    const groups = [...Object.keys(GROUP_CONFIG), "Rivals"];

    for (const group of groups) {
      const raw = await redis.hgetall(`users:${group}`).catch(() => ({}));
      if (!raw || typeof raw !== "object") continue;

      for (const [discordId, uStr] of Object.entries(raw)) {
        const u = safeParse(uStr, {});
        if (!allUsers[discordId]) {
          allUsers[discordId] = {
            name: u.name || u.heartbeatName || "Unknown",
            heartbeatName: u.heartbeatName || u.name || "Unknown",
            main_id: normalizeId(u.main_id),
            sec_id: normalizeId(u.sec_id),
            group
          };
        }
        if (u.main_id) idToDiscordMap[normalizeId(u.main_id)] = discordId;
        if (u.sec_id) idToDiscordMap[normalizeId(u.sec_id)] = discordId;
      }
    }
    return { allUsers, idToDiscordMap };
  }

  async function loadAllOnlineDiscordIds(idToDiscordMap) {
    const onlineDiscordSet = new Set();

    for (const group of Object.keys(GROUP_CONFIG)) {
      const ids = await redis.smembers(`online:${group}`).catch(() => []);
      if (Array.isArray(ids)) {
        for (const rawId of ids) {
          const clean = normalizeId(rawId);
          if (idToDiscordMap[clean]) {
            onlineDiscordSet.add(idToDiscordMap[clean]);
          }
        }
      }
    }

    const rivalsRaw = await redis.hgetall(RIVALS_SESSIONS_KEY).catch(() => ({}));
    if (rivalsRaw && typeof rivalsRaw === "object") {
      for (const raw of Object.values(rivalsRaw)) {
        const sess = safeParse(raw, null);
        if (sess && Array.isArray(sess.members)) {
          sess.members.forEach((m) => {
            if (m.discordId) onlineDiscordSet.add(String(m.discordId));
          });
        }
      }
    }

    return onlineDiscordSet;
  }

  async function syncTrackingCycle() {
    try {
      const now = Date.now();
      const elapsedSeconds = Math.max(0, (now - lastCycleTs) / 1000);
      lastCycleTs = now;

      const { allUsers, idToDiscordMap } = await loadAllRegisteredUsers();
      const onlineDiscordSet = await loadAllOnlineDiscordIds(idToDiscordMap);
      const gpUsersRaw = await redis.hgetall("gp_users").catch(() => ({}));

      if (gpUsersRaw && typeof gpUsersRaw === "object") {
        for (const [discordId, rawGp] of Object.entries(gpUsersRaw)) {
          const parsedGp = safeParse(rawGp, {});
          if (!trackingData[discordId]) {
            trackingData[discordId] = {
              name: parsedGp.name || allUsers[discordId]?.name || "Unknown",
              xp: 0,
              time: 0,
              totalpacks: 0,
              gp: 0,
              recordInstances: 0
            };
          }
          trackingData[discordId].gp = Number(parsedGp.gp) || 0;
          if (allUsers[discordId]?.name) {
            trackingData[discordId].name = allUsers[discordId].name;
          }
        }
      }

      for (const discordId of onlineDiscordSet) {
        const u = allUsers[discordId];
        if (!u) continue;

        if (!trackingData[discordId]) {
          trackingData[discordId] = {
            name: u.name,
            xp: 0,
            time: 0,
            totalpacks: 0,
            gp: 0,
            recordInstances: 0
          };
        }

        if (!liveSessions[discordId]) {
          liveSessions[discordId] = { sessionXP: 0, sessionSeconds: 0 };
        }

        liveSessions[discordId].sessionSeconds += elapsedSeconds;
        liveSessions[discordId].sessionXP += (BASE_XP_PER_MINUTE / 60) * elapsedSeconds;
      }

      for (const discordId of Object.keys(liveSessions)) {
        if (!onlineDiscordSet.has(discordId)) {
          const sess = liveSessions[discordId];
          if (trackingData[discordId]) {
            trackingData[discordId].xp = (Number(trackingData[discordId].xp) || 0) + sess.sessionXP;
            trackingData[discordId].time =
              (Number(trackingData[discordId].time) || 0) + Math.floor(sess.sessionSeconds / 60);
          }
          delete liveSessions[discordId];
        }
      }

      await redis.set("tracking_data", JSON.stringify(trackingData));

      if (now - lastUpdateTs >= RANKING_UPDATE_MS) {
        lastUpdateTs = now;
        await updateGeneralRankingBoard(allUsers, onlineDiscordSet);
      }
    } catch (err) {
      console.error("❌ Error in syncTrackingCycle (ranking.js):", err);
    }
  }

  async function buildUnifiedRankingRows(allUsers, onlineDiscordSet, sortBy = "xp") {
    const rows = [];
    const allIds = new Set([...Object.keys(allUsers), ...Object.keys(trackingData)]);

    for (const discordId of allIds) {
      const u = allUsers[discordId] || {};
      const t = trackingData[discordId] || {};
      const s = liveSessions[discordId] || { sessionXP: 0, sessionSeconds: 0 };

      const baseXP = (Number(t.xp) || 0) + (Number(s.sessionXP) || 0);
      const gpCount = Number(t.gp) || 0;
      const totalXP = Math.floor(baseXP + gpCount * XP_PER_GP_BONUS);
      const totalMinutes = (Number(t.time) || 0) + Math.floor((Number(s.sessionSeconds) || 0) / 60);
      const totalPacks = (Number(t.totalpacks) || 0) + (Number(t.currentpacks) || 0);

      if (totalXP <= 0 && gpCount <= 0 && totalMinutes <= 0) continue;

      const level = getUserLevel(totalXP);

      rows.push({
        id: discordId,
        name: u.name || t.name || "Unknown",
        level,
        title: getRankTitle(level),
        xpBar: buildXpBar(totalXP, 8),
        xp: totalXP,
        gp: gpCount,
        time: totalMinutes,
        packs: totalPacks,
        instances: Number(t.recordInstances) || 0,
        isOnline: onlineDiscordSet.has(discordId)
      });
    }

    if (sortBy === "gp") {
      return rows.sort((a, b) => b.gp - a.gp || b.xp - a.xp || b.time - a.time);
    }
    if (sortBy === "packs") {
      return rows.sort((a, b) => b.packs - a.packs || b.xp - a.xp || b.gp - a.gp);
    }
    return rows.sort((a, b) => b.xp - a.xp || b.gp - a.gp || b.time - a.time);
  }

  function buildInteractiveLeaderboardPayload(rows, sortBy = "xp") {
    const totalGP = rows.reduce((acc, r) => acc + r.gp, 0);
    const totalPacks = rows.reduce((acc, r) => acc + r.packs, 0);
    const onlineCount = rows.filter((r) => r.isOnline).length;

    const sortLabel =
      sortBy === "gp"
        ? "🌟 Sorted by God Packs Found"
        : sortBy === "packs"
        ? "🀄 Sorted by Total Packs Opened"
        : "✨ Sorted by Total XP & Level";

    // Top 3 Podium Cards
    const podiumMedals = ["🥇 **1ST PLACE**", "🥈 **2ND PLACE**", "🥉 **3RD PLACE**"];
    const podiumFields = rows.slice(0, 3).map((u, idx) => {
      const statusDot = u.isOnline ? "🟢" : "⚫";
      return {
        name: `${podiumMedals[idx]} — ${statusDot} ${u.name}`,
        value:
          `> 🎖️ **Lv. ${u.level}** (${u.title})\n` +
          `> \`[${u.xpBar}]\` **${formatCompactNumber(u.xp)} XP**\n` +
          `> 🌟 **${u.gp} GP**  •  🀄 **${formatCompactNumber(u.packs)}**  •  ⏱️ **${formatDurationCompact(u.time)}**`,
        inline: true
      };
    });

    // Ranks #4 to #15
    const challengers = rows.slice(3, 15).map((u, idx) => {
      const rankNum = String(idx + 4).padStart(2, "0");
      const statusDot = u.isOnline ? "🟢" : "⚫";
      return (
        `\`#${rankNum}\` ${statusDot} **${u.name}** — **Lv.${u.level}** \`[${u.xpBar}]\`\n` +
        `┗ ✨ \`${formatCompactNumber(u.xp)} XP\`  •  🌟 \`${u.gp} GP\`  •  🀄 \`${formatCompactNumber(u.packs)}\`  •  ⏱️ \`${formatDurationCompact(u.time)}\`  •  🖥️ \`x${u.instances}\``
      );
    });

    const embed = new EmbedBuilder()
      .setColor(sortBy === "gp" ? 0xffd700 : sortBy === "packs" ? 0x00f2fe : 0x9b59b6)
      .setTitle("🏆 ZENITH REROLL — GLOBAL HALL OF FAME")
      .setDescription(
        `> 🌐 **Global Community Stats:** \`${rows.length} Ranked Players\`  •  🟢 \`${onlineCount} Online\`  •  🌟 \`${totalGP} Total GPs\`  •  🀄 \`${formatCompactNumber(totalPacks)} Packs\`\n` +
        `> 📊 **Current View:** **${sortLabel}**\n` +
        `───────────────────────────────────────────────`
      )
      .addFields(...podiumFields)
      .addFields({
        name: "⚔️ TOP CHALLENGERS (#04 — #15)",
        value: challengers.length > 0 ? challengers.join("\n\n").slice(0, 1020) : "*Waiting for more challengers...*",
        inline: false
      })
      .setFooter({ text: "Use the buttons below to switch sorting or inspect your personal rank card!" })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("rank_sort_xp")
        .setLabel("Sort by XP")
        .setEmoji("✨")
        .setStyle(sortBy === "xp" ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("rank_sort_gp")
        .setLabel("Sort by God Packs")
        .setEmoji("🌟")
        .setStyle(sortBy === "gp" ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("rank_sort_packs")
        .setLabel("Sort by Packs")
        .setEmoji("🀄")
        .setStyle(sortBy === "packs" ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("rank_my_stats")
        .setLabel("My Rank Card")
        .setEmoji("👤")
        .setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [row] };
  }

  async function updateGeneralRankingBoard(allUsersCache = null, onlineSetCache = null) {
    if (!RANKING_CHANNEL_ID) return;
    try {
      const channel = await client.channels.fetch(RANKING_CHANNEL_ID).catch(() => null);
      if (!channel) return;

      const { allUsers, idToDiscordMap } = allUsersCache
        ? { allUsers: allUsersCache, idToDiscordMap: {} }
        : await loadAllRegisteredUsers();

      const onlineSet = onlineSetCache || (await loadAllOnlineDiscordIds(idToDiscordMap));
      const rows = await buildUnifiedRankingRows(allUsers, onlineSet, currentSortBy);
      const payload = buildInteractiveLeaderboardPayload(rows, currentSortBy);

      let msg = null;
      if (rankingMsgId) {
        msg = await channel.messages.fetch(rankingMsgId).catch(() => null);
      }

      if (!msg) {
        const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
        msg = recent?.find(
          (m) =>
            m.author.id === client.user.id &&
            m.embeds[0]?.title?.includes("GLOBAL HALL OF FAME")
        );
      }

      if (msg) {
        await msg.edit({ content: "", ...payload, files: [], attachments: [] }).catch(() => {});
        rankingMsgId = msg.id;
      } else {
        const sent = await channel.send(payload).catch(() => null);
        if (sent) rankingMsgId = sent.id;
      }

      const settings = safeParse(await redis.get("panel_settings"), {});
      settings.unifiedRankingMessageId = rankingMsgId;
      await redis.set("panel_settings", JSON.stringify(settings));
    } catch (err) {
      console.error("❌ Error updating General Ranking:", err);
    }
  }

  client.once("ready", async () => {
    trackingData = safeParse(await redis.get("tracking_data"), {});
    const settings = safeParse(await redis.get("panel_settings"), {});
    rankingMsgId = settings.unifiedRankingMessageId || settings.rankingMessageId || null;

    await syncTrackingCycle();
    await updateGeneralRankingBoard();

    setInterval(syncTrackingCycle, TRACKING_CYCLE_MS);
  });

  // Interactive Buttons for Sorting & Personal Rank Card
  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction.isButton()) return;
      const { customId } = interaction;
      if (!customId.startsWith("rank_")) return;

      const { allUsers, idToDiscordMap } = await loadAllRegisteredUsers();
      const onlineSet = await loadAllOnlineDiscordIds(idToDiscordMap);

      if (customId === "rank_my_stats") {
        const rows = await buildUnifiedRankingRows(allUsers, onlineSet, "xp");
        const index = rows.findIndex((r) => String(r.id) === String(interaction.user.id));

        if (index === -1) {
          return interaction.reply({
            content: "📭 You don't have recorded ranking stats yet. Go online and start rerolling!",
            flags: MessageFlags.Ephemeral
          });
        }

        const me = rows[index];
        const nextLevelXP = me.level * XP_PER_LEVEL;
        const neededXP = Math.max(0, nextLevelXP - me.xp);

        const myEmbed = new EmbedBuilder()
          .setColor(0x00f2fe)
          .setTitle(`👤 PERSONAL RANK CARD — ${me.name}`)
          .setDescription(
            `> 🏆 **Global Rank:** \`#${index + 1} of ${rows.length}\`\n` +
            `> 🎖️ **Level ${me.level}** — **${me.title}**\n` +
            `> \`[${me.xpBar}]\` *(Needs **${neededXP} XP** for Lv. ${me.level + 1})*`
          )
          .addFields(
            { name: "✨ Total XP", value: `\`${me.xp.toLocaleString()} XP\``, inline: true },
            { name: "🌟 God Packs", value: `\`${me.gp} GP\``, inline: true },
            { name: "🀄 Total Packs", value: `\`${me.packs.toLocaleString()}\``, inline: true },
            { name: "⏱️ Online Time", value: `\`${formatDurationCompact(me.time)}\``, inline: true },
            { name: "🖥️ Max Instances", value: `\`x${me.instances}\``, inline: true },
            { name: "📡 Current Status", value: me.isOnline ? "🟢 **ONLINE**" : "⚫ **OFFLINE**", inline: true }
          )
          .setTimestamp();

        return interaction.reply({ embeds: [myEmbed], flags: MessageFlags.Ephemeral });
      }

      if (customId === "rank_sort_xp") currentSortBy = "xp";
      else if (customId === "rank_sort_gp") currentSortBy = "gp";
      else if (customId === "rank_sort_packs") currentSortBy = "packs";

      const rows = await buildUnifiedRankingRows(allUsers, onlineSet, currentSortBy);
      const payload = buildInteractiveLeaderboardPayload(rows, currentSortBy);
      await interaction.update(payload);
    } catch (err) {
      console.error("Error in ranking interaction:", err);
    }
  });

  // Admin text commands
  client.on("messageCreate", async (msg) => {
    if (msg.author.bot || !msg.content) return;
    const cmd = msg.content.trim().toLowerCase();

    if (cmd === "!ranking" || cmd === "ranking update") {
      await syncTrackingCycle();
      await updateGeneralRankingBoard();
      return msg.reply("✅ **Global Hall of Fame updated.**");
    }

    if (cmd === "!resetxp" || cmd === "reset xp") {
      const isChamp = msg.member?.roles?.cache?.has(CHAMPION_ROLE_ID);
      if (!isChamp) return msg.reply("❌ Only **Champions** can reset XP.");

      for (const id in trackingData) {
        trackingData[id].xp = 0;
      }
      for (const id in liveSessions) {
        liveSessions[id].sessionXP = 0;
      }
      await redis.set("tracking_data", JSON.stringify(trackingData));
      await updateGeneralRankingBoard();
      return msg.reply("✅ **Base XP has been reset for all users.**");
    }
  });
};
