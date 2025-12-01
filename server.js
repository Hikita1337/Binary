// server.js
import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

let gamesBuffer = [];

const API_URL = "https://cs2run.app/games";

// Фиксированный токен
const accessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTg2ODYxLCJpYXQiOjE3NjQ2MTgxODQsImV4cCI6MTc2NTQ4MjE4NH0.Qlhq1x4HDHjhvos6LLlhX7vqX5Is6hs7jYkDFqRwUdg";

const REQUEST_DELAY = 1000;
const MAX_ATTEMPTS_PER_GAME = 8;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function safeRead(res) {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

async function fetchGame(gameId) {
  const headers = {
    Authorization: `JWT ${accessToken}`,
    Accept: "application/json"
  };

  let attempt = 0;
  let backoffBase = 1500;

  while (attempt < MAX_ATTEMPTS_PER_GAME) {
    attempt++;

    try {
      const res = await fetch(`${API_URL}/${gameId}`, { headers });
      const status = res.status;

      if (status === 429) {
        const text = await safeRead(res);
        const wait = Math.min(backoffBase * Math.pow(2, attempt), 20);
        console.log(`[429] game ${gameId}, attempt ${attempt}, wait ${wait}ms, body:`, text);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const text = await safeRead(res);
        console.log(`[${status}] game ${gameId}, attempt ${attempt}, body:`, text);
        await sleep(2000);
        continue;
      }

      const text = await res.text();
      const json = JSON.parse(text);
      if (!json?.data) {
        console.log(`Empty data for game ${gameId}`);
        return null;
      }

      const d = json.data;
      return {
        id: d.id,
        crash: d.crash,
        salt: d.salt,
        hashRound: d.hashRound,
        };

    } catch (err) {
      console.log(`Error game ${gameId}, attempt ${attempt}:`, err.message);
      await sleep(2000);
    }
  }

  console.log(`GAME FAILED AFTER ${MAX_ATTEMPTS_PER_GAME} attempts: ${gameId}`);
  return null;
}

async function fetchGamesSequential(startId, total) {
  let current = startId;
  while (gamesBuffer.length < total) {
    const game = await fetchGame(current);
    if (game) {
      gamesBuffer.push(game);
      console.log(`Got: ${game.id} (${gamesBuffer.length}/${total})`);
    }
    current--;
    await sleep(REQUEST_DELAY);
  }
}

app.get("/games", (req, res) => res.json(gamesBuffer));

app.get("/start", (req, res) => {
  const start = parseInt(req.query.startGame);
  const count = parseInt(req.query.count);

  if (!start || !count) {
    return res.status(400).json({ error: "startGame & count required" });
  }

  gamesBuffer.length = 0;
  fetchGamesSequential(start, count);
  res.json({ message: "Started" });
});

app.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));