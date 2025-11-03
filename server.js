// ===============================================================
// tg-bot-alerts / server.js
// Полностью рабочий сервер для приёма постбеков и отправки в Telegram
// Требования по ENV: BOT_TOKEN, CHAT_ID, SECRET, PUBLIC_URL, NODE_VERSION>=18
// Зависимости: express, node-fetch, morgan, sqlite, sqlite3
// ===============================================================

import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import crypto from "crypto"; // используем как универсальный импорт (есть fallback)

// ========================
// 1) Конфигурация и ENV
// ========================
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";
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
app.use(express.json()); // для application/json
app.use(express.urlencoded({ extended: true })); // для form-data / x-www-form-urlencoded
app.use(morgan("dev"));

// ========================
// 3) Подключение к SQLite
// ========================
let db; // будем хранить экземпляр подключения

async function initDB() {
  db = await open({
    filename: "./db.sqlite",
    driver: sqlite3.Database,
  });

  // Таблица сумм по RD (пример: накопление Total Amount по игроку и валюте)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS totals (
      player    TEXT NOT NULL,
      currency  TEXT NOT NULL,
      total     REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (player, currency)
    );
  `);

  // Таблица сырого payload на каждое событие (для кнопки "raw")
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  console.log("✅ DB initialized");
}

// Утилита для накопления total и возврата итогового значения (для RD)
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

// Экранирование HTML для Telegram (parse_mode: "HTML")
function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Очистка значений, чтобы скрывать пустые, плейсхолдеры и "мусорные" строки
// Пример: cleanVal(p.clickid, ["${clickid}"]) — скроет плейсхолдер ${clickid}
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

// Генератор ID события (универсальный: работает и на старой, и на новой Node)
const genId = () =>
  crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");

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
      ...extra, // здесь можно передать reply_markup с inline-кнопкой "raw"
    }),
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
//
// Реализует 3 требования:
//
// (1) Если в постбэке ${clickid} или ${pubid} — эти поля НЕ показывать
// (2) brand=... выводить в теле сообщения
// (3) Не отправлять raw в это сообщение — вместо этого дать кнопку "raw",
//     которая по клику отправит сырой payload отдельными сообщениями в чат
//
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
    if (status === "reg") header = "🟢 <b>New Registration</b>";
    else if (status === "ftd") header = "💰 <b>New FTD</b>";
    else if (status === "rd") header = "🔁 <b>Re-Deposit</b>";
    else header = "📩 <b>New Event</b>";

    // Формируем строковое сообщение (без RAW)
    const lines = [header];

    // (2) Вынести brand в тело (если есть)
    if (brand) lines.push(`Brand: <b>${esc(brand)}</b>`);

    if (affiliate) lines.push(`Affiliate: <b>${esc(affiliate)}</b>`);
    if (mid) lines.push(`MID: <code>${esc(mid)}</code>`);
    // (1) clickid/pubid показываем только если не пустые и не плейсхолдеры
    if (clickidRaw) lines.push(`ClickID: <code>${esc(clickidRaw)}</code>`);
    if (pubidRaw) lines.push(`PubID: <code>${esc(pubidRaw)}</code>`);
    if (player) lines.push(`Player ID: <code>${esc(player)}</code>`);

    if (!Number.isNaN(amountNum)) {
      lines.push(`Amount: <b>${esc(amountNum)}</b>${currency ? " " + esc(currency) : ""}`);
    }

    // Если RD — показываем накопительный Total Amount (если есть всё нужное)
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

    // (3) RAW в это сообщение не добавляем — сохраняем payload в БД
    const eventId = genId();
    await db.run(
      `INSERT INTO events (id, payload, created_at) VALUES (?, ?, ?)`,
      [eventId, JSON.stringify(p), Date.now()]
    );

    // Текст сообщения
    const text = lines.filter(Boolean).join("\n");

    // Кнопка "raw" — ссылка на наш эндпоинт, который отправит сырьё в чат
    const rawUrl = `${PUBLIC_URL}/raw/${eventId}?s=${encodeURIComponent(SECRET || "")}`;

    await sendToTelegram(text, {
      reply_markup: {
        inline_keyboard: [[{ text: "raw", url: rawUrl }]],
      },
    });

    res.status(200).json({ ok: true, id: eventId });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ========================
// 8) Роут "raw": отправляет сырой payload в чат
// ========================
//
// По клику на inline-кнопку "raw" Telegram откроет этот URL.
// Роут:
//  - проверит секрет (?s=SECRET), если он задан,
//  - достанет payload из БД,
//  - порубит на части и отправит в чат как <code>...</code>,
//  - вернёт в браузер короткий ответ.
//
app.get("/raw/:id", async (req, res) => {
  try {
    if (SECRET) {
      if ((req.query.s || "") !== SECRET) {
        return res.status(403).send("Forbidden");
      }
    }

    const id = String(req.params.id || "");
    const row = await db.get(`SELECT payload FROM events WHERE id = ?`, [id]);
    if (!row) {
      return res.status(404).send("Not found");
    }

    const payload = row.payload;

    // Лимит Telegram ~4096 символов; оставим запас для обёртки <code>...</code>
    const chunks = [];
    const max = 3500;
    for (let i = 0; i < payload.length; i += max) {
      chunks.push(payload.slice(i, i + max));
    }

    await sendToTelegram(`🧾 <b>Raw event</b> (${id})`);
    for (const part of chunks) {
      await sendToTelegram(`<code>${esc(part)}</code>`);
    }

    res.status(200).send("Raw sent to chat ✅");
  } catch (e) {
    console.error(e);
    res.status(500).send("Internal error");
  }
});

// ========================
// 9) Запуск: сначала инициализируем БД
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
