const db = require('../db/database');

class InstallLog {
  static create({ package_id, device_id, operator_id, status = 'pending', message = '' }) {
    const stmt = db.prepare(
      `INSERT INTO install_logs (package_id, device_id, operator_id, status, message)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(package_id, device_id, operator_id, status, message);
    return this.findById(result.lastInsertRowid);
  }

  static findById(id) {
    return db.prepare(
      `SELECT il.*, p.hap_id, p.name as package_name, d.ip as device_ip, d.name as device_name, u.username as operator_name
       FROM install_logs il
       LEFT JOIN packages p ON il.package_id = p.id
       LEFT JOIN devices d ON il.device_id = d.id
       LEFT JOIN users u ON il.operator_id = u.id
       WHERE il.id = ?`
    ).get(id);
  }

  static findByPackage(packageId) {
    return db.prepare(
      `SELECT il.*, p.hap_id, p.name as package_name, d.ip as device_ip, d.name as device_name, u.username as operator_name
       FROM install_logs il
       LEFT JOIN packages p ON il.package_id = p.id
       LEFT JOIN devices d ON il.device_id = d.id
       LEFT JOIN users u ON il.operator_id = u.id
       WHERE il.package_id = ?
       ORDER BY il.created_at DESC`
    ).all(packageId);
  }

  static findByDevice(deviceId) {
    return db.prepare(
      `SELECT il.*, p.hap_id, p.name as package_name, d.ip as device_ip, d.name as device_name, u.username as operator_name
       FROM install_logs il
       LEFT JOIN packages p ON il.package_id = p.id
       LEFT JOIN devices d ON il.device_id = d.id
       LEFT JOIN users u ON il.operator_id = u.id
       WHERE il.device_id = ?
       ORDER BY il.created_at DESC`
    ).all(deviceId);
  }

  static findAll() {
    return db.prepare(
      `SELECT il.*, p.hap_id, p.name as package_name, d.ip as device_ip, d.name as device_name, u.username as operator_name
       FROM install_logs il
       LEFT JOIN packages p ON il.package_id = p.id
       LEFT JOIN devices d ON il.device_id = d.id
       LEFT JOIN users u ON il.operator_id = u.id
       ORDER BY il.created_at DESC`
    ).all();
  }

  static updateStatus(id, status, message = '') {
    db.prepare('UPDATE install_logs SET status = ?, message = ? WHERE id = ?').run(status, message, id);
    return this.findById(id);
  }
}

module.exports = InstallLog;
