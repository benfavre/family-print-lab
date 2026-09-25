'use strict';
// Minimal MQTT 3.1.1 client (QoS 0 only): enough to read Bambu Lab printer reports on the local network.
const {EventEmitter} = require('node:events');
const net = require('node:net');
const tls = require('node:tls');

const TYPE = {CONNECT:1, CONNACK:2, PUBLISH:3, SUBSCRIBE:8, SUBACK:9, PINGREQ:12, PINGRESP:13, DISCONNECT:14};

function encodeLength(n) {
  const bytes = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; bytes.push(b); } while (n > 0);
  return Buffer.from(bytes);
}
const str = (s) => { const b = Buffer.from(s, 'utf8'), len = Buffer.alloc(2); len.writeUInt16BE(b.length); return Buffer.concat([len, b]); };
const packet = (header, body) => Buffer.concat([Buffer.from([header]), encodeLength(body.length), body]);

const encode = {
  connect({clientId, username, password, keepalive = 30}) {
    const flags = 0x02 | (username ? 0x80 : 0) | (password ? 0x40 : 0);
    const ka = Buffer.alloc(2); ka.writeUInt16BE(keepalive);
    return packet(TYPE.CONNECT << 4, Buffer.concat([str('MQTT'), Buffer.from([4, flags]), ka, str(clientId), username ? str(username) : Buffer.alloc(0), password ? str(password) : Buffer.alloc(0)]));
  },
  connack(code = 0) { return packet(TYPE.CONNACK << 4, Buffer.from([0, code])); },
  subscribe(id, topic) { const pid = Buffer.alloc(2); pid.writeUInt16BE(id); return packet((TYPE.SUBSCRIBE << 4) | 2, Buffer.concat([pid, str(topic), Buffer.from([0])])); },
  suback(id) { const b = Buffer.alloc(3); b.writeUInt16BE(id); b[2] = 0; return packet(TYPE.SUBACK << 4, b); },
  publish(topic, payload) { return packet(TYPE.PUBLISH << 4, Buffer.concat([str(topic), Buffer.from(payload)])); },
  pingreq() { return Buffer.from([TYPE.PINGREQ << 4, 0]); },
  pingresp() { return Buffer.from([TYPE.PINGRESP << 4, 0]); },
  disconnect() { return Buffer.from([TYPE.DISCONNECT << 4, 0]); },
};

// Splits a byte stream into packets. Returns {packets, rest}.
function decode(buffer) {
  const packets = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    let length = 0, multiplier = 1, i = offset + 1, byte;
    do {
      if (i >= buffer.length) return {packets, rest:buffer.subarray(offset)};
      byte = buffer[i++]; length += (byte & 127) * multiplier; multiplier *= 128;
      if (multiplier > 128 ** 4) throw new Error('Malformed MQTT length.');
    } while (byte & 128);
    if (buffer.length < i + length) break;
    const header = buffer[offset], body = buffer.subarray(i, i + length), type = header >> 4;
    const p = {type};
    if (type === TYPE.CONNACK) p.code = body[1];
    if (type === TYPE.PUBLISH) {
      const qos = (header >> 1) & 3, topicLength = body.readUInt16BE(0);
      p.topic = body.subarray(2, 2 + topicLength).toString('utf8');
      p.payload = body.subarray(2 + topicLength + (qos ? 2 : 0));
    }
    if (type === TYPE.SUBSCRIBE || type === TYPE.SUBACK) p.id = body.readUInt16BE(0);
    if (type === TYPE.SUBSCRIBE) { const tl = body.readUInt16BE(2); p.topic = body.subarray(4, 4 + tl).toString('utf8'); }
    if (type === TYPE.CONNECT) {
      let o = 10; const read = () => { const l = body.readUInt16BE(o); const s = body.subarray(o + 2, o + 2 + l).toString('utf8'); o += 2 + l; return s; };
      const flags = body[7]; p.clientId = read(); if (flags & 0x80) p.username = read(); if (flags & 0x40) p.password = read();
    }
    packets.push(p);
    offset = i + length;
  }
  return {packets, rest:buffer.subarray(offset)};
}

// Emits: 'connect', 'message' (topic, Buffer), 'close', 'error'.
class MqttClient extends EventEmitter {
  constructor({host, port, useTls = true, tlsOptions = {}, clientId, username, password, keepalive = 30}) {
    super();
    Object.assign(this, {host, port, useTls, tlsOptions, clientId, username, password, keepalive});
    this.buffer = Buffer.alloc(0); this.nextId = 1; this.socket = null; this.connected = false;
  }

  connect() {
    const onOpen = () => this.socket.write(encode.connect(this));
    this.socket = this.useTls
      ? tls.connect({host:this.host, port:this.port, ...this.tlsOptions}, onOpen)
      : net.connect({host:this.host, port:this.port}, onOpen);
    this.socket.setTimeout((this.keepalive * 2 + 10) * 1000, () => this.socket.destroy(new Error('Printer stopped responding.')));
    this.socket.on('data', (chunk) => this.receive(chunk));
    this.socket.on('error', (error) => this.emit('error', error));
    this.socket.on('close', () => { clearInterval(this.ping); const was = this.connected; this.connected = false; this.emit('close', was); });
    return this;
  }

  receive(chunk) {
    let result;
    try { result = decode(Buffer.concat([this.buffer, chunk])); } catch (error) { this.socket.destroy(error); return; }
    this.buffer = result.rest;
    for (const p of result.packets) {
      if (p.type === TYPE.CONNACK) {
        if (p.code !== 0) { this.socket.destroy(new Error(p.code === 4 || p.code === 5 ? 'Printer rejected the access code.' : `Printer refused the connection (code ${p.code}).`)); return; }
        this.connected = true;
        this.ping = setInterval(() => this.socket.write(encode.pingreq()), this.keepalive * 500);
        this.emit('connect');
      }
      if (p.type === TYPE.PUBLISH) this.emit('message', p.topic, p.payload);
    }
  }

  subscribe(topic) { this.socket.write(encode.subscribe(this.nextId++, topic)); }
  publish(topic, payload) { this.socket.write(encode.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload))); }
  end() { clearInterval(this.ping); if (this.socket && !this.socket.destroyed) { if (this.connected) this.socket.write(encode.disconnect()); this.socket.end(); this.socket.destroy(); } }
}

module.exports = {MqttClient, encode, decode, TYPE};
