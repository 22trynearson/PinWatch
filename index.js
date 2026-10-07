const express = require("express");
const axios = require("axios");
const twilio = require("twilio");

const app = express();
const PORT = process.env.PORT || 10000;

const SITE_URL = process.env.SITE_URL || "https://www.pinkalamode.com/";
const COLLECTION_URL = process.env.COLLECTION_URL || "https://www.pinkalamode.com/collections/new-arrivals";
const PRODUCTS_JSON = process.env.PRODUCTS_JSON || "https://www.pinkalamode.com/collections/new-arrivals/products.json?limit=250";
const POLL_MS = Math.max(10000, Number(process.env.POLL_MS || 15000));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const ALERT_TO = process.env.ALERT_TO;

const client = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

let baselineLoaded = false;
let knownProductIds = new Set();
let queueActive = false;
let lastCheck = null;
let lastError = null;
let lastAlert = null;

function now() {
  return new Date().toISOString();
}

function looksLikeQueue(response) {
  const finalUrl = response?.request?.res?.responseUrl || response?.config?.url || "";
  const body = String(response?.data || "").toLowerCase();

  const urlSignals = [
    "queue-it",
    "queue",
    "waitingroom",
    "waiting-room"
  ];

  const bodySignals = [
    "you are now in line",
    "you are in line",
    "virtual waiting room",
    "waiting room",
    "estimated wait time",
    "queue-it",
    "your place in line",
    "please wait while we prepare",
    "we're getting things ready"
  ];

  return urlSignals.some(s => finalUrl.toLowerCase().includes(s)) ||
    bodySignals.some(s => body.includes(s));
}

async function sendAlert(kind, title, link) {
  lastAlert = { kind, title, link, at: now() };
  console.log("[ALERT]", lastAlert);

  if (!client || !TWILIO_FROM || !ALERT_TO) {
    console.log("Twilio not configured yet; alert logged only.");
    return;
  }

  const smsBody = kind === "queue"
    ? `🚨 PINWATCH: A queue/waiting room appears to be live on Pink a la Mode. Open now: ${link}`
    : `📌 PINWATCH: New item detected: ${title}. ${link}`;

  try {
    await client.messages.create({
      from: TWILIO_FROM,
      to: ALERT_TO,
      body: smsBody
    });
  } catch (err) {
    console.error("SMS failed:", err.message);
  }

  if (kind === "queue") {
    try {
      await client.calls.create({
        from: TWILIO_FROM,
        to: ALERT_TO,
        twiml: `<Response><Say voice="Polly.Amy">Pin Watch alert. A queue is live on Pink a la Mode. Open the website now.</Say></Response>`
      });
    } catch (err) {
      console.error("Call failed:", err.message);
    }
  }
}

async function checkQueue() {
  try {
    const response = await axios.get(SITE_URL, {
      timeout: 10000,
      maxRedirects: 10,
      headers: {
        "User-Agent": "Mozilla/5.0 PinWatch/1.0",
        "Accept": "text/html,application/xhtml+xml"
      },
      validateStatus: () => true
    });

    const detected = looksLikeQueue(response);

    if (detected && !queueActive) {
      queueActive = true;
      await sendAlert("queue", "Queue detected", COLLECTION_URL);
    } else if (!detected && queueActive) {
      queueActive = false;
      console.log("Queue no longer detected.");
    }
  } catch (err) {
    lastError = `Queue check: ${err.message}`;
    console.error(lastError);
  }
}

function extractProductHandles(html) {
  const handles = new Set();
  const text = String(html || "");
  const regex = new RegExp("href=[\\\"'](?:https?:\\/\\/www\\.pinkalamode\\.com)?\\/products\\/([^\\\"'?#/]+)[^\\\"']*[\\\"']", "gi");
  let match;
  while ((match = regex.exec(text)) !== null) {
    handles.add(match[1]);
  }
  return handles;
}

async function loadProductHandles() {
  try {
    const response = await axios.get(PRODUCTS_JSON, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 PinWatch/1.0",
        "Accept": "application/json"
      }
    });

    const products = Array.isArray(response.data?.products) ? response.data.products : [];
    if (products.length) {
      return new Map(products.map(p => [String(p.handle || p.id), {
        title: p.title || "New product",
        link: p.handle ? `https://www.pinkalamode.com/products/${p.handle}` : COLLECTION_URL
      }]));
    }
  } catch (err) {
    if (err.response?.status !== 403) {
      console.error(`Product JSON check: ${err.message}`);
    }
  }

  const response = await axios.get(COLLECTION_URL, {
    timeout: 10000,
    maxRedirects: 10,
    headers: {
      "User-Agent": "Mozilla/5.0 PinWatch/1.0",
      "Accept": "text/html,application/xhtml+xml"
    },
    validateStatus: () => true
  });

  if (response.status >= 400) {
    throw new Error(`Collection page returned HTTP ${response.status}`);
  }

  const handles = extractProductHandles(response.data);
  return new Map(Array.from(handles).map(handle => [handle, {
    title: handle.replace(/-/g, " "),
    link: `https://www.pinkalamode.com/products/${handle}`
  }]));
}

async function checkProducts() {
  try {
    const products = await loadProductHandles();
    const currentIds = new Set(products.keys());

    if (!baselineLoaded) {
      knownProductIds = currentIds;
      baselineLoaded = true;
      console.log(`Baseline loaded with ${knownProductIds.size} products.`);
      return;
    }

    for (const [id, product] of products.entries()) {
      if (!knownProductIds.has(id)) {
        await sendAlert("product", product.title, product.link);
      }
    }

    knownProductIds = currentIds;
    lastError = null;
  } catch (err) {
    lastError = `Product check: ${err.message}`;
    console.error(lastError);
  }
}

async function tick() {
  lastCheck = now();
  await Promise.allSettled([checkQueue(), checkProducts()]);
}

setInterval(tick, POLL_MS);
tick();

app.get("/", (_req, res) => {
  res.json({
    service: "PinWatch",
    status: "running",
    queueActive,
    baselineLoaded,
    knownProducts: knownProductIds.size,
    pollMs: POLL_MS,
    lastCheck,
    lastError,
    lastAlert,
    twilioConfigured: Boolean(client && TWILIO_FROM && ALERT_TO)
  });
});

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`PinWatch listening on port ${PORT}`);
  console.log(`Twilio configured: ${Boolean(client && TWILIO_FROM && ALERT_TO)}`);
});
