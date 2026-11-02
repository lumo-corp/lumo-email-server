// LUMO – Fragebogen-Endpunkt (POST /api/questionnaire)
// Nimmt die Antworten aus dem Formular entgegen und schickt sie per Resend an OWNER_EMAIL.
// Benötigte Railway-Variablen: RESEND_API_KEY (vorhanden), OWNER_EMAIL (neu).

const FROM_ADDRESS = process.env.QUESTIONNAIRE_FROM || "LUMO <hallo@lumo-ai.de>";
const MAX_BODY_BYTES = 200 * 1024;

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
      <td style="padding:10px 12px;border-bottom:1px solid #e6d9b3;width:45%;vertical-align:top;font-weight:bold;color:#1A1A2E;">${esc(q)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e6d9b3;vertical-align:top;color:#1A1A2E;white-space:pre-wrap;">${
        a ? esc(a) : '<span style="color:#9a9a9a;">–</span>'
      }</td>
    </tr>`;
}

function buildHtml(data) {
  const metaRows = (data.meta || []).map((m) => row(m.q, m.a)).join("");
  const sections = (data.sections || [])
    .map(
      (s) => `
    <h3 style="margin:28px 0 8px;font-family:Arial,sans-serif;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;color:#9a7b22;border-bottom:2px solid #C9A84C;padding-bottom:6px;">${esc(s.title)}</h3>
    <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
      ${(s.items || []).map((i) => row(i.q, i.a)).join("")}
    </table>`
    )
    .join("");

  return `<!DOCTYPE html>
<html><body style="margin:0;background:#F5EDD6;padding:24px;">
  <div style="max-width:760px;margin:0 auto;background:#fffdf7;border:1px solid #e6d9b3;">
    <div style="background:#1A1A2E;padding:24px 28px;border-bottom:4px solid #C9A84C;">
      <div style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:0.35em;color:#C9A84C;font-weight:bold;">L U M O</div>
      <div style="font-family:Georgia,serif;font-size:22px;color:#F5EDD6;margin-top:10px;">Neue Fragebogen-Antwort</div>
    </div>
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
