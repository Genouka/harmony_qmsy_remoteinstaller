package com.genouka.remotelinker.utils;

import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

public class QmsyClient {

    // ============ 协议常量 ============
    private static final String MAGIC = "QMSY";
    private static final String TYPE_REQ = "REQ";
    private static final String TYPE_NEQ = "NEQ";
    private static final String TYPE_PST = "PST";
    private static final String TYPE_RST = "RST";

    private static final int DEFAULT_SERVER_PORT = 59338;
    private static final int DEFAULT_FORWARD_PORT = 1080;

    // ============ 连接配置 ============
    private final String serverIp;
    private final int serverPort;
    private final String uid;
    private final String pwd;
    private final String aid;
    private final String urid;
    private final String hid;
    private final String forwardIp;
    private final int forwardPort;

    // ============ 连接状态 ============
    private Socket serviceSocket;
    private Socket forwardSocket;
    private Socket targetSocket;
    private volatile int allocatedPort = 0;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private Thread serviceThread;
    private Thread forwardThread1;
    private Thread forwardThread2;

    // ============ 回调接口 ============
    public interface MessageCallback {
        void onMessage(String message);

        void onError(String error);

        void onConnected(int port);

        void onDisconnected();
    }

    private MessageCallback callback;

    // ============ 构造函数 ============

    /**
     * 完整参数构造函数
     */
    public QmsyClient(String serverIp, int serverPort,
                      String uid, String pwd, String aid, String urid, String hid,
                      String forwardIp, int forwardPort) {
        this.serverIp = serverIp;
        this.serverPort = serverPort;
        this.uid = uid;
        this.pwd = pwd;
        this.aid = aid;
        this.urid = urid;
        this.hid = hid;
        this.forwardIp = forwardIp;
        this.forwardPort = forwardPort;
    }

    /**
     * 简化构造函数 (使用默认端口)
     */
    public QmsyClient(String serverIp, String uid, String pwd,
                      String aid, String urid, String hid, String forwardIp) {
        this(parseIp(serverIp, DEFAULT_SERVER_PORT),
                parsePort(serverIp, DEFAULT_SERVER_PORT),
                uid, pwd, aid, urid, hid,
                parseIp(forwardIp, DEFAULT_FORWARD_PORT),
                parsePort(forwardIp, DEFAULT_FORWARD_PORT));
    }

    private static String parseIp(String input, int defaultPort) {
        if (input == null || input.isEmpty()) return "127.0.0.1";

        // IPv6 [addr]:port 格式
        if (input.startsWith("[")) {
            int bracketEnd = input.indexOf(']');
            if (bracketEnd > 0) {
                return input.substring(1, bracketEnd);
            }
        }

        // IPv4 addr:port 格式
        int lastColon = input.lastIndexOf(':');
        int firstColon = input.indexOf(':');

        // 检查是否是IPv6地址(多个冒号)
        if (firstColon != lastColon) {
            // 多个冒号，可能是IPv6，也可能带端口
            if (lastColon > firstColon) {
                String afterLastColon = input.substring(lastColon + 1);
                try {
                    int port = Integer.parseInt(afterLastColon);
                    if (port > 0 && port <= 65535) {
                        return input.substring(0, lastColon);
                    }
                } catch (NumberFormatException e) {
                    // 不是端口，整个是IPv6地址
                }
            }
            return input; // 纯IPv6地址
        }

        if (lastColon > 0) {
            return input.substring(0, lastColon);
        }
        return input;
    }

    private static int parsePort(String input, int defaultPort) {
        if (input == null || input.isEmpty()) return defaultPort;

        // IPv6 [addr]:port 格式
        if (input.startsWith("[")) {
            int bracketEnd = input.indexOf(']');
            if (bracketEnd > 0 && bracketEnd + 1 < input.length() && input.charAt(bracketEnd + 1) == ':') {
                try {
                    return Integer.parseInt(input.substring(bracketEnd + 2));
                } catch (NumberFormatException e) {
                    return defaultPort;
                }
            }
            return defaultPort;
        }

        // 检查是否是IPv6地址(多个冒号)
        int lastColon = input.lastIndexOf(':');
        int firstColon = input.indexOf(':');

        if (firstColon != lastColon) {
            // IPv6地址，检查末尾是否有端口
            if (lastColon > firstColon) {
                String afterLastColon = input.substring(lastColon + 1);
                try {
                    int port = Integer.parseInt(afterLastColon);
                    if (port > 0 && port <= 65535) {
                        return port;
                    }
                } catch (NumberFormatException e) {
                    // 不是端口
                }
            }
            return defaultPort;
        }

        if (lastColon > 0) {
            try {
                int port = Integer.parseInt(input.substring(lastColon + 1));
                if (port > 0 && port <= 65535) return port;
            } catch (NumberFormatException e) {
                // 解析失败，使用默认端口
            }
        }
        return defaultPort;
    }

    /**
     * 设置消息回调
     */
    public void setCallback(MessageCallback callback) {
        this.callback = callback;
    }

    /**
     * 连接到服务器并开始转发
     */
    public boolean connect() {
        if (running.get()) {
            System.err.println("Already connected");
            return false;
        }

        try {
            // 1. 连接服务端口
            if(callback!=null) callback.onMessage("[Client]Connecting to server " + serverIp + ":" + serverPort + "...");
            serviceSocket = new Socket();
            serviceSocket.connect(new InetSocketAddress(serverIp, serverPort), 10000);
            serviceSocket.setTcpNoDelay(true);

            // 2. 发送Pa1认证包
            if (!sendPa1()) {
                if(callback!=null) callback.onMessage("[Client]Failed to send request");
                closeAll();
                return false;
            }

            if(callback!=null) callback.onMessage("[Client]Request sent, waiting for port allocation...");

            // 3. 接收Pa3端口分配包
            if (!receivePa3()) {
                if(callback!=null) callback.onError("[Client][ERROR]Port allocation failed");
                closeAll();
                return false;
            }

            if(callback!=null) callback.onMessage("[Client]Allocated port: " + allocatedPort);
            if (callback != null) callback.onConnected(allocatedPort);

            // 4. 连接转发端口
            if(callback!=null) callback.onMessage("[Client]Connecting to forward port " + allocatedPort + "...");
            forwardSocket = new Socket();
            forwardSocket.connect(new InetSocketAddress(serverIp, allocatedPort), 10000);
            forwardSocket.setTcpNoDelay(true);

            if(callback!=null) callback.onMessage("[Client]Connected! Forwarding to " + forwardIp + ":" + forwardPort);

            // 5. 连接目标服务器
            if(callback!=null) callback.onMessage("[Client]Connecting to target " + forwardIp + ":" + forwardPort + "...");
            targetSocket = new Socket();
            targetSocket.connect(new InetSocketAddress(forwardIp, forwardPort), 10000);
            targetSocket.setTcpNoDelay(true);

            if(callback!=null) callback.onMessage("[Client]Target connected! Starting data forwarding...");

            // 6. 启动转发线程
            running.set(true);
            startServiceThread();
            startForwardThreads();

            return true;

        } catch (IOException e) {
            System.err.println("Connection failed: " + e.getMessage());
            if (callback != null) callback.onError("[Client][ERROR]onnection failed: " + e.getMessage());
            closeAll();
            return false;
        }
    }

    /**
     * 断开连接
     */
    public void disconnect() {
        if (!running.get()) return;

        running.set(false);

        // 发送断开请求
        try {
            sendPa4();
        } catch (IOException e) {
            // 忽略发送错误
        }

        closeAll();

        // 等待线程结束
        try {
            if (serviceThread != null) serviceThread.join(5000);
            if (forwardThread1 != null) forwardThread1.join(5000);
            if (forwardThread2 != null) forwardThread2.join(5000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        if (callback != null) callback.onDisconnected();
        System.out.println("Disconnected");
    }

    /**
     * 检查是否正在运行
     */
    public boolean isRunning() {
        return running.get();
    }

    /**
     * 获取分配的端口
     */
    public int getAllocatedPort() {
        return allocatedPort;
    }

    // ============ 协议实现 ============

    /**
     * 发送Pa1认证包
     */
    private boolean sendPa1() throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(baos);

        // Magic (4 bytes)
        dos.writeBytes(MAGIC);
        // Type (3 bytes)
        dos.writeBytes(TYPE_REQ);

        // 长度字段 (小端序)
        dos.writeInt(Integer.reverseBytes(uid.length()));
        dos.writeInt(Integer.reverseBytes(pwd.length()));
        dos.writeInt(Integer.reverseBytes(aid.length()));
        dos.writeInt(Integer.reverseBytes(urid.length()));
        dos.writeInt(Integer.reverseBytes(hid.length()));

        // 字符串数据
        if (!uid.isEmpty()) dos.writeBytes(uid);
        if (!pwd.isEmpty()) dos.writeBytes(pwd);
        if (!aid.isEmpty()) dos.writeBytes(aid);
        if (!urid.isEmpty()) dos.writeBytes(urid);
        if (!hid.isEmpty()) dos.writeBytes(hid);

        dos.flush();
        byte[] data = baos.toByteArray();

        return sendAll(serviceSocket, data);
    }

    /**
     * 发送Pa4断开包
     */
    private boolean sendPa4() throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(baos);

        dos.writeBytes(MAGIC);
        dos.writeBytes(TYPE_RST);
        dos.flush();

        return sendAll(serviceSocket, baos.toByteArray());
    }

    /**
     * 接收Pa3端口分配包
     */
    private boolean receivePa3() throws IOException {
        InputStream in = serviceSocket.getInputStream();
        byte[] header = new byte[7]; // magic(4) + type(3)

        // 读取头部
        if (!readFully(in, header)) return false;

        String magic = new String(header, 0, 4, StandardCharsets.US_ASCII);
        String type = new String(header, 4, 3, StandardCharsets.US_ASCII);

        if (!MAGIC.equals(magic) || !TYPE_PST.equals(type)) {
            System.err.println("Invalid response packet: " + magic + "/" + type);
            return false;
        }

        // 读取剩余数据 (status + port)
        byte[] body = new byte[8]; // status(4) + port(4)
        if (!readFully(in, body)) return false;

        ByteBuffer buffer = ByteBuffer.wrap(body).order(ByteOrder.LITTLE_ENDIAN);
        int status = buffer.getInt();
        allocatedPort = buffer.getInt();

        if (status != 0 || allocatedPort == 0) {
            System.err.println("Port allocation failed, status: " + status);
            return false;
        }

        return true;
    }

    /**
     * 接收数据包头
     */
    private boolean recvHeader(InputStream in, String[] outMagic, String[] outType) throws IOException {
        byte[] header = new byte[7];
        if (!readFully(in, header)) return false;

        outMagic[0] = new String(header, 0, 4, StandardCharsets.US_ASCII);
        outType[0] = new String(header, 4, 3, StandardCharsets.US_ASCII);
        return true;
    }

    /**
     * 读取定长字符串
     */
    private String readString(InputStream in, int length) throws IOException {
        if (length <= 0) return "";
        byte[] data = new byte[length];
        if (!readFully(in, data)) return null;
        //return new String(data, StandardCharsets.UTF_8);
        return new String(data, Charset.forName("GBK"));
    }

    /**
     * 完整读取指定字节数
     */
    private boolean readFully(InputStream in, byte[] buffer) throws IOException {
        int totalRead = 0;
        while (totalRead < buffer.length) {
            int read = in.read(buffer, totalRead, buffer.length - totalRead);
            if (read < 0) return false;
            totalRead += read;
        }
        return true;
    }

    /**
     * 发送所有数据
     */
    private boolean sendAll(Socket socket, byte[] data) throws IOException {
        OutputStream out = socket.getOutputStream();
        out.write(data);
        out.flush();
        return true;
    }

    // ============ 线程管理 ============

    /**
     * 启动服务线程 (处理Pa2消息和Pa4断开)
     */
    private void startServiceThread() {
        serviceThread = new Thread(() -> {
            try {
                InputStream in = serviceSocket.getInputStream();

                while (running.get()) {
                    String[] magic = new String[1];
                    String[] type = new String[1];

                    if (!recvHeader(in, magic, type)) {
                        if (running.get()) {
                            if (callback != null)
                                callback.onError("[ERROR] Failed to receive packet header");
                        }
                        break;
                    }

                    if (!MAGIC.equals(magic[0])) {
                        if (callback != null) callback.onError("[ERROR] Invalid MAGIC packet received");
                        continue;
                    }

                    if (TYPE_NEQ.equals(type[0])) {
                        // 处理Pa2消息包
                        if (!handlePa2(in)) {
                            if (callback != null) callback.onError("[ERROR] Invalid PA2 packet received");
                            running.set(false);
                            break;
                        }
                    }
                    if (TYPE_RST.equals(type[0])) {
                        if (callback != null)
                            callback.onMessage("[ClientCtl] Server requested disconnect");
                        running.set(false);
                        break;
                    }
                }
            } catch (IOException e) {
                if (running.get()) {
                    if (callback != null)
                        callback.onError("[ERROR] Service thread error: " + e.getMessage());
                }
            }

            // 连接异常，自动断开
            running.set(false);
            closeAll();
            if (callback != null) callback.onDisconnected();
        }, "ServiceThread");

        serviceThread.setDaemon(true);
        serviceThread.start();
    }

    /**
     * 处理Pa2消息包
     */
    private boolean handlePa2(InputStream in) throws IOException {
        // 读取Pa2剩余头部 (已读取7字节，还需读取status+msgLength)
        byte[] body = new byte[8]; // status(4) + msgLength(4)
        if (!readFully(in, body)) return false;

        ByteBuffer buffer = ByteBuffer.wrap(body).order(ByteOrder.LITTLE_ENDIAN);
        int status = buffer.getInt();
        int msgLength = buffer.getInt();

        String msg = readString(in, msgLength);
        if (msg == null) return false;
        if (callback != null) callback.onMessage(msg);

        return true;
    }

    /**
     * 启动数据转发线程
     */
    private void startForwardThreads() {
        // forwardSocket <-> targetSocket 双向转发
        forwardThread1 = new Thread(() -> {
            try {
                forwardData(forwardSocket, targetSocket);
            } catch (IOException e) {
                if (running.get()) {
                    callback.onError("[ERROR] Forward thread 1 error: " + e.getMessage());
                }
            }
            callback.onMessage("[Forward] Forward thread 1 end");
            //running.set(false);
        }, "ForwardThread-1");

        forwardThread2 = new Thread(() -> {
            try {
                forwardData(targetSocket, forwardSocket);
            } catch (IOException e) {
                if (running.get()) {
                    callback.onError("[ERROR] Forward thread 2 error: " + e.getMessage());
                }
            }
            callback.onMessage("[Forward] Forward thread 2 end");
            //running.set(false);
        }, "ForwardThread-2");

        forwardThread1.setDaemon(true);
        forwardThread2.setDaemon(true);
        forwardThread1.start();
        forwardThread2.start();
    }

    /**
     * 数据转发
     */
    private void forwardData(Socket from, Socket to) throws IOException {
        InputStream in = from.getInputStream();
        OutputStream out = to.getOutputStream();

        byte[] buffer = new byte[4096];
        while (running.get()) {
            int available = in.available();
            int toRead = Math.min(available > 0 ? available : buffer.length, buffer.length);

            int read = in.read(buffer, 0, toRead);
            if (read < 0) break;
            if (read == 0) {
                try {
                    Thread.sleep(1);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
                continue;
            }

            out.write(buffer, 0, read);
            out.flush();
        }
    }

    /**
     * 关闭所有连接
     */
    private void closeAll() {
        closeQuietly(targetSocket);
        closeQuietly(forwardSocket);
        closeQuietly(serviceSocket);
        targetSocket = null;
        forwardSocket = null;
        serviceSocket = null;
    }

    private void closeQuietly(Socket socket) {
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException e) {
                // 忽略
            }
        }
    }

    // ============ 主方法 (示例用法) ============

    public static void main(String[] args) {
        if (args.length < 7) {
            System.err.println("Usage: java QmsyClient <server_ip>[:port] <uid> <pwd> <aid> <urid> <hid> <forward_ip>[:port]");
            System.exit(1);
        }

        String serverInput = args[0];
        String uid = args[1];
        String pwd = args[2];
        String aid = args[3];
        String urid = args[4];
        String hid = args[5];
        String forwardInput = args[6];

        // 解析服务器地址
        String serverIp = parseIp(serverInput, DEFAULT_SERVER_PORT);
        int serverPort = parsePort(serverInput, DEFAULT_SERVER_PORT);

        // 解析转发目标地址
        String forwardIp = parseIp(forwardInput, DEFAULT_FORWARD_PORT);
        int forwardPort = parsePort(forwardInput, DEFAULT_FORWARD_PORT);

        // 创建客户端
        QmsyClient client = new QmsyClient(serverIp, serverPort, uid, pwd, aid, urid, hid, forwardIp, forwardPort);

        // 设置回调
        client.setCallback(new MessageCallback() {
            @Override
            public void onMessage(String message) {
                System.out.println("[Callback] Message: " + message);
            }

            @Override
            public void onError(String error) {
                System.err.println("[Callback] Error: " + error);
            }

            @Override
            public void onConnected(int port) {
                System.out.println("[Callback] Connected on port: " + port);
            }

            @Override
            public void onDisconnected() {
                System.out.println("[Callback] Disconnected");
            }
        });

        // 连接
        if (!client.connect()) {
            System.exit(1);
        }

        // 等待用户输入断开
        System.out.println("Press Enter to disconnect...");
        try {
            System.in.read();
        } catch (IOException e) {
            e.printStackTrace();
        }

        // 断开连接
        client.disconnect();
    }
}