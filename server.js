/**
 * LUMO E-Mail & Google Calendar Server
 * Läuft auf Railway.app
 */

const http = require("http");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");

const SMTP_CONFIG = {
  host: "smtp.ionos.de",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { rejectUnauthorized: false },
  connectionTimeout: 8000
};

const FROM_ADDRESS = `"LUMO Terminbuchung" <${process.env.SMTP_USER}>`;
const PORT = process.env.PORT || 3001;

// Google Calendar Setup
const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
const privateKey  = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n") : undefined;
const calendarId  = process.env.GOOGLE_CALENDAR_ID;

let calendar = null;
if (clientEmail && privateKey && calendarId) {
  try {
    const auth = new google.auth.JWT(clientEmail, null, privateKey, ["https://www.googleapis.com/auth/calendar"]);
    calendar = google.calendar({ version: "v3", auth });
    console.log("📅 Google Calendar API erfolgreich initialisiert.");
  } catch (e) {
    console.error("❌ Google Calendar Fehler:", e.message);
  }
}

const ALLOWED_ORIGINS = [
  "https://lumo-ai.de",
  "https://www.lumo-ai.de",
  "http://localhost",
  "http://127.0.0.1",
];

const transporter = nodemailer.createTransport(SMTP_CONFIG);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST" || req.url !== "/send-email") {
    res.writeHead(404); res.end(JSON.stringify({ error: "Not found" })); return;
  }

  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", async () => {
    try {
      const { toCustomer, toOwner, startZeit, endZeit } = JSON.parse(body);

      if (!toCustomer?.to || !toOwner?.to) {
        res.writeHead(400); res.end(JSON.stringify({ error: "Fehlende Empfänger" })); return;
      }

      // 1. E-Mails senden
      let emailSent = false;
      try {
        await Promise.all([
          transporter.sendMail({ from: FROM_ADDRESS, to: toCustomer.to, subject: toCustomer.subject, html: toCustomer.html }),
          transporter.sendMail({ from: FROM_ADDRESS, to: toOwner.to,   subject: toOwner.subject,   html: toOwner.html }),
        ]);
        console.log(`✅ E-Mails gesendet → ${toCustomer.to}`);
        emailSent = true;
      } catch (mailErr) {
        console.warn("⚠️ E-Mail fehlgeschlagen:", mailErr.message);
      }

      // 2. Google Kalender — OHNE attendees (vermeidet Domain-Delegation Fehler)
      if (calendar && startZeit && endZeit) {
        try {
          const kundenName = toCustomer.subject.replace("✅ Terminbestätigung LUMO – ", "").split(",")[0] || "Kunde";
          await calendar.events.insert({
            calendarId: calendarId,
            requestBody: {
              summary: `Erstgespräch – ${kundenName}`,
              description: `Gebucht über lumo-ai.de\nKunde: ${kundenName}\nE-Mail: ${toCustomer.to}`,
              start: { dateTime: startZeit, timeZone: "Europe/Berlin" },
              end:   { dateTime: endZeit,   timeZone: "Europe/Berlin" },
            },
          });
          console.log("📅 Kalendereintrag erstellt!");
        } catch (calErr) {
          console.error("❌ Kalender Fehler:", calErr.message);
        }
      }

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, emailSent }));
    } catch (err) {
      console.error("❌ Server Fehler:", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
