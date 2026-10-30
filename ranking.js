const { AttachmentBuilder } = require("discord.js");
const { createCanvas, registerFont } = require("canvas");
const path = require("path");
const fs = require("fs");

// Intentar registrar la fuente Righteous si existe en el repositorio
const fontPath = path.join(process.cwd(), "assets/fonts/Righteous-Regular.ttf");
if (fs.existsSync(fontPath)) {
  try {
    registerFont(fontPath, { family: "Righteous" });
  } catch {}
}

const RANKING_CHANNEL_ID = process.env.RANKING_CHANNEL_ID;
const RIVALS_SESSIONS_KEY = "rivals_sessions";

// Configuración de XP y Niveles
const BASE_XP_PER_MINUTE = 0.25;
const XP_PER_GP_BONUS = 175;
const XP_PER_LEVEL = 250;

const TRACKING_CYCLE_MS = 5 * 60 * 1000;   // Cada 5 min actualiza progreso en vivo
const RANKING_RENDER_MS = 20 * 60 * 1000;  // Cada 20 min redibuja el tablero en Discord

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

function getLevelProgressRatio(totalXP) {
  const intoLevel = (Number(totalXP) || 0) % XP_PER_LEVEL;
  return Math.min(Math.max(intoLevel / XP_PER_LEVEL, 0), 1);
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
  let lastCycleTs = Date.now();
  let lastRenderTs = 0;

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

    // Incluir también miembros dentro de sesiones activas de Rivals
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

      // 1. Sincronizar God Packs desde Redis
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

      // 2. Sumar XP y Tiempo a los usuarios actualmente Online
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

      // 3. Consolidar sesiones de usuarios que se desconectaron
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

      if (now - lastRenderTs >= RANKING_RENDER_MS) {
        lastRenderTs = now;
        await updateGeneralRankingBoard(allUsers, onlineDiscordSet);
      }
    } catch (err) {
      console.error("❌ Error en syncTrackingCycle (ranking.js):", err);
    }
  }

  async function buildUnifiedRankingRows(allUsers, onlineDiscordSet) {
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

      rows.push({
        id: discordId,
        name: u.name || t.name || "Unknown",
        level: getUserLevel(totalXP),
        progress: getLevelProgressRatio(totalXP),
        xp: totalXP,
        gp: gpCount,
        time: totalMinutes,
        packs: totalPacks,
        instances: Number(t.recordInstances) || 0,
        isOnline: onlineDiscordSet.has(discordId)
      });
    }

    return rows.sort((a, b) => b.xp - a.xp || b.gp - a.gp || b.time - a.time);
  }

  async function renderGeneralRankingCanvas(rows) {
    const width = 1000;
    const height = 1340;
    const headerHeight = 165;
    const rowHeight = 74;
    const shown = rows.slice(0, 15);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // 1. Fondo degradado espacial profundo
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, "#0b1120");
    bgGrad.addColorStop(0.5, "#0f172a");
    bgGrad.addColorStop(1, "#020617");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // 2. Cabecera dorada/cian
    ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
    ctx.fillRect(0, 0, width, headerHeight);

    ctx.fillStyle = "#ffd700";
    ctx.font = "bold 44px Righteous, sans-serif";
    ctx.fillText("ZENITH REROLL — GLOBAL HALL OF FAME", 45, 70);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "22px Righteous, sans-serif";
    ctx.fillText("Unified General Leaderboard  •  Sorted by Total XP & God Packs", 47, 112);

    const lineGrad = ctx.createLinearGradient(45, 0, width - 45, 0);
    lineGrad.addColorStop(0, "#ffd700");
    lineGrad.addColorStop(0.5, "#00f2fe");
    lineGrad.addColorStop(1, "#a855f7");
    ctx.fillStyle = lineGrad;
    ctx.fillRect(45, 135, width - 90, 4);

    if (shown.length === 0) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "28px Righteous, sans-serif";
      ctx.fillText("No ranking data available yet.", 45, 230);
      return new AttachmentBuilder(canvas.toBuffer("image/png"), { name: "zenith-global-ranking.png" });
    }

    // 3. Dibujar filas del Top 15
    for (let i = 0; i < shown.length; i++) {
      const user = shown[i];
      const y = headerHeight + 12 + i * rowHeight;

      // Fondo de tarjeta por fila (destacando el Top 3)
      if (i === 0) ctx.fillStyle = "rgba(255, 215, 0, 0.13)";
      else if (i === 1) ctx.fillStyle = "rgba(226, 232, 240, 0.10)";
      else if (i === 2) ctx.fillStyle = "rgba(249, 115, 22, 0.10)";
      else ctx.fillStyle = i % 2 === 0 ? "rgba(255, 255, 255, 0.045)" : "rgba(255, 255, 255, 0.02)";

      ctx.fillRect(35, y, width - 70, rowHeight - 8);

      // Barra lateral de color para el Top 3
      if (i < 3) {
        ctx.fillStyle = i === 0 ? "#ffd700" : i === 1 ? "#e2e8f0" : "#f97316";
        ctx.fillRect(35, y, 6, rowHeight - 8);
      }

      // Posición (#1, #2, #3...)
      ctx.fillStyle = i === 0 ? "#ffd700" : i === 1 ? "#e2e8f0" : i === 2 ? "#fb923c" : "#64748b";
      ctx.font = "bold 30px Righteous, sans-serif";
      ctx.fillText(`#${i + 1}`, 58, y + 44);

      // Indicador Online + Nombre del Jugador
      ctx.fillStyle = user.isOnline ? "#10b981" : "#475569";
      ctx.beginPath();
      ctx.arc(135, y + 26, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px Righteous, sans-serif";
      ctx.fillText(String(user.name).slice(0, 18), 152, y + 34);

      // Barra de progreso hacia el siguiente nivel debajo del nombre
      const barX = 152;
      const barY = y + 46;
      const barW = 210;
      const barH = 8;
      ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = "#00f2fe";
      ctx.fillRect(barX, barY, Math.round(barW * user.progress), barH);

      // Nivel y XP
      ctx.fillStyle = "#00f2fe";
      ctx.font = "bold 24px Righteous, sans-serif";
      ctx.fillText(`Lv. ${user.level}`, 420, y + 34);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "17px Righteous, sans-serif";
      ctx.fillText(`${formatCompactNumber(user.xp)} XP`, 420, y + 56);

      // God Packs
      ctx.fillStyle = "#ffd700";
      ctx.font = "bold 24px Righteous, sans-serif";
      ctx.fillText(`★ ${user.gp} GP`, 575, y + 34);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "17px Righteous, sans-serif";
      ctx.fillText(`${formatCompactNumber(user.packs)} packs`, 575, y + 56);

      // Tiempo Online Acumulado
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 22px Righteous, sans-serif";
      ctx.fillText(`${formatDurationCompact(user.time)}`, 745, y + 34);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "16px Righteous, sans-serif";
      ctx.fillText("online time", 745, y + 56);

      // Récord de Instancias
      ctx.fillStyle = "#c084fc";
      ctx.font = "bold 22px Righteous, sans-serif";
      ctx.fillText(`x${user.instances}`, 885, y + 34);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "16px Righteous, sans-serif";
      ctx.fillText("max inst", 885, y + 56);
    }

    return new AttachmentBuilder(canvas.toBuffer("image/png"), {
      name: "zenith-global-ranking.png"
    });
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
      const rows = await buildUnifiedRankingRows(allUsers, onlineSet);
      const attachment = await renderGeneralRankingCanvas(rows);

      let msg = null;
      if (rankingMsgId) {
        msg = await channel.messages.fetch(rankingMsgId).catch(() => null);
      }

      if (!msg) {
        const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
        msg = recent?.find((m) => m.author.id === client.user.id && m.attachments.size > 0);
      }

      const payload = {
        content: "🏆 **ZENITH REROLL — RANKING GENERAL UNIFICADO**",
        files: [attachment],
        attachments: []
      };

      if (msg) {
        await msg.edit(payload).catch(() => {});
        rankingMsgId = msg.id;
      } else {
        const sent = await channel.send(payload).catch(() => null);
        if (sent) rankingMsgId = sent.id;
      }

      const settings = safeParse(await redis.get("panel_settings"), {});
      settings.unifiedRankingMessageId = rankingMsgId;
      await redis.set("panel_settings", JSON.stringify(settings));
    } catch (err) {
      console.error("❌ Error actualizando el Ranking General:", err);
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

  // Comandos rápidos de administración del Ranking
  client.on("messageCreate", async (msg) => {
    if (msg.author.bot || !msg.content) return;
    const cmd = msg.content.trim().toLowerCase();

    if (cmd === "!ranking" || cmd === "ranking update") {
      await syncTrackingCycle();
      await updateGeneralRankingBoard();
      return msg.reply("✅ **Ranking General actualizado.**");
    }

    if (cmd === "!resetxp" || cmd === "reset xp") {
      const isChamp = msg.member?.roles?.cache?.has(CHAMPION_ROLE_ID);
      if (!isChamp) return msg.reply("❌ Solo los **Champion** pueden reiniciar el XP.");

      for (const id in trackingData) {
        trackingData[id].xp = 0;
      }
      for (const id in liveSessions) {
        liveSessions[id].sessionXP = 0;
      }
      await redis.set("tracking_data", JSON.stringify(trackingData));
      await updateGeneralRankingBoard();
      return msg.reply("✅ **XP base reiniciado para todos los usuarios.**");
    }
  });
};
