import express from "express";
import fetch from "node-fetch";
import { createClient as createRedisClient } from "redis";

const app = express();
const PORT = process.env.PORT || 3000;

// Массив для хранения игр
let gamesBuffer = [];

// Конфигурация
const API_URL = "https://cs2run.app/games"; // <-- URL API игры
const JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTg2ODYxLCJpYXQiOjE3NjQ0NDcyODQsImV4cCI6MTc2NTMxMTI4NH0.ZK1J86BGJJcOCw93MUnXrAsS3n0sLybUhd1EXSFULEc"; // <-- твой токен

// Функция для получения пачки игр параллельно
async function fetchGamesBatch(startGameId, batchSize) {
  const requests = [];
  for (let i = 0; i < batchSize; i++) {
    const gameId = startGameId - i;
    requests.push(
      fetch(`${API_URL}/${gameId}`, {
        headers: { Authorization: `JWT ${JWT_TOKEN}` },
      })
        .then(res => res.json())
        .then(data => {
          if (!data.data) {
            console.log(`Игра ${gameId} недоступна`);
            return null;
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
        })
        .catch(err => {
          console.log(`Ошибка при запросе игры ${gameId}:`, err.message);
          return null;
        })
    );
  }

  const batchGames = await Promise.all(requests);
  return batchGames.filter(Boolean);
}

// Публичный endpoint для всех игр
app.get("/games", (req, res) => {
  res.json(gamesBuffer);
});

// Старт сбора игр
app.get("/start", async (req, res) => {
  const startGameId = parseInt(req.query.startId) || 6233360;
  const batchSize = parseInt(req.query.batchSize) || 18;
  const totalGames = parseInt(req.query.totalGames) || 30000;

  let currentId = startGameId;
  while (gamesBuffer.length < totalGames) {
    const batch = await fetchGamesBatch(currentId, batchSize);
    gamesBuffer.push(...batch);
    currentId -= batchSize;
    console.log(`Собрано ${gamesBuffer.length} игр`);

    // Пауза между пачками, чтобы API не ругался
    await new Promise(r => setTimeout(r, 2500));
  }

  res.json({ message: `Собрано ${gamesBuffer.length} игр` });
});

// Endpoint для завершения контейнера
app.post("/a", (req, res) => {
  res.json({ message: "Сервер завершает работу..." });
  console.log("Shutdown endpoint вызван, завершение процесса.");
  setTimeout(() => process.exit(0), 500);
});

// Слушаем все интерфейсы
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

// ===============================
// REDIS ANTI-IDLE KEEPALIVE
// ===============================
(async () => {
  try {
    const redis = createRedisClient({
      url: process.env.REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => Math.min(500 * retries, 3000),
        keepAlive: 10000,
        connectTimeout: 10000
      }
    });

    redis.on("error", (err) => console.warn("[Redis] ERROR:", err.message));
    redis.on("connect", () => console.log("[Redis] connected (anti-idle)"));
    redis.on("reconnecting", () => console.log("[Redis] reconnecting..."));

    await redis.connect();

    setInterval(async () => {
      try {
        await redis.ping();
        console.log("[Redis] ping");
      } catch (err) {
        console.warn("[Redis] ping failed:", err.message);
      }
    }, 20000);

  } catch (e) {
    console.error("[Redis] init failed:", e.message);
  }
})();