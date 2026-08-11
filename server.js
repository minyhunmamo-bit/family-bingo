const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// Serve static files (the HTML)
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(port, () => {
    console.log(`✅ Server running on http://localhost:${port}`);
});

const wss = new WebSocket.Server({ server });

// ----- Game configuration -----
const PICK_LIMIT = 5;
const MAX_SPINS = 3;
const SELECTION_TIME = 30;
const RESET_DELAY = 5000;

// ----- Game state -----
let gameState = {
    phase: 'selection', // 'selection' | 'spinning' | 'results'
    round: 1,
    timer: SELECTION_TIME,
    drawnNumbers: [],
    spinCount: 0,
    winners: [],
    allTakenNumbers: [],
};

let players = {};
let playerIdCounter = 0;
let timerInterval = null;
let resetTimeout = null;
let isSpinning = false;

// ----- Helper functions -----
function broadcastState() {
    const state = {
        type: 'state',
        players: Object.fromEntries(
            Object.entries(players).map(([id, p]) => [id, { name: p.name, picks: p.picks }])
        ),
        gameState: {
            phase: gameState.phase,
            round: gameState.round,
            timer: gameState.timer,
            drawnNumbers: gameState.drawnNumbers,
            spinCount: gameState.spinCount,
            winners: gameState.winners,
            allTakenNumbers: gameState.allTakenNumbers,
        }
    };
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(state));
        }
    });
}

function sendToClient(client, data) {
    if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
    }
}

function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    gameState.timer = SELECTION_TIME;
    broadcastState();
    timerInterval = setInterval(() => {
        gameState.timer--;
        broadcastState();
        if (gameState.timer <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
            if (gameState.phase === 'selection') {
                startSpinning();
            }
        }
    }, 1000);
}

function startSpinning() {
    if (isSpinning) return;
    if (gameState.phase === 'spinning' || gameState.phase === 'results') return;

    const numbers = gameState.allTakenNumbers;
    if (numbers.length === 0) {
        broadcastState();
        setTimeout(() => resetRound(), 2000);
        return;
    }

    gameState.phase = 'spinning';
    gameState.drawnNumbers = [];
    gameState.spinCount = 0;
    gameState.winners = [];
    isSpinning = true;
    broadcastState();

    // Send spin start
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'spin_start' }));
        }
    });

    let spinIndex = 0;

    function doSpin() {
        if (spinIndex >= MAX_SPINS) {
            isSpinning = false;
            gameState.phase = 'results';

            // Determine winners
            const winIds = [];
            for (let id in players) {
                const p = players[id];
                if (p.picks.some(num => gameState.drawnNumbers.includes(num))) {
                    winIds.push(id);
                }
            }
            gameState.winners = winIds;

            // Broadcast spin end
            const endMsg = { type: 'spin_end', winners: winIds };
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(endMsg));
                }
            });

            broadcastState();

            if (resetTimeout) clearTimeout(resetTimeout);
            resetTimeout = setTimeout(() => resetRound(), RESET_DELAY);
            return;
        }

        const available = gameState.allTakenNumbers.filter(n => !gameState.drawnNumbers.includes(n));
        if (available.length === 0) {
            isSpinning = false;
            gameState.phase = 'results';
            gameState.winners = [];
            broadcastState();
            resetTimeout = setTimeout(resetRound, RESET_DELAY);
            return;
        }

        const randomNum = available[Math.floor(Math.random() * available.length)];
        gameState.drawnNumbers.push(randomNum);
        gameState.spinCount = spinIndex + 1;

        const totalNumbers = gameState.allTakenNumbers.length;
        const angleStep = 360 / totalNumbers;
        const numIndex = gameState.allTakenNumbers.indexOf(randomNum);
        const targetAngle = numIndex * angleStep;
        const extraSpins = 3 + Math.floor(Math.random() * 3);
        const totalRotation = 360 * extraSpins + targetAngle;

        const spinMsg = {
            type: 'spin_result',
            spinNumber: spinIndex + 1,
            number: randomNum,
            totalRotation: totalRotation,
        };
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(spinMsg));
            }
        });

        spinIndex++;
        setTimeout(doSpin, 3000);
    }

    setTimeout(doSpin, 500);
}

function resetRound() {
    if (resetTimeout) clearTimeout(resetTimeout);
    resetTimeout = null;

    // Clear all picks
    for (let id in players) {
        players[id].picks = [];
    }
    gameState.allTakenNumbers = [];
    gameState.drawnNumbers = [];
    gameState.winners = [];
    gameState.spinCount = 0;
    gameState.phase = 'selection';
    gameState.round++;
    isSpinning = false;

    const resetMsg = {
        type: 'round_reset',
        gameState: {
            phase: gameState.phase,
            round: gameState.round,
            timer: gameState.timer,
            drawnNumbers: gameState.drawnNumbers,
            spinCount: gameState.spinCount,
            winners: gameState.winners,
            allTakenNumbers: gameState.allTakenNumbers,
        },
        players: Object.fromEntries(
            Object.entries(players).map(([id, p]) => [id, { name: p.name, picks: p.picks }])
        )
    };

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(resetMsg));
        }
    });

    startTimer();
}

// ----- WebSocket connection -----
wss.on('connection', function(ws) {
    const playerId = String(++playerIdCounter);
    players[playerId] = { name: 'Player', picks: [], ws: ws };

    ws.on('message', function(message) {
        try {
            const data = JSON.parse(message);
            switch (data.type) {
                case 'join':
                    if (data.name) players[playerId].name = data.name;
                    const initMsg = {
                        type: 'init',
                        playerId: playerId,
                        players: Object.fromEntries(
                            Object.entries(players).map(([id, p]) => [id, { name: p.name, picks: p.picks }])
                        ),
                        gameState: {
                            phase: gameState.phase,
                            round: gameState.round,
                            timer: gameState.timer,
                            drawnNumbers: gameState.drawnNumbers,
                            spinCount: gameState.spinCount,
                            winners: gameState.winners,
                            allTakenNumbers: gameState.allTakenNumbers,
                        }
                    };
                    sendToClient(ws, initMsg);
                    broadcastState();
                    break;

                case 'save_picks':
                    if (gameState.phase !== 'selection') {
                        sendToClient(ws, { type: 'error', message: 'Cannot save during spinning' });
                        return;
                    }
                    const picks = data.picks;
                    if (!Array.isArray(picks) || picks.length !== PICK_LIMIT) {
                        sendToClient(ws, { type: 'error', message: `Must select exactly ${PICK_LIMIT} numbers` });
                        return;
                    }
                    const allTaken = gameState.allTakenNumbers;
                    const currentPicks = players[playerId].picks;
                    for (let num of picks) {
                        if (allTaken.includes(num) && !currentPicks.includes(num)) {
                            sendToClient(ws, { type: 'error', message: `Number ${num} already taken` });
                            return;
                        }
                    }
                    for (let num of currentPicks) {
                        const idx = gameState.allTakenNumbers.indexOf(num);
                        if (idx !== -1) gameState.allTakenNumbers.splice(idx, 1);
                    }
                    players[playerId].picks = picks;
                    for (let num of picks) {
                        if (!gameState.allTakenNumbers.includes(num)) {
                            gameState.allTakenNumbers.push(num);
                        }
                    }
                    broadcastState();
                    break;

                case 'reset_game':
                    if (gameState.phase === 'spinning') return;
                    resetRound();
                    break;

                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });

    ws.on('close', function() {
        delete players[playerId];
        // Rebuild allTakenNumbers
        gameState.allTakenNumbers = [];
        for (let id in players) {
            for (let num of players[id].picks) {
                if (!gameState.allTakenNumbers.includes(num)) {
                    gameState.allTakenNumbers.push(num);
                }
            }
        }
        broadcastState();
    });
});

// Start the game
startTimer();
console.log('🎯 WebSocket server running on ws://localhost:' + port);