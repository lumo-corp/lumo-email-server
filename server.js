/**
 * LUMO E-Mail-Server
 * Läuft auf Railway.app
 */

const http = require("http");
const nodemailer = require("nodemailer");

const SMTP_CONFIG = {
  host: "smtp.ionos.de",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,   // wird in Railway als Variable gesetzt
    pass: process.env.SMTP_PASS,   // wird in Railway als Variable gesetzt
  },
};

const FROM_ADDRESS = `"LUMO Terminbuchung" <${process.env.SMTP_USER}>`;
const PORT = process.env.PORT || 3001;

// CORS: deine Webseite eintragen
const ALLOWED_ORIGINS = [
  "https://lumo-ai.de",
  "https://www.lumo-ai.de",
  "http://localhost",           // zum lokalen Testen
  "http://127.0.0.1",
];

const transporter = nodemailer.createTransport(SMTP_CONFIG);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";

  // CORS-Header
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/send-email") {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", async () => {
    try {
      const { toCustomer, toOwner } = JSON.parse(body);

      if (!toCustomer?.to || !toOwner?.to) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Fehlende Empfänger" }));
        return;
      }

      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
      if (!emailRe.test(toCustomer.to)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Ungültige E-Mail" }));
        return;
      }

      await Promise.all([
        transporter.sendMail({ from: FROM_ADDRESS, to: toCustomer.to, subject: toCustomer.subject, html: toCustomer.html }),
        transporter.sendMail({ from: FROM_ADDRESS, to: toOwner.to,   subject: toOwner.subject,   html: toOwner.html   }),
      ]);

      console.log(`✅ E-Mails gesendet → ${toCustomer.to}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error("❌ Fehler:", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`📬 LUMO E-Mail-Server läuft auf Port ${PORT}`);
  transporter.verify((err) => {
    if (err) console.error("⚠️  SMTP-Fehler:", err.message);
    else     console.log("✅ SMTP-Verbindung erfolgreich!");
  });
});
