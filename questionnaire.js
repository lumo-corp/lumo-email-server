// LUMO – Fragebogen-Endpunkt (POST /api/questionnaire)
// Nimmt die Antworten aus dem Formular entgegen und schickt sie per Resend an OWNER_EMAIL.
// Benötigte Railway-Variablen: RESEND_API_KEY (vorhanden), OWNER_EMAIL (neu).

const fs = require("fs");
const path = require("path");

const FROM_ADDRESS = process.env.QUESTIONNAIRE_FROM || "LUMO <hallo@lumo-ai.de>";
const MAX_BODY_BYTES = 200 * 1024;

// Logo wird als eingebettetes Bild (cid) mitgeschickt – so zeigen es auch Gmail & Co.
let LOGO_BASE64 = null;
try {
  LOGO_BASE64 = fs.readFileSync(path.join(__dirname, "logo.png")).toString("base64");
} catch (e) {
  console.warn("⚠️ logo.png nicht gefunden – E-Mail ohne Logo");
}

// Einfaches Rate-Limit im Speicher: max. 5 Sendungen pro IP und Stunde
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function row(q, a) {
  return `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #E4DFD3;width:45%;vertical-align:top;font-weight:bold;color:#5A5855;">${esc(q)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #E4DFD3;vertical-align:top;color:#5A5855;white-space:pre-wrap;">${
        a ? esc(a) : '<span style="color:#9a9a9a;">–</span>'
      }</td>
    </tr>`;
}

function buildHtml(data) {
  const metaRows = (data.meta || []).map((m) => row(m.q, m.a)).join("");
  const sections = (data.sections || [])
    .map(
      (s) => `
    <h3 style="margin:28px 0 8px;font-family:Arial,sans-serif;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;color:#D4922A;border-bottom:2px solid #D4922A;padding-bottom:6px;">${esc(s.title)}</h3>
    <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
      ${(s.items || []).map((i) => row(i.q, i.a)).join("")}
    </table>`
    )
    .join("");

  return `<!DOCTYPE html>
<html><body style="margin:0;background:#F5F0E8;padding:24px;">
  <div style="max-width:760px;margin:0 auto;background:#FFFFFF;border:1px solid #E4DFD3;">
    <div style="background:#F5F0E8;padding:22px 28px;">
      <table role="presentation" style="border-collapse:collapse;"><tr>
        ${LOGO_BASE64 ? '<td style="padding-right:18px;vertical-align:middle;"><img src="cid:lumo-logo" width="70" alt="LUMO" style="display:block;border:0;"></td>' : ""}
        <td style="vertical-align:middle;font-family:Arial,sans-serif;">
          <div style="font-size:13px;letter-spacing:0.16em;color:#D4922A;font-weight:bold;">WEBSITE &amp; PERSONAL BRAND QUESTIONNAIRE</div>
          <div style="font-size:15px;color:#939290;margin-top:6px;">Neue Antwort eingegangen</div>
        </td>
      </tr></table>
    </div>
    <div style="background:#D4922A;color:#FFFFFF;padding:13px 28px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Neue Fragebogen-Antwort</div>
    <div style="padding:8px 28px 28px;">
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;margin-top:18px;">${metaRows}</table>
      ${sections}
    </div>
  </div>
</body></html>`;
}

function buildText(data) {
  const lines = [];
  (data.meta || []).forEach((m) => lines.push(`${m.q}: ${m.a || "-"}`));
  (data.sections || []).forEach((s) => {
    lines.push("", `== ${s.title} ==`);
    (s.items || []).forEach((i) => lines.push(`${i.q}\n  -> ${i.a || "-"}`));
  });
  return lines.join("\n");
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Wird aus server.js aufgerufen. CORS und OPTIONS erledigt server.js bereits.
function handleQuestionnaire(req, res) {
  let body = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (tooBig) return;
    try {
      const data = JSON.parse(body || "{}");

      // Honeypot: Bots füllen das versteckte Feld aus – still ignorieren
      if (data.website) return send(res, 200, { ok: true });

      const ip =
        (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        req.socket.remoteAddress ||
        "unknown";
      if (rateLimited(ip)) return send(res, 429, { ok: false, error: "rate_limited" });

      if (!Array.isArray(data.sections) || data.sections.length === 0) {
        return send(res, 400, { ok: false, error: "invalid_payload" });
      }

      const to = process.env.OWNER_EMAIL;
      const key = process.env.RESEND_API_KEY;
      if (!to || !key) {
        console.error("❌ Fragebogen: OWNER_EMAIL oder RESEND_API_KEY fehlt");
        return send(res, 500, { ok: false, error: "server_not_configured" });
      }

      const guestName = String(data.meta?.[0]?.a || "").slice(0, 80) || "unbekannt";

      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: [to],
          subject: `Fragebogen Tourguide – ${guestName}`,
          html: buildHtml(data),
          text: buildText(data),
          ...(LOGO_BASE64
            ? {
                attachments: [
                  {
                    filename: "lumo-logo.png",
                    content: LOGO_BASE64,
                    content_type: "image/png",
                    content_id: "lumo-logo",
                  },
                ],
              }
            : {}),
        }),
      });

      if (!r.ok) {
        console.error("❌ Fragebogen: Resend-Fehler", r.status, await r.text());
        return send(res, 502, { ok: false, error: "mail_failed" });
      }
      console.log(`✅ Fragebogen gesendet (${guestName})`);
      send(res, 200, { ok: true });
    } catch (e) {
      console.error("❌ Fragebogen Fehler:", e.message);
      send(res, 500, { ok: false, error: "server_error" });
    }
  });
}

module.exports = { handleQuestionnaire };
