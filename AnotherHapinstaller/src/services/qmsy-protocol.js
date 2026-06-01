const MAGIC = Buffer.from('QMSY');

const PACKET_TYPES = {
  REQ: Buffer.from('REQ'),
  NEQ: Buffer.from('NEQ'),
  PST: Buffer.from('PST'),
  RST: Buffer.from('RST'),
  HET: Buffer.from('HET'),
  QEU: Buffer.from('QEU')
};

function encodePa1({ uid, pwd, aid, urid, hid }) {
  const uidBuf = Buffer.from(uid || '');
  const pwdBuf = Buffer.from(pwd || '');
  const aidBuf = Buffer.from(aid || '');
  const uridBuf = Buffer.from(urid || '');
  const hidBuf = Buffer.from(hid || '');

  const headerSize = 4 + 3 + 4 * 5;
  const totalSize = headerSize + uidBuf.length + pwdBuf.length + aidBuf.length + uridBuf.length + hidBuf.length;
  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  MAGIC.copy(buf, offset); offset += 4;
  PACKET_TYPES.REQ.copy(buf, offset); offset += 3;
  buf.writeInt32LE(uidBuf.length, offset); offset += 4;
  buf.writeInt32LE(pwdBuf.length, offset); offset += 4;
  buf.writeInt32LE(aidBuf.length, offset); offset += 4;
  buf.writeInt32LE(uridBuf.length, offset); offset += 4;
  buf.writeInt32LE(hidBuf.length, offset); offset += 4;

  uidBuf.copy(buf, offset); offset += uidBuf.length;
  pwdBuf.copy(buf, offset); offset += pwdBuf.length;
  aidBuf.copy(buf, offset); offset += aidBuf.length;
  uridBuf.copy(buf, offset); offset += uridBuf.length;
  hidBuf.copy(buf, offset); offset += hidBuf.length;

  return buf;
}

function decodePa1(buf) {
  let offset = 0;

  const magic = buf.slice(offset, offset + 4).toString();
  offset += 4;
  if (magic !== 'QMSY') throw new Error(`Invalid magic: ${magic}`);

  const type = buf.slice(offset, offset + 3).toString();
  offset += 3;
  if (type !== 'REQ') throw new Error(`Invalid type: ${type}`);

  const uidLength = buf.readInt32LE(offset); offset += 4;
  const pwdLength = buf.readInt32LE(offset); offset += 4;
  const aidLength = buf.readInt32LE(offset); offset += 4;
  const uridLength = buf.readInt32LE(offset); offset += 4;
  const hidLength = buf.readInt32LE(offset); offset += 4;

  const uid = buf.slice(offset, offset + uidLength).toString(); offset += uidLength;
  const pwd = buf.slice(offset, offset + pwdLength).toString(); offset += pwdLength;
  const aid = buf.slice(offset, offset + aidLength).toString(); offset += aidLength;
  const urid = buf.slice(offset, offset + uridLength).toString(); offset += uridLength;
  const hid = buf.slice(offset, offset + hidLength).toString(); offset += hidLength;

  return { uid, pwd, aid, urid, hid };
}

function encodePa2(status, msg) {
  const msgBuf = Buffer.from(msg || '');
  const buf = Buffer.alloc(4 + 3 + 4 + 4 + msgBuf.length);
  let offset = 0;

  MAGIC.copy(buf, offset); offset += 4;
  PACKET_TYPES.NEQ.copy(buf, offset); offset += 3;
  buf.writeInt32LE(status, offset); offset += 4;
  buf.writeInt32LE(msgBuf.length, offset); offset += 4;
  msgBuf.copy(buf, offset);

  return buf;
}

function decodePa2(buf) {
  let offset = 4 + 3;
  const status = buf.readInt32LE(offset); offset += 4;
  const msgLength = buf.readInt32LE(offset); offset += 4;
  const msg = buf.slice(offset, offset + msgLength).toString();
  return { status, msg };
}

function encodePa3(status, port) {
  const buf = Buffer.alloc(4 + 3 + 4 + 4);
  let offset = 0;

  MAGIC.copy(buf, offset); offset += 4;
  PACKET_TYPES.PST.copy(buf, offset); offset += 3;
  buf.writeInt32LE(status, offset); offset += 4;
  buf.writeInt32LE(port, offset);

  return buf;
}

function decodePa3(buf) {
  let offset = 4 + 3;
  const status = buf.readInt32LE(offset); offset += 4;
  const port = buf.readInt32LE(offset);
  return { status, port };
}

function encodePa4() {
  const buf = Buffer.alloc(4 + 3);
  MAGIC.copy(buf, 0);
  PACKET_TYPES.RST.copy(buf, 4);
  return buf;
}

function encodePa5() {
  const buf = Buffer.alloc(4 + 3);
  MAGIC.copy(buf, 0);
  PACKET_TYPES.HET.copy(buf, 4);
  return buf;
}

function encodePa6(queuePosition) {
  const buf = Buffer.alloc(4 + 3 + 4);
  let offset = 0;
  MAGIC.copy(buf, offset); offset += 4;
  PACKET_TYPES.QEU.copy(buf, offset); offset += 3;
  buf.writeInt32LE(queuePosition, offset);
  return buf;
}

function decodePa6(buf) {
  const queuePosition = buf.readInt32LE(4 + 3);
  return { queuePosition };
}

function detectPacketType(buf) {
  if (buf.length < 7) return null;
  const magic = buf.slice(0, 4).toString();
  if (magic !== 'QMSY') return null;
  const type = buf.slice(4, 7).toString();
  return type;
}

const PA1_HEADER_SIZE = 4 + 3 + 4 * 5;
const PA2_HEADER_SIZE = 4 + 3 + 4 + 4;
const PA3_SIZE = 4 + 3 + 4 + 4;
const PA4_SIZE = 4 + 3;
const PA5_SIZE = 4 + 3;
const PA6_SIZE = 4 + 3 + 4;

module.exports = {
  encodePa1, decodePa1,
  encodePa2, decodePa2,
  encodePa3, decodePa3,
  encodePa4,
  encodePa5,
  encodePa6, decodePa6,
  detectPacketType,
  PA1_HEADER_SIZE,
  PA2_HEADER_SIZE,
  PA3_SIZE,
  PA4_SIZE,
  PA5_SIZE,
  PA6_SIZE,
  MAGIC,
  PACKET_TYPES
};
