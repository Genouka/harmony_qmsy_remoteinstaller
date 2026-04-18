class QmsyClient {
    constructor() {
        this.connections = new Map(); // tabId -> connection info
        this.socketCounter = 0;
        this.heartbeatInterval = 30000; // 30秒心跳
        this.heartbeatTimers = new Map(); // connId -> timer
        this.lastActivity = new Map(); // connId -> timestamp
        
        // 监听标签页关闭，自动断开连接
        chrome.tabs.onRemoved.addListener((tabId) => {
            this.disconnectByTabId(tabId);
        });
    }

    // 根据tabId断开所有连接
    disconnectByTabId(tabId) {
        for (const [connId, conn] of this.connections.entries()) {
            if (conn.tabId === tabId) {
                this.disconnect(connId, 'Tab closed');
            }
        }
    }

    // 生成唯一连接ID
    generateId() {
        return `conn_${Date.now()}_${++this.socketCounter}`;
    }

    // 创建新连接
    async connect(config, tabId) {
        const connId = this.generateId();
        const connection = {
            id: connId,
            tabId: tabId,
            config: config,
            serviceSocket: null,
            forwardSocket: null,
            targetSocket: null,
            allocatedPort: 0,
            running: false,
            readers: new Map()
        };

        this.connections.set(connId, connection);

        try {
            await this.establishConnection(connection);
            return { success: true, connectionId: connId, port: connection.allocatedPort };
        } catch (error) {
            this.connections.delete(connId);
            return { success: false, error: error.message };
        }
    }

    // 建立完整连接流程
    async establishConnection(conn) {
        const { serverIp, serverPort, uid, pwd, aid, urid, hid, forwardIp, forwardPort } = conn.config;

        // 1. 连接服务端口
        conn.serviceSocket = await this.createTcpConnection(serverIp, serverPort);
        
        // 2. 发送Pa1认证包
        await this.sendPa1(conn, uid, pwd, aid, urid, hid);

        // 3. 接收Pa3端口分配
        const pa3Result = await this.receivePa3(conn);
        if (!pa3Result.success) {
            throw new Error('Port allocation failed: ' + pa3Result.error);
        }
        conn.allocatedPort = pa3Result.port;

        // 4. 连接转发端口
        conn.forwardSocket = await this.createTcpConnection(serverIp, conn.allocatedPort);

        // 5. 连接目标服务器
        conn.targetSocket = await this.createTcpConnection(forwardIp, forwardPort);

        // 6. 启动数据转发
        conn.running = true;
        this.lastActivity.set(conn.id, Date.now());
        this.startForwarding(conn);
        this.startServiceHandler(conn);
        
        // 7. 启动心跳检测
        this.startHeartbeat(conn);
    }

        // 启动心跳检测
    startHeartbeat(conn) {
        // 定期发送心跳包
        const heartbeatTimer = setInterval(() => {
            if (!conn.running) {
                this.stopHeartbeat(conn.id);
                return;
            }

            // 检查空闲超时 (5分钟无活动自动断开)
            const lastActivity = this.lastActivity.get(conn.id) || 0;
            if (Date.now() - lastActivity > 5 * 60 * 1000) {
                console.log(`Connection ${conn.id} idle timeout`);
                this.disconnect(conn.id, 'Idle timeout');
                return;
            }

            // 发送Pa5心跳包 (假设协议支持)
            try {
                const encoder = new TextEncoder();
                const packet = new Uint8Array(7);
                packet.set(encoder.encode('QMSY'), 0);
                packet.set(encoder.encode('HBT'), 4); // 心跳类型
                conn.serviceSocket.write(packet);
            } catch (e) {
                console.error('Heartbeat failed:', e);
                this.disconnect(conn.id, 'Heartbeat failed');
            }
        }, this.heartbeatInterval);

        this.heartbeatTimers.set(conn.id, heartbeatTimer);
    }

    // 停止心跳
    stopHeartbeat(connId) {
        const timer = this.heartbeatTimers.get(connId);
        if (timer) {
            clearInterval(timer);
            this.heartbeatTimers.delete(connId);
        }
        this.lastActivity.delete(connId);
    }

    // 更新活动时间
    updateActivity(connId) {
        this.lastActivity.set(connId, Date.now());
    }

    // 创建TCP连接 (使用chrome.sockets API或通过native messaging)
    async createTcpConnection(host, port) {
        // 方案1: 使用fetch作为TCP替代 (HTTP CONNECT隧道)
        // 方案2: 使用WebSocket到本地代理
        // 这里实现基于WebSocket的桥接方案
        
        return new Promise((resolve, reject) => {
            // 尝试直接连接 (如果是WebSocket服务器)
            const ws = new WebSocket(`ws://${host}:${port}`);
            
            ws.onopen = () => {
                resolve({
                    type: 'websocket',
                    socket: ws,
                    host,
                    port,
                    write: (data) => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(data);
                        }
                    },
                    close: () => ws.close()
                });
            };

            ws.onerror = () => {
                // WebSocket失败，使用fetch轮询方案
                //resolve(this.createHttpTunnel(host, port));
                reject(new Error('WebSocket connection failed'));
            };
        });
    }

    // HTTP隧道方案 (用于TCP over HTTP)
    createHttpTunnel(host, port) {
        const tunnelId = Math.random().toString(36).substr(2, 9);
        const buffer = [];
        let closed = false;

        const connection = {
            type: 'http',
            host,
            port,
            tunnelId,
            write: async (data) => {
                if (closed) return;
                try {
                    await fetch(`http://${host}:${port}/tunnel/${tunnelId}/send`, {
                        method: 'POST',
                        body: data,
                        headers: { 'Content-Type': 'application/octet-stream' }
                    });
                } catch (e) {
                    console.error('Tunnel write error:', e);
                }
            },
            close: () => { closed = true; }
        };

        // 启动接收轮询
        this.startTunnelPolling(connection, buffer);
        
        return connection;
    }

    async startTunnelPolling(conn, buffer) {
        while (!conn.closed) {
            try {
                const response = await fetch(`http://${conn.host}:${conn.port}/tunnel/${conn.tunnelId}/recv`, {
                    method: 'GET'
                });
                if (response.ok) {
                    const data = await response.arrayBuffer();
                    if (data.byteLength > 0) {
                        buffer.push(new Uint8Array(data));
                    }
                }
            } catch (e) {
                await new Promise(r => setTimeout(r, 100));
            }
        }
    }

    // 发送Pa1认证包
    async sendPa1(conn, uid, pwd, aid, urid, hid) {
        const MAGIC = 'QMSY';
        const TYPE_REQ = 'REQ';
        
        const encoder = new TextEncoder('UTF-16LE');
        const uidBytes = encoder.encode(uid);
        const pwdBytes = encoder.encode(pwd);
        const aidBytes = encoder.encode(aid);
        const uridBytes = encoder.encode(urid);
        const hidBytes = encoder.encode(hid);

        // 计算总长度
        const totalLength = 7 + 20 + uidBytes.length + pwdBytes.length + 
                           aidBytes.length + uridBytes.length + hidBytes.length;
        
        const packet = new Uint8Array(totalLength);
        let offset = 0;

        // Magic (4 bytes)
        packet.set(encoder.encode(MAGIC), offset);
        offset += 4;

        // Type (3 bytes)
        packet.set(encoder.encode(TYPE_REQ), offset);
        offset += 3;

        // 长度字段 (小端序, 4 bytes each)
        const writeInt32LE = (value) => {
            packet[offset++] = value & 0xFF;
            packet[offset++] = (value >> 8) & 0xFF;
            packet[offset++] = (value >> 16) & 0xFF;
            packet[offset++] = (value >> 24) & 0xFF;
        };

        writeInt32LE(uidBytes.length);
        writeInt32LE(pwdBytes.length);
        writeInt32LE(aidBytes.length);
        writeInt32LE(uridBytes.length);
        writeInt32LE(hidBytes.length);

        // 字符串数据
        packet.set(uidBytes, offset);
        offset += uidBytes.length;
        packet.set(pwdBytes, offset);
        offset += pwdBytes.length;
        packet.set(aidBytes, offset);
        offset += aidBytes.length;
        packet.set(uridBytes, offset);
        offset += uridBytes.length;
        packet.set(hidBytes, offset);

        // 发送
        if (conn.serviceSocket.type === 'websocket') {
            conn.serviceSocket.write(packet);
        } else {
            await conn.serviceSocket.write(packet);
        }
    }

    // 接收Pa3端口分配包
    async receivePa3(conn) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve({ success: false, error: 'Timeout waiting for Pa3' });
            }, 10000);

            const handler = (data) => {
                if (data.length < 15) return;
                
                const decoder = new TextDecoder('UTF-16LE');
                const magic = decoder.decode(data.slice(0, 4));
                const type = decoder.decode(data.slice(4, 7));

                if (magic !== 'QMSY' || type !== 'PST') return;

                clearTimeout(timeout);
                
                // 解析状态码和端口 (小端序)
                const view = new DataView(data.buffer);
                const status = view.getInt32(7, true);
                const port = view.getInt32(11, true);

                if (status !== 0 || port === 0) {
                    resolve({ success: false, error: `Status: ${status}` });
                } else {
                    resolve({ success: true, port: port });
                }
            };

            // 设置数据处理器
            if (conn.serviceSocket.type === 'websocket') {
                conn.serviceSocket.socket.onmessage = (event) => {
                    handler(new Uint8Array(event.data));
                };
            }
        });
    }

    // 启动数据转发
    startForwarding(conn) {
        // forwardSocket -> targetSocket
        const forward1 = async () => {
            while (conn.running) {
                try {
                    const data = await this.readSocket(conn.forwardSocket);
                    if (data) {
                        this.updateActivity(conn.id);
                        conn.targetSocket.write(data);
                    }
                } catch (e) {
                    console.error('Forward1 error:', e);
                    break;
                }
            }
        };

        // targetSocket -> forwardSocket
        const forward2 = async () => {
            while (conn.running) {
                try {
                    const data = await this.readSocket(conn.targetSocket);
                    if (data) {
                        this.updateActivity(conn.id);
                        conn.forwardSocket.write(data);
                    }
                } catch (e) {
                    console.error('Forward2 error:', e);
                    break;
                }
            }
        };

        Promise.all([forward1(), forward2()]).then(() => {
            this.disconnect(conn.id, 'Forward loop ended');
        }).catch((err) => {
            this.disconnect(conn.id, 'Forward error: ' + err.message);
        });
    }

    // 启动服务处理器 (处理Pa2消息)
    startServiceHandler(conn) {
        const handleService = async () => {
            while (conn.running) {
                try {
                    const data = await this.readSocket(conn.serviceSocket);
                    if (!data || data.length < 7) continue;

                    const decoder = new TextDecoder('UTF-16LE');
                    const magic = decoder.decode(data.slice(0, 4));
                    const type = decoder.decode(data.slice(4, 7));

                    if (magic !== 'QMSY') continue;

                    // 更新活动时间
                    this.updateActivity(conn.id);

                    if (type === 'NEQ') {
                        // Pa2消息包
                        const view = new DataView(data.buffer);
                        const status = view.getInt32(7, true);
                        const msgLength = view.getInt32(11, true);
                        
                        if (data.length >= 15 + msgLength) {
                            const msgBytes = data.slice(15, 15 + msgLength);
                            // GBK解码
                            const msg = new TextDecoder('gbk').decode(msgBytes);
                            
                            // 发送消息到content script
                            chrome.tabs.sendMessage(conn.tabId, {
                                type: 'QMSY_MESSAGE',
                                connectionId: conn.id,
                                message: msg
                            }).catch(() => {});
                        }
                    } else if (type === 'RST') {
                        // 服务器请求断开
                        this.disconnect(conn.id, 'Server requested disconnect');
                        break;
                    } else if (type === 'HBT') {
                        // 心跳响应，忽略
                        console.log(`Heartbeat ack received for ${conn.id}`);
                    }
                } catch (e) {
                    console.error('Service handler error:', e);
                    this.disconnect(conn.id, 'Service handler error: ' + e.message);
                    break;
                }
            }
        };

        handleService();
    }

    // 从socket读取数据
    async readSocket(socketInfo) {
        return new Promise((resolve) => {
            if (socketInfo.type === 'websocket') {
                const handler = (event) => {
                    socketInfo.socket.onmessage = null;
                    resolve(new Uint8Array(event.data));
                };
                socketInfo.socket.onmessage = handler;
                
                // 超时
                setTimeout(() => {
                    socketInfo.socket.onmessage = null;
                    resolve(null);
                }, 100);
            } else {
                // HTTP轮询模式
                setTimeout(() => resolve(null), 100);
            }
        });
    }

    // 断开连接
    disconnect(connectionId, reason = 'User request') {
        const conn = this.connections.get(connectionId);
        if (!conn) return { success: false, error: 'Connection not found' };

        // 防止重复断开
        if (!conn.running && conn.disconnected) {
            return { success: false, error: 'Already disconnected' };
        }

        console.log(`Disconnecting ${connectionId}, reason: ${reason}`);
        conn.running = false;
        conn.disconnected = true;

        // 停止心跳
        this.stopHeartbeat(connectionId);

        // 发送Pa4断开包 (仅当服务socket仍可用时)
        if (conn.serviceSocket && !conn.serviceSocket.closed) {
            try {
                const encoder = new TextEncoder();
                const packet = new Uint8Array(7);
                packet.set(encoder.encode('QMSY'), 0);
                packet.set(encoder.encode('RST'), 4);
                conn.serviceSocket.write(packet);
            } catch (e) {
                // 忽略发送错误
            }
        }

        // 关闭所有socket (增加延迟确保包发送)
        setTimeout(() => {
            try {
                if (conn.targetSocket) conn.targetSocket.close();
            } catch (e) {}
            try {
                if (conn.forwardSocket) conn.forwardSocket.close();
            } catch (e) {}
            try {
                if (conn.serviceSocket) conn.serviceSocket.close();
            } catch (e) {}
        }, 100);

        this.connections.delete(connectionId);

        // 通知页面 (增加错误处理)
        try {
            chrome.tabs.sendMessage(conn.tabId, {
                type: 'QMSY_DISCONNECTED',
                connectionId: connectionId,
                reason: reason
            }).catch(() => {
                // 标签页可能已关闭，忽略错误
            });
        } catch (e) {
            // 忽略通知错误
        }

        return { success: true, reason: reason };
    }

    // 断开所有连接
    disconnectAll(reason = 'Extension shutdown') {
        const promises = [];
        for (const connId of this.connections.keys()) {
            promises.push(this.disconnect(connId, reason));
        }
        return Promise.all(promises);
    }

    // 获取连接状态
    getStatus(connectionId) {
        const conn = this.connections.get(connectionId);
        if (!conn) return { connected: false };
        return {
            connected: conn.running,
            port: conn.allocatedPort,
            config: conn.config
        };
    }
}

// 初始化客户端
const qmsyClient = new QmsyClient();

// 处理来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    switch (request.action) {
        case 'QMSY_CONNECT':
            qmsyClient.connect(request.config, tabId).then(sendResponse);
            return true;

        case 'QMSY_DISCONNECT':
            // 支持强制断开选项
            const force = request.force || false;
            sendResponse(qmsyClient.disconnect(request.connectionId, request.reason || 'User request'));
            break;

        case 'QMSY_DISCONNECT_ALL':
            // 新增：断开所有连接
            qmsyClient.disconnectAll(request.reason).then(sendResponse);
            return true;

        case 'QMSY_STATUS':
            sendResponse(qmsyClient.getStatus(request.connectionId));
            break;

        case 'QMSY_LIST_CONNECTIONS':
            const conns = Array.from(qmsyClient.connections.values()).map(c => ({
                id: c.id,
                port: c.allocatedPort,
                running: c.running,
                server: `${c.config.serverIp}:${c.config.serverPort}`,
                idleTime: Date.now() - (qmsyClient.lastActivity.get(c.id) || Date.now())
            }));
            sendResponse({ connections: conns });
            break;
    }
});