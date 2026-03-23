import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

const PORT = process.env.PORT || 3001;
const DICE_FACES = ['1', '2', '3', 'claw', 'heart', 'lightning'];
const ROOM_TTL = 30 * 60 * 1000; // 30 min
const DISCONNECT_TIMEOUT = 60 * 1000; // 60s before AI takeover

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

// ── Room Management ──

function createRoom(playerName) {
  const code = generateCode();
  const token = crypto.randomUUID();
  const room = {
    code,
    state: 'lobby',
    hostIndex: 0,
    players: [{
      index: 0,
      name: playerName,
      token,
      ws: null,
      connected: false,
      monsterId: null,
      isAI: false,
    }],
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
  if (room.players.filter(p => !p.isAI).length >= 6) return { error: 'Room is full' };

  const token = crypto.randomUUID();
  const playerIndex = room.players.length;
  room.players.push({
    index: playerIndex,
    name: playerName,
    token,
    ws: null,
    connected: false,
    monsterId: null,
    isAI: false,
  });
  room.lastActivity = Date.now();
  return { room, token, playerIndex };
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
  };
  room.lastActivity = Date.now();
  return { cardDeckSeed, initialDice: firstTurnDice[0] };
}

function advanceTurn(room) {
  const g = room.game;
  // Move to next player (skip dead — client handles this, server just tracks index)
  g.currentPlayerIndex = (g.currentPlayerIndex + 1) % room.players.length;
  if (g.currentPlayerIndex === 0) g.round++;
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
  const ctx = ws._ctx; // attached room/player context

  switch (type) {
    case 'c:create': {
      const { playerName } = msg;
      if (!playerName) return send(ws, { type: 's:error', message: 'Name required' });
      const { room, token, playerIndex } = createRoom(playerName);
      room.players[0].ws = ws;
      room.players[0].connected = true;
      ws._ctx = { room, playerIndex };
      send(ws, { type: 's:roomCreated', roomCode: room.code, playerToken: token, playerIndex });
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
      broadcast(room, { type: 's:playerJoined', player: { index: playerIndex, name: playerName } }, playerIndex);
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
        send(ws, { type: 's:sync', game: room.game, players: lobbyState(room).players });
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

    case 'c:start': {
      if (!ctx) return;
      const { room } = ctx;
      if (ctx.playerIndex !== room.hostIndex) return send(ws, { type: 's:error', message: 'Only host can start' });
      if (room.players.filter(p => p.connected || p.isAI).length < 2) return send(ws, { type: 's:error', message: 'Need 2+ players' });
      const { cardDeckSeed, initialDice } = startGame(room);
      broadcast(room, {
        type: 's:gameStart',
        players: room.players.map(p => ({ index: p.index, name: p.name, monsterId: p.monsterId, isAI: p.isAI })),
        cardDeckSeed,
        initialDice,
        currentPlayerIndex: 0,
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
      ctx.room.lastActivity = Date.now();
      // Advance turn, pre-roll next dice
      advanceTurn(ctx.room);
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
      ctx.room.state = 'ended';
      broadcast(ctx.room, { type: 's:gameOver', winnerIndex: msg.winnerIndex });
      break;
    }

    default:
      send(ws, { type: 's:error', message: `Unknown message type: ${type}` });
  }
}

function isPlayerTurn(ctx) {
  return ctx.room.game && ctx.room.game.currentPlayerIndex === ctx.playerIndex;
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
  }
}

// ── Room Cleanup ──

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL) {
      // Close all connections
      for (const p of room.players) {
        if (p.ws) send(p.ws, { type: 's:roomClosed', reason: 'Inactivity timeout' });
      }
      rooms.delete(code);
    }
  }
}, 60_000);

// ── HTTP + WebSocket Server ──

const httpServer = createServer((req, res) => {
  // Health check + CORS for wake-up ping
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
