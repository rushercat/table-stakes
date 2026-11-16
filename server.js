'use strict';
/**
 * Table Stakes — virtual chips for real card nights.
 * Express serves the client, Socket.io keeps every phone at the table in sync.
 */
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { RoomStore, dispatch } = require('./src/rooms');
const { userError, cleanName } = require('./src/util');

const PORT = Number(process.env.PORT) || 3000;
const USE_HTTPS = process.argv.includes('--https');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const store = new RoomStore();

app.get('/healthz', (req, res) => res.json({ ok: true, tables: store.rooms.size, uptime: Math.round(process.uptime()) }));

// QR code for the join link, so friends can scan it straight off the host's phone.
app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.u || '');
  if (!/^https?:\/\/[^\s]{1,280}$/.test(text)) return res.status(400).send('Bad link');
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#07140f', light: '#f3ecd9' } });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
  } catch (e) {
    res.status(500).send('QR failed');
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (/\.woff2$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'no-cache');
  },
}));

let server;
if (USE_HTTPS) {
  // Self-signed certificate for playing on home Wi-Fi: phones only allow camera access over HTTPS.
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'table-stakes.local' }], { days: 365, keySize: 2048, algorithm: 'sha256' });
  server = require('https').createServer({ key: pems.private, cert: pems.cert }, app);
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  pingInterval: 15000,
  pingTimeout: 12000,
  maxHttpBufferSize: 300 * 1024,
});

function broadcast(room) {
  io.to(room.code).emit('state', room.publicState());
  const host = room.player(room.hostId);
  if (host && host.socketId) io.to(host.socketId).emit('backup', room.backup());
}

function runEffects(room) {
  for (const fx of room.effects.splice(0)) {
    const s = io.sockets.sockets.get(fx.socketId);
    if (!s) continue;
    s.data.ctx = null;
    s.leave(room.code);
    s.emit('removed', { kicked: !!fx.kicked });
  }
  if (!room.players.some((p) => !p.left)) store.rooms.delete(room.code);
}

io.on('connection', (socket) => {
  socket.data.ctx = null;
  socket.data.misses = [];
  const reply = (ack, data) => { if (typeof ack === 'function') ack(data); };
  const fail = (ack, e) => {
    if (e && e.user) return reply(ack, { ok: false, error: e.message, reason: e.reason });
    console.error(e);
    reply(ack, { ok: false, error: 'Something went wrong on the server. Try again.' });
  };

  function seat(room, p) {
    // One phone per seat: a newer connection replaces the older one.
    if (p.socketId && p.socketId !== socket.id) {
      const old = io.sockets.sockets.get(p.socketId);
      if (old) { old.data.ctx = null; old.leave(room.code); old.emit('replaced'); }
    }
    if (socket.data.ctx && socket.data.ctx.code !== room.code) socket.leave(socket.data.ctx.code);
    p.socketId = socket.id;
    p.connected = true;
    socket.data.ctx = { code: room.code, pid: p.id };
    socket.join(room.code);
    if (room.hostId === p.id) room.hostOfflineSince = null;
    room.lastActive = Date.now();
  }

  socket.on('room:create', (msg, ack) => {
    try {
      const { room, player } = store.create(msg && msg.name, msg && msg.mode, msg && msg.settings);
      seat(room, player);
      reply(ack, { ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcast(room);
    } catch (e) { fail(ack, e); }
  });

  socket.on('room:join', (msg, ack) => {
    try {
      const now = Date.now();
      socket.data.misses = socket.data.misses.filter((t) => now - t < 60000);
      if (socket.data.misses.length >= 10) throw userError('Too many wrong codes. Wait a minute and try again.');
      const room = store.get(msg && msg.code);
      if (!room) { socket.data.misses.push(now); throw userError('No table with that code. Check the four digits.'); }
      const name = cleanName(msg.name);
      // Same name as an offline seat: take that seat back (dead battery, borrowed phone).
      let p = room.players.find((x) => !x.left && !x.connected && x.name.toLowerCase() === name.toLowerCase());
      if (p) {
        p.token = require('./src/util').uid(16);
        room.log(`${p.name} is back.`);
      } else {
        p = room.addPlayer(name);
      }
      seat(room, p);
      reply(ack, { ok: true, code: room.code, playerId: p.id, token: p.token });
      broadcast(room);
    } catch (e) { fail(ack, e); }
  });

  socket.on('room:rejoin', (msg, ack) => {
    const room = store.get(msg && msg.code);
    if (!room) return reply(ack, { ok: false, reason: 'no_room', error: 'That table is no longer running.' });
    const p = room.players.find((x) => x.id === msg.playerId && x.token === msg.token && !x.left);
    if (!p) return reply(ack, { ok: false, reason: 'no_seat', error: 'Your seat at that table is gone.' });
    seat(room, p);
    reply(ack, { ok: true, code: room.code, playerId: p.id });
    broadcast(room);
  });

  socket.on('room:restore', (msg, ack) => {
    try {
      const room = store.restore(msg && msg.backup, msg && msg.playerId, msg && msg.token);
      seat(room, room.player(msg.playerId));
      reply(ack, { ok: true, code: room.code });
      broadcast(room);
    } catch (e) { fail(ack, e); }
  });

  socket.on('action', (msg, ack) => {
    const ctx = socket.data.ctx;
    const room = ctx && store.get(ctx.code);
    const me = room && room.player(ctx.pid);
    if (!room || !me || me.left) return reply(ack, { ok: false, reason: 'no_room', error: 'You are not at a table.' });
    try {
      dispatch(room, me, msg);
      reply(ack, { ok: true });
      broadcast(room);
      runEffects(room);
    } catch (e) { fail(ack, e); }
  });

  socket.on('sync', () => {
    const ctx = socket.data.ctx;
    const room = ctx && store.get(ctx.code);
    if (room) socket.emit('state', room.publicState());
  });

  socket.on('disconnect', () => {
    const ctx = socket.data.ctx;
    const room = ctx && store.get(ctx.code);
    const p = room && room.player(ctx.pid);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    if (room.hostId === p.id) room.hostOfflineSince = Date.now();
    room.lastActive = Date.now();
    broadcast(room);
  });
});

const sweeper = setInterval(() => store.sweep(), 10 * 60 * 1000);
sweeper.unref();

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const proto = USE_HTTPS ? 'https' : 'http';
    console.log(`Table Stakes is running on ${proto}://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  on your Wi-Fi: ${proto}://${ip}:${PORT}`);
    if (!USE_HTTPS && !process.env.RENDER) console.log('  Phones need HTTPS for the live camera scanner — run "npm run https" or deploy (see README).');
  });
  const stop = () => { io.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { app, server, io, store };
