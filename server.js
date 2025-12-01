import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

let gamesBuffer = [];

// Конфигурация
const API_URL = "https://cs2run.app/games";
const REFRESH_URL = "https://cs2run.app/auth/refresh-token";
const REQUEST_DELAY = 1000; // 1 секунда

let accessToken = "";  // краткоживущий токен
let refreshToken = ""; // рефреш токен

// Обновление токенов через рефреш
async function refreshJwt() {
  try {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json();
    if (!data || !data.data || !data.data.token || !data.data.refreshToken) {
      throw new Error("Invalid refresh response");
    }
    accessToken = data.data.token;
    refreshToken = data.data.refreshToken;
    console.log("JWT обновлён:", accessToken);
  } catch (err) {
    console.error("Ошибка обновления JWT:", err.message);
    throw err;
  }
}

// Получение одной игры с попытками и автообновлением токена
async function fetchGame(gameId, attempt = 1) {
  if (attempt > 12) {
    console.log(`Игра ${gameId} не получена после 12 попыток`);
    return null;
  }

  try {
    const response = await fetch(`${API_URL}/${gameId}`, {
      headers: {
        Authorization: `JWT ${accessToken}`,
        Accept: "application/json, text/plain, */*",
        Referer: "https://csgoyz.run/crash/",
      },
    });

    if (response.status === 429 || response.status === 401) {
      console.log(`Ошибка HTTP ${response.status} на игре ${gameId} → обновляем токены и retry (${attempt})`);
      await refreshJwt(); // обновляем токены
      return fetchGame(gameId, attempt + 1); // повторяем тот же запрос
    }

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
    console.log(`Ошибка ${err.message} на игре ${gameId} → retry (${attempt})`);
    await new Promise(r => setTimeout(r, 500));
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

// Старт с указанием игры, количества и refreshToken
app.get("/start", async (req, res) => {
  const start = parseInt(req.query.startGame);
  const count = parseInt(req.query.count);
  const clientRefreshToken = req.query.refreshToken;

  if (!clientRefreshToken) return res.status(400).json({ error: "Не указан refreshToken" });

  refreshToken = clientRefreshToken;

  try {
    await refreshJwt(); // сразу обновляем токены при старте
    fetchGamesSequential(start, count); // запускаем основной сбор
    res.json({ message: `Запуск с ${start} на ${count} игр` });
  } catch (err) {
    res.status(500).json({ error: "Не удалось обновить токены", detail: err.message });
  }
});

// Завершение процесса
app.post("/a", (req, res) => {
  res.json({ message: "Сервер завершает работу" });
  setTimeout(() => process.exit(0), 300);
});

app.listen(PORT, "0.0.0.0", () => console.log(`RUN: ${PORT}`));