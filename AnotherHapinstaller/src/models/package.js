const db = require('../db/database');

class Package {
  static create({ hap_id, name, description = '', file_path = '', version = '1.0.0', created_by }) {
    const stmt = db.prepare(
      `INSERT INTO packages (hap_id, name, description, file_path, version, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(hap_id, name, description, file_path, version, created_by);
    return this.findById(result.lastInsertRowid);
  }

  static findById(id) {
    return db.prepare(
      `SELECT p.*, u.username as created_by_name
       FROM packages p
       LEFT JOIN users u ON p.created_by = u.id
       WHERE p.id = ?`
    ).get(id);
  }

  static findByHapId(hap_id) {
    return db.prepare(
      `SELECT p.*, u.username as created_by_name
       FROM packages p
       LEFT JOIN users u ON p.created_by = u.id
       WHERE p.hap_id = ?`
    ).get(hap_id);
  }

  static findAll() {
    return db.prepare(
      `SELECT p.*, u.username as created_by_name
       FROM packages p
       LEFT JOIN users u ON p.created_by = u.id
       ORDER BY p.created_at DESC`
    ).all();
  }

  static update(id, fields) {
    const allowed = ['name', 'description', 'file_path', 'version'];
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
    db.prepare(`UPDATE packages SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  static delete(id) {
    return db.prepare('DELETE FROM packages WHERE id = ?').run(id);
  }
}

module.exports = Package;
