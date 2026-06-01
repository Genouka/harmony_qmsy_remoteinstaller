const net = require('net');
const crypto = require('crypto');
const qmsy = require('./qmsy-protocol');
const installer = require('./installer');
const Device = require('../models/device');

const QMSY_PORT = parseInt(process.env.QMSY_PORT || '59338', 10);
const HEARTBEAT_INTERVAL = 30000;

function sha1Hash(input) {
  return crypto.createHash('sha1').update(input).digest();
}

function base64Encode(buf) {
  return buf.toString('base64');
}

function generateWebSocketAccept(key) {
  const magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const hash = sha1Hash(key + magic);
  return base64Encode(hash);
}

function parseHttpHeaders(request) {
  const headers = {};
  const lines = request.split('\r\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break;
    const pos = line.indexOf(':');
    if (pos !== -1) {
      const key = line.substring(0, pos).trim();
      const value = line.substring(pos + 1).trim();
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

function buildWebSocketFrame(data, opcode = 0x01, mask = false) {
  const frame = [];
  frame.push(0x80 | (opcode & 0x0F));

  const len = data.length;
  if (len < 126) {
    frame.push(mask ? (0x80 | len) : len);
  } else if (len <= 0xFFFF) {
    frame.push(mask ? (0x80 | 126) : 126);
    frame.push((len >> 8) & 0xFF);
    frame.push(len & 0xFF);
  } else {
    frame.push(mask ? (0x80 | 127) : 127);
    for (let i = 7; i >= 0; --i) {
      frame.push((len >> (i * 8)) & 0xFF);
    }
  }

  if (mask) {
    frame.push(0, 0, 0, 0);
  }

  return Buffer.concat([Buffer.from(frame), Buffer.from(data)]);
}

function parseWebSocketFrame(buf) {
  if (buf.length < 2) return null;

  const opcode = buf[0] & 0x0F;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7F;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = (buf[2] << 8) | buf[3];
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = 0;
    for (let i = 0; i < 8; i++) {
      payloadLen = (payloadLen << 8) | buf[offset + i];
    }
    offset = 10;
  }

  let maskingKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskingKey = buf.slice(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + payloadLen) return null;

  let payload = buf.slice(offset, offset + payloadLen);
  if (masked && maskingKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskingKey[i % 4];
    }
  }

  return { opcode, payload, totalLength: offset + payloadLen };
}

function sendWebSocketBinary(socket, data) {
  const frame = buildWebSocketFrame(data, 0x02, false);
  socket.write(frame);
}

function sendWebSocketText(socket, text) {
  const frame = buildWebSocketFrame(Buffer.from(text), 0x01, false);
  socket.write(frame);
}

function sendWebSocketClose(socket, code = 1000, reason = '') {
  const payload = Buffer.alloc(2 + Buffer.from(reason).length);
  payload.writeInt16BE(code, 0);
  Buffer.from(reason).copy(payload, 2);
  const frame = buildWebSocketFrame(payload, 0x08, false);
  socket.write(frame);
}

function sendWebSocketPong(socket, pingData) {
  const frame = buildWebSocketFrame(pingData, 0x0A, false);
  socket.write(frame);
}

class QmsyServerAdapter {
  constructor() {
    this.server = null;
    this.connections = new Map();
    this.activeConnections = 0;
    this.maxPending = parseInt(process.env.PENDING_MAX || '2', 10);
    this.pendingQueue = [];
    this.running = false;
  }

  start() {
    this.server = net.createServer((socket) => this.handleConnection(socket));

    this.server.listen(QMSY_PORT, () => {
      console.log(`[QmsyAdapter] QMSY协议适配器已启动，监听端口 ${QMSY_PORT}`);
      console.log(`[QmsyAdapter] 支持协议: 原生二进制协议 / WebSocket (RFC6455)`);
      console.log(`[QmsyAdapter] 最大并发数: ${this.maxPending}`);
    });

    this.running = true;
  }

  stop() {
    this.running = false;
    if (this.server) {
      this.server.close();
    }
  }

  handleConnection(socket) {
    const clientIp = socket.remoteAddress;
    const clientPort = socket.remotePort;
    const connId = `${clientIp}:${clientPort}:${Date.now()}`;

    console.log(`[QmsyAdapter] 客户端连接: ${clientIp}:${clientPort}`);

    let isWebSocket = false;
    let handshakeComplete = false;
    let buffer = Buffer.alloc(0);
    let heartbeatTimer = null;

    const cleanup = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      this.connections.delete(connId);
      try { socket.destroy(); } catch {}
    };

    socket.on('data', async (data) => {
      buffer = Buffer.concat([buffer, data]);

      if (!handshakeComplete) {
        const peekStr = buffer.toString('utf8', 0, Math.min(buffer.length, 1024));
        if (peekStr.includes('GET /') && peekStr.includes('Upgrade:') && peekStr.includes('websocket')) {
          isWebSocket = true;
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;

          const requestStr = buffer.slice(0, headerEnd).toString();
          const headers = parseHttpHeaders(requestStr);
          const wsKey = headers['sec-websocket-key'];

          if (!wsKey) {
            socket.destroy();
            return;
          }

          const acceptKey = generateWebSocketAccept(wsKey);
          const response = [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptKey}`,
            '',
            ''
          ].join('\r\n');

          socket.write(response);
          handshakeComplete = true;
          buffer = buffer.slice(headerEnd + 4);
          console.log(`[QmsyAdapter] WebSocket 握手完成: ${clientIp}:${clientPort}`);
          return;
        }

        if (!isWebSocket && buffer.length >= 7) {
          handshakeComplete = true;
        }
      }

      if (isWebSocket && handshakeComplete) {
        while (buffer.length > 0) {
          const frame = parseWebSocketFrame(buffer);
          if (!frame) break;

          buffer = buffer.slice(frame.totalLength);

          if (frame.opcode === 0x08) {
            sendWebSocketClose(socket);
            cleanup();
            return;
          }

          if (frame.opcode === 0x09) {
            sendWebSocketPong(socket, frame.payload);
            continue;
          }

          if (frame.opcode === 0x01 || frame.opcode === 0x02) {
            await this.processQmsyPacket(socket, frame.payload, isWebSocket, connId, cleanup);
          }
        }
      } else if (!isWebSocket && handshakeComplete) {
        if (buffer.length >= qmsy.PA1_HEADER_SIZE) {
          const packetType = qmsy.detectPacketType(buffer);
          if (packetType === 'REQ') {
            const uidLength = buffer.readInt32LE(7);
            const pwdLength = buffer.readInt32LE(11);
            const aidLength = buffer.readInt32LE(15);
            const uridLength = buffer.readInt32LE(19);
            const hidLength = buffer.readInt32LE(23);

            const totalSize = qmsy.PA1_HEADER_SIZE + uidLength + pwdLength + aidLength + uridLength + hidLength;
            if (buffer.length >= totalSize) {
              const pa1Data = buffer.slice(0, totalSize);
              buffer = buffer.slice(totalSize);

              await this.processQmsyPacket(socket, pa1Data, false, connId, cleanup);
            }
          } else if (packetType === 'HET') {
            buffer = buffer.slice(qmsy.PA5_SIZE);
          } else {
            buffer = Buffer.alloc(0);
          }
        }
      }
    });

    socket.on('close', () => {
      console.log(`[QmsyAdapter] 客户端断开: ${clientIp}:${clientPort}`);
      cleanup();
    });

    socket.on('error', (err) => {
      console.error(`[QmsyAdapter] 连接错误: ${err.message}`);
      cleanup();
    });
  }

  async processQmsyPacket(socket, data, isWebSocket, connId, cleanup) {
    try {
      const pa1 = qmsy.decodePa1(data);

      console.log(`[QmsyAdapter] 收到安装请求: uid=${pa1.uid}, hid=${pa1.hid}`);

      this.connections.set(connId, { socket, isWebSocket, pa1, startTime: Date.now() });

      const sendPa3 = isWebSocket
        ? () => sendWebSocketBinary(socket, qmsy.encodePa3(0, 0))
        : () => socket.write(qmsy.encodePa3(0, 0));

      sendPa3();

      this.activeConnections++;
      try {
        const result = await installer.executeFromQmsyProtocol(socket, pa1, isWebSocket);

        const sendPa4 = isWebSocket
          ? () => sendWebSocketBinary(socket, qmsy.encodePa4())
          : () => socket.write(qmsy.encodePa4());

        sendPa4();

        if (isWebSocket) {
          sendWebSocketClose(socket);
        }
      } finally {
        this.activeConnections--;
      }
    } catch (err) {
      console.error(`[QmsyAdapter] 处理请求异常: ${err.message}`);

      const sendPa2 = isWebSocket
        ? () => sendWebSocketBinary(socket, qmsy.encodePa2(-99, err.message))
        : () => socket.write(qmsy.encodePa2(-99, err.message));

      try { sendPa2(); } catch {}

      const sendPa4 = isWebSocket
        ? () => sendWebSocketBinary(socket, qmsy.encodePa4())
        : () => socket.write(qmsy.encodePa4());

      try { sendPa4(); } catch {}
    }

    cleanup();
  }
}

module.exports = new QmsyServerAdapter();
