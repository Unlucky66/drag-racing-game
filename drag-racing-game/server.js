const express = require('express');
const app = express();
const http = require('http').createServer(app);
const cors = require('cors');

// Enable CORS for CrazyGames
app.use(cors());
app.use(express.static('public'));

const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', players: players.size });
});

// Game state
const players = new Map();
const matchmaking = [];
const activeRaces = new Map();

// Car stats database
const carStats = {
    starter: { speed: 50, acceleration: 60, handling: 55, nos: 30 },
    sport: { speed: 70, acceleration: 75, handling: 45, nos: 50 },
    super: { speed: 85, acceleration: 80, handling: 65, nos: 70 },
    hyper: { speed: 95, acceleration: 90, handling: 60, nos: 90 }
};

io.on('connection', (socket) => {
    console.log('🟢 Player connected:', socket.id);
    
    let playerData = {
        id: socket.id,
        username: 'Racer',
        rating: 1000,
        car: 'starter',
        currency: 5000,
        inRace: false,
        connected: true
    };
    
    // Player joins with profile
    socket.on('join', (data) => {
        playerData.username = data.username || 'Racer_' + Math.random().toString(36).substr(2, 5);
        playerData.rating = data.rating || 1000;
        playerData.car = data.car || 'starter';
        playerData.currency = data.currency || 5000;
        
        players.set(socket.id, playerData);
        
        // Send initial data
        socket.emit('joined', {
            playerId: socket.id,
            playerCount: players.size
        });
        
        // Broadcast updated player count
        io.emit('playerCount', players.size);
        
        console.log(`👤 ${playerData.username} joined. Total players: ${players.size}`);
    });
    
    // Find multiplayer match
    socket.on('findMatch', (data) => {
        if (playerData.inRace) {
            socket.emit('error', 'Already in a race!');
            return;
        }
        
        // Update car selection
        playerData.car = data.car || playerData.car;
        
        // Add to matchmaking queue
        matchmaking.push({
            socketId: socket.id,
            rating: playerData.rating,
            car: playerData.car,
            timestamp: Date.now()
        });
        
        socket.emit('searching', 'Looking for opponent...');
        
        // Try to create match
        tryCreateMatch();
    });
    
    // Cancel matchmaking
    socket.on('cancelMatch', () => {
        const index = matchmaking.findIndex(m => m.socketId === socket.id);
        if (index > -1) {
            matchmaking.splice(index, 1);
            socket.emit('matchCancelled');
        }
    });
    
    // Player shift action during race
    socket.on('shiftStart', () => {
        const race = findPlayerRace(socket.id);
        if (race) {
            const playerRace = race.players.get(socket.id);
            if (playerRace) {
                playerRace.shifting = true;
            }
        }
    });
    
    socket.on('shiftEnd', () => {
        const race = findPlayerRace(socket.id);
        if (race) {
            const playerRace = race.players.get(socket.id);
            if (playerRace) {
                playerRace.shifting = false;
            }
        }
    });
    
    // NOS boost
    socket.on('useNOS', () => {
        const race = findPlayerRace(socket.id);
        if (race) {
            const playerRace = race.players.get(socket.id);
            if (playerRace && playerRace.nosLeft > 0) {
                playerRace.nosLeft--;
                playerRace.position += 15;
                
                // Notify opponent
                const opponentId = getOpponentId(race, socket.id);
                if (opponentId) {
                    io.to(opponentId).emit('opponentNOS');
                }
            }
        }
    });
    
    // Leave race
    socket.on('leaveRace', () => {
        const race = findPlayerRace(socket.id);
        if (race) {
            endRace(race, socket.id, 'forfeit');
        }
        playerData.inRace = false;
    });
    
    // Get leaderboard
    socket.on('getLeaderboard', () => {
        const leaderboard = Array.from(players.values())
            .sort((a, b) => b.rating - a.rating)
            .slice(0, 20)
            .map((p, i) => ({
                rank: i + 1,
                username: p.username,
                rating: p.rating,
                car: p.car
            }));
        
        socket.emit('leaderboard', leaderboard);
    });
    
    // Chat message
    socket.on('chatMessage', (message) => {
        const race = findPlayerRace(socket.id);
        if (race) {
            const opponentId = getOpponentId(race, socket.id);
            if (opponentId) {
                io.to(opponentId).emit('chatMessage', {
                    from: playerData.username,
                    message: message
                });
            }
        }
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        console.log('🔴 Player disconnected:', playerData.username);
        
        // Remove from matchmaking
        const matchIndex = matchmaking.findIndex(m => m.socketId === socket.id);
        if (matchIndex > -1) matchmaking.splice(matchIndex, 1);
        
        // End any active races
        const race = findPlayerRace(socket.id);
        if (race) {
            endRace(race, socket.id, 'disconnect');
        }
        
        players.delete(socket.id);
        io.emit('playerCount', players.size);
    });
});

function tryCreateMatch() {
    if (matchmaking.length < 2) return;
    
    // Sort by waiting time
    matchmaking.sort((a, b) => b.timestamp - a.timestamp);
    
    // Find best match based on rating
    let bestMatch = null;
    let bestDiff = Infinity;
    
    for (let i = 0; i < matchmaking.length - 1; i++) {
        for (let j = i + 1; j < matchmaking.length; j++) {
            const diff = Math.abs(matchmaking[i].rating - matchmaking[j].rating);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestMatch = [i, j];
            }
        }
    }
    
    if (bestMatch) {
        const player1 = matchmaking[bestMatch[0]];
        const player2 = matchmaking[bestMatch[1]];
        
        // Remove from queue
        matchmaking.splice(Math.max(bestMatch[0], bestMatch[1]), 1);
        matchmaking.splice(Math.min(bestMatch[0], bestMatch[1]), 1);
        
        // Create race
        startNewRace(player1, player2);
    }
}

function startNewRace(player1, player2) {
    const raceId = 'race_' + Date.now();
    const p1Data = players.get(player1.socketId);
    const p2Data = players.get(player2.socketId);
    
    if (!p1Data || !p2Data) return;
    
    // Mark players as in race
    p1Data.inRace = true;
    p2Data.inRace = true;
    
    const race = {
        id: raceId,
        players: new Map([
            [player1.socketId, {
                position: 0,
                shifting: false,
                nosLeft: 3,
                finishTime: null
            }],
            [player2.socketId, {
                position: 0,
                shifting: false,
                nosLeft: 3,
                finishTime: null
            }]
        ]),
        startTime: Date.now(),
        interval: null,
        finished: false
    };
    
    activeRaces.set(raceId, race);
    
    // Notify players
    io.to(player1.socketId).emit('matchFound', {
        raceId: raceId,
        opponent: {
            username: p2Data.username,
            car: p2Data.car,
            rating: p2Data.rating
        },
        yourCar: player1.car
    });
    
    io.to(player2.socketId).emit('matchFound', {
        raceId: raceId,
        opponent: {
            username: p1Data.username,
            car: p1Data.car,
            rating: p1Data.rating
        },
        yourCar: player2.car
    });
    
    // Start race simulation
    race.interval = setInterval(() => {
        if (race.finished) {
            clearInterval(race.interval);
            return;
        }
        
        race.players.forEach((data, playerId) => {
            // Calculate speed based on shifting
            const playerInfo = players.get(playerId);
            const carStats_data = playerInfo ? carStats[playerInfo.car] : carStats.starter;
            
            let speedMultiplier = 0.3; // Base speed
            
            if (data.shifting) {
                speedMultiplier = 1.5; // Shifting bonus
            }
            
            // Add car stats bonus
            speedMultiplier *= (carStats_data.acceleration / 50);
            
            // Update position
            data.position += speedMultiplier * (0.5 + Math.random() * 0.5);
            data.position = Math.min(100, data.position);
            
            // Check finish
            if (data.position >= 100 && !data.finishTime) {
                data.finishTime = Date.now();
                
                // Check if race is complete
                const bothFinished = Array.from(race.players.values())
                    .every(p => p.finishTime !== null);
                
                if (bothFinished) {
                    finishRace(race);
                }
            }
        });
        
        // Send position updates (every 100ms to reduce bandwidth)
        race.players.forEach((data, playerId) => {
            const opponentId = getOpponentId(race, playerId);
            if (opponentId) {
                io.to(opponentId).emit('raceUpdate', {
                    position: data.position,
                    shifting: data.shifting
                });
            }
        });
    }, 100);
    
    // Safety timeout (30 seconds max race)
    setTimeout(() => {
        if (!race.finished) {
            finishRace(race);
        }
    }, 30000);
}

function finishRace(race) {
    if (race.finished) return;
    race.finished = true;
    
    clearInterval(race.interval);
    
    // Determine winner
    let winner = null;
    let bestTime = Infinity;
    
    race.players.forEach((data, playerId) => {
        if (data.finishTime && data.finishTime < bestTime) {
            bestTime = data.finishTime;
            winner = playerId;
        }
    });
    
    // If no clear winner, use position
    if (!winner) {
        let bestPosition = 0;
        race.players.forEach((data, playerId) => {
            if (data.position > bestPosition) {
                bestPosition = data.position;
                winner = playerId;
            }
        });
    }
    
    const loser = getOpponentId(race, winner);
    const winnerData = players.get(winner);
    const loserData = players.get(loser);
    
    // Update ratings
    const ratingChange = 25;
    if (winnerData) winnerData.rating += ratingChange;
    if (loserData) loserData.rating = Math.max(0, loserData.rating - ratingChange);
    
    // Calculate rewards
    const winnerReward = 1000 + Math.floor(Math.random() * 500);
    const loserReward = 100;
    
    // Send results
    if (winner) {
        io.to(winner).emit('raceEnd', {
            won: true,
            position: race.players.get(winner).position,
            reward: winnerReward,
            ratingChange: ratingChange,
            opponentPosition: loser ? race.players.get(loser).position : 0
        });
        
        if (winnerData) winnerData.currency += winnerReward;
    }
    
    if (loser) {
        io.to(loser).emit('raceEnd', {
            won: false,
            position: race.players.get(loser).position,
            reward: loserReward,
            ratingChange: -ratingChange,
            opponentPosition: winner ? race.players.get(winner).position : 0
        });
        
        if (loserData) loserData.currency += loserReward;
    }
    
    // Mark players as not in race
    if (winnerData) winnerData.inRace = false;
    if (loserData) loserData.inRace = false;
    
    // Clean up race
    setTimeout(() => {
        activeRaces.delete(race.id);
    }, 5000);
    
    // Update leaderboard
    io.emit('leaderboardUpdate');
}

function endRace(race, disconnectedPlayer, reason) {
    if (race.finished) return;
    race.finished = true;
    
    clearInterval(race.interval);
    
    const opponentId = getOpponentId(race, disconnectedPlayer);
    
    if (opponentId && reason === 'disconnect') {
        io.to(opponentId).emit('raceEnd', {
            won: true,
            reason: 'Opponent disconnected',
            reward: 500,
            ratingChange: 10
        });
        
        const opponentData = players.get(opponentId);
        if (opponentData) {
            opponentData.rating += 10;
            opponentData.currency += 500;
            opponentData.inRace = false;
        }
    }
    
    const disconnectedData = players.get(disconnectedPlayer);
    if (disconnectedData) {
        disconnectedData.inRace = false;
    }
    
    activeRaces.delete(race.id);
}

function findPlayerRace(playerId) {
    for (const [raceId, race] of activeRaces) {
        if (race.players.has(playerId)) {
            return race;
        }
    }
    return null;
}

function getOpponentId(race, playerId) {
    for (const [id] of race.players) {
        if (id !== playerId) return id;
    }
    return null;
}

// Matchmaking cleanup (remove stale entries)
setInterval(() => {
    const now = Date.now();
    for (let i = matchmaking.length - 1; i >= 0; i--) {
        if (now - matchmaking[i].timestamp > 30000) { // 30 seconds timeout
            const player = players.get(matchmaking[i].socketId);
            if (player) {
                io.to(matchmaking[i].socketId).emit('matchTimeout');
            }
            matchmaking.splice(i, 1);
        }
    }
}, 5000);

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🏁 Drag Racing Server running on port ${PORT}`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});