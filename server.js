import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";

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

// === Основной роут постбеков ===
// Работает с GET и POST, принимает SECRET как параметр пути
app.all("/postback/:secret", async (req, res) => {
  try {
    const secretFromUrl = req.params.secret;
    if (process.env.SECRET && secretFromUrl !== process.env.SECRET) {
      return res.status(403).json({ ok: false, error: "Forbidden (bad secret)" });
    }

    // собираем все поля
    const p = { ...req.query, ...req.body };

    // нормализуем данные
    const status = (p.status || "").toLowerCase();

    // ==== Формируем текст сообщения ====
    let header = "";
    if (status === "reg") header = "🟢 <b>New Registration</b>";
    else if (status === "ftd") header = "💰 <b>New FTD</b>";
    else if (status === "rd") header = "🔁 <b>Re-Deposit</b>";
    else header = "📩 <b>New Event</b>";

    const lines = [
      header,
      p.affiliate ? `Affiliate: <b>${p.affiliate}</b>` : null,
      p.mid ? `MID: <code>${p.mid}</code>` : null,
      p.clickid ? `ClickID: <code>${p.clickid}</code>` : null,
      p.pubid ? `PubID: <code>${p.pubid}</code>` : null,
      p.player ? `Player ID: <code>${p.player}</code>` : null,
      p.currency && p.amount ? `Amount: <b>${p.amount} ${p.currency}</b>` : (p.amount ? `Amount: <b>${p.amount}</b>` : null),
      "",
      `<i>Raw:</i>`,
      `<code>${JSON.stringify(p)}</code>`
    ].filter(Boolean);

    const text = lines.join("\n");

    await sendToTelegram(text);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => console.log(`✅ Listening on port ${PORT}`));
