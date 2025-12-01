import express from "express";
import fetch from "node-fetch";
import { createClient as createRedisClient } from "redis";

const app = express();
const PORT = process.env.PORT || 3000;

let gamesBuffer = [];

// Конфигурация
const API_URL = "https://cs2run.app/games";
const JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTg2ODYxLCJpYXQiOjE3NjQ0NDcyODQsImV4cCI6MTc2NTMxMTI4NH0.ZK1J86BGJJcOCw93MUnXrAsS3n0sLybUhd1EXSFULEc";
const REQUEST_DELAY = 1000; // 1 секунда

// Ротация User-Agent
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/118.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 Version/16.5 Safari/605.1.15",
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/117.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile Safari/604.1",
  "Mozilla/5.0 (Linux; U; Android 12; en-us) AppleWebKit/533.1 Mobile Safari/533.1",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) Gecko/20100101 Firefox/118.0",
  "Mozilla/5.0 (iPad; CPU OS 16_4 like Mac OS X) AppleWebKit/604.1.38 Version/16.4 Mobile Safari/604.1",
  "Mozilla/5.0 (Windows NT 6.3; Win64; x64) Chrome/107.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 12_5) Firefox/117.0",
  "Mozilla/5.0 (Linux; Android 10) Chrome/110.0 Mobile Safari/537.36",
];

// Ротация доменов Referer
const referers = [
  "https://csgoyz.run/crash/",
  "https://csgouv.run/crash/",
  "https://csgowx.run/crash/",
  "https://csgoab.run/crash/",
  "https://csgobc.run/crash/",
  "https://csgode.run/crash/",
  "https://csgofg.run/crash/",
  "https://csgoih.run/crash/",
  "https://csgojk.run/crash/",
  "https://csgomn.run/crash/",
  "https://csgopq.run/crash/",
  "https://csgost.run/crash/",
  "https://csgoac.run/crash/",
  "https://csgobd.run/crash/",
  "https://csgoef.run/crash/",
  "https://csgogj.run/crash/",
  "https://csgoid.run/crash/",
  "https://cs2run.bet/",
  "https://csrun.bet/",
];

let uaIndex = 0;
let refIndex = 0;

function getNextUserAgent() {
  uaIndex = (uaIndex + 1) % userAgents.length;
  return userAgents[uaIndex];
}

function getNextReferer() {
  refIndex = (refIndex + 1) % referers.length;
  return referers[refIndex];
}

// Функция получения игры с лимитом попыток
async function fetchGame(gameId, attempt = 1) {
  if (attempt > 12) {
    console.log(`Игра ${gameId} не получена после 12 попыток`);
    return null;
  }

  const userAgent = getNextUserAgent();
  const referer = getNextReferer();

  try {
    const response = await fetch(`${API_URL}/${gameId}`, {
      headers: {
        Authorization: `JWT ${JWT_TOKEN}`,
        "User-Agent": userAgent,
        Accept: "application/json, text/plain, */*",
        Referer: referer,
      },
    });

    if (!response.ok) {
      console.log(`Ошибка HTTP ${response.status} на игре ${gameId} → retry (${attempt})`);
      return fetchGame(gameId, attempt + 1);
    }

    const data = await response.json();
    if (!data.data) {
      console.log(`Пустой объект на игре ${gameId} → retry`);
      return fetchGame(gameId, attempt + 1);
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
    console.log(`Ошибка ${err.message} на игре ${gameId} → retry`);
    return fetchGame(gameId, attempt + 1);
  }
}

// Основной цикл
async function fetchGamesSequential(startId, total) {
  let current = startId;

  while (gamesBuffer.length < total) {
    const game = await fetchGame(current);
    if (game) {
      gamesBuffer.push(game);
      console.log(`Собрано: ${gamesBuffer.length}, ID: ${game.id}`);
    }
    current--;
    await new Promise(r => setTimeout(r, REQUEST_DELAY));
  }
}

// API
app.get("/games", (req, res) => res.json(gamesBuffer));

app.get("/start", (req, res) => {
  const start = parseInt(req.query.startGame);
  const count = parseInt(req.query.count);
  fetchGamesSequential(start, count);
  res.json({ message: `Запуск с ${start} на ${count} игр` });
});

app.post("/a", (req, res) => {
  res.json({ message: "Сервер завершает работу" });
  setTimeout(() => process.exit(0), 300);
});

app.listen(PORT, "0.0.0.0", () => console.log(`RUN: ${PORT}`));