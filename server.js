import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 3000;

// === ENV ===
const BOT_TOKEN = process.env.BOT_TOKEN;     // Токен бота из BotFather
const CHAT_ID   = process.env.CHAT_ID;       // ID группы/чата, куда слать
const SECRET    = process.env.SECRET || "";  // Секретный хвост в URL

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing!");
  process.exit(1);
}

app.use(morgan("tiny"));
app.use(express.urlencoded({ extended: true })); // для form-data/x-www-form-urlencoded
app.use(express.json());                          // для JSON

async function sendToTelegram({ text, parseMode = "HTML", disablePreview = true }) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: parseMode,              // HTML проще, чем MarkdownV2
      disable_web_page_preview: disablePreview
    })
  });
  const data = await res.json();
  if (!data.ok) console.error("Telegram API error:", data);
  return data;
}

// Healthcheck
app.get("/", (_req, res) => res.send("OK"));

// Точка приёма постбеков
// Пример: POST https://<твой-сервис>.onrender.com/postback/<SECRET>
app.post(`/postback/${SECRET}`, async (req, res) => {
  try {
    // Собираем любые параметры из query/body
    const p = { ...req.query, ...req.body };

    // Читаемый текст для телеграм
    const lines = [
      "<b>🚀 New Conversion</b>",
      p.status ? `Status: <b>${p.status}</b>` : null,
      p.goal ? `Goal: <b>${p.goal}</b>` : null,
      p.currency && p.payout ? `Payout: <b>${p.payout} ${p.currency}</b>` : (p.payout ? `Payout: <b>${p.payout}</b>` : null),
      p.offer ? `Offer: <b>${p.offer}</b>` : null,
      p.campaign ? `Campaign: <b>${p.campaign}</b>` : null,
      p.country ? `Country: <b>${p.country}</b>` : null,
      p.affiliate_id ? `Aff ID: <b>${p.affiliate_id}</b>` : null,
      p.clickid ? `ClickID: <code>${p.clickid}</code>` : null,
      p.sub1 ? `sub1: <code>${p.sub1}</code>` : null,
      p.sub2 ? `sub2: <code>${p.sub2}</code>` : null,
      "",
      "<i>Raw:</i>",
      `<code>${JSON.stringify(p)}</code>`
    ].filter(Boolean);

    const text = lines.join("\n");
    await sendToTelegram({ text, parseMode: "HTML" });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
