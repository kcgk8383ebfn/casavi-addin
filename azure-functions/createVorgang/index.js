/**
 * Azure Function: createVorgang
 *
 * Analysiert eine E-Mail mit Claude AI und erstellt automatisch
 * einen Casavi-Vorgang (Service Request / Ticket).
 *
 * Input (POST body):
 * {
 *   email: {
 *     subject:      "Betreff der E-Mail",
 *     body:         "Volltext der E-Mail",
 *     sender:       "Max Mustermann",
 *     senderEmail:  "max@example.com",
 *     receivedDate: "2026-03-25T10:00:00Z",
 *     to:           "hausverwaltung@example.com"
 *   },
 *   contact: {
 *     id:           "casavi-contact-id",
 *     name:         "Max Mustermann",
 *     // ... weitere Felder aus checkContact
 *   }
 * }
 *
 * Output:
 * {
 *   success: true,
 *   vorgangId: "...",
 *   vorgangUrl: "...",
 *   extractedData: { ... }  // Was Claude aus der E-Mail extrahiert hat
 * }
 */

const Anthropic = require("@anthropic-ai/sdk").default;
const fetch = require("node-fetch");

const CASAVI_API_BASE = process.env.CASAVI_API_BASE_URL || "https://api.casavi.de/api/v1";
const CASAVI_API_KEY = process.env.CASAVI_API_KEY;
const CASAVI_API_SECRET = process.env.CASAVI_API_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── Casavi Auth ──────────────────────────────────────────────────────────────

function getCasaviHeaders() {
  const credentials = Buffer.from(`${CASAVI_API_KEY}:${CASAVI_API_SECRET}`).toString("base64");
  return {
    "Authorization": `Basic ${credentials}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

// ─── Claude: E-Mail analysieren ───────────────────────────────────────────────

async function analyzeEmailWithClaude(emailData, contactData) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const systemPrompt = `Du bist ein Assistent für eine Hausverwaltung und arbeitest mit der Casavi-Software.
Deine Aufgabe: Analysiere eine eingehende E-Mail und extrahiere alle relevanten Informationen für einen Casavi-Vorgang (Service Request / Ticket).

Antworte IMMER mit einem validen JSON-Objekt. Keine Erklärungen, nur JSON.

Bekannte Kategorien in Casavi (typische Werte):
- "Reparatur" / "Instandhaltung"
- "Reinigung"
- "Schlüssel / Zugang"
- "Heizung / Sanitär"
- "Elektrik"
- "Lärm / Nachbarschaft"
- "Abrechnung / Verwaltung"
- "Sonstiges"

Prioritäten:
- "low" = niedrig (Hinweis, nicht dringend)
- "normal" = normal (Standard)
- "high" = hoch (dringend, zeitkritisch)
- "urgent" = sehr dringend (Notfall, Wasserrohrbruch, Einbruch etc.)

Fülle ALLE Felder aus. Wenn du etwas nicht genau weißt, rate intelligent basierend auf dem Kontext.
Denke wie ein erfahrener Hausverwalter.`;

  const userPrompt = `Analysiere diese eingehende E-Mail und erstelle die Casavi-Vorgang-Daten:

ABSENDER-KONTAKT (aus Casavi-Stammdaten):
${JSON.stringify(contactData, null, 2)}

E-MAIL:
Von: ${emailData.sender} <${emailData.senderEmail}>
An: ${emailData.to || "Hausverwaltung"}
Datum: ${emailData.receivedDate}
Betreff: ${emailData.subject}

Inhalt:
${emailData.body}

---

Antworte mit diesem JSON (alle Felder ausfüllen):
{
  "title": "Kurzer, prägnanter Titel für den Vorgang (max. 80 Zeichen)",
  "description": "Vollständige Beschreibung des Anliegens. Schreibe in der 3. Person aus Sicht der Hausverwaltung. Ergänze relevante Details aus dem Kontext.",
  "category": "Passende Kategorie aus der Liste oben",
  "priority": "low|normal|high|urgent",
  "priorityReason": "Begründung warum diese Priorität",
  "requestedBy": "Name des Absenders",
  "location": "Adresse/Einheit wenn erwähnt, sonst aus Kontaktdaten ableiten",
  "dueDate": "ISO-Datum wenn Frist erwähnt, sonst null",
  "internalNote": "Interne Notiz für die Hausverwaltung (was zu beachten ist, nächste Schritte)",
  "tags": ["tag1", "tag2"],
  "estimatedEffort": "Geschätzter Aufwand (z.B. '30 Min', '1 Tag', 'Handwerker beauftragen')",
  "confidenceScore": 0.95
}`;

  console.log("[createVorgang] Sende E-Mail an Claude zur Analyse...");

  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
    system: systemPrompt,
  });

  const responseText = message.content[0].text;
  console.log("[createVorgang] Claude Antwort:", responseText);

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Claude hat kein valides JSON zurückgegeben");
  }

  return JSON.parse(jsonMatch[0]);
}

// ─── Casavi: Vorgang erstellen ─────────────────────────────────────────────────

async function createCasaviVorgang(extractedData, emailData, contactData) {
  const url = `${CASAVI_API_BASE}/service-requests`;

  const vorgangPayload = {
    title: extractedData.title || emailData.subject || "E-Mail Anfrage",
    description: buildDescription(extractedData, emailData),
    category: extractedData.category || "Sonstiges",
    priority: extractedData.priority || "normal",
    status: "open",
    ...(contactData?.id && { contact_id: contactData.id }),
    ...(contactData?.tenant_id && { tenant_id: contactData.tenant_id }),
    ...(contactData?.property_id && { property_id: contactData.property_id }),
    source: "email",
    source_email: emailData.senderEmail,
    internal_note: extractedData.internalNote || "",
    tags: extractedData.tags || [],
    ...(extractedData.dueDate && { due_date: extractedData.dueDate }),
    custom_fields: {
      original_email_subject: emailData.subject,
      original_email_date: emailData.receivedDate,
      original_sender: emailData.senderEmail,
      created_by: "Outlook Add-in (KI)",
      ai_confidence: extractedData.confidenceScore || 0,
    },
  };

  console.log("[createVorgang] Erstelle Casavi-Vorgang:", JSON.stringify(vorgangPayload, null, 2));

  const response = await fetch(url, {
    method: "POST",
    headers: getCasaviHeaders(),
    body: JSON.stringify(vorgangPayload),
    timeout: 15000,
  });

  const responseBody = await response.text();
  console.log(`[createVorgang] Casavi Antwort (${response.status}):`, responseBody);

  if (!response.ok) {
    throw new Error(`Casavi API Fehler ${response.status}: ${responseBody}`);
  }

  let createdVorgang;
  try {
    createdVorgang = JSON.parse(responseBody);
  } catch {
    createdVorgang = { raw: responseBody };
  }

  return createdVorgang;
}

function buildDescription(extractedData, emailData) {
  const parts = [];

  if (extractedData.description) {
    parts.push(extractedData.description);
  }

  parts.push(`\n---`);
  parts.push(`📧 Ursprüngliche E-Mail vom ${new Date(emailData.receivedDate).toLocaleDateString("de-DE")}`);
  parts.push(`Von: ${emailData.sender} <${emailData.senderEmail}>`);
  parts.push(`Betreff: ${emailData.subject}`);

  if (extractedData.location) {
    parts.push(`📍 Ort/Einheit: ${extractedData.location}`);
  }

  if (extractedData.estimatedEffort) {
    parts.push(`⏱ Geschätzter Aufwand: ${extractedData.estimatedEffort}`);
  }

  parts.push(`\nE-Mail-Text:\n"${emailData.body.substring(0, 1000)}${emailData.body.length > 1000 ? "..." : ""}"`);

  return parts.join("\n");
}

// ─── Hauptfunktion ─────────────────────────────────────────────────────────────

module.exports = async function (context, req) {
  context.log("[createVorgang] Funktion gestartet");

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (req.method === "OPTIONS") {
    context.res = { status: 200, headers: corsHeaders, body: "" };
    return;
  }

  const body = req.body || {};
  if (!body.email) {
    context.res = {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "E-Mail-Daten fehlen (body.email ist erforderlich)" }),
    };
    return;
  }

  const emailData = body.email;
  const contactData = body.contact || null;

  if (!emailData.body && !emailData.subject) {
    context.res = {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "E-Mail muss mindestens Betreff oder Inhalt haben" }),
    };
    return;
  }

  if (!CASAVI_API_KEY || !CASAVI_API_SECRET) {
    context.res = {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Casavi API-Zugangsdaten nicht konfiguriert" }),
    };
    return;
  }

  if (!ANTHROPIC_API_KEY) {
    context.res = {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Anthropic API-Key nicht konfiguriert (ANTHROPIC_API_KEY)" }),
    };
    return;
  }

  try {
    context.log("[createVorgang] Schritt 1: Claude analysiert die E-Mail...");
    const extractedData = await analyzeEmailWithClaude(emailData, contactData);
    context.log("[createVorgang] Extrahierte Daten:", extractedData);

    context.log("[createVorgang] Schritt 2: Erstelle Casavi-Vorgang...");
    const createdVorgang = await createCasaviVorgang(extractedData, emailData, contactData);

    const vorgangId = createdVorgang.id || createdVorgang.ticket_id || createdVorgang.number;
    const vorgangUrl = createdVorgang.url ||
      (vorgangId ? `https://app.casavi.de/tickets/${vorgangId}` : null);

    context.log(`[createVorgang] ✅ Vorgang erstellt: ID=${vorgangId}`);

    context.res = {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        vorgangId,
        vorgangUrl,
        extractedData,
        casaviResponse: createdVorgang,
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    context.log.error("[createVorgang] Fehler:", error);
    context.res = {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        error: error.message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      }),
    };
  }
};
