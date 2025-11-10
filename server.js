// ===============================================================
// tg-bot-alerts / server.js
// Полностью рабочий сервер для приёма постбеков и отправки в Telegram
// Специально: если brand=Britsino — отправляем в BRITSINO_CHAT_ID
// Требования по ENV: BOT_TOKEN, CHAT_ID, SECRET, PUBLIC_URL, NODE>=18
// Опционально: BRITSINO_CHAT_ID (чат для бренда Britsino)
// Зависимости: express, node-fetch, morgan, sqlite, sqlite3
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
const BRITSINO_CHAT_ID = process.env.BRITSINO_CHAT_ID || ""; // новый (опц.)
const SECRET = process.env.SECRET || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";

// Проверки жизненно важных ENV
if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN in environment!");
  process.exit(1);
}
if (!CHAT_ID) {
  console.error("❌ Missing CHAT_ID in environment!");
  process.exit(1);
}
if (!SECRET) {
  console.error("❌ Missing SECRET in environment!");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("❌ Missing PUBLIC_URL in environment!");
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

  // Накопления Total Amount по RD (на игрока и валюту)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS totals (
      player    TEXT NOT NULL,
      currency  TEXT NOT NULL,
      total     REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (player, currency)
    );
  `);

  // Сырые события + чат, куда отправили (для правильного Log/raw)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      chat_id    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Мягкое добавление столбца chat_id, если старая БД без него
  try {
    const cols = await db.all(`PRAGMA table_info(events);`);
    const hasChatId = cols.some(c => c.name === "chat_id");
    if (!hasChatId) {
      await db.exec(`ALTER TABLE events ADD COLUMN chat_id TEXT;`);
      // Старые записи будут без chat_id — для них по умолчанию используем CHAT_ID
      await db.exec(`UPDATE events SET chat_id = COALESCE(chat_id, '') WHERE chat_id IS NULL;`);
    }
  } catch (e) {
    // Если ALTER упадёт (например, колонка уже есть) — просто игнорируем
  }

  console.log("✅ DB initialized");
}

// Накопление total и возврат итогового значения (для RD)
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
// 4) Утилиты форматирования
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

// Генерация ID (совместимо со старыми Node)
const genId = () =>
  crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");

// ========================
// 5) Отправка сообщений в Telegram
// ========================
async function sendToTelegram(text, extra = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT_ID, // по умолчанию
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra, // может переопределить chat_id
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error("Telegram API error:", data);
  return data;
}

// ========================
// 6) Служебные маршруты
// ========================
app.get("/health", (req, res) => res.json({ ok: true }));

// ========================
// 7) Основной маршрут постбэка
// ========================
app.all("/postback/:secret", async (req, res) => {
  try {
    const secretFromUrl = req.params.secret;
    if (SECRET && secretFromUrl !== SECRET) {
      return res.status(403).json({ ok: false, error: "Forbidden (bad secret)" });
    }

    // Собираем параметры (из query и body)
    const p = { ...req.query, ...req.body };

    // Нормализация значений
    const status = cleanVal(p.status).toLowerCase(); // reg / ftd / rd / ...
    const affiliate = cleanVal(p.affiliate);
    const mid = cleanVal(p.mid);
    const clickidRaw = cleanVal(p.clickid, ["${clickid}"]);
    const pubidRaw = cleanVal(p.pubid, ["${pubid}"]);
    const player = cleanVal(p.player);
    const currency = cleanVal(p.currency);
    const brand = cleanVal(p.brand || p.Brand || p.BRAND);

    const amountStr = cleanVal(p.amount).replace(",", ".");
    const amountNum = Number.isFinite(parseFloat(amountStr)) ? parseFloat(amountStr) : NaN;

    // Заголовок по статусу
    let header = "";
    if (status === "reg") header = "📩 <b>Reg</b>";
    else if (status === "ftd") header = "🤑 <b>FTD</b>";
    else if (status === "rd") header = "💶 <b>Re-Deposit</b>";
    else header = "📩 <b>New Event</b>";

    // Формируем строковое сообщение
    const lines = [header];

    // Важно: brand в теле сообщения
    if (brand) lines.push(`Brand: <b>${esc(brand)}</b>`);
    if (affiliate) lines.push(`Affiliate: <b>${esc(affiliate)}</b>`);
    if (mid) lines.push(`MID: <code>${esc(mid)}</code>`);
    if (clickidRaw) lines.push(`ClickID: <code>${esc(clickidRaw)}</code>`);
    if (pubidRaw) lines.push(`PubID: <code>${esc(pubidRaw)}</code>`);
    if (player) lines.push(`Player ID: <code>${esc(player)}</code>`);

    if (!Number.isNaN(amountNum)) {
      lines.push(`Amount: <b>${esc(amountNum)}</b>${currency ? " " + esc(currency) : ""}`);
    }

    // Для RD — показываем накопительный Total Amount
    if (status === "rd") {
      if (player && currency && !Number.isNaN(amountNum)) {
        const total = await addAndGetTotal(player, currency, amountNum);
        if (Number.isFinite(total)) {
          lines.push(`Total Amount: <b>${esc(total)}</b> ${esc(currency)}`);
        } else {
          lines.push(`<i>Total Amount недоступен (нет currency/amount).</i>`);
        }
      } else {
        lines.push(`<i>Total Amount недоступен (нужно player, currency, amount).</i>`);
      }
    }

    // Выбор чата: если brand=Britsino (без учёта регистра) — в спец. чат
    const isBritsino = (brand || "").toLowerCase() === "britsino";
    const targetChatId = isBritsino && BRITSINO_CHAT_ID ? BRITSINO_CHAT_ID : CHAT_ID;

    // Сохраняем сырой payload вместе с целевым чат-ID
    const eventId = genId();
    await db.run(
      `INSERT INTO events (id, payload, chat_id, created_at) VALUES (?, ?, ?, ?)`,
      [eventId, JSON.stringify(p), targetChatId, Date.now()]
    );

    // Текст сообщения
    const text = lines.filter(Boolean).join("\n");

    // Кнопка "Log" — ссылка на эндпоинт, который вышлет сырой payload в нужный чат
    const logUrl = `${PUBLIC_URL}/raw/${eventId}?s=${encodeURIComponent(SECRET || "")}`;

    await sendToTelegram(text, {
      chat_id: targetChatId,
      reply_markup: {
        inline_keyboard: [[{ text: "Log", url: logUrl }]],
      },
    });

    res.status(200).json({ ok: true, id: eventId, chat_id: targetChatId });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ========================
// 8) Роут "raw": шлёт сырой payload в тот же чат, куда ушло событие
// ========================
app.get("/raw/:id", async (req, res) => {
  try {
    if (SECRET) {
      if ((req.query.s || "") !== SECRET) {
        return res.status(403).send("Forbidden");
      }
    }

    const id = String(req.params.id || "");
    const row = await db.get(
      `SELECT payload, COALESCE(NULLIF(chat_id,''), ?) AS chat_id FROM events WHERE id = ?`,
      [CHAT_ID, id]
    );
    if (!row) {
      return res.status(404).send("Not found");
    }

    const payload = row.payload;
    const chatId = row.chat_id || CHAT_ID;

    // Разбивка для лимита Telegram (~4096 символов), оставим запас
    const chunks = [];
    const max = 3500;
    for (let i = 0; i < payload.length; i += max) {
      chunks.push(payload.slice(i, i + max));
    }

    await sendToTelegram(`🧾 <b>Raw event</b> (${id})`, { chat_id: chatId });
    for (const part of chunks) {
      await sendToTelegram(`<code>${esc(part)}</code>`, { chat_id: chatId });
    }

    res.status(200).send("Raw sent to chat ✅");
  } catch (e) {
    console.error(e);
    res.status(500).send("Internal error");
  }
});

// ========================
// 9) Запуск
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
