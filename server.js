import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

let gamesBuffer = [];
let JWT_TOKEN = null; // будет обновляться через refresh
const REQUEST_DELAY = 1000; // 1 секунда
const API_URL = "https://cs2run.app/games";
const REFRESH_URL = "https://cs2run.app/auth/refresh-token";

// ----------------- REFRESH -----------------
async function refreshJwt(refreshToken) {
  try {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken })
    });
    const data = await res.json();
    if (!data || !data.accessToken) throw new Error("Invalid refresh response");
    JWT_TOKEN = data.accessToken;
    console.log("JWT обновлён через refresh");
  } catch (err) {
    console.error("Ошибка обновления JWT:", err.message);
    throw err;
  }
}

// ----------------- FETCH GAME -----------------
async function fetchGame(gameId, refreshToken, attempt = 1) {
  if (attempt > 12) {
    console.log(`Игра ${gameId} не получена после 12 попыток`);
    return null;
  }

  try {
    const res = await fetch(`${API_URL}/${gameId}`, {
      headers: {
        Authorization: `JWT ${JWT_TOKEN}`,
        Accept: "application/json",
        Referer: "https://csgoyz.run/crash/"
      }
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 429) {
        console.log(`Ошибка ${res.status} на игре ${gameId}, обновляем токен → retry (${attempt})`);
        await refreshJwt(refreshToken);
        return fetchGame(gameId, refreshToken, attempt + 1);
      } else {
        console.log(`Ошибка HTTP ${res.status} на игре ${gameId} → retry (${attempt})`);
        return fetchGame(gameId, refreshToken, attempt + 1);
      }
    }

    const data = await res.json();
    if (!data.data) {
      console.log(`Пустой объект на игре ${gameId} → retry (${attempt})`);
      return fetchGame(gameId, refreshToken, attempt + 1);
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
    return fetchGame(gameId, refreshToken, attempt + 1);
  }
}

// ----------------- MAIN LOOP -----------------
async function fetchGamesSequential(startId, total, refreshToken) {
  // Обновляем JWT сразу при первом запуске
  await refreshJwt(refreshToken);

  let current = startId;

  while (gamesBuffer.length < total) {
    const game = await fetchGame(current, refreshToken);
    if (game) {
      gamesBuffer.push(game);
      console.log(`Собрано: ${gamesBuffer.length}, ID: ${game.id}`);
    }
    current--;
    await new Promise(r => setTimeout(r, REQUEST_DELAY));
  }
}

// ----------------- API -----------------
app.get("/games", (req, res) => res.json(gamesBuffer));

app.get("/start", async (req, res) => {
  const start = parseInt(req.query.startGame);
  const count = parseInt(req.query.count);
  const refreshToken = req.query.refreshToken;

  if (!refreshToken) return res.status(400).json({ error: "Не указан refreshToken" });

  fetchGamesSequential(start, count, refreshToken);
  res.json({ message: `Запуск с ${start} на ${count} игр` });
});

app.post("/a", (req, res) => {
  res.json({ message: "Сервер завершает работу" });
  setTimeout(() => process.exit(0), 300);
});

app.listen(PORT, "0.0.0.0", () => console.log(`RUN: ${PORT}`));