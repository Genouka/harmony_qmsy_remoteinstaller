const Device = require('../models/device');
const hdc = require('./hdc');

const SCAN_INTERVAL = 15000;
let scanTimer = null;

async function scanDevices() {
  try {
    const devices = await hdc.listDevices();
    const onlineIps = new Set();

    for (const dev of devices) {
      onlineIps.add(dev.ip);
      Device.upsert({
        ip: dev.ip,
        name: dev.raw,
        status: 'online'
      });
    }

    const allDevices = Device.findAll();
    for (const dbDev of allDevices) {
      if (!onlineIps.has(dbDev.ip) && dbDev.status === 'online') {
        Device.updateStatus(dbDev.ip, 'offline');
      }
    }

    return devices;
  } catch (err) {
    return [];
  }
}

async function connectAndRegister(ip, port = '5555') {
  const result = await hdc.connectDevice(ip, port);
  if (result.success) {
    Device.upsert({
      ip,
      name: `${ip}:${port}`,
      status: 'online'
    });
  }
  return result;
}

async function disconnectAndRemove(ip) {
  const result = await hdc.disconnectDevice(ip);
  Device.updateStatus(ip, 'offline');
  return result;
}

function startAutoScan() {
  if (scanTimer) return;

  scanDevices();

  scanTimer = setInterval(() => {
    scanDevices();
  }, SCAN_INTERVAL);

  console.log(`[DeviceManager] 自动设备扫描已启动，间隔 ${SCAN_INTERVAL / 1000}s`);
}

function stopAutoScan() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
    console.log('[DeviceManager] 自动设备扫描已停止');
  }
}

module.exports = {
  scanDevices,
  connectAndRegister,
  disconnectAndRemove,
  startAutoScan,
  stopAutoScan
};
