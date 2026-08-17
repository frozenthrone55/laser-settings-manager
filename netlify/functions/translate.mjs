import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

const AUTHORIZED_PARTIES = [
  "https://laser-settings-manager-v3.netlify.app",
  "https://development--laser-settings-manager-v3.netlify.app",
];

const LANGS = new Set(["nl", "en", "fr", "de"]);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 4000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function requestSourceAllowed(request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (origin && !AUTHORIZED_PARTIES.includes(origin)) return false;
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return false;
  return true;
}

function requestBodyAllowed(request) {
  const raw = request.headers.get("content-length");
  if (!raw) return true;
  const length = Number(raw);
  return Number.isFinite(length) && length >= 0 && length <= MAX_BODY_BYTES;
}

async function authenticated(request) {
  const authState = await clerk.authenticateRequest(request, {
    authorizedParties: AUTHORIZED_PARTIES,
    acceptsToken: "session_token",
  });
  if (!authState.isAuthenticated) return false;
  const auth = authState.toAuth();
  return Boolean(auth.userId);
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).length;
}

function splitForMyMemory(value, maxBytes = 440) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (utf8Bytes(text) <= maxBytes) return [text];

  const pieces = [];
  let rest = text;

  while (rest) {
    if (utf8Bytes(rest) <= maxBytes) {
      pieces.push(rest);
      break;
    }

    let low = 1;
    let high = rest.length;
    let best = 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (utf8Bytes(rest.slice(0, mid)) <= maxBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    let cut = best;
    const candidate = rest.slice(0, best);
    const sentenceBreak = Math.max(
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("! "),
      candidate.lastIndexOf("? "),
      candidate.lastIndexOf("; "),
      candidate.lastIndexOf(", "),
      candidate.lastIndexOf(" ")
    );

    if (sentenceBreak > Math.floor(best * 0.55)) {
      cut = sentenceBreak + 1;
    }

    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  return pieces.filter(Boolean);
}

async function translateChunk(chunk, sourceLanguage, targetLanguage) {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", chunk);
  url.searchParams.set("langpair", `${sourceLanguage}|${targetLanguage}`);
  url.searchParams.set("mt", "1");

  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "LaserSettingsManager/2.2.12",
    },
  });

  if (!response.ok) {
    throw new Error(`Vertaalservice antwoordde met ${response.status}`);
  }

  const data = await response.json();
  const translated = String(data?.responseData?.translatedText || "").trim();

  if (!translated) {
    throw new Error("Vertaalservice gaf geen vertaling terug.");
  }

  if (/MYMEMORY WARNING/i.test(translated)) {
    throw new Error("Daglimiet van de vertaalservice bereikt.");
  }

  return translated;
}

async function translateText(value, sourceLanguage, targetLanguage) {
  const text = String(value || "").trim();
  if (!text || sourceLanguage === targetLanguage) return text;
  if (text.length > MAX_TEXT_CHARS) {
    throw new Error("Tekst is te lang om automatisch te vertalen.");
  }

  // MyMemory accepteert max. 500 bytes per segment. We blijven daaronder.
  const chunks = splitForMyMemory(text, 440);
  const translated = [];

  for (const chunk of chunks) {
    translated.push(await translateChunk(chunk, sourceLanguage, targetLanguage));
  }

  return translated.join(" ").replace(/\s+/g, " ").trim();
}

export default async (request) => {
  try {
    if (request.method !== "POST") {
      return json({ success: false, error: "Methode niet toegestaan." }, 405);
    }

    if (!requestSourceAllowed(request)) {
      return json({ success: false, error: "Aanvraagbron niet toegestaan." }, 403);
    }

    if (!requestBodyAllowed(request)) {
      return json({ success: false, error: "Aanvraag is te groot." }, 413);
    }

    if (!(await authenticated(request))) {
      return json({ success: false, error: "Niet aangemeld." }, 401);
    }

    const body = await request.json();
    const sourceLanguage = String(body?.sourceLanguage || "").toLowerCase();
    const targetLanguage = String(body?.targetLanguage || "").toLowerCase();
    const texts = Array.isArray(body?.texts) ? body.texts : [];

    if (!LANGS.has(sourceLanguage) || !LANGS.has(targetLanguage)) {
      return json({ success: false, error: "Ongeldige taal." }, 400);
    }

    if (!texts.length || texts.length > 6) {
      return json({ success: false, error: "Ongeldige vertaalopdracht." }, 400);
    }

    const translations = [];
    for (const item of texts) {
      translations.push(
        await translateText(item, sourceLanguage, targetLanguage)
      );
    }

    return json({
      success: true,
      sourceLanguage,
      targetLanguage,
      translations,
      provider: "mymemory",
    });
  } catch (error) {
    console.error("Translation API:", error);
    return json(
      {
        success: false,
        error:
          error?.message ||
          "Automatische vertaling is momenteel niet beschikbaar.",
      },
      502
    );
  }
};

export const config = {
  path: "/api/translate",
};
