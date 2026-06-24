/**
 * LUMO E-Mail-Server + Google Calendar Integration
 * Läuft auf Railway.app
 */

const http = require("http");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");

// SMTP-Konfiguration
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

// Google Calendar API Auth einrichten
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
let calendar = null;

if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Zeilenumbrüche fixen
    SCOPES
  );
  calendar = google.calendar({ version: 'v3', auth });
  console.log("📅 Google Calendar API initialisiert.");
} else {
  console.warn("⚠️ Google Calendar Variablen fehlen noch in Railway!");
}

const transporter = nodemailer.createTransport(SMTP_CONFIG);

// Hilfsfunktion für den Google Kalendereintrag
async function erstelleKalenderEintrag(kundeEmail, startZeit, endZeit) {
  if (!calendar || !process.env.GOOGLE_CALENDAR_ID) {
    console.log("⏭️ Kalendereintrag übersprungen (API nicht konfiguriert oder Variablen fehlen).");
    return;
  }

  // Fallback-Zeiten, falls das Widget keine mitschickt (heute in 1 Stunde für 30 Min)
  const defaultStart = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const defaultEnd = new Date(Date.now() + 90 * 60 * 1000).toISOString();

  const event = {
    'summary': 'Dein LUMO Beratungstermin',
    'description': `Automatisch erstellter Termin für ${kundeEmail}.`,
    'start': {
      'dateTime': startZeit || defaultStart, // Format: '2026-06-25T14:00:00+02:00'
      'timeZone': 'Europe/Berlin',
    },
    'end': {
      'dateTime': endZeit || defaultEnd,     // Format: '2026-06-25T14:30:00+02:00'
      'timeZone': 'Europe/Berlin',
    },
    'attendees': [
      { 'email': kundeEmail }
    ],
    'reminders': {
      'useDefault': true,
    },
  };

  await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: event,
    sendUpdates: 'all', // Verschickt die schicke Google-E-Mail-Einladung!
  });
  console.log(`📅 Google Kalendereintrag erstellt & Einladung an ${kundeEmail} gesendet!`);
}

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
      const payload = JSON.parse(body);
      const { toCustomer, toOwner } = payload;

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

      // 1. E-Mails wie gewohnt senden
      await Promise.all([
        transporter.sendMail({ from: FROM_ADDRESS, to: toCustomer.to, subject: toCustomer.subject, html: toCustomer.html }),
        transporter.sendMail({ from: FROM_ADDRESS, to: toOwner.to,   subject: toOwner.subject,   html: toOwner.html   }),
      ]);
      console.log(`✅ E-Mails gesendet → ${toCustomer.to}`);

      // 2. Google Kalendereintrag erstellen
      // Sucht nach startZeit/endZeit im Request (entweder direkt oder im toCustomer Objekt)
      const startZeit = payload.startZeit || toCustomer.startZeit;
      const endZeit = payload.endZeit || toCustomer.endZeit;
      
      try {
        await erstelleKalenderEintrag(toCustomer.to, startZeit, endZeit);
      } catch (calErr) {
        console.error("❌ Fehler beim Kalendereintrag (E-Mails gingen trotzdem raus):", calErr.message);
        // Wir blockieren die Response nicht, falls nur der Kalender zickt
      }

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error("❌ Allgemeiner Fehler:", err.message);
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
