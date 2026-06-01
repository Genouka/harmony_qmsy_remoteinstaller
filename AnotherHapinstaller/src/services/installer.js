const net = require('net');
const User = require('../models/user');
const Package = require('../models/package');
const Device = require('../models/device');
const InstallLog = require('../models/install-log');
const hdc = require('./hdc');
const qmsy = require('./qmsy-protocol');

class InstallerService {
  async execute({ username, password, accessToken, userId, hapId, ip, port }) {
    console.log('[Installer] 开始执行安装任务');
    console.log(`[Installer]   用户: ${username}`);
    console.log(`[Installer]   HAP ID: ${hapId}`);
    console.log(`[Installer]   目标: ${ip}:${port}`);

    const authResult = this.authenticateUser(username, password);
    if (!authResult.success) {
      await this.reportStatus(ip, port, 'auth_failed', authResult.message);
      return { success: false, message: authResult.message, exitCode: 1 };
    }

    const user = authResult.user;

    if (accessToken && userId) {
      this.updateOAuthInfo(user.id, accessToken, userId);
    }

    const pkgResult = this.findPackage(hapId);
    if (!pkgResult.success) {
      await this.reportStatus(ip, port, 'package_not_found', pkgResult.message);
      return { success: false, message: pkgResult.message, exitCode: 2 };
    }

    const pkg = pkgResult.package;

    const deviceResult = this.resolveDevice(ip);
    if (!deviceResult.success) {
      await this.reportStatus(ip, port, 'device_not_found', deviceResult.message);
      return { success: false, message: deviceResult.message, exitCode: 3 };
    }

    const device = deviceResult.device;

    await this.reportStatus(ip, port, 'installing', `正在安装 ${pkg.name} 到 ${device.ip}`);

    const log = InstallLog.create({
      package_id: pkg.id,
      device_id: device.id,
      operator_id: user.id,
      status: 'installing',
      message: `正在安装到 ${device.ip}`
    });

    try {
      const installResult = await hdc.installHap(pkg.file_path, device.ip);

      if (installResult.success) {
        InstallLog.updateStatus(log.id, 'success', installResult.message);
        await this.reportStatus(ip, port, 'success', installResult.message);
        console.log(`[Installer] 安装成功: ${installResult.message}`);
        return { success: true, message: installResult.message, exitCode: 0 };
      } else {
        InstallLog.updateStatus(log.id, 'failed', installResult.message);
        await this.reportStatus(ip, port, 'failed', installResult.message);
        console.log(`[Installer] 安装失败: ${installResult.message}`);
        return { success: false, message: installResult.message, exitCode: 4 };
      }
    } catch (err) {
      InstallLog.updateStatus(log.id, 'failed', err.message);
      await this.reportStatus(ip, port, 'error', err.message);
      return { success: false, message: err.message, exitCode: 5 };
    }
  }

  authenticateUser(username, password) {
    if (!username || !password) {
      return { success: false, message: '用户名或密码为空' };
    }

    const user = User.findByUsername(username);
    if (!user) {
      return { success: false, message: `用户不存在: ${username}` };
    }

    if (!User.verifyPassword(user, password)) {
      return { success: false, message: '密码错误' };
    }

    return { success: true, user };
  }

  updateOAuthInfo(userId, accessToken, huaweiUserId) {
    try {
      User.update(userId, { access_token: accessToken, user_id: huaweiUserId });
      console.log(`[Installer] 已更新用户OAuth信息: access_token=${accessToken}, user_id=${huaweiUserId}`);
    } catch (err) {
      console.error(`[Installer] 更新OAuth信息失败: ${err.message}`);
    }
  }

  findPackage(hapId) {
    if (!hapId) {
      return { success: false, message: 'hap-id 为空' };
    }

    const pkg = Package.findByHapId(hapId);
    if (!pkg) {
      return { success: false, message: `未找到HAP包: ${hapId}` };
    }

    if (!pkg.file_path) {
      return { success: false, message: `HAP包未上传文件: ${hapId}` };
    }

    const fs = require('fs');
    if (!fs.existsSync(pkg.file_path)) {
      return { success: false, message: `HAP文件不存在: ${pkg.file_path}` };
    }

    return { success: true, package: pkg };
  }

  resolveDevice(ip) {
    if (!ip) {
      const onlineDevices = Device.findOnline();
      if (onlineDevices.length === 0) {
        return { success: false, message: '没有在线设备' };
      }
      return { success: true, device: onlineDevices[0] };
    }

    let device = Device.findByIp(ip);
    if (!device) {
      device = Device.create({ ip, name: ip });
    }

    return { success: true, device };
  }

  reportStatus(ip, port, status, message) {
    return new Promise((resolve) => {
      if (!ip || !port) {
        resolve();
        return;
      }

      const socket = new net.Socket();
      socket.setTimeout(5000);

      socket.on('connect', () => {
        console.log(`[Installer] 已连接到 ${ip}:${port}，发送状态: ${status}`);

        const statusMap = {
          'auth_failed': 10,
          'package_not_found': 20,
          'device_not_found': 30,
          'installing': 1,
          'success': 0,
          'failed': -1,
          'error': -2
        };

        const pa2 = qmsy.encodePa2(statusMap[status] || 0, message || status);
        socket.write(pa2);

        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 500);
      });

      socket.on('error', (err) => {
        console.log(`[Installer] 连接 ${ip}:${port} 失败: ${err.message}`);
        resolve();
      });

      socket.on('timeout', () => {
        console.log(`[Installer] 连接 ${ip}:${port} 超时`);
        socket.destroy();
        resolve();
      });

      socket.connect(port, ip);
    });
  }

  async executeFromQmsyProtocol(socket, { uid, pwd, aid, urid, hid }, isWebSocket = false) {
    console.log(`[Installer] 从QMSY协议接收安装请求`);
    console.log(`[Installer]   UID: ${uid}`);
    console.log(`[Installer]   AID: ${aid}`);
    console.log(`[Installer]   URID: ${urid}`);
    console.log(`[Installer]   HID: ${hid}`);

    const sendFn = isWebSocket
      ? (data) => this.sendWebSocketBinary(socket, data)
      : (data) => socket.write(data);

    const authResult = this.authenticateUser(uid, pwd);
    if (!authResult.success) {
      const pa2 = qmsy.encodePa2(-1, authResult.message);
      sendFn(pa2);
      return { success: false, message: authResult.message };
    }

    if (aid && urid) {
      this.updateOAuthInfo(authResult.user.id, aid, urid);
    }

    const pkgResult = this.findPackage(hid);
    if (!pkgResult.success) {
      const pa2 = qmsy.encodePa2(-2, pkgResult.message);
      sendFn(pa2);
      return { success: false, message: pkgResult.message };
    }

    const onlineDevices = Device.findOnline();
    if (onlineDevices.length === 0) {
      const pa2 = qmsy.encodePa2(-3, '没有在线设备');
      sendFn(pa2);
      return { success: false, message: '没有在线设备' };
    }

    const targetDevice = onlineDevices[0];

    const pa2progress = qmsy.encodePa2(1, `正在安装 ${pkgResult.package.name} 到 ${targetDevice.ip}`);
    sendFn(pa2progress);

    const log = InstallLog.create({
      package_id: pkgResult.package.id,
      device_id: targetDevice.id,
      operator_id: authResult.user.id,
      status: 'installing',
      message: `正在安装到 ${targetDevice.ip}`
    });

    try {
      const installResult = await hdc.installHap(pkgResult.package.file_path, targetDevice.ip);

      if (installResult.success) {
        InstallLog.updateStatus(log.id, 'success', installResult.message);
        const pa2ok = qmsy.encodePa2(0, installResult.message);
        sendFn(pa2ok);
      } else {
        InstallLog.updateStatus(log.id, 'failed', installResult.message);
        const pa2fail = qmsy.encodePa2(-4, installResult.message);
        sendFn(pa2fail);
      }

      return installResult;
    } catch (err) {
      InstallLog.updateStatus(log.id, 'failed', err.message);
      const pa2err = qmsy.encodePa2(-5, err.message);
      sendFn(pa2err);
      return { success: false, message: err.message };
    }
  }

  sendWebSocketBinary(ws, data) {
    if (ws.send && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

module.exports = new InstallerService();
