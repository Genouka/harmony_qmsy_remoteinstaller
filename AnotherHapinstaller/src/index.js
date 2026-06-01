const express = require('express');
const path = require('path');
const db = require('./db/database');
const hdc = require('./services/hdc');
const deviceManager = require('./services/device');
const qmsyAdapter = require('./services/qmsy-adapter');
const userRoutes = require('./routes/user');
const packageRoutes = require('./routes/package');
const deviceRoutes = require('./routes/device');

const app = express();
const PORT = process.env.PORT || 3000;
const QMSY_PORT = parseInt(process.env.QMSY_PORT || '59338', 10);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use('/api/users', userRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/devices', deviceRoutes);

app.get('/api/status', async (req, res) => {
  const hdcAvailable = await hdc.checkHdcAvailable();
  res.json({
    status: 'running',
    hdc_available: hdcAvailable,
    version: require('../package.json').version,
    uptime: process.uptime(),
    qmsy_adapter: {
      enabled: true,
      port: QMSY_PORT
    }
  });
});

app.use((err, req, res, _next) => {
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '文件大小超出限制（最大500MB）' });
    }
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  if (err.message && err.message.includes('仅支持')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[Error]', err);
  res.status(500).json({ error: '服务器内部错误' });
});

async function start() {
  console.log('='.repeat(50));
  console.log('  AnotherHapInstaller 启动中...');
  console.log('='.repeat(50));

  console.log('[DB] 数据库初始化完成');

  const hdcAvailable = await hdc.checkHdcAvailable();
  if (hdcAvailable) {
    console.log('[HDC] hdc 命令可用，启动设备自动扫描');
    deviceManager.startAutoScan();
  } else {
    console.log('[HDC] hdc 命令不可用，设备自动扫描已跳过');
    console.log('[HDC] 请确保 hdc 已加入 PATH，或设置 HDC_PATH 环境变量');
  }

  qmsyAdapter.start();
  console.log(`[QmsyAdapter] QMSY协议适配器已启用 (端口 ${QMSY_PORT})`);

  app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`  HTTP 服务:    http://localhost:${PORT}`);
    console.log(`  QMSY 适配器:  端口 ${QMSY_PORT}`);
    console.log(`  API 状态:     http://localhost:${PORT}/api/status`);
    console.log('='.repeat(50));
    console.log('');
    console.log('API 路由:');
    console.log('  用户管理:     /api/users');
    console.log('  安装包管理:   /api/packages');
    console.log('  设备管理:     /api/devices');
    console.log('');
    console.log('QMSY协议:');
    console.log('  原生二进制:   端口 59338');
    console.log('  WebSocket:   ws://localhost:59338');
    console.log('');
    console.log('CLI模式 (兼容QmsyServer):');
    console.log('  node src/cli.js --username <uid> --password <pwd>');
    console.log('    --access-token <aid> --user-id <urid>');
    console.log('    --hap-id <hid> -IP <ip:port>');
    console.log('');
    console.log('默认管理员: admin / admin123');
    console.log('='.repeat(50));
  });
}

process.on('SIGINT', () => {
  console.log('\n[Shutdown] 正在关闭服务...');
  qmsyAdapter.stop();
  deviceManager.stopAutoScan();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  qmsyAdapter.stop();
  deviceManager.stopAutoScan();
  db.close();
  process.exit(0);
});

start();
