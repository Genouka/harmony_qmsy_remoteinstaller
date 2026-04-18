(function() {
    'use strict';

    // 请求ID生成器
    let requestIdCounter = 0;
    const pendingRequests = new Map();
    const messageCallbacks = new Map();
    const disconnectCallbacks = new Map();

    // 监听来自content script的响应
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data.type) return;

        const data = event.data;

        // 处理连接响应
        if (data.type === 'QMSY_CONNECT_RESPONSE') {
            const request = pendingRequests.get(data.requestId);
            if (request) {
                pendingRequests.delete(data.requestId);
                if (data.success) {
                    // 存储回调
                    if (request.onMessage) {
                        messageCallbacks.set(data.connectionId, request.onMessage);
                    }
                    if (request.onDisconnected) {
                        disconnectCallbacks.set(data.connectionId, request.onDisconnected);
                    }
                    request.resolve({
                        connectionId: data.connectionId,
                        port: data.port,
                        disconnect: () => QmsyClient.disconnect(data.connectionId)
                    });
                } else {
                    request.reject(new Error(data.error || 'Connection failed'));
                }
            }
        }

        // 处理断开响应
        if (data.type === 'QMSY_DISCONNECT_RESPONSE') {
            const request = pendingRequests.get(data.requestId);
            if (request) {
                pendingRequests.delete(data.requestId);
                messageCallbacks.delete(data.connectionId);
                disconnectCallbacks.delete(data.connectionId);
                request.resolve(data.success);
            }
        }

        // 处理状态响应
        if (data.type === 'QMSY_STATUS_RESPONSE') {
            const request = pendingRequests.get(data.requestId);
            if (request) {
                pendingRequests.delete(data.requestId);
                request.resolve(data);
            }
        }

        // 处理列表响应
        if (data.type === 'QMSY_LIST_RESPONSE') {
            const request = pendingRequests.get(data.requestId);
            if (request) {
                pendingRequests.delete(data.requestId);
                request.resolve(data.connections || []);
            }
        }

        // 处理服务器消息
        if (data.type === 'QMSY_MESSAGE') {
            const callback = messageCallbacks.get(data.connectionId);
            if (callback) {
                callback(data.message);
            }
        }

        // 处理断开通知
        if (data.type === 'QMSY_DISCONNECTED') {
            const callback = disconnectCallbacks.get(data.connectionId);
            if (callback) {
                callback();
            }
            messageCallbacks.delete(data.connectionId);
            disconnectCallbacks.delete(data.connectionId);
        }
    });

    // 发送请求并等待响应
    function sendRequest(type, payload, callbacks = {}) {
        return new Promise((resolve, reject) => {
            const requestId = ++requestIdCounter;
            pendingRequests.set(requestId, { 
                resolve, 
                reject, 
                ...callbacks 
            });

            window.postMessage({
                type: type,
                requestId: requestId,
                ...payload
            }, '*');

            // 超时处理
            setTimeout(() => {
                if (pendingRequests.has(requestId)) {
                    pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 30000);
        });
    }

    // 解析地址字符串 (支持 ip:port 格式)
    function parseAddress(input, defaultPort) {
        if (!input) return { ip: '127.0.0.1', port: defaultPort };
        
        // IPv6 [addr]:port 格式
        if (input.startsWith('[')) {
            const bracketEnd = input.indexOf(']');
            if (bracketEnd > 0) {
                const ip = input.substring(1, bracketEnd);
                let port = defaultPort;
                if (bracketEnd + 1 < input.length && input[bracketEnd + 1] === ':') {
                    const portStr = input.substring(bracketEnd + 2);
                    const parsedPort = parseInt(portStr);
                    if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
                        port = parsedPort;
                    }
                }
                return { ip, port };
            }
        }

        // IPv4 addr:port 格式 或 IPv6
        const lastColon = input.lastIndexOf(':');
        const firstColon = input.indexOf(':');

        // 多个冒号，可能是IPv6
        if (firstColon !== lastColon) {
            // 检查末尾是否有端口
            if (lastColon > firstColon) {
                const afterLastColon = input.substring(lastColon + 1);
                const parsedPort = parseInt(afterLastColon);
                if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
                    return { 
                        ip: input.substring(0, lastColon), 
                        port: parsedPort 
                    };
                }
            }
            return { ip: input, port: defaultPort };
        }

        // 单个冒号，IPv4:port
        if (lastColon > 0) {
            const ip = input.substring(0, lastColon);
            const portStr = input.substring(lastColon + 1);
            const port = parseInt(portStr);
            if (!isNaN(port) && port > 0 && port <= 65535) {
                return { ip, port };
            }
            return { ip: input, port: defaultPort };
        }

        return { ip: input, port: defaultPort };
    }

    // QmsyClient 主类
    const QmsyClient = {
        // 版本号
        version: '1.0.0',

        /**
         * 连接到服务器
         * @param {Object} config - 连接配置
         * @param {string} config.server - 服务器地址 (ip:port 或 仅ip使用默认59338)
         * @param {string} config.uid - 用户ID
         * @param {string} config.pwd - 密码
         * @param {string} config.aid - AID
         * @param {string} config.urid - URID
         * @param {string} config.hid - HID
         * @param {string} config.forward - 转发目标地址 (ip:port 或 仅ip使用默认1080)
         * @param {Function} config.onMessage - 消息回调函数 (可选)
         * @param {Function} config.onDisconnected - 断开回调函数 (可选)
         * @returns {Promise<Object>} - 返回连接对象 { connectionId, port, disconnect() }
         */
        connect: async function(config) {
            if (!config) {
                throw new Error('Config is required');
            }

            const serverAddr = parseAddress(config.server, 59338);
            const forwardAddr = parseAddress(config.forward, 1080);

            const fullConfig = {
                serverIp: serverAddr.ip,
                serverPort: serverAddr.port,
                uid: config.uid || '',
                pwd: config.pwd || '',
                aid: config.aid || '',
                urid: config.urid || '',
                hid: config.hid || '',
                forwardIp: forwardAddr.ip,
                forwardPort: forwardAddr.port
            };

            return sendRequest('QMSY_CONNECT_REQUEST', {
                config: fullConfig
            }, {
                onMessage: config.onMessage,
                onDisconnected: config.onDisconnected
            });
        },

        /**
         * 断开连接
         * @param {string} connectionId - 连接ID
         * @returns {Promise<boolean>} - 是否成功断开
         */
        disconnect: async function(connectionId) {
            if (!connectionId) {
                throw new Error('ConnectionId is required');
            }

            return sendRequest('QMSY_DISCONNECT_REQUEST', {
                connectionId: connectionId
            });
        },

        /**
         * 获取连接状态
         * @param {string} connectionId - 连接ID
         * @returns {Promise<Object>} - 状态信息 { connected, port, config }
         */
        status: async function(connectionId) {
            if (!connectionId) {
                throw new Error('ConnectionId is required');
            }

            return sendRequest('QMSY_STATUS_REQUEST', {
                connectionId: connectionId
            });
        },

        /**
         * 获取所有活动连接列表
         * @returns {Promise<Array>} - 连接列表
         */
        listConnections: async function() {
            return sendRequest('QMSY_LIST_REQUEST', {});
        },

        /**
         * 快速连接 (简化版)
         * @param {string} server - 服务器地址
         * @param {string} uid - 用户ID
         * @param {string} pwd - 密码
         * @param {string} forward - 转发目标
         * @param {Object} options - 其他选项 (aid, urid, hid, callbacks)
         * @returns {Promise<Object>} - 连接对象
         */
        quickConnect: async function(server, uid, pwd, forward, options = {}) {
            return this.connect({
                server: server,
                uid: uid,
                pwd: pwd,
                forward: forward,
                aid: options.aid || '',
                urid: options.urid || '',
                hid: options.hid || '',
                onMessage: options.onMessage,
                onDisconnected: options.onDisconnected
            });
        }
    };

    // 暴露到全局
    window.QmsyClient = QmsyClient;

    // 触发就绪事件
    window.dispatchEvent(new CustomEvent('QmsyClientReady', { detail: QmsyClient }));

    console.log('[QmsyClient] API已加载，版本:', QmsyClient.version);
})();