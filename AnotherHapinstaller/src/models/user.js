const db = require('../db/database');
const bcrypt = require('bcryptjs');

class User {
  static create({ username, password, access_token = '', user_id = '', role = 'user' }) {
    const hashedPassword = bcrypt.hashSync(password, 10);
    const stmt = db.prepare(
      `INSERT INTO users (username, password, access_token, user_id, role)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(username, hashedPassword, access_token, user_id, role);
    return this.findById(result.lastInsertRowid);
  }

  static findById(id) {
    return db.prepare('SELECT id, username, access_token, user_id, role, created_at, updated_at FROM users WHERE id = ?').get(id);
  }

  static findByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  static findAll() {
    return db.prepare('SELECT id, username, access_token, user_id, role, created_at, updated_at FROM users ORDER BY created_at DESC').all();
  }

  static update(id, fields) {
    const allowed = ['access_token', 'user_id', 'role'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
    if (updates.length === 0) return this.findById(id);
    updates.push("updated_at = datetime('now', 'localtime')");
    values.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  static updatePassword(id, newPassword) {
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    db.prepare("UPDATE users SET password = ?, updated_at = datetime('now', 'localtime') WHERE id = ?").run(hashedPassword, id);
    return this.findById(id);
  }

  static delete(id) {
    return db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  static verifyPassword(user, password) {
    return bcrypt.compareSync(password, user.password);
  }
}

module.exports = User;
