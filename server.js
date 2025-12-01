import express from "express";
import fetch from "node-fetch";
import { createClient as createRedisClient } from "redis";

const app = express();
const PORT = process.env.PORT || 3000;

let gamesBuffer = [];

// Конфигурация
const API_URL = "https://cs2run.app/games"; 
const JWT_TOKEN = "YOUR_JWT_TOKEN";

// Список User-Agent для рандома
const userAgents = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)...",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6)...",
  // добавь ещё варианты
];

// Функция для получения игры
async function fetchGame(gameId) {
  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

  try {
    const response = await fetch(`${API_URL}/${gameId}`, {
      headers: {
        Authorization: `JWT ${JWT_TOKEN}`,
        "User-Agent": userAgent,
        Accept: "application/json, text/plain, */*",
        Referer: "https://csgoyz.run/crash/",
      },
    });

    if (!response.ok) {
      console.log(`Ошибка при запросе игры ${gameId}: HTTP ${response.status}`);
      return fetchGame(gameId); // повторяем при ошибке
    }

    const data = await response.json();

    if (!data.data) {
      console.log(`Игра ${gameId} вернула пустой объект`);
      return fetchGame(gameId);
    }

    return {
      id: data.data.id,
      crash: data.data.crash,
      salt: data.data.salt,
      hashRound: data.data.hashRound,
      bets: data.data.bets.map(bet => ({
        userId: bet.user.id,
        userName: bet.user.name,
        userBlm: bet.user.blm,
        depositAmount: bet.deposit.amount,
        withdrawAmount: bet.withdraw.amount,
        coefficient: bet.coefficient,
        coefficientAuto: bet.coefficientAuto,
        itemsUsed: bet.deposit.items.length > 0 ? 1 : 0,
      })),
    };

  } catch (err) {
    console.log(`Ошибка при запросе игры ${gameId}: ${err.message}`);
    return fetchGame(gameId);
  }
}

// Последовательная сборка игр
async function fetchGamesSequential(startGameId, totalGames) {
  let currentId = startGameId;

  while (gamesBuffer.length < totalGames) {
    const game = await fetchGame(currentId);
    gamesBuffer.push(game);
    currentId--;

    await new Promise(r => setTimeout(r, 1000)); // пауза 1 сек
    console.log(`Собрано ${gamesBuffer.length} игр`);
  }
}

// Endpoints
app.get("/games", (req, res) => res.json(gamesBuffer));

app.get("/start", (req, res) => {
  const startGameId = parseInt(req.query.startId) || 6233360;
  const totalGames = parseInt(req.query.totalGames) || 30000;
  fetchGamesSequential(startGameId, totalGames);
  res.json({ message: `Сбор игр запущен с ID ${startGameId} на ${totalGames} игр` });
});

app.post("/a", (req, res) => {
  res.json({ message: "Сервер завершает работу..." });
  console.log("Shutdown endpoint вызван, завершение процесса.");
  process.exit(0);
});

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

// ===============================
// REDIS ANTI-IDLE KEEPALIVE
// ===============================
(async () => {
  try {
    const redis = createRedisClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: retries => Math.min(500 * retries, 3000), keepAlive: 10000, connectTimeout: 10000 }
    });
    redis.on("error", (err) => console.warn("[Redis] ERROR:", err.message));
    redis.on("connect", () => console.log("[Redis] connected (anti-idle)"));
    redis.on("reconnecting", () => console.log("[Redis] reconnecting..."));
    await redis.connect();
    setInterval(async () => { try { await redis.ping(); console.log("[Redis] ping"); } catch (err) { console.warn("[Redis] ping failed:", err.message); } }, 20000);
  } catch (e) { console.error("[Redis] init failed:", e.message); }
})();