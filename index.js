import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

const PORT = process.env.PORT || 3001;
const DICE_FACES = ['1', '2', '3', 'claw', 'heart', 'lightning'];
const ROOM_TTL = 30 * 60 * 1000; // 30 min
const AI_NAMES = ['Bot Alpha', 'Bot Beta', 'Bot Gamma', 'Bot Delta', 'Bot Epsilon'];

// ── Room Storage ──

const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function rollDice(count = 6) {
  return Array.from({ length: count }, () => DICE_FACES[crypto.randomInt(6)]);
}

function prerollTurn(numDice = 6) {
  return [rollDice(numDice), rollDice(numDice), rollDice(numDice)];
}

function makeAISlot(index) {
  const aiCount = index - 1; // host is 0
  return {
    index,
    name: AI_NAMES[aiCount % AI_NAMES.length],
    token: null,
    ws: null,
    connected: true,
    monsterId: null,
    isAI: true,
  };
}

function makeOpenSlot(index) {
  return {
    index,
    name: '',
    token: null,
    ws: null,
    connected: false,
    monsterId: null,
    isAI: false,
  };
}

// ── Room Management ──

function createRoom(playerName) {
  const code = generateCode();
  const token = crypto.randomUUID();
  const room = {
    code,
    state: 'lobby',
    hostIndex: 0,
    players: [
      { index: 0, name: playerName, token, ws: null, connected: false, monsterId: null, isAI: false },
      makeAISlot(1),
    ],
    config: null,
    game: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return { room, token, playerIndex: 0 };
}

function joinRoom(code, playerName) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };
  if (room.state !== 'lobby') return { error: 'Game already in progress' };

  // Find first open human slot (not AI, not connected, no token)
  const openSlot = room.players.find(p => !p.isAI && !p.connected && !p.token);
  if (!openSlot) return { error: 'No open slots available' };

  const token = crypto.randomUUID();
  openSlot.name = playerName;
  openSlot.token = token;
  // ws and connected will be set after this returns
  room.lastActivity = Date.now();
  return { room, token, playerIndex: openSlot.index };
}

function reconnectPlayer(code, token) {
  const room = rooms.get(code);
  if (!room) return { error: 'Room not found' };
  const player = room.players.find(p => p.token === token);
  if (!player) return { error: 'Invalid token' };
  return { room, player };
}

// ── Broadcasting ──

function broadcast(room, msg, excludeIndex = -1) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.index !== excludeIndex && p.ws && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function lobbyState(room) {
  return {
    type: 's:lobbyUpdate',
    roomCode: room.code,
    hostIndex: room.hostIndex,
    players: room.players.map(p => ({
      index: p.index,
      name: p.name,
      connected: p.connected,
      monsterId: p.monsterId,
      isAI: p.isAI,
      isOpen: !p.isAI && !p.connected && !p.token, // unfilled human slot
    })),
  };
}

// ── Game State ──

function startGame(room) {
  const cardDeckSeed = crypto.randomInt(1_000_000_000);
  const firstTurnDice = prerollTurn();
  room.state = 'playing';
  room.game = {
    currentPlayerIndex: 0,
    round: 1,
    phase: 'rolling',
    prerolledDice: firstTurnDice,
    rerollIndex: 0,
    cardDeckSeed,
    eliminated: new Set(),
  };
  room.lastActivity = Date.now();
  return { cardDeckSeed, initialDice: firstTurnDice[0] };
}

function advanceTurn(room) {
  const g = room.game;
  const totalPlayers = room.players.length;
  let attempts = 0;
  do {
    g.currentPlayerIndex = (g.currentPlayerIndex + 1) % totalPlayers;
    if (g.currentPlayerIndex === 0) g.round++;
    attempts++;
  } while (g.eliminated.has(g.currentPlayerIndex) && attempts < totalPlayers);
  g.prerolledDice = prerollTurn();
  g.rerollIndex = 0;
  g.phase = 'rolling';
  room.lastActivity = Date.now();
}

// ── Message Handlers ──

function handleMessage(ws, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return send(ws, { type: 's:error', message: 'Invalid JSON' }); }

  const { type } = msg;
  const ctx = ws._ctx;

  switch (type) {
    case 'c:create': {
      const { playerName } = msg;
      if (!playerName) return send(ws, { type: 's:error', message: 'Name required' });
      const { room, token, playerIndex } = createRoom(playerName);
      room.players[0].ws = ws;
      room.players[0].connected = true;
      ws._ctx = { room, playerIndex };
      send(ws, { type: 's:roomCreated', roomCode: room.code, playerToken: token, playerIndex });
      broadcast(room, lobbyState(room));
      break;
    }

    case 'c:join': {
      const { roomCode, playerName } = msg;
      if (!roomCode || !playerName) return send(ws, { type: 's:error', message: 'Code and name required' });
      const result = joinRoom(roomCode.toUpperCase(), playerName);
      if (result.error) return send(ws, { type: 's:error', message: result.error });
      const { room, token, playerIndex } = result;
      room.players[playerIndex].ws = ws;
      room.players[playerIndex].connected = true;
      ws._ctx = { room, playerIndex };
      send(ws, { type: 's:joined', playerToken: token, playerIndex, roomCode: room.code });
      broadcast(room, lobbyState(room));
      break;
    }

    case 'c:reconnect': {
      const { roomCode, playerToken } = msg;
      const result = reconnectPlayer(roomCode, playerToken);
      if (result.error) return send(ws, { type: 's:error', message: result.error });
      const { room, player } = result;
      player.ws = ws;
      player.connected = true;
      ws._ctx = { room, playerIndex: player.index };
      send(ws, { type: 's:reconnected', playerIndex: player.index, roomState: room.state });
      if (room.state === 'playing') {
        send(ws, { type: 's:sync', game: { ...room.game, eliminated: [...room.game.eliminated] }, players: lobbyState(room).players });
      } else {
        broadcast(room, lobbyState(room));
      }
      broadcast(room, { type: 's:playerReconnected', playerIndex: player.index }, player.index);
      break;
    }

    case 'c:updateMonster': {
      if (!ctx) return;
      const { monsterId } = msg;
      ctx.room.players[ctx.playerIndex].monsterId = monsterId;
      ctx.room.lastActivity = Date.now();
      broadcast(ctx.room, lobbyState(ctx.room));
      break;
    }

    case 'c:updateName': {
      if (!ctx) return;
      const { name } = msg;
      if (name && name.trim()) {
        ctx.room.players[ctx.playerIndex].name = name.trim().slice(0, 20);
        ctx.room.lastActivity = Date.now();
        broadcast(ctx.room, lobbyState(ctx.room));
      }
      break;
    }

    case 'c:setPlayerCount': {
      if (!ctx) return;
      const { room } = ctx;
      if (ctx.playerIndex !== room.hostIndex) return send(ws, { type: 's:error', message: 'Only host can change player count' });
      if (room.state !== 'lobby') return;
      const count = Math.max(2, Math.min(6, msg.count));

      // Growing: add AI slots
      while (room.players.length < count) {
        room.players.push(makeAISlot(room.players.length));
      }
      // Shrinking: remove from end (only AI or open slots)
      while (room.players.length > count) {
        const last = room.players[room.players.length - 1];
        if (last.connected && !last.isAI) break; // can't remove connected human
        room.players.pop();
      }
      // Re-index
      room.players.forEach((p, i) => { p.index = i; });
      room.lastActivity = Date.now();
      broadcast(room, lobbyState(room));
      break;
    }

    case 'c:setSlotType': {
      if (!ctx) return;
      const { room } = ctx;
      if (ctx.playerIndex !== room.hostIndex) return send(ws, { type: 's:error', message: 'Only host can change slot types' });
      if (room.state !== 'lobby') return;
      const idx = msg.playerIndex;
      const target = room.players[idx];
      if (!target || idx === room.hostIndex) return; // can't change host slot

      if (msg.slotType === 'ai') {
        // Can only switch to AI if not a connected human
        if (target.connected && !target.isAI) return;
        const aiCount = room.players.filter(p => p.isAI).length;
        target.isAI = true;
        target.connected = true;
        target.name = AI_NAMES[aiCount % AI_NAMES.length];
        target.token = null;
        target.ws = null;
        target.monsterId = null;
      } else {
        // Switch to open human slot
        target.isAI = false;
        target.connected = false;
        target.name = '';
        target.token = null;
        target.ws = null;
        target.monsterId = null;
      }
      room.lastActivity = Date.now();
      broadcast(room, lobbyState(room));
      break;
    }

    case 'c:setSlotMonster': {
      // Host sets monster for AI slots
      if (!ctx) return;
      const { room } = ctx;
      if (ctx.playerIndex !== room.hostIndex) return;
      if (room.state !== 'lobby') return;
      const target = room.players[msg.playerIndex];
      if (!target || !target.isAI) return;
      target.monsterId = msg.monsterId;
      room.lastActivity = Date.now();
      broadcast(room, lobbyState(room));
      break;
    }

    case 'c:setSlotName': {
      // Host sets name for AI slots
      if (!ctx) return;
      const { room } = ctx;
      if (ctx.playerIndex !== room.hostIndex) return;
      if (room.state !== 'lobby') return;
      const target = room.players[msg.playerIndex];
      if (!target || !target.isAI) return;
      target.name = (msg.name || '').trim().slice(0, 20);
      room.lastActivity = Date.now();
      broadcast(room, lobbyState(room));
      break;
    }

    case 'c:start': {
      if (!ctx) return;
      const { room } = ctx;
      if (ctx.playerIndex !== room.hostIndex) return send(ws, { type: 's:error', message: 'Only host can start' });
      // Check all human slots are filled
      const hasOpenSlots = room.players.some(p => !p.isAI && !p.connected);
      if (hasOpenSlots) return send(ws, { type: 's:error', message: 'Waiting for players to join' });
      if (room.players.filter(p => p.connected || p.isAI).length < 2) return send(ws, { type: 's:error', message: 'Need 2+ players' });

      // Auto-assign monsters to players without one
      const allMonsters = ['king', 'gigazaur', 'mekadragon', 'cyberbunny', 'alienoid', 'kraken'];
      const usedMonsters = new Set(room.players.filter(p => p.monsterId).map(p => p.monsterId));
      const available = allMonsters.filter(m => !usedMonsters.has(m));
      for (const p of room.players) {
        if (!p.monsterId && available.length > 0) {
          const idx = crypto.randomInt(available.length);
          p.monsterId = available.splice(idx, 1)[0];
        }
      }

      const { cardDeckSeed, initialDice } = startGame(room);
      broadcast(room, {
        type: 's:gameStart',
        players: room.players.map(p => ({ index: p.index, name: p.name, monsterId: p.monsterId, isAI: p.isAI })),
        cardDeckSeed,
        initialDice,
        currentPlayerIndex: 0,
        hostIndex: room.hostIndex,
        aiDifficulty: msg.aiDifficulty || 'normal',
      });
      break;
    }

    // ── Game actions (relay + validate turn) ──

    case 'c:keepDice': {
      if (!ctx || !isPlayerTurn(ctx)) return;
      broadcast(ctx.room, { type: 's:keepChanged', playerIndex: ctx.playerIndex, keptDice: msg.keptDice }, ctx.playerIndex);
      break;
    }

    case 'c:reroll': {
      if (!ctx || !isPlayerTurn(ctx)) return;
      const g = ctx.room.game;
      g.rerollIndex++;
      const dice = g.prerolledDice[Math.min(g.rerollIndex, 2)];
      ctx.room.lastActivity = Date.now();
      broadcast(ctx.room, { type: 's:diceRolled', dice, rerollIndex: g.rerollIndex, playerIndex: ctx.playerIndex });
      break;
    }

    case 'c:confirmDice': {
      if (!ctx || !isPlayerTurn(ctx)) return;
      ctx.room.game.phase = 'resolving';
      ctx.room.lastActivity = Date.now();
      broadcast(ctx.room, { type: 's:diceConfirmed', playerIndex: ctx.playerIndex }, ctx.playerIndex);
      break;
    }

    case 'c:yieldDecision': {
      if (!ctx) return;
      broadcast(ctx.room, { type: 's:yieldResult', playerIndex: ctx.playerIndex, yielded: msg.yielded }, ctx.playerIndex);
      break;
    }

    case 'c:buyCard': {
      if (!ctx || !isPlayerTurn(ctx)) return;
      ctx.room.lastActivity = Date.now();
      broadcast(ctx.room, { type: 's:cardBought', playerIndex: ctx.playerIndex, cardIndex: msg.cardIndex }, ctx.playerIndex);
      break;
    }

    case 'c:sweepStore': {
      if (!ctx || !isPlayerTurn(ctx)) return;
      ctx.room.lastActivity = Date.now();
      broadcast(ctx.room, { type: 's:storeSweep', playerIndex: ctx.playerIndex }, ctx.playerIndex);
      break;
    }

    case 'c:rapidHeal': {
      if (!ctx || !isPlayerTurn(ctx)) return;
      broadcast(ctx.room, { type: 's:rapidHeal', playerIndex: ctx.playerIndex }, ctx.playerIndex);
      break;
    }

    case 'c:endBuy': {
      if (!ctx || !isPlayerTurn(ctx)) return;
      if (ctx.room.state === 'ended') return;
      ctx.room.lastActivity = Date.now();
      advanceTurn(ctx.room);
      if (ctx.room.state === 'ended') return;
      const g = ctx.room.game;
      broadcast(ctx.room, {
        type: 's:turnAdvance',
        nextPlayerIndex: g.currentPlayerIndex,
        round: g.round,
        initialDice: g.prerolledDice[0],
      });
      break;
    }

    case 'c:gameOver': {
      if (!ctx) return;
      if (ctx.room.state === 'ended') return;
      if (ctx.playerIndex !== ctx.room.hostIndex) return;
      ctx.room.state = 'ended';
      broadcast(ctx.room, { type: 's:gameOver', winnerIndex: msg.winnerIndex });
      break;
    }

    case 'c:eliminatePlayer': {
      if (!ctx) return;
      const { room } = ctx;
      if (room.state !== 'playing' || !room.game) return;
      if (ctx.playerIndex !== room.hostIndex) return;
      const eliminatedIdx = msg.playerIndex;
      if (eliminatedIdx == null || eliminatedIdx < 0 || eliminatedIdx >= room.players.length) return;
      if (room.game.eliminated.has(eliminatedIdx)) return;

      room.game.eliminated.add(eliminatedIdx);
      broadcast(room, { type: 's:playerEliminated', playerIndex: eliminatedIdx });

      // Check if only one player remains alive
      const alive = room.players.filter(p => !room.game.eliminated.has(p.index));
      if (alive.length <= 1) {
        room.state = 'ended';
        const winnerIndex = alive.length === 1 ? alive[0].index : -1;
        broadcast(room, { type: 's:gameOver', winnerIndex });
        return;
      }

      // If the eliminated player was the current turn player, auto-advance
      if (eliminatedIdx === room.game.currentPlayerIndex) {
        advanceTurn(room);
        const g = room.game;
        broadcast(room, {
          type: 's:turnAdvance',
          nextPlayerIndex: g.currentPlayerIndex,
          round: g.round,
          initialDice: g.prerolledDice[0],
        });
      }
      break;
    }

    default:
      send(ws, { type: 's:error', message: `Unknown message type: ${type}` });
  }
}

function isPlayerTurn(ctx) {
  if (!ctx.room.game) return false;
  if (ctx.room.game.eliminated.has(ctx.playerIndex)) return false;
  const currentIdx = ctx.room.game.currentPlayerIndex;
  if (ctx.playerIndex === currentIdx) return true;
  // Host can act on behalf of AI players
  const currentPlayer = ctx.room.players[currentIdx];
  if (ctx.playerIndex === ctx.room.hostIndex && currentPlayer && currentPlayer.isAI) return true;
  return false;
}

// ── Disconnect Handling ──

function handleDisconnect(ws) {
  const ctx = ws._ctx;
  if (!ctx) return;
  const { room, playerIndex } = ctx;
  const player = room.players[playerIndex];
  if (player) {
    player.connected = false;
    player.ws = null;
    broadcast(room, { type: 's:playerDisconnected', playerIndex });
    if (room.state === 'lobby') {
      broadcast(room, lobbyState(room));
    }
  }
}

// ── Room Cleanup ──

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL) {
      for (const p of room.players) {
        if (p.ws) send(p.ws, { type: 's:roomClosed', reason: 'Inactivity timeout' });
      }
      rooms.delete(code);
    }
  }
}, 60_000);

// ── HTTP + WebSocket Server ──

const httpServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws._ctx = null;

  ws.on('message', (data) => {
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

httpServer.listen(PORT, () => {
  console.log(`Tokyo Rampage server running on port ${PORT}`);
});
