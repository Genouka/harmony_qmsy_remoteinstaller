const db = require('../db/database');

class Device {
  static create({ ip, name = '' }) {
    const stmt = db.prepare(
      `INSERT INTO devices (ip, name, status, last_seen)
       VALUES (?, ?, 'online', datetime('now', 'localtime'))`
    );
    const result = stmt.run(ip, name);
    return this.findById(result.lastInsertRowid);
  }

  static findById(id) {
    return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  }

  static findByIp(ip) {
    return db.prepare('SELECT * FROM devices WHERE ip = ?').get(ip);
  }

  static findAll() {
    return db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
  }

  static findOnline() {
    return db.prepare("SELECT * FROM devices WHERE status = 'online' ORDER BY last_seen DESC").all();
  }

  static updateStatus(ip, status) {
    db.prepare(
      `UPDATE devices SET status = ?, last_seen = datetime('now', 'localtime') WHERE ip = ?`
    ).run(status, ip);
    return this.findByIp(ip);
  }

  static upsert({ ip, name, status = 'online' }) {
    const existing = this.findByIp(ip);
    if (existing) {
      db.prepare(
        `UPDATE devices SET status = ?, name = ?, last_seen = datetime('now', 'localtime') WHERE ip = ?`
      ).run(status, name || existing.name, ip);
      return this.findByIp(ip);
    }
    return this.create({ ip, name });
  }

  static update(id, fields) {
    const allowed = ['name', 'status'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
    if (updates.length === 0) return this.findById(id);
    if (fields.status) {
      updates.push("last_seen = datetime('now', 'localtime')");
    }
    values.push(id);
    db.prepare(`UPDATE devices SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  static delete(id) {
    return db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  static setAllOffline() {
    db.prepare("UPDATE devices SET status = 'offline'").run();
  }
}

module.exports = Device;
