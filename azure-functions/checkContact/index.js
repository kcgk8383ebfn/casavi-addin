/**
 * Azure Function: checkContact
 *
 * Prüft ob der E-Mail-Absender in den Casavi/Impower Stammdaten vorhanden ist.
 *
 * Input (POST body oder GET query):
 *   - email: E-Mail-Adresse des Absenders
 *   - name:  (optional) Name des Absenders
 *
 * Output:
 *   - found: true/false
 *   - contact: Kontakt-Objekt aus Casavi (wenn gefunden)
 *   - properties: zugehörige Objekte/Liegenschaften
 */

const fetch = require("node-fetch");

const CASAVI_API_BASE = process.env.CASAVI_API_BASE_URL || "https://api.casavi.de/api/v1";
const CASAVI_API_KEY = process.env.CASAVI_API_KEY;
const CASAVI_API_SECRET = process.env.CASAVI_API_SECRET;

/**
 * Erstellt den Authorization-Header für Casavi API.
 * Casavi nutzt HTTP Basic Auth: key:secret als Base64.
 */
function getCasaviHeaders() {
  const credentials = Buffer.from(`${CASAVI_API_KEY}:${CASAVI_API_SECRET}`).toString("base64");
  return {
    "Authorization": `Basic ${credentials}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

/**
 * Sucht einen Kontakt in Casavi anhand der E-Mail-Adresse.
 * Probiert mehrere Endpunkte, da Casavi verschiedene Kontakttypen hat:
 * - Mieter (tenants)
 * - Eigentümer (owners)
 * - Allgemeine Kontakte (contacts)
 */
async function findContactByEmail(email) {
  const endpoints = [
    `/contacts?email=${encodeURIComponent(email)}`,
    `/tenants?email=${encodeURIComponent(email)}`,
    `/owners?email=${encodeURIComponent(email)}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const url = `${CASAVI_API_BASE}${endpoint}`;
      console.log(`[checkContact] Suche in: ${url}`);

      const response = await fetch(url, {
        method: "GET",
        headers: getCasaviHeaders(),
        timeout: 10000,
      });

      if (response.ok) {
        const data = await response.json();

        // Casavi gibt entweder ein Array oder { data: [...] } zurück
        const items = Array.isArray(data) ? data : (data.data || data.items || []);

        if (items.length > 0) {
          console.log(`[checkContact] Kontakt gefunden in ${endpoint}:`, items[0]);
          return {
            found: true,
            contact: items[0],
            contactType: endpoint.includes("tenant") ? "tenant" :
                         endpoint.includes("owner") ? "owner" : "contact",
            source: endpoint,
          };
        }
      } else if (response.status !== 404) {
        console.warn(`[checkContact] Fehler bei ${endpoint}: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error(`[checkContact] Netzwerkfehler bei ${endpoint}:`, error.message);
    }
  }

  return { found: false };
}

/**
 * Hauptfunktion der Azure Function
 */
module.exports = async function (context, req) {
  context.log("[checkContact] Funktion gestartet");

  // CORS-Header für lokale Entwicklung
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  // Preflight Request
  if (req.method === "OPTIONS") {
    context.res = { status: 200, headers: corsHeaders, body: "" };
    return;
  }

  // E-Mail aus Body oder Query extrahieren
  const email = (req.body && req.body.email) || req.query.email;
  const senderName = (req.body && req.body.name) || req.query.name || "";

  if (!email) {
    context.res = {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "E-Mail-Adresse ist erforderlich" }),
    };
    return;
  }

  // Konfiguration prüfen
  if (!CASAVI_API_KEY || !CASAVI_API_SECRET) {
    context.res = {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Casavi API-Zugangsdaten nicht konfiguriert" }),
    };
    return;
  }

  try {
    context.log(`[checkContact] Suche Kontakt für E-Mail: ${email}`);
    const result = await findContactByEmail(email);

    context.res = {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...result,
        queriedEmail: email,
        queriedName: senderName,
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    context.log.error("[checkContact] Unerwarteter Fehler:", error);
    context.res = {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Interner Serverfehler",
        details: error.message,
      }),
    };
  }
};
