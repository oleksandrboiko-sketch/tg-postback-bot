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

    // нормализуем
    const status   = (p.status || "").toLowerCase(); // reg / ftd / rd
    const affiliate = p.affiliate || "";
    const mid       = p.mid || "";
    const clickid   = p.clickid || "";
    const pubid     = p.pubid || "";
    const player    = p.player || "";
    const currency  = p.currency || "";
    const amountStr = (p.amount || "").toString().replace(",", "."); // на всякий
    const amountNum = Number.parseFloat(amountStr);

    let header = "";
    if (status === "reg") header = "🟢 <b>New Registration</b>";
    else if (status === "ftd") header = "💰 <b>New FTD</b>";
    else if (status === "rd") header = "🔁 <b>Re-Deposit</b>";
    else header = "📩 <b>New Event</b>";

    const lines = [header];

    if (affiliate) lines.push(`Affiliate: <b>${affiliate}</b>`);
    if (mid)       lines.push(`MID: <code>${mid}</code>`);
    if (clickid)   lines.push(`ClickID: <code>${clickid}</code>`);
    if (pubid)     lines.push(`PubID: <code>${pubid}</code>`);
    if (player)    lines.push(`Player ID: <code>${player}</code>`);
    if (brand)    lines.push(`Brand: <code>${brand}</code>`);

    // Для FTD/rd показываем сумму транзакции (если есть)
    if (Number.isFinite(amountNum)) {
      if (currency) lines.push(`Amount: <b>${amountNum} ${currency}</b>`);
      else          lines.push(`Amount: <b>${amountNum}</b>`);
    }

    // === NEW: Total Amount для rd ===
    if (status === "rd") {
      if (player && currency && Number.isFinite(amountNum)) {
        const total = await addAndGetTotal(player, currency, amountNum);
        if (Number.isFinite(total)) {
          lines.push(`Total Amount: <b>${total} ${currency}</b>`);
        } else {
          // Нет данных (например, не пришла валюта/сумма)
          lines.push(`<i>Total Amount недоступен (нет currency/amount).</i>`);
        }
      } else {
        lines.push(`<i>Total Amount недоступен (нужно player, currency, amount).</i>`);
      }
    }

    // Debug/raw (оставим — полезно при интеграции)
    lines.push("", "<i>Raw:</i>", `<code>${JSON.stringify(p)}</code>`);

    const text = lines.filter(Boolean).join("\n");
    await sendToTelegram(text);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Запуск
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Listening on port ${PORT}`));
});
