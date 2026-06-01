const express = require('express');
const router = express.Router();
const Device = require('../models/device');
const InstallLog = require('../models/install-log');
const hdc = require('../services/hdc');
const deviceManager = require('../services/device');
const { authMiddleware } = require('../middleware/auth');

router.get('/', authMiddleware, (req, res) => {
  const devices = Device.findAll();
  res.json({ devices });
});

router.get('/online', authMiddleware, (req, res) => {
  const devices = Device.findOnline();
  res.json({ devices });
});

router.get('/scan', authMiddleware, async (req, res) => {
  const devices = await deviceManager.scanDevices();
  const allDevices = Device.findAll();
  res.json({ message: '扫描完成', discovered: devices, all: allDevices });
});

router.get('/:id', authMiddleware, (req, res) => {
  const device = Device.findById(req.params.id);
  if (!device) {
    return res.status(404).json({ error: '设备不存在' });
  }
  res.json({ device });
});

router.post('/connect', authMiddleware, async (req, res) => {
  const { ip, port = '5555' } = req.body;
  if (!ip) {
    return res.status(400).json({ error: 'IP地址不能为空' });
  }

  const result = await deviceManager.connectAndRegister(ip, port);
  if (result.success) {
    const device = Device.findByIp(ip);
    res.json({ message: `已连接到 ${ip}:${port}`, device, output: result.output });
  } else {
    res.status(500).json({ error: `连接 ${ip}:${port} 失败`, output: result.output });
  }
});

router.post('/disconnect', authMiddleware, async (req, res) => {
  const { ip } = req.body;
  if (!ip) {
    return res.status(400).json({ error: 'IP地址不能为空' });
  }

  const result = await deviceManager.disconnectAndRemove(ip);
  res.json({ message: `已断开 ${ip}`, output: result.output });
});

router.delete('/:id', authMiddleware, (req, res) => {
  const device = Device.findById(req.params.id);
  if (!device) {
    return res.status(404).json({ error: '设备不存在' });
  }

  Device.delete(req.params.id);
  res.json({ message: '设备已移除' });
});

router.get('/:id/info', authMiddleware, async (req, res) => {
  const device = Device.findById(req.params.id);
  if (!device) {
    return res.status(404).json({ error: '设备不存在' });
  }

  const result = await hdc.getDeviceInfo(device.ip);
  if (result.success) {
    res.json({ device, info: result.info });
  } else {
    res.status(500).json({ error: '获取设备信息失败', detail: result.error });
  }
});

router.get('/:id/logs', authMiddleware, (req, res) => {
  const logs = InstallLog.findByDevice(req.params.id);
  res.json({ logs });
});

router.post('/install-by-ip', authMiddleware, async (req, res) => {
  const { ip, hap_path, port = '5555' } = req.body;
  if (!ip || !hap_path) {
    return res.status(400).json({ error: 'IP地址和HAP路径不能为空' });
  }

  await deviceManager.connectAndRegister(ip, port);

  try {
    const result = await hdc.installHap(hap_path, ip);
    res.json({
      message: result.message,
      success: result.success,
      output: result.output
    });
  } catch (err) {
    res.status(500).json({ error: '安装失败', detail: err.message });
  }
});

module.exports = router;
