// server.js — финальная версия с подсчётом GameID и участников
import WebSocket from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

// ----------------- Конфиг -----------------
const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNEL = process.env.CHANNEL || "csgorun:crash";
const PORT = Number(process.env.PORT || 10000);

const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES || 40000);
const MAX_LOG_BYTES = Number(process.env.MAX_LOG_BYTES || 100 * 1024 * 1024);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 5 * 60 * 1000);
const OPEN_TIMEOUT_MS = Number(process.env.OPEN_TIMEOUT_MS || 15000);

// ----------------- Состояние -----------------
let ws = null;
let running = true;
let reconnectAttempts = 0;

let sessionStartTs = null;
let lastPongTs = null;
let lastDisconnect = null;

let logs = [];
let logsBytes = 0;

// Для подсчёта участников по GameID
const gameStats = {};

// ----------------- Хелперы -----------------
function nowIso() { return new Date().toISOString(); }
function approxSizeOfObj(o) { try { return Buffer.byteLength(JSON.stringify(o), "utf8"); } catch { return 200; } }

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

// ----------------- Получение токена -----------------
async function fetchToken() {
  try {
    const resp = await fetch(TOKEN_URL, { cache: "no-store" });
    const j = await resp.json();
    const token = j?.data?.main?.centrifugeToken || null;
    pushLog({ type: "token_fetch", ok: !!token });
    return token;
  } catch (e) {
    pushLog({ type: "token_fetch_error", error: String(e) });
    return null;
  }
}

// ----------------- Пинг WS -----------------
function makeBinaryJsonPong() { return Buffer.from(JSON.stringify({ type: 3 })); }

// ----------------- Обработка base64 и подсчёт GameID -----------------
function parseBase64BetMessage(base64) {
  let decoded;
  try {
    decoded = Buffer.from(base64, "base64").toString("utf8");
    const obj = JSON.parse(decoded);

    // идём по структуре: push -> pub -> data -> bet
    const bets = [];
    if (obj?.push?.pub?.data?.bet) {
      const betData = obj.push.pub.data.bet;
      if (betData?.deposit?.items) {
        betData.deposit.items.forEach(item => {
          if (item?.id && betData?.status === 1) {
            bets.push({ gameId: betData.id });
          }
        });
      } else if (Array.isArray(betData?.deposit?.items)) {
        betData.deposit.items.forEach(item => {
          if (betData?.status === 1 && item?.id) {
            bets.push({ gameId: betData.id });
          }
        });
      } else {
        // если ставка без вложенных предметов, но status 1
        if (betData?.status === 1 && betData?.id) bets.push({ gameId: betData.id });
      }
    }

    // обновляем gameStats
    bets.forEach(b => {
      if (!gameStats[b.gameId]) gameStats[b.gameId] = 0;
      gameStats[b.gameId]++;
    });
  } catch (e) {
    pushLog({ type: "base64_parse_error", error: String(e) });
  }
}

// ----------------- WS обработчики -----------------
function attachWsHandlers(socket) {
  socket.on("open", () => {
    reconnectAttempts = 0;
    sessionStartTs = Date.now();
    lastPongTs = null;
    pushLog({ type: "ws_open", url: WS_URL });
  });

  socket.on("message", (data) => {
    let parsed = null;
    let txt;
    try {
      txt = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      parsed = JSON.parse(txt);
    } catch {
      parsed = null;
    }

    if (!parsed) {
      const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      const base64 = bufferData.toString("base64");
      pushLog({ type: "message_nonjson", base64 });
      parseBase64BetMessage(base64);
      return;
    }

    if (parsed && typeof parsed === "object" && Object.keys(parsed).length === 0) {
      try { socket.send(makeBinaryJsonPong(), { binary: true }); lastPongTs = Date.now(); pushLog({ type: "json_pong_sent" }); } catch {}
      return;
    }
  });

  socket.on("ping", (data) => { try { socket.pong(data); pushLog({ type: "transport_ping_recv" }); } catch {} });
  socket.on("pong", (data) => { lastPongTs = Date.now(); pushLog({ type: "transport_pong_recv" }); });
  socket.on("close", (code, reasonBuf) => {
    lastDisconnect = { ts: nowIso(), code, reason: reasonBuf?.toString() || "", duration_ms: sessionStartTs ? Date.now() - sessionStartTs : 0 };
    pushLog({ type: "ws_close", code, reason: lastDisconnect.reason });
    sessionStartTs = null;
  });
  socket.on("error", (err) => pushLog({ type: "ws_error", error: String(err) }));
}

// ----------------- Основной цикл -----------------
async function mainLoop() {
  while (running) {
    try {
      const token = await fetchToken();
      if (!token) { await new Promise(r => setTimeout(r, 3000)); continue; }

      ws = new WebSocket(WS_URL, { handshakeTimeout: OPEN_TIMEOUT_MS });
      attachWsHandlers(ws);

      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("ws open timeout")), OPEN_TIMEOUT_MS);
        ws.once("open", () => { clearTimeout(to); resolve(); });
        ws.once("error", (e) => { clearTimeout(to); reject(e); });
      });

      ws.send(JSON.stringify({ id: 1, connect: { token, subs: {} } }));
      ws.send(JSON.stringify({ id: 100, subscribe: { channel: CHANNEL } }));

      await new Promise((resolve) => { ws.once("close", resolve); ws.once("error", resolve); });

      reconnectAttempts++;
      const backoff = Math.min(30000, 2000 * Math.pow(1.5, reconnectAttempts));
      await new Promise(r => setTimeout(r, backoff));
    } catch (e) {
      pushLog({ type: "main_loop_exception", error: String(e) });
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ----------------- HTTP -----------------
const server = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok\n"); return; }

  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ts: nowIso(),
      connected: !!(ws && ws.readyState === WebSocket.OPEN),
      session_start: sessionStartTs ? new Date(sessionStartTs).toISOString() : null,
      last_pong_ts: lastPongTs ? new Date(lastPongTs).toISOString() : null,
      logs_count: logs.length,
      gameStats
    }));
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => pushLog({ type: "http_listen", port: PORT }));

// ----------------- Heartbeat -----------------
setInterval(() => {
  pushLog({ type: "heartbeat", connected: !!(ws && ws.readyState === WebSocket.OPEN), logs_count: logs.length });
}, HEARTBEAT_MS);

// ----------------- Завершение -----------------
process.on("SIGINT", () => { running = false; try { if (ws) ws.close(); } catch {}; process.exit(0); });
process.on("SIGTERM", () => { running = false; try { if (ws) ws.close(); } catch {}; process.exit(0); });

// ----------------- Старт -----------------
mainLoop().catch(e => pushLog({ type: "fatal", error: String(e) }));