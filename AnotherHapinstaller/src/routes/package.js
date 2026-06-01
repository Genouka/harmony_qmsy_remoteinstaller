const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Package = require('../models/package');
const InstallLog = require('../models/install-log');
const Device = require('../models/device');
const hdc = require('../services/hdc');
const { authMiddleware } = require('../middleware/auth');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.hap', '.app', '.hap.gz'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.originalname.endsWith('.hap.gz')) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .hap / .app 格式的安装包'));
    }
  },
  limits: { fileSize: 500 * 1024 * 1024 }
});

router.get('/', authMiddleware, (req, res) => {
  const packages = Package.findAll();
  res.json({ packages });
});

router.get('/:id', authMiddleware, (req, res) => {
  const pkg = Package.findById(req.params.id);
  if (!pkg) {
    return res.status(404).json({ error: '安装包不存在' });
  }
  res.json({ package: pkg });
});

router.get('/hap-id/:hap_id', authMiddleware, (req, res) => {
  const pkg = Package.findByHapId(req.params.hap_id);
  if (!pkg) {
    return res.status(404).json({ error: '安装包不存在' });
  }
  res.json({ package: pkg });
});

router.post('/', authMiddleware, upload.single('file'), (req, res) => {
  const { hap_id, name, description, version } = req.body;
  if (!hap_id || !name) {
    return res.status(400).json({ error: 'hap_id 和 name 不能为空' });
  }

  const existing = Package.findByHapId(hap_id);
  if (existing) {
    return res.status(409).json({ error: 'hap_id 已存在' });
  }

  const filePath = req.file ? req.file.path : '';
  try {
    const pkg = Package.create({
      hap_id,
      name,
      description: description || '',
      file_path: filePath,
      version: version || '1.0.0',
      created_by: req.user.id
    });
    res.status(201).json({ message: '安装包创建成功', package: pkg });
  } catch (err) {
    res.status(500).json({ error: '创建安装包失败', detail: err.message });
  }
});

router.put('/:id', authMiddleware, upload.single('file'), (req, res) => {
  const pkg = Package.findById(req.params.id);
  if (!pkg) {
    return res.status(404).json({ error: '安装包不存在' });
  }

  const { name, description, version } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (version !== undefined) updates.version = version;
  if (req.file) updates.file_path = req.file.path;

  const updated = Package.update(req.params.id, updates);
  res.json({ message: '安装包已更新', package: updated });
});

router.delete('/:id', authMiddleware, (req, res) => {
  const pkg = Package.findById(req.params.id);
  if (!pkg) {
    return res.status(404).json({ error: '安装包不存在' });
  }

  if (pkg.file_path && fs.existsSync(pkg.file_path)) {
    fs.unlinkSync(pkg.file_path);
  }

  Package.delete(req.params.id);
  res.json({ message: '安装包已删除' });
});

router.post('/:id/install', authMiddleware, async (req, res) => {
  const pkg = Package.findById(req.params.id);
  if (!pkg) {
    return res.status(404).json({ error: '安装包不存在' });
  }

  if (!pkg.file_path || !fs.existsSync(pkg.file_path)) {
    return res.status(400).json({ error: '安装包文件不存在，请先上传文件' });
  }

  const { device_id, ip } = req.body;
  let targetIp = '';
  let deviceRecord = null;

  if (device_id) {
    deviceRecord = Device.findById(device_id);
    if (!deviceRecord) {
      return res.status(404).json({ error: '设备不存在' });
    }
    targetIp = deviceRecord.ip;
  } else if (ip) {
    targetIp = ip;
    deviceRecord = Device.findByIp(ip);
  }

  const log = InstallLog.create({
    package_id: pkg.id,
    device_id: deviceRecord ? deviceRecord.id : 0,
    operator_id: req.user.id,
    status: 'installing',
    message: `正在安装到 ${targetIp || '所有设备'}`
  });

  try {
    const result = await hdc.installHap(pkg.file_path, targetIp);
    InstallLog.updateStatus(log.id, result.success ? 'success' : 'failed', result.message);
    res.json({
      message: result.message,
      success: result.success,
      output: result.output,
      log: InstallLog.findById(log.id)
    });
  } catch (err) {
    InstallLog.updateStatus(log.id, 'failed', err.message);
    res.status(500).json({ error: '安装失败', detail: err.message, log: InstallLog.findById(log.id) });
  }
});

router.post('/:id/uninstall', authMiddleware, async (req, res) => {
  const pkg = Package.findById(req.params.id);
  if (!pkg) {
    return res.status(404).json({ error: '安装包不存在' });
  }

  const { device_id, ip } = req.body;
  let targetIp = '';
  let deviceRecord = null;

  if (device_id) {
    deviceRecord = Device.findById(device_id);
    if (!deviceRecord) {
      return res.status(404).json({ error: '设备不存在' });
    }
    targetIp = deviceRecord.ip;
  } else if (ip) {
    targetIp = ip;
    deviceRecord = Device.findByIp(ip);
  }

  try {
    const result = await hdc.uninstallHap(pkg.hap_id, targetIp);
    res.json({
      message: result.message,
      success: result.success,
      output: result.output
    });
  } catch (err) {
    res.status(500).json({ error: '卸载失败', detail: err.message });
  }
});

router.get('/:id/logs', authMiddleware, (req, res) => {
  const logs = InstallLog.findByPackage(req.params.id);
  res.json({ logs });
});

module.exports = router;
