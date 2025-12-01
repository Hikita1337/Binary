import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

let gamesBuffer = [];
let JWT_TOKEN = ""; // краткоживущий токен
const REQUEST_DELAY = 1000; // 1 секунда
const REFRESH_URL = "https://cs2run.app/auth/refresh-token";

// Ротация доменов Referer
const referers = [
  "https://csgoyz.run/crash/"];
let refIndex = 0;
function getNextReferer() {
  refIndex = (refIndex + 1) % referers.length;
  return referers[refIndex];
}

// Функция обновления JWT через refreshToken
async function refreshJwt(refreshToken) {
  try {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json();
    if (data && data.token) {
      JWT_TOKEN = data.token;
      console.log("JWT обновлён через refreshToken");
      return true;
    } else {
      console.log("Ошибка обновления JWT:", data);
      return false;
    }
  } catch (e) {
    console.log("Ошибка refreshJwt:", e.message);
    return false;
  }
}

// Получение игры с попытками и обновлением JWT при ошибке
async function fetchGame(gameId, attempt = 1, refreshToken) {
  if (attempt > 12) {
    console.log(`Игра ${gameId} не получена после 12 попыток`);
    return null;
  }

  const referer = getNextReferer();

  try {
    const response = await fetch(`https://cs2run.app/games/${gameId}`, {
      headers: {
        Authorization: `JWT ${JWT_TOKEN}`,
        Accept: "application/json, text/plain, */*",
        Referer: referer,
      },
    });

    if (!response.ok) {
      console.log(`Ошибка HTTP ${response.status} на игре ${gameId} → retry (${attempt})`);
      // если 401 или 429 — обновляем JWT через refreshToken
      if ((response.status === 401 || response.status === 429) && refreshToken) {
        await refreshJwt(refreshToken);
      }
      return fetchGame(gameId, attempt + 1, refreshToken);
    }

    const data = await response.json();
    if (!data.data) {
      console.log(`Пустой объект на игре ${gameId} → retry`);
      return fetchGame(gameId, attempt + 1, refreshToken);
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
    return fetchGame(gameId, attempt + 1, refreshToken);
  }
}

// Основной цикл
async function fetchGamesSequential(startId, total, refreshToken) {
  let current = startId;

  while (gamesBuffer.length < total) {
    const game = await fetchGame(current, 1, refreshToken);
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

app.get("/start", async (req, res) => {
  const start = parseInt(req.query.startGame);
  const count = parseInt(req.query.count);
  const refreshToken = req.query.refreshToken;

  if (!refreshToken) {
    return res.status(400).json({ message: "Нужен refreshToken" });
  }

  const ok = await refreshJwt(refreshToken);
  if (!ok) return res.status(500).json({ message: "Не удалось обновить JWT" });

  fetchGamesSequential(start, count, refreshToken);
  res.json({ message: `Запуск с ${start} на ${count} игр с использованием refreshToken` });
});

app.post("/a", (req, res) => {
  res.json({ message: "Сервер завершает работу" });
  setTimeout(() => process.exit(0), 300);
});

app.listen(PORT, "0.0.0.0", () => console.log(`RUN: ${PORT}`));