// server.js — финальная версия с подсчётом GameID
// Node (ESM) + ws
// Установка: npm i ws

import WebSocket from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

// ----------------- Конфиг (env или дефолты) -----------------
const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNEL = process.env.CHANNEL || "csgorun:crash"; // подписка для видимости
const PORT = Number(process.env.PORT || 10000);

const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES || 40000);
const MAX_LOG_BYTES = Number(process.env.MAX_LOG_BYTES || 100 * 1024 * 1024); // 100 MiB
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 5 * 60 * 1000); // 5 минут
const OPEN_TIMEOUT_MS = Number(process.env.OPEN_TIMEOUT_MS || 15000);

// ----------------- Состояние -----------------
let ws = null;
let running = true;
let reconnectAttempts = 0;

let sessionStartTs = null;
let lastPongTs = null;
let lastDisconnect = null;

// лог-буфер (круговой с ограничением по записям и по байтам)
let logs = [];
let logsBytes = 0;

// ----------------- Сбор статистики по GameID -----------------
const gameStats = {};

// ----------------- Вспомогательные -----------------
function nowIso() { return new Date().toISOString(); }

function approxSizeOfObj(o) {
  try { return Buffer.byteLength(JSON.stringify(o), "utf8"); } catch { return 200; }
}

function pushLog(entry) {
  entry.ts = nowIso();
  const size = approxSizeOfObj(entry);
  logs.push(entry);
  logsBytes += size;

  while (logs.length > MAX_LOG_ENTRIES || logsBytes > MAX_LOG_BYTES) {
    const removed = logs.shift();
    logsBytes -= approxSizeOfObj(removed);
    if (logsBytes < 0) logsBytes = 0;
  }

  const noisyTypes = new Set(["push", "push_full", "raw_msg"]);
  if (!noisyTypes.has(entry.type)) console.log(JSON.stringify(entry));
}

async function fetchToken() {
  try {
    const resp = await fetch(TOKEN_URL, { cache: "no-store" });
    const j = await resp.json();
    const token = j?.data?.main?.centrifugeToken || null;
    pushLog({ type: "token_fetch", ok: !!token });
    return token;
  } catch (e) { pushLog({ type: "token_fetch_error", error: String(e) }); return null; }
}

function makeBinaryJsonPong() { return Buffer.from(JSON.stringify({ type: 3 })); }

// ----------------- Парсинг base64 ставок -----------------
function parseBase64BetMessage(base64) {
  let decoded;
  try {
    decoded = Buffer.from(base64, "base64").toString("utf8");

    // регулярка для поиска JSON объектов
    const matches = decoded.match(/\{[^{}]*\}/g);
    if (!matches) return;

    matches.forEach(m => {
      try {
        const obj = JSON.parse(m);
        // проверка вложенной ставки
        if (obj?.push?.pub?.data?.bet) {
          const betData = obj.push.pub.data.bet;
          if (betData?.status === 1 && betData?.id) {
            if (!gameStats[betData.id]) gameStats[betData.id] = 0;
            gameStats[betData.id]++;
          }
        }
      } catch(e) {
        pushLog({ type: "inner_base64_parse_error", error: String(e) });
      }
    });
  } catch (e) {
    pushLog({ type: "base64_parse_error", error: String(e) });
  }
}

// ----------------- Обработчики WS -----------------
function attachWsHandlers(socket) {
  socket.on("open", () => {
    reconnectAttempts = 0;
    sessionStartTs = Date.now();
    lastPongTs = null;
    pushLog({ type: "ws_open", url: WS_URL });
    console.log("[WS] OPEN");
  });

  socket.on("message", (data, isBinary) => {
    let parsed = null;
    let txt;
    try {
      txt = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      parsed = JSON.parse(txt);
    } catch { parsed = null; }

    if (parsed && Object.keys(parsed).length === 0) {
      try { socket.send(makeBinaryJsonPong(), { binary: true }); lastPongTs = Date.now(); pushLog({ type: "json_pong_sent" }); } catch(e){pushLog({type:"json_pong_exception",error:String(e)});}
      return;
    }

    if (parsed && parsed.id === 1 && parsed.connect) { pushLog({ type: "connect_ack", meta: parsed.connect }); return; }
    if (parsed && parsed.push) {
      pushLog({ type: "push_received" });
      // декодируем base64 ставки
      if (parsed.push.pub?.data) {
        parseBase64BetMessage(Buffer.from(JSON.stringify(parsed)).toString("base64"));
      }
      return;
    }
    if (parsed && parsed.id !== undefined) { pushLog({ type: "msg_with_id", id: parsed.id, summary: parsed.error || "ok" }); return; }

    if (parsed) { pushLog({ type: "message_parsed", summary: JSON.stringify(Object.keys(parsed).slice(0,5)) }); return; }

    // НЕПАРСИРУЕМОЕ сообщение
    const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    pushLog({ type: "message_nonjson", size: bufferData.length, base64: bufferData.toString("base64") });
  });

  socket.on("ping", (data) => { try { socket.pong(data); pushLog({ type: "transport_ping_recv" }); } catch (e) { pushLog({ type: "transport_ping_err", error: String(e) }); } });
  socket.on("pong", () => { lastPongTs = Date.now(); pushLog({ type: "transport_pong_recv" }); });

  socket.on("close", (code, reasonBuf) => {
    const reason = reasonBuf?.toString() || "";
    const durationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
    lastDisconnect = { ts: nowIso(), code, reason, duration_ms: durationMs };
    pushLog({ type: "ws_close", code, reason, duration_ms: durationMs });
    console.log(`[WS] CLOSE code=${code} reason=${reason} duration=${Math.round(durationMs/1000)}s`);
    sessionStartTs = null;
  });

  socket.on("error", (err) => { pushLog({ type: "ws_error", error: String(err) }); console.error("[WS ERROR]", err?.message || err); });
}

// ----------------- HTTP -----------------
const server = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok\n"); return; }

  if (req.url === "/status") {
    const connected = !!(ws && ws.readyState === WebSocket.OPEN);
    const sessionDurationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
    const payload = {
      ts: nowIso(),
      connected,
      channel: CHANNEL,
      session_start: sessionStartTs ? new Date(sessionStartTs).toISOString() : null,
      session_duration_ms: sessionDurationMs,
      gameStats, // сюда добавляем GameID и количество участников
      last_pong_ts: lastPongTs ? new Date(lastPongTs).toISOString() : null,
      last_disconnect: lastDisconnect || null,
      logs_count: logs.length
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.url === "/logs") {
    const payload = { ts: nowIso(), count: logs.length, tail: logs.slice(-MAX_LOG_ENTRIES), gameStats };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => { pushLog({ type: "http_listen", port: PORT }); console.log("[HTTP] listening", PORT); });

// ----------------- Основной цикл -----------------
async function mainLoop() {
  while (running) {
    try {
      const token = await fetchToken();
      if (!token) { await new Promise(r => setTimeout(r, 3000)); continue; }

      pushLog({ type: "start_connect", url: WS_URL, channel: CHANNEL });
      console.log("[RUN] connecting to", WS_URL);

      ws = new WebSocket(WS_URL, { handshakeTimeout: OPEN_TIMEOUT_MS });
      attachWsHandlers(ws);

      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("ws open timeout")), OPEN_TIMEOUT_MS);
        ws.once("open", () => { clearTimeout(to); resolve(); });
        ws.once("error", (e) => { clearTimeout(to); reject(e); });
      });

      try {
        const connectPayload = { id: 1, connect: { token, subs: {} } };
        ws.send(JSON.stringify(connectPayload));
        pushLog({ type: "connect_sent" });
      } catch (e) { pushLog({ type: "connect_send_error", error: String(e) }); }

      await new Promise(r => setTimeout(r, 200));
      try {
        const payload = { id: 100, subscribe: { channel: CHANNEL } };
        ws.send(JSON.stringify(payload));
        pushLog({ type: "subscribe_sent", channel: CHANNEL, id: 100 });
      } catch (e) { pushLog({ type: "subscribe_send_error", error: String(e) }); }

      await new Promise((resolve) => {
        const onEnd = () => resolve();
        ws.once("close", onEnd);
        ws.once("error", onEnd);
      });

      reconnectAttempts++;
      const backoff = Math.min(30000, 2000 * Math.pow(1.5, reconnectAttempts));
      pushLog({ type: "reconnect_scheduled", attempt: reconnectAttempts, backoff_ms: Math.round(backoff) });
      await new Promise(r => setTimeout(r, backoff));
    } catch (e) {
      pushLog({ type: "main_loop_exception", error: String(e) });
      console.error("[MAIN EXCEPTION]", e?.message || e);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ----------------- Периодические задачи -----------------
setInterval(() => {
  const connected = !!(ws && ws.readyState === WebSocket.OPEN);
  const sessionDurationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
  pushLog({ type: "heartbeat", connected, session_duration_ms: sessionDurationMs, logs_count: logs.length, logs_bytes: logsBytes });
}, HEARTBEAT_MS);

// ----------------- Завершение -----------------
process.on("SIGINT", () => { pushLog({ type: "shutdown", signal: "SIGINT" }); running = false; try { if (ws) ws.close(); } catch {} process.exit(0); });
process.on("SIGTERM", () => { pushLog({ type: "shutdown", signal: "SIGTERM" }); running = false; try { if (ws) ws.close(); } catch {} process.exit(0); });

// ----------------- Старт -----------------
mainLoop().catch(e => { pushLog({ type: "fatal", error: String(e) }); console.error("[FATAL]", e); process.exit(1); });