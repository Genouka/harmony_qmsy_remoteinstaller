# QMSY 秋冥散雨远程安装服务套件

> 一套用于远程HarmonyOS应用安装的客户端-服务端通信协议及多平台实现

## 项目简介

QMSY（秋冥散雨）是一套完整的远程应用安装的通信解决方案，支持通过TCP/WebSocket协议在Windows、Linux、Android和HarmonyOS平台之间建立安全的端口转发通道，实现远程HAP（HarmonyOS Ability Package）应用的安装部署。

## 项目结构

```
QMSY/
├── QmsyClient/                          # 客户端实现
│   ├── QmsyClient-FirefoxExtension/    # Firefox浏览器扩展
│   ├── QmsyClient-linux/               # Linux桌面客户端
│   ├── QmsyClient-windows/               # Windows桌面客户端
│   ├── RemoteLinker-android-genouka/     # Android客户端
│   └── RemoteLinker-hmos-genouka/        # HarmonyOS客户端
├── QmsyServer/                           # 服务端实现
│   ├── linux/                            # Linux服务端
│   └── windows/                          # Windows服务端
└── protocol_v5.md                    # QMSY协议规范v5.0.0
```

### PDU类型概览

| 类型 | 名称 | 描述 |
|:---:|:---:|:---|
| `REQ` | Pa1 | 连接请求 (Connection Request) |
| `NEQ` | Pa2 | 连接通知 (Connection Notification) |
| `PST` | Pa3 | 端口分配 (Port Assignment) |
| `RST` | Pa4 | 连接重置 (Connection Reset) |
| `HET` | Pa5 | 心跳保活 (Heartbeat) |
| `QEU` | Pa6 | 队列更新 (Queue Update) |

## 部署

### 服务端部署 (Windows)

```bash
cd QmsyServer/windows
set PENDING_MAX=2        # 最大并发连接数 (默认2, 范围1-100)
QmsyServer.exe
```

### 服务端部署 (Linux)

```bash
cd QmsyServer/linux
export PENDING_MAX=2
./qmsy-server
```


### 端口分配

```
外部转发端口池: [53000, 54000]  ← 客户端连接的目标端口
内部转发端口池: [55000, 56000]  ← hapinstaller监听端口
服务管理端口:   59338           ← QMSY协议控制通道
```

## 连接生命周期

```
[IDLE] → [CONNECTING] → [AUTHENTICATING] → [QUEUING] → [ESTABLISHED] → [FORWARDING] → [CLOSED]
            ↓                ↓                ↓            ↓              ↓
        TCP连接          发送Pa1          接收Pa6      接收Pa3        双向转发
                                          (如需要)     端口分配
```

## 技术文档

- [QMSY Protocol Specification v5.0.0](./protocol_v5.md) - 完整协议规范
- [Android Client API](./QmsyClient/RemoteLinker-android-genouka/) - Java客户端实现
- [HarmonyOS Client API](./QmsyClient/RemoteLinker-hmos-genouka/) - ArkTS客户端实现

## 许可证

Copyright (c) 2026-present, 秋冥散雨_GenOuka. All Rights Reserved.

请参见： [许可证/LICENSE](LICENSE)

---

<p align="center">
  <sub>Built with ❤️ by 秋冥散雨_GenOuka</sub>
</p>
