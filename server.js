// server.js — Node (ESM) + ws
// npm i ws

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

// ----------------- Статистика ставок -----------------
const gameStats = {}; // { [gameId]: Set(userIds) }

function processBetMessage(base64str) {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(base64str, "base64").toString("utf8"));
  } catch { return; }

  const data = decoded?.push?.pub?.data;
  if (!data) return;

  if (data.type === "betCreated" || data.type === "topBetCreated") {
    const bet = data.bet;
    if (!bet) return;
    const gameId = bet.gameId;
    if (!gameId) return;

    if (!gameStats[gameId]) gameStats[gameId] = new Set();
    const users = bet.bet?.deposit?.items || [];
    for (const item of users) {
      if (item.status === 1 && item.id) gameStats[gameId].add(item.id);
    }
  }
}

// ----------------- Вспомогательные -----------------
function nowIso() { return new Date().toISOString(); }

function approxSizeOfObj(o) {
  try { return Buffer.byteLength(JSON.stringify(o), "utf8"); }
  catch { return 200; }
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
  if (!noisyTypes.has(entry.type)) {
    console.log(JSON.stringify(entry));
  }
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

function makeBinaryJsonPong() {
  return Buffer.from(JSON.stringify({ type: 3 }));
}

// ----------------- WS обработчики -----------------
function attachWsHandlers(socket) {
  socket.on("open", () => {
    reconnectAttempts = 0;
    sessionStartTs = Date.now();
    lastPongTs = null;
    pushLog({ type: "ws_open", url: WS_URL });
    console.log("[WS] OPEN");
  });

  socket.on("message", (data) => {
    let parsed = null, txt;
    try { txt = Buffer.isBuffer(data) ? data.toString("utf8") : String(data); parsed = JSON.parse(txt); }
    catch { parsed = null; }

    if (parsed && parsed.push) return; // игнорируем обычные пуши

    if (!parsed) {
      const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      pushLog({ type: "message_nonjson", size: bufferData.length, base64: bufferData.toString("base64") });
      processBetMessage(bufferData.toString("base64"));
      return;
    }

    pushLog({ type: "message_parsed", summary: typeof parsed === "object" ? Object.keys(parsed).slice(0,5) : String(parsed).slice(0,200) });
  });

  socket.on("ping", (data) => { try { socket.pong(data); pushLog({ type: "transport_ping_recv" }); } catch(e) { pushLog({ type:"transport_ping_err", error:String(e)}); } });
  socket.on("pong", () => { lastPongTs = Date.now(); pushLog({ type:"transport_pong_recv" }); });

  socket.on("close", (code, reasonBuf) => {
    const reason = (reasonBuf && reasonBuf.length) ? reasonBuf.toString() : "";
    const durationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
    lastDisconnect = { ts: nowIso(), code, reason, duration_ms: durationMs };
    pushLog({ type: "ws_close", code, reason, duration_ms: durationMs });
    sessionStartTs = null;
  });

  socket.on("error", (err) => { pushLog({ type:"ws_error", error:String(err) }); console.error("[WS ERROR]", err?.message || err); });
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

      try { ws.send(JSON.stringify({ id:1, connect:{ token, subs:{} } })); } catch(e) { pushLog({ type:"connect_send_error", error:String(e) }); }
      await new Promise(r=>setTimeout(r,200));
      try { ws.send(JSON.stringify({ id:100, subscribe:{ channel: CHANNEL } })); } catch(e) { pushLog({ type:"subscribe_send_error", error:String(e) }); }

      await new Promise(resolve => { ws.once("close", resolve); ws.once("error", resolve); });
      reconnectAttempts++;
      await new Promise(r => setTimeout(r, Math.min(30000, 2000*Math.pow(1.5,reconnectAttempts))));
    } catch(e) { pushLog({ type:"main_loop_exception", error:String(e) }); await new Promise(r=>setTimeout(r,2000)); }
  }
}

// ----------------- HTTP -----------------
const server = http.createServer((req,res)=>{
  if(req.url==="/"){ res.writeHead(200,{"Content-Type":"text/plain"}); res.end("ok\n"); return; }

  if(req.url==="/status"){
    const connected = !!(ws && ws.readyState === WebSocket.OPEN);
    const sessionDurationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
    const gameStatsArray = Object.entries(gameStats).map(([gameId,set])=>({ gameId:Number(gameId), players:set.size }));

    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({
      ts: nowIso(),
      connected,
      channel: CHANNEL,
      session_start: sessionStartTs ? new Date(sessionStartTs).toISOString():null,
      session_duration_ms: sessionDurationMs,
      last_pong_ts: lastPongTs?new Date(lastPongTs).toISOString():null,
      last_disconnect: lastDisconnect||null,
      logs_count: logs.length,
      gameStats: gameStatsArray
    }));
    return;
  }

  if(req.url==="/logs"){
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({ ts: nowIso(), count:logs.length, tail:logs.slice(-MAX_LOG_ENTRIES) }));
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT,()=>{ pushLog({ type:"http_listen", port:PORT }); console.log("[HTTP] listening",PORT); });

// ----------------- Периодические задачи -----------------
setInterval(()=>{
  const connected = !!(ws && ws.readyState===WebSocket.OPEN);
  const sessionDurationMs = sessionStartTs? (Date.now()-sessionStartTs):0;
  pushLog({ type:"heartbeat", connected, session_duration_ms:sessionDurationMs, logs_count:logs.length, logs_bytes:logsBytes });
}, HEARTBEAT_MS);

// ----------------- Завершение -----------------
process.on("SIGINT",()=>{ pushLog({ type:"shutdown", signal:"SIGINT" }); running=false; try{if(ws)ws.close();}catch{} process.exit(0); });
process.on("SIGTERM",()=>{ pushLog({ type:"shutdown", signal:"SIGTERM" }); running=false; try{if(ws)ws.close();}catch{} process.exit(0); });

// ----------------- Старт -----------------
mainLoop().catch(e=>{ pushLog({ type:"fatal", error:String(e) }); console.error("[FATAL]", e); process.exit(1); });

// ----------------- Keep-alive -----------------
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
function keepAlive(){
  if(!SELF_URL) return;
  const delay = 240000 + Math.random()*120000;
  setTimeout(async ()=>{
    try{ await fetch(SELF_URL+"/healthz",{headers:{"User-Agent":"Mozilla/5.0","X-Keep-Alive":String(Math.random())}}); console.log("Keep-alive ping OK"); }
    catch(e){ console.log("Keep-alive error:",e.message); }
    keepAlive();
  }, delay);
}
keepAlive();