const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const HDC_COMMAND = process.env.HDC_PATH || 'hdc';

function execHdc(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(HDC_COMMAND, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
        return;
      }
      resolve({
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || ''
      });
    });
  });
}

async function listDevices() {
  try {
    const { stdout } = await execHdc(['list', 'targets'], 10000);
    const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l !== '[Empty]');
    return lines.map(line => {
      const parts = line.split(':');
      return {
        ip: parts[0] || line,
        port: parts[1] || '5555',
        raw: line
      };
    });
  } catch (err) {
    return [];
  }
}

async function connectDevice(ip, port = '5555') {
  try {
    const target = `${ip}:${port}`;
    const { stdout } = await execHdc(['tconn', target], 10000);
    return { success: true, output: stdout, target };
  } catch (err) {
    return { success: false, error: err.error, output: err.stdout || err.stderr };
  }
}

async function disconnectDevice(ip, port = '5555') {
  try {
    const target = `${ip}:${port}`;
    const { stdout } = await execHdc(['tconn', target, 'remove'], 10000);
    return { success: true, output: stdout };
  } catch (err) {
    return { success: false, error: err.error, output: err.stdout || err.stderr };
  }
}

async function installHap(hapPath, target = '') {
  if (!fs.existsSync(hapPath)) {
    throw new Error(`HAP文件不存在: ${hapPath}`);
  }

  const args = target ? ['install', '-t', target, hapPath] : ['install', hapPath];
  try {
    const { stdout, stderr } = await execHdc(args, 120000);
    const output = stdout + stderr;
    const success = output.includes('AppMod finish') || output.includes('msg:install success') || output.includes('Success');
    return {
      success,
      output,
      message: success ? '安装成功' : '安装失败'
    };
  } catch (err) {
    return {
      success: false,
      output: err.stdout + (err.stderr || ''),
      message: `安装失败: ${err.error}`
    };
  }
}

async function uninstallHap(bundleName, target = '') {
  const args = target ? ['uninstall', '-t', target, bundleName] : ['uninstall', bundleName];
  try {
    const { stdout, stderr } = await execHdc(args, 60000);
    const output = stdout + stderr;
    const success = output.includes('Success') || output.includes('msg:uninstall success');
    return {
      success,
      output,
      message: success ? '卸载成功' : '卸载失败'
    };
  } catch (err) {
    return {
      success: false,
      output: err.stdout + (err.stderr || ''),
      message: `卸载失败: ${err.error}`
    };
  }
}

async function getDeviceInfo(target = '') {
  const args = target ? ['shell', 'param', 'get', 'const.ohos.serial', '-t', target] : ['shell', 'param', 'get', 'const.ohos.serial'];
  try {
    const { stdout } = await execHdc(args, 10000);
    return { success: true, info: stdout.trim() };
  } catch (err) {
    return { success: false, error: err.error };
  }
}

async function checkHdcAvailable() {
  try {
    await execHdc(['version'], 5000);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  execHdc,
  listDevices,
  connectDevice,
  disconnectDevice,
  installHap,
  uninstallHap,
  getDeviceInfo,
  checkHdcAvailable
};
