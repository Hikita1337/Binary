const express = require('express');
const axios = require('axios');

const app = express();
const PORT = 3000;

// Твой краткоживущий JWT
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTg2ODYxLCJpYXQiOjE3NjQ0NDcyODQsImV4cCI6MTc2NTMxMTI4NH0.ZK1J86BGJJcOCw93MUnXrAsS3n0sLybUhd1EXSFULEc';

// Начальная игра
let currentGameId = 6233329;

// Храним все игры здесь
let gamesBuffer = [];

// Функция для запроса одной игры по gameId
async function fetchGame(gameId) {
    try {
        const res = await axios.get(`https://example.com/api/game/${gameId}`, {
            headers: { Authorization: `Bearer ${JWT}` }
        });

        const data = res.data.data;

        // Преобразуем ставки
        const bets = data.bets.map(bet => ({
            userId: bet.user.id,
            username: bet.user.name,
            userBlm: bet.user.blm,
            depositAmount: bet.deposit.amount,
            withdrawAmount: bet.withdraw.amount,
            coefficient: bet.coefficient,
            coefficientAuto: bet.coefficientAuto,
            time: bet.createdAt,
            skinsUsed: bet.deposit.items.length
        }));

        return {
            gameId: data.id,
            crash: data.crash,
            salt: data.salt,
            hashRound: data.hashRound,
            bets
        };

    } catch (err) {
        console.error(`Ошибка запроса gameId ${gameId}:`, err.message);
        return null;
    }
}

// Функция для пачки игр
async function fetchGamesBatch(batchSize = 40) {
    const promises = [];
    for (let i = 0; i < batchSize; i++) {
        promises.push(fetchGame(currentGameId));
        currentGameId--; // идем вниз
    }

    const results = await Promise.all(promises);
    const validGames = results.filter(g => g !== null);
    gamesBuffer.push(...validGames);
    console.log(`Собрано игр: ${gamesBuffer.length}`);
}

// Endpoint для отдачи всех игр
app.get('/games', (req, res) => {
    res.json({
        success: true,
        date: new Date().toISOString(),
        games: gamesBuffer
    });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // Тест: собираем первую пачку раз в 2 секунды
    const interval = setInterval(async () => {
        await fetchGamesBatch(40);

        // Остановим после 30 000 игр (или можно убрать лимит для бесконечной работы)
        if (gamesBuffer.length >= 30000) {
            console.log('Собрано 30 000 игр, останавливаем сбор.');
            clearInterval(interval);
        }
    }, 2000);
});