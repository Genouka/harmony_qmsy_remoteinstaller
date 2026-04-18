const script = document.createElement('script');
script.src = chrome.runtime.getURL('qmsy-bridge.js');
script.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(script);

// 活跃连接管理 (用于页面刷新时自动断开)
const activeConnections = new Set();

// 页面卸载时断开所有连接
window.addEventListener('beforeunload', () => {
    for (const connId of activeConnections) {
        chrome.runtime.sendMessage({
            action: 'QMSY_DISCONNECT',
            connectionId: connId,
            reason: 'Page unloading'
        }).catch(() => {});
    }
    activeConnections.clear();
});

// 监听来自页面的消息
window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data.type || !event.data.type.startsWith('QMSY_')) return;

    const message = event.data;
    
    switch (message.type) {
        case 'QMSY_CONNECT_REQUEST':
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'QMSY_CONNECT',
                    config: message.config
                });
                
                // 记录成功连接的ID
                if (response.success && response.connectionId) {
                    activeConnections.add(response.connectionId);
                }
                
                window.postMessage({
                    type: 'QMSY_CONNECT_RESPONSE',
                    requestId: message.requestId,
                    ...response
                }, '*');
            } catch (error) {
                window.postMessage({
                    type: 'QMSY_CONNECT_RESPONSE',
                    requestId: message.requestId,
                    success: false,
                    error: error.message
                }, '*');
            }
            break;

        case 'QMSY_DISCONNECT_REQUEST':
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'QMSY_DISCONNECT',
                    connectionId: message.connectionId,
                    reason: message.reason || 'User request',
                    force: message.force || false
                });
                
                // 从活跃连接中移除
                activeConnections.delete(message.connectionId);
                
                window.postMessage({
                    type: 'QMSY_DISCONNECT_RESPONSE',
                    requestId: message.requestId,
                    ...response
                }, '*');
            } catch (error) {
                window.postMessage({
                    type: 'QMSY_DISCONNECT_RESPONSE',
                    requestId: message.requestId,
                    success: false,
                    error: error.message
                }, '*');
            }
            break;

        case 'QMSY_DISCONNECT_ALL_REQUEST':
            // 新增：断开所有连接请求
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'QMSY_DISCONNECT_ALL',
                    reason: message.reason || 'User disconnect all'
                });
                
                activeConnections.clear();
                
                window.postMessage({
                    type: 'QMSY_DISCONNECT_ALL_RESPONSE',
                    requestId: message.requestId,
                    ...response
                }, '*');
            } catch (error) {
                window.postMessage({
                    type: 'QMSY_DISCONNECT_ALL_RESPONSE',
                    requestId: message.requestId,
                    success: false,
                    error: error.message
                }, '*');
            }
            break;

        case 'QMSY_STATUS_REQUEST':
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'QMSY_STATUS',
                    connectionId: message.connectionId
                });
                
                window.postMessage({
                    type: 'QMSY_STATUS_RESPONSE',
                    requestId: message.requestId,
                    ...response
                }, '*');
            } catch (error) {
                window.postMessage({
                    type: 'QMSY_STATUS_RESPONSE',
                    requestId: message.requestId,
                    error: error.message
                }, '*');
            }
            break;

        case 'QMSY_LIST_REQUEST':
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'QMSY_LIST_CONNECTIONS'
                });
                
                // 同步活跃连接集合
                if (response.connections) {
                    const currentIds = new Set(response.connections.map(c => c.id));
                    for (const id of activeConnections) {
                        if (!currentIds.has(id)) {
                            activeConnections.delete(id);
                        }
                    }
                }
                
                window.postMessage({
                    type: 'QMSY_LIST_RESPONSE',
                    requestId: message.requestId,
                    ...response
                }, '*');
            } catch (error) {
                window.postMessage({
                    type: 'QMSY_LIST_RESPONSE',
                    requestId: message.requestId,
                    error: error.message
                }, '*');
            }
            break;
            
        case 'QMSY_FORCE_DISCONNECT':
            // 页面主动要求强制断开所有连接
            for (const connId of activeConnections) {
                chrome.runtime.sendMessage({
                    action: 'QMSY_DISCONNECT',
                    connectionId: connId,
                    reason: 'Force disconnect from page',
                    force: true
                }).catch(() => {});
            }
            activeConnections.clear();
            window.postMessage({
                type: 'QMSY_FORCE_DISCONNECT_RESPONSE',
                requestId: message.requestId,
                success: true
            }, '*');
            break;
    }
});

// 监听来自background的消息 (转发到页面)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'QMSY_MESSAGE') {
        window.postMessage(message, '*');
    } else if (message.type === 'QMSY_DISCONNECTED') {
        // 从活跃连接中移除断开的连接
        activeConnections.delete(message.connectionId);
        window.postMessage(message, '*');
    }
});