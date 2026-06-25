// Update 3 — Google Meet Link Integration
/**
 * LUMO E-Mail & Google Calendar Server
 * Läuft auf Railway.app — verwendet Resend für E-Mails
 */

const http = require("http");
const { google } = require("googleapis");

const PORT = process.env.PORT || 3001;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = "LUMO Terminbuchung <hallo@lumo-ai.de>";

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

// E-Mail senden via Resend API
async function sendEmail(to, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend Fehler: ${err}`);
  }
  return res.json();
}

// Setzt den Meet-Link in die E-Mail-HTML ein bzw. entfernt den Platzhalter-Block,
// falls kein Link erzeugt werden konnte.
// booking_inject.html muss dafür im E-Mail-Template enthalten:
//   <!--MEET_LINK_START--> ... {{MEET_LINK}} ... <!--MEET_LINK_END-->
function injectMeetLink(html, meetLink) {
  if (!html) return html;
  if (meetLink) {
    return html.replace(/\{\{MEET_LINK\}\}/g, meetLink);
  }
  return html.replace(/<!--MEET_LINK_START-->[\s\S]*?<!--MEET_LINK_END-->/g, "");
}

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

      // 1. Google Kalender Eintrag ZUERST anlegen, um den Meet-Link zu erhalten
      let meetLink = null;
      if (calendar && startZeit && endZeit) {
        try {
          const calResponse = await calendar.events.insert({
            calendarId: calendarId,
            conferenceDataVersion: 1, // Pflicht, damit Meet-Link erzeugt wird
            requestBody: {
              summary: `Erstgespräch – ${toCustomer.subject.split("LUMO – ")[1]?.split(",")[0] || "Kunde"}`,
              description: `Gebucht über lumo-ai.de\nE-Mail: ${toCustomer.to}`,
              start: { dateTime: startZeit, timeZone: "Europe/Berlin" },
              end:   { dateTime: endZeit,   timeZone: "Europe/Berlin" },
              conferenceData: {
                createRequest: {
                  requestId: `lumo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              },
            },
          });

          meetLink = calResponse.data.conferenceData?.entryPoints
            ?.find(e => e.entryPointType === "video")?.uri || null;

          console.log(`📅 Kalendereintrag erstellt! Meet-Link: ${meetLink || "— kein Link erhalten"}`);
        } catch (calErr) {
          console.error("❌ Kalender Fehler:", calErr.message);
        }
      }

      // 2. Meet-Link in die E-Mail-HTML einsetzen (oder Platzhalter-Block entfernen)
      const customerHtml = injectMeetLink(toCustomer.html, meetLink);
      const ownerHtml = injectMeetLink(toOwner.html, meetLink);

      // 3. E-Mails via Resend senden
      let emailSent = false;
      try {
        await Promise.all([
          sendEmail(toCustomer.to, toCustomer.subject, customerHtml),
          sendEmail(toOwner.to,   toOwner.subject,   ownerHtml),
        ]);
        console.log(`✅ E-Mails gesendet via Resend → ${toCustomer.to}`);
        emailSent = true;
      } catch (mailErr) {
        console.error("❌ Resend Fehler:", mailErr.message);
      }

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, emailSent, meetLink }));
    } catch (err) {
      console.error("❌ Server Fehler:", err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 LUMO Server läuft auf Port ${PORT}`);
  if (!RESEND_API_KEY) console.warn("⚠️ RESEND_API_KEY fehlt!");
  if (!calendar)       console.warn("⚠️ Google Calendar nicht initialisiert!");
});
