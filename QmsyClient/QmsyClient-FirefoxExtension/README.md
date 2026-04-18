# Qmsy Forwarder Chrome扩展

将Java版QmsyClient转换为Chrome扩展程序，实现TCP端口转发功能。

## 文件结构

```
qmsy-forwarder/
├── manifest.json      # 扩展配置
├── background.js      # Service Worker - 核心连接逻辑
├── content.js         # 内容脚本 - 页面通信桥接
├── qmsy-bridge.js     # 页面API - 暴露window.QmsyClient
├── popup.html         # 弹出窗口UI
```

## API参考

### QmsyClient.connect(config)

建立到服务器的连接。

**参数:**
- `config.server` - 服务器地址 (ip:port，默认端口59338)
- `config.uid` - 用户ID
- `config.pwd` - 密码
- `config.aid` - AID (可选)
- `config.urid` - URID (可选)
- `config.hid` - HID (可选)
- `config.forward` - 转发目标地址 (ip:port，默认端口1080)
- `config.onMessage` - 消息回调函数 (可选)
- `config.onDisconnected` - 断开回调函数 (可选)

**返回:** Promise<连接对象>
- `connectionId` - 连接唯一标识
- `port` - 服务器分配的转发端口
- `disconnect()` - 断开此连接的方法

### QmsyClient.disconnect(connectionId)

断开指定连接。

### QmsyClient.quickConnect(server, uid, pwd, forward, options)

简化版连接方法。

### QmsyClient.listConnections()

获取所有活动连接列表。

## 注意事项

1. **TCP连接限制**: Chrome扩展的Service Worker不支持原生TCP Socket，当前实现使用WebSocket或HTTP隧道方案。如需纯TCP支持，需要配合Native Messaging Host或外部代理程序。

2. **持久连接**: Manifest V3的Service Worker会休眠，长时间无活动可能导致连接中断。

3. **跨域限制**: 扩展需要 `host_permissions: ["<all_urls>"]` 以连接任意服务器。

## 协议兼容性

完全兼容QMSY协议。
