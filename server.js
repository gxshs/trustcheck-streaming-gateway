const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const WebSocket = require("ws");

const { HttpRequest } = require("@aws-sdk/protocol-http");
const { SignatureV4 } = require("@aws-sdk/signature-v4");
const { Hash } = require("@aws-sdk/hash-node");
const { EventStreamMarshaller } = require("@aws-sdk/eventstream-marshaller");
const { toUtf8, fromUtf8 } = require("@aws-sdk/util-utf8-node");

// ===== config =====
const PORT = process.env.PORT || 4001;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

// Credentials from env (simple, reliable)
function credentialsProvider() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN; // optional
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY in environment variables.");
  }
  return Promise.resolve({ accessKeyId, secretAccessKey, sessionToken });
}

// ===== helpers =====
const marshaller = new EventStreamMarshaller(toUtf8, fromUtf8);

function encodeRFC3986(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildQueryString(query) {
  const pairs = [];
  const keys = Object.keys(query || {}).sort();
  for (const k of keys) {
    const v = query[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      // For arrays, include each value separately (sorted)
      const vals = v.map(x => String(x)).sort();
      for (const vv of vals) {
        pairs.push(`${encodeRFC3986(k)}=${encodeRFC3986(vv)}`);
      }
    } else {
      pairs.push(`${encodeRFC3986(k)}=${encodeRFC3986(String(v))}`);
    }
  }
  return pairs.join("&");
}

function formatSignedUrl({ protocol, hostname, port, path, query }) {
  const qs = buildQueryString(query);
  return `${protocol}//${hostname}:${port}${path}?${qs}`;
}

async function buildTranscribePresignedUrl({ languageCode, sampleRate, mediaEncoding }) {
  // Amazon Transcribe streaming WebSocket endpoint (port 8443)
  const hostname = `transcribestreaming.${AWS_REGION}.amazonaws.com`;
  const protocol = "wss:";
  const port = 8443;
  const path = "/stream-transcription-websocket";

  // Required query params: language-code, media-encoding, sample-rate
  const query = {
    "language-code": languageCode,
    "media-encoding": mediaEncoding,
    "sample-rate": String(sampleRate),
  };

  const request = new HttpRequest({
    protocol,
    hostname,
    port,
    method: "GET",
    path,
    query,
    headers: {
      host: `${hostname}:8443`,
    },
  });

  const signer = new SignatureV4({
    credentials: credentialsProvider,
    region: AWS_REGION,
    service: "transcribe",
    sha256: Hash.bind(null, "sha256"),
  });

  // Presigned URL expires max 300s is typical; 60s is enough for demo.
  const signed = await signer.presign(request, { expiresIn: 60 });

  return formatSignedUrl({
    protocol: signed.protocol,
    hostname: signed.hostname,
    port: signed.port,
    path: signed.path,
    query: signed.query,
  });
}

function parseJsonBody(bodyBytes) {
  try {
    const txt = Buffer.from(bodyBytes).toString("utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function extractTranscriptParts(json) {
  const results = json?.Transcript?.Results || [];
  const out = [];
  for (const r of results) {
    const alt = r.Alternatives && r.Alternatives[0] ? r.Alternatives[0] : null;
    const text = alt?.Transcript || "";
    if (!text) continue;
    out.push({
      text,
      isPartial: !!r.IsPartial,
      startTime: r.StartTime ?? null,
      endTime: r.EndTime ?? null,
    });
  }
  return out;
}

// ===== app =====
const app = express();
app.use(cors({ origin: true }));
app.get("/health", (_, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ["GET", "POST"] } });

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  let ws = null;
  let started = false;

  socket.on("start", async (msg = {}) => {
    if (started) return;
    started = true;

    const languageCode = msg.languageCode || "en-US";
    const sampleRate = msg.sampleRateHertz || 16000;
    const mediaEncoding = "pcm";

    try {
      socket.emit("status", { state: "starting", languageCode, sampleRate });

      const url = await buildTranscribePresignedUrl({ languageCode, sampleRate, mediaEncoding });
      ws = new WebSocket(url, { perMessageDeflate: false });

      ws.on("open", () => socket.emit("status", { state: "streaming" }));

      ws.on("message", (data) => {
        try {
          const m = marshaller.unmarshall(Buffer.from(data));
          const headers = m.headers || {};
          const messageType = headers[":message-type"]?.value;
          const eventType = headers[":event-type"]?.value;

          if (messageType === "event" && eventType === "TranscriptEvent") {
            const json = parseJsonBody(m.body);
            const parts = extractTranscriptParts(json);
            for (const p of parts) socket.emit("transcript", p);
            return;
          }

          if (messageType === "exception") {
            const errTxt = Buffer.from(m.body || []).toString("utf8");
            socket.emit("error", { message: `Transcribe exception: ${eventType || "Unknown"} ${errTxt}` });
            return;
          }
        } catch (e) {
          // ignore parsing errors
        }
      });

      ws.on("close", (code, reason) => {
        socket.emit("status", { state: "ended", code, reason: reason?.toString?.() || "" });
        started = false;
        ws = null;
      });

      ws.on("error", (e) => {
        socket.emit("error", { message: String(e?.message || e) });
        started = false;
        ws = null;
      });
    } catch (e) {
      socket.emit("error", { message: String(e?.message || e) });
      started = false;
      ws = null;
    }
  });

  socket.on("audio", (msg = {}) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const b64 = msg.chunkBase64;
    if (!b64) return;

    try {
      const audioBytes = Buffer.from(b64, "base64");
      const payload = marshaller.marshall({
        headers: {
          ":message-type": { type: "string", value: "event" },
          ":event-type": { type: "string", value: "AudioEvent" },
          ":content-type": { type: "string", value: "application/octet-stream" },
        },
        body: audioBytes,
      });
      ws.send(payload);
    } catch {
      socket.emit("error", { message: "Bad audio chunk" });
    }
  });

  socket.on("stop", () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(1000, "client stop"); } catch {}
    }
    socket.emit("status", { state: "stopping" });
    started = false;
    ws = null;
  });

  socket.on("disconnect", () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(1001, "client disconnect"); } catch {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`TrustCheck STT gateway running: http://localhost:${PORT}`);
});
