// Было:
// app.post(`/postback/${SECRET}`, async (req, res) => {

// Стало: принимаем и GET, и POST, и секрет как параметр
app.all('/postback/:secret', async (req, res) => {
  try {
    const secretFromUrl = req.params.secret;
    if (process.env.SECRET && secretFromUrl !== process.env.SECRET) {
      return res.status(403).json({ ok: false, error: "Forbidden (bad secret)" });
    }

    // Собираем параметры из query и body
    const p = { ...req.query, ...req.body };

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
