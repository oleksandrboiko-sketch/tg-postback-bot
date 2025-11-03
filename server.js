import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
const PORT = process.env.PORT || 3000;

// === ENV ===
const BOT_TOKEN = process.env.BOT_TOKEN; // токен из BotFather
const CHAT_ID   = process.env.CHAT_ID;   // chat_id группы
const SECRET    = process.env.SECRET || ""; // секрет для URL

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing BOT_TOKEN or CHAT_ID in environment!");
  process.exit(1);
}

// ---------- DB (SQLite) ----------
let db;
async function initDB() {
  // Файл БД (в корне проекта). Для Render ок.
  db = await open({
    filename: "./data.sqlite",
    driver: sqlite3.Database
  });

  // Храним сумму по ключу (player, currency)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS totals (
      player   TEXT NOT NULL,
      currency TEXT NOT NULL,
      total    REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (player, currency)
    );
  `);
}

async function addAndGetTotal(player, currency, amountNum) {
  if (!player || !currency || !Number.isFinite(amountNum)) return null;

  // UPSERT: вставить или обновить сумму
  await db.run(
    `
    INSERT INTO totals (player, currency, total)
    VALUES (?, ?, ?)
    ON CONFLICT(player, currency)
    DO UPDATE SET total = total + excluded.total;
    `,
    [player, currency, amountNum]
  );

  const row = await db.get(
    `SELECT total FROM totals WHERE player = ? AND currency = ?;`,
    [player, currency]
  );
  return row ? row.total : null;
}

// ---------- App ----------
app.use(morgan("tiny"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

async function sendToTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  const data = await res.json();
  if (!data.ok) console.error("Telegram API error:", data);
}

// Healthcheck
app.get("/", (_, res) => res.send("OK"));

// Основной роут постбеков (GET/POST), секрет в пути
app.all("/postback/:secret", async (req, res) => {
  try {
    const secretFromUrl = req.params.secret;
    if (process.env.SECRET && secretFromUrl !== process.env.SECRET) {
      return res.status(403).json({ ok: false, error: "Forbidden (bad secret)" });
    }

    const p = { ...req.query, ...req.body };

    // ==== НОРМАЛИЗАЦИЯ ====
    const status     = cleanVal(p.status).toLowerCase(); // reg / ftd / rd / ...
    const affiliate  = cleanVal(p.affiliate);
    const mid        = cleanVal(p.mid);
    // 1) clickid/pubid — не показывать, если пусто ИЛИ это плейсхолдеры вида ${clickid}/${pubid}
    const clickidRaw = cleanVal(p.clickid, ["${clickid}"]);
    const pubidRaw   = cleanVal(p.pubid,   ["${pubid}"]);
    const player     = cleanVal(p.player);
    const currency   = cleanVal(p.currency);
    const brand      = cleanVal(p.brand || p.Brand || p.BRAND);

    const amountStr  = cleanVal(p.amount).replace(",", ".");
    const amountNum  = Number.isFinite(parseFloat(amountStr)) ? parseFloat(amountStr) : NaN;

    // ==== ЗАГОЛОВОК ====
    let header = "";
    if (status === "reg") header = "📩 <b>Reg</b>";
    else if (status === "ftd") header = "🤑 <b>FTD</b>";
    else if (status === "rd") header = "💶 <b>Re-Deposit</b>";
    else header = "📩 <b>New Event</b>";

    const lines = [header];

    // 2) Вынести brand в основное тело (если есть)
    if (brand)     lines.push(`Brand: <b>${esc(brand)}</b>`);

    if (affiliate) lines.push(`Affiliate: <b>${esc(affiliate)}</b>`);
    if (mid)       lines.push(`MID: <code>${esc(mid)}</code>`);
    if (clickidRaw)lines.push(`ClickID: <code>${esc(clickidRaw)}</code>`);
    if (pubidRaw)  lines.push(`PubID: <code>${esc(pubidRaw)}</code>`);
    if (player)    lines.push(`Player ID: <code>${esc(player)}</code>`);

    if (!Number.isNaN(amountNum)) {
      lines.push(`Amount: <b>${esc(amountNum)}</b>${currency ? " " + esc(currency) : ""}`);
    }

    // Total для RD
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

    // 3) НЕ показываем Raw в самом сообщении.
    // Вместо этого — сохраняем payload в БД и даём кнопку "raw" (URL)
    const eventId = randomUUID();
    await db.run(
      `INSERT INTO events (id, payload, created_at) VALUES (?, ?, ?)`,
      [eventId, JSON.stringify(p), Date.now()]
    );

    const text = lines.filter(Boolean).join("\n");

    // Кнопка "raw" ведёт на наш URL, клик по которому отправит raw в чат
    const rawUrl = `${PUBLIC_URL}/raw/${eventId}?s=${encodeURIComponent(SECRET || "")}`;

    await sendToTelegram(text, {
      reply_markup: {
        inline_keyboard: [[{ text: "raw", url: rawUrl }]]
      }
    });

    res.status(200).json({ ok: true, id: eventId });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});
// Запуск
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Listening on port ${PORT}`));
});
