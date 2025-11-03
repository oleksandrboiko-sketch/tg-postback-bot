// ===============================================================
// tg-bot-alerts / server.js
// Версия с кнопкой "Log", callback_data и webhook-обработчиком
// Требования по ENV: BOT_TOKEN, CHAT_ID, SECRET, PUBLIC_URL, NODE_VERSION>=18
// ===============================================================

import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import crypto from "crypto";

// ========================
// 1) Конфигурация и ENV
// ========================
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";
const SECRET = process.env.SECRET || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";

if (!BOT_TOKEN || !CHAT_ID || !SECRET || !PUBLIC_URL) {
  console.error("❌ Missing one of required ENV: BOT_TOKEN, CHAT_ID, SECRET, PUBLIC_URL");
  process.exit(1);
}

// ========================
// 2) Инициализация Express
// ========================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

// ========================
// 3) Подключение к SQLite
// ========================
let db;

async function initDB() {
  db = await open({
    filename: "./db.sqlite",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS totals (
      player    TEXT NOT NULL,
      currency  TEXT NOT NULL,
      total     REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (player, currency)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  console.log("✅ DB initialized");
}

// ========================
// 4) Утилиты
// ========================
function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function cleanVal(v, placeholders = []) {
  if (v == null) return "";
  const s = String(v).trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  const deny = new Set([
    "null",
    "undefined",
    "-",
    "na",
    "n/a",
    "none",
    ...placeholders.map((p) => p.toLowerCase()),
  ]);
  return deny.has(lower) ? "" : s;
}

const genId = () =>
  crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");

function makeSig(id) {
  return crypto.createHmac("sha256", SECRET).update(String(id)).digest("hex").slice(0, 16);
}

async function addAndGetTotal(player, currency, deltaAmount) {
  if (!player || !currency || !Number.isFinite(deltaAmount)) return NaN;
  const row = await db.get(
    `SELECT total FROM totals WHERE player = ? AND currency = ?`,
    [player, currency]
  );
  if (!row) {
    await db.run(
      `INSERT INTO totals (player, currency, total) VALUES (?, ?, ?)`,
      [player, currency, deltaAmount]
    );
    return deltaAmount;
  } else {
    const newTotal = Number(row.total || 0) + deltaAmount;
    await db.run(
      `UPDATE totals SET total = ? WHERE player = ? AND currency = ?`,
      [newTotal, player, currency]
    );
    return newTotal;
  }
}

// ========================
// 5) Отправка сообщений в Telegram
// ========================
async function sendToTelegram(text, extra = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    }),
  });
  const data = await res.json();
  if (!data.ok) console.error("Telegram API error:", data);
  return data;
}

// ========================
// 6) Service routes
// ========================
app.get("/health", (req, res) => res.json({ ok: true }));

// ========================
// 7) Основной маршрут постбэка
// ========================
app.all("/postback/:secret", async (req, res) => {
  try {
    if (req.params.secret !== SECRET) {
      return res.status(403).json({ ok: false, error: "Forbidden (bad secret)" });
    }

    const p = { ...req.query, ...req.body };
    const status = cleanVal(p.status).toLowerCase();
    const affiliate = cleanVal(p.affiliate);
    const mid = cleanVal(p.mid);
    const clickidRaw = cleanVal(p.clickid, ["${clickid}"]);
    const pubidRaw = cleanVal(p.pubid, ["${pubid}"]);
    const player = cleanVal(p.player);
    const currency = cleanVal(p.currency);
    const brand = cleanVal(p.brand || p.Brand || p.BRAND);
    const amountStr = cleanVal(p.amount).replace(",", ".");
    const amountNum = Number.isFinite(parseFloat(amountStr)) ? parseFloat(amountStr) : NaN;

    let header = "";
    if (status === "reg") header = "📩 <b>Reg</b>";
    else if (status === "ftd") header = "🤑 <b>FTD</b>";
    else if (status === "rd") header = "💶 <b>Re-Deposit</b>";
    else header = "📩 <b>New Event</b>";

    const lines = [header];
    if (brand) lines.push(`Brand: <b>${esc(brand)}</b>`);
    if (affiliate) lines.push(`Affiliate: <b>${esc(affiliate)}</b>`);
    if (mid) lines.push(`MID: <code>${esc(mid)}</code>`);
    if (clickidRaw) lines.push(`ClickID: <code>${esc(clickidRaw)}</code>`);
    if (pubidRaw) lines.push(`PubID: <code>${esc(pubidRaw)}</code>`);
    if (player) lines.push(`Player ID: <code>${esc(player)}</code>`);
    if (!Number.isNaN(amountNum))
      lines.push(`Amount: <b>${esc(amountNum)}</b>${currency ? " " + esc(currency) : ""}`);

    if (status === "rd" && player && currency && !Number.isNaN(amountNum)) {
      const total = await addAndGetTotal(player, currency, amountNum);
      if (Number.isFinite(total))
        lines.push(`Total Amount: <b>${esc(total)}</b> ${esc(currency)}`);
    }

    const eventId = genId();
    await db.run(
      `INSERT INTO events (id, payload, created_at) VALUES (?, ?, ?)`,
      [eventId, JSON.stringify(p), Date.now()]
    );

    const text = lines.filter(Boolean).join("\n");
    const sig = makeSig(eventId);

    await sendToTelegram(text, {
      reply_markup: {
        inline_keyboard: [[{ text: "Log", callback_data: `raw:${eventId}:${sig}` }]],
      },
    });

    res.status(200).json({ ok: true, id: eventId });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ========================
// 8) Telegram webhook handler
// ========================
app.post("/tg-webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update.callback_query?.data) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id || cq.from?.id;
      const [kind, id, sig] = String(cq.data).split(":");

      if (kind === "raw" && id && sig) {
        const expected = makeSig(id);
        const answerUrl = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;

        if (sig !== expected) {
          await fetch(answerUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              callback_query_id: cq.id,
              text: "Signature mismatch",
            }),
          });
          return res.json({ ok: true });
        }

        const row = await db.get(`SELECT payload FROM events WHERE id = ?`, [id]);
        await fetch(answerUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callback_query_id: cq.id,
            text: row ? "Sending Log…" : "Log not found",
          }),
        });

        if (row) {
          const payload = row.payload;
          const chunks = [];
          const max = 3500;
          for (let i = 0; i < payload.length; i += max) {
            chunks.push(payload.slice(i, i + max));
          }

          const send = (text) =>
            fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId ?? CHAT_ID,
                text,
                parse_mode: "HTML",
                disable_web_page_preview: true,
              }),
            });

          await send(`🧾 <b>Log for event</b> (${id})`);
          for (const part of chunks) {
            await send(`<code>${esc(part)}</code>`);
          }
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(200).json({ ok: true });
  }
});

// ========================
// 9) Установка вебхука
// ========================
app.get("/set-webhook/:secret", async (req, res) => {
  if (req.params.secret !== SECRET) return res.status(403).send("Forbidden");

  const webhookUrl = `${PUBLIC_URL}/tg-webhook`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, drop_pending_updates: false }),
    });
    const data = await r.json();
    res.status(200).json({ set: true, data, webhookUrl });
  } catch (e) {
    res.status(500).json({ set: false, error: String(e) });
  }
});

// ========================
// 10) Запуск
// ========================
(async () => {
  try {
    await initDB();
    app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
  } catch (e) {
    console.error("DB init error:", e);
    process.exit(1);
  }
})();
