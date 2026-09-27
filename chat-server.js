// chat-server.js  --  single file, NO npm install needed (only Node's built-in modules).
// Upload this file to your host, set it as the startup file, and start it.
//
// Optional settings (set as environment variables in your host's panel, or edit below):
//   PORT      the port the host gives you (falls back to SERVER_PORT, then 3000)
//   ROOM_KEY  a shared password. If set, players must connect with ws://ADDRESS:PORT/?key=YOURKEY

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
const ROOM_KEY = process.env.ROOM_KEY || '';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const clients = new Set();

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Chat server is running.\n');
});

// ---- WebSocket framing (text messages only, which is all the overlay needs) ----
function frame(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcast(obj) {
  const data = frame(Buffer.from(JSON.stringify(obj)));
  for (const c of clients) {
    try { c.socket.write(data); } catch {}
  }
}

function drop(client) {
  if (!clients.delete(client)) return;
  if (client.name) broadcast({ type: 'system', text: `${client.name} left` });
}

function handle(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg.type === 'join') {
    client.name = String(msg.name || 'Player').slice(0, 24);
    broadcast({ type: 'system', text: `${client.name} joined` });
  } else if (msg.type === 'chat') {
    // basic flood control: max 5 messages per 3 seconds
    const now = Date.now();
    client.times = (client.times || []).filter((t) => now - t < 3000);
    if (client.times.length >= 5) return;
    client.times.push(now);

    const body = String(msg.text || '').trim().slice(0, 300);
    if (!body) return;
    broadcast({
      type: 'chat',
      name: String(msg.name || client.name || 'Player').slice(0, 24),
      color: /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : '#ffffff',
      text: body,
      ts: now,
    });
  }
}

function parse(client) {
  for (;;) {
    const b = client.buf;
    if (b.length < 2) return;

    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < 4) return;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return;
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }

    if (!masked || len > 16384) { client.socket.destroy(); return; }
    if (b.length < off + 4 + len) return; // wait for the rest of the frame

    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    client.buf = b.subarray(off + 4 + len);

    if (opcode === 0x8) { // close
      try { client.socket.end(frame(Buffer.alloc(0), 0x8)); } catch {}
      return;
    }
    if (opcode === 0x9) { // ping -> pong
      try { client.socket.write(frame(payload, 0xa)); } catch {}
      continue;
    }
    if (opcode === 0x1) handle(client, payload.toString('utf8'));
  }
}

server.on('upgrade', (req, socket) => {
  let key = '';
  try { key = new URL(req.url, 'http://x').searchParams.get('key') || ''; } catch {}

  if (ROOM_KEY && key !== ROOM_KEY) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const wsKey = req.headers['sec-websocket-key'];
  if (!wsKey) { socket.destroy(); return; }

  const accept = crypto.createHash('sha1').update(wsKey + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const client = { socket, name: null, buf: Buffer.alloc(0) };
  clients.add(client);

  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    if (client.buf.length > 65536) { socket.destroy(); return; }
    parse(client);
  });
  socket.on('close', () => drop(client));
  socket.on('error', () => drop(client));
});

// Keep connections alive through proxies/hosts that close idle sockets
setInterval(() => {
  const ping = frame(Buffer.alloc(0), 0x9);
  for (const c of clients) {
    try { c.socket.write(ping); } catch {}
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Chat server listening on port ${PORT}${ROOM_KEY ? ' (room key required)' : ''}`);
});
