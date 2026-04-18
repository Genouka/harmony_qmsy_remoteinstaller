package com.genouka.remotelinker.utils;
import android.util.Log;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketAddress;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * TCP端口转发器
 * 功能：连接到一个源地址，并将所有数据转发到目标地址（本地或远程）
 */
public class PortForwarder {
    private static final String TAG = "PortForwarder";
    private static final int BUFFER_SIZE = 4096;
    private static final int CONNECT_TIMEOUT_MS = 10000; // 10秒连接超时
    private static final int SELECT_TIMEOUT_MS = 1000;   // 1秒select超时

    private final ExecutorService executor;
    private final AtomicBoolean isRunning;
    private Socket sourceSocket;
    private Socket targetSocket;
    private ServerSocket serverSocket;
    private Thread forwardThread;

    public PortForwarder() {
        this.executor = Executors.newFixedThreadPool(2);
        this.isRunning = new AtomicBoolean(false);
    }

    /**
     * 地址解析类
     */
    public static class Address {
        public final String ip;
        public final int port;

        public Address(String ip, int port) {
            this.ip = ip;
            this.port = port;
        }

        @Override
        public String toString() {
            return ip + ":" + port;
        }
    }

    /**
     * 解析IP:端口字符串
     * @param addrStr 格式为 "ip:port" 的字符串
     * @return Address对象
     * @throws IllegalArgumentException 格式错误时抛出
     */
    public static Address parseAddress(String addrStr) throws IllegalArgumentException {
        int lastColon = addrStr.lastIndexOf(':');
        if (lastColon == -1) {
            throw new IllegalArgumentException("Invalid address format. Expected ip:port");
        }

        String ip = addrStr.substring(0, lastColon);
        String portStr = addrStr.substring(lastColon + 1);

        try {
            int port = Integer.parseInt(portStr);
            if (port <= 0 || port > 65535) {
                throw new IllegalArgumentException("Invalid port number: " + port);
            }
            return new Address(ip, port);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Invalid port number: " + portStr);
        }
    }

    /**
     * 检查是否为本地地址
     */
    private boolean isLocalAddress(String ip) {
        return ip.equals("127.0.0.1") ||
                ip.equals("0.0.0.0") ||
                ip.equals("localhost") ||
                ip.equals("::1") ||
                ip.equals("[::1]");
    }

    /**
     * 连接到指定地址（带超时）
     */
    private Socket connectTo(String ip, int port) throws IOException {
        Socket socket = new Socket();
        socket.setTcpNoDelay(true);
        socket.setKeepAlive(true);

        SocketAddress address = new InetSocketAddress(ip, port);

        try {
            socket.connect(address, CONNECT_TIMEOUT_MS);
            Log.d(TAG, "Connected to " + ip + ":" + port);
            return socket;
        } catch (IOException e) {
            socket.close();
            throw new IOException("Failed to connect to " + ip + ":" + port + " - " + e.getMessage());
        }
    }

    /**
     * 创建本地监听Socket
     */
    private ServerSocket createListener(int port) throws IOException {
        ServerSocket serverSocket = new ServerSocket();
        serverSocket.setReuseAddress(true);
        serverSocket.bind(new InetSocketAddress(port));
        Log.d(TAG, "Listening on port " + port);
        return serverSocket;
    }

    /**
     * 启动端口转发
     * @param sourceAddr 源地址（程序A的地址）
     * @param targetAddr 目标转发地址
     * @param callback 状态回调接口
     */
    public void start(String sourceAddr, String targetAddr, ForwardCallback callback) {
        if (isRunning.get()) {
            if (callback != null) {
                callback.onError("PortForwarder is already running");
            }
            return;
        }

        forwardThread = new Thread(() -> {
            try {
                Address source = parseAddress(sourceAddr);
                Address target = parseAddress(targetAddr);

                Log.i(TAG, "Connecting to source: " + source);
                if (callback != null) {
                    callback.onStatusUpdate("Connecting to source: " + source);
                }

                // 1. 连接到源（程序A）
                sourceSocket = connectTo(source.ip, source.port);

                if (callback != null) {
                    callback.onStatusUpdate("Connected to source, setting up target...");
                }

                // 2. 根据目标是本地还是远程采取不同策略
                if (isLocalAddress(target.ip)) {
                    // 本地模式：监听端口等待连接
                    setupLocalForward(target, callback);
                } else {
                    // 远程模式：主动连接
                    setupRemoteForward(target, callback);
                }

            } catch (Exception e) {
                Log.e(TAG, "Forwarder error: " + e.getMessage());
                if (callback != null) {
                    callback.onError(e.getMessage());
                }
                stop();
            }
        });

        forwardThread.start();
    }

    /**
     * 本地转发模式：监听端口等待连接
     */
    private void setupLocalForward(Address target, ForwardCallback callback) throws IOException {
        Log.i(TAG, "Local forward mode: listening on " + target);
        if (callback != null) {
            callback.onStatusUpdate("Local mode: listening on " + target.port);
        }

        serverSocket = createListener(target.port);

        // 设置超时以便检查sourceSocket是否断开
        serverSocket.setSoTimeout(1000);

        boolean accepted = false;
        while (isRunning.get() && !accepted) {
            try {
                // 检查sourceSocket是否仍然连接
                if (sourceSocket.isClosed() || !sourceSocket.isConnected()) {
                    throw new IOException("Source connection lost");
                }

                targetSocket = serverSocket.accept();
                accepted = true;
                Log.i(TAG, "Accepted connection from " + targetSocket.getInetAddress());
                if (callback != null) {
                    callback.onStatusUpdate("Accepted local connection");
                }

            } catch (java.net.SocketTimeoutException e) {
                // 超时，继续循环检查
                continue;
            }
        }

        if (accepted) {
            serverSocket.close();
            startBidirectionalForward(callback);
        }
    }

    /**
     * 远程转发模式：主动连接目标
     */
    private void setupRemoteForward(Address target, ForwardCallback callback) throws IOException {
        Log.i(TAG, "Remote forward mode: connecting to " + target);
        if (callback != null) {
            callback.onStatusUpdate("Remote mode: connecting to " + target);
        }

        targetSocket = connectTo(target.ip, target.port);

        if (callback != null) {
            callback.onStatusUpdate("Connected to remote target");
        }

        startBidirectionalForward(callback);
    }

    /**
     * 启动双向转发
     */
    private void startBidirectionalForward(ForwardCallback callback) {
        isRunning.set(true);

        if (callback != null) {
            callback.onStatusUpdate("Starting bidirectional forwarding...");
            callback.onConnected();
        }

        // 启动两个转发线程：source -> target 和 target -> source
        executor.execute(() -> forwardData(sourceSocket, targetSocket, "Source->Target"));
        executor.execute(() -> forwardData(targetSocket, sourceSocket, "Target->Source"));

        // 等待转发完成
        executor.shutdown();
        try {
            if (!executor.awaitTermination(1, TimeUnit.HOURS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
        }

        isRunning.set(false);

        if (callback != null) {
            callback.onDisconnected();
        }
    }

    /**
     * 数据转发
     */
    private void forwardData(Socket from, Socket to, String direction) {
        byte[] buffer = new byte[BUFFER_SIZE];

        try (InputStream input = from.getInputStream();
             OutputStream output = to.getOutputStream()) {

            int bytesRead;
            while (isRunning.get() && (bytesRead = input.read(buffer)) != -1) {
                output.write(buffer, 0, bytesRead);
                output.flush();

                Log.v(TAG, direction + " forwarded " + bytesRead + " bytes");
            }

        } catch (IOException e) {
            if (isRunning.get()) {
                Log.d(TAG, direction + " forward ended: " + e.getMessage());
            }
        } finally {
            // 一个方向断开，关闭所有连接
            stop();
        }
    }

    /**
     * 停止转发
     */
    public void stop() {
        isRunning.set(false);

        // 关闭所有socket
        closeQuietly(sourceSocket);
        closeQuietly(targetSocket);
        closeQuietly(serverSocket);

        // 中断线程
        if (forwardThread != null && forwardThread.isAlive()) {
            forwardThread.interrupt();
        }

        // 关闭线程池
        executor.shutdownNow();

        Log.i(TAG, "PortForwarder stopped");
    }

    /**
     * 安静关闭Socket
     */
    private void closeQuietly(Socket socket) {
        if (socket != null) {
            try {
                if (!socket.isClosed()) {
                    socket.close();
                }
            } catch (IOException e) {
                // 忽略
            }
        }
    }

    /**
     * 安静关闭ServerSocket
     */
    private void closeQuietly(ServerSocket socket) {
        if (socket != null) {
            try {
                if (!socket.isClosed()) {
                    socket.close();
                }
            } catch (IOException e) {
                // 忽略
            }
        }
    }

    /**
     * 检查是否正在运行
     */
    public boolean isRunning() {
        return isRunning.get();
    }

    /**
     * 回调接口
     */
    public interface ForwardCallback {
        void onStatusUpdate(String status);
        void onConnected();
        void onDisconnected();
        void onError(String error);
    }

    /**
     * 简单的回调适配器
     */
    public static abstract class ForwardCallbackAdapter implements ForwardCallback {
        @Override
        public void onStatusUpdate(String status) {}
        @Override
        public void onConnected() {}
        @Override
        public void onDisconnected() {}
        @Override
        public void onError(String error) {}
    }

    // ==================== 使用示例 ====================

    /**
     * 使用示例1：基本用法
     */
    public static void example1() {
        PortForwarder forwarder = new PortForwarder();

        forwarder.start("192.168.1.100:61009", "127.0.0.1:8080", new ForwardCallback() {
            @Override
            public void onStatusUpdate(String status) {
                Log.d(TAG, "Status: " + status);
            }

            @Override
            public void onConnected() {
                Log.i(TAG, "Forwarding started");
            }

            @Override
            public void onDisconnected() {
                Log.i(TAG, "Forwarding stopped");
            }

            @Override
            public void onError(String error) {
                Log.e(TAG, "Error: " + error);
            }
        });

        // 稍后停止
        // forwarder.stop();
    }

    /**
     * 使用示例2：Activity中使用
     */
    /*
    public class ForwardActivity extends AppCompatActivity {
        private PortForwarder forwarder;

        @Override
        protected void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);
            setContentView(R.layout.activity_forward);

            forwarder = new PortForwarder();

            findViewById(R.id.startBtn).setOnClickListener(v -> {
                String source = ((EditText)findViewById(R.id.sourceInput)).getText().toString();
                String target = ((EditText)findViewById(R.id.targetInput)).getText().toString();

                forwarder.start(source, target, new PortForwarder.ForwardCallback() {
                    @Override
                    public void onStatusUpdate(String status) {
                        runOnUiThread(() -> {
                            ((TextView)findViewById(R.id.statusText)).setText(status);
                        });
                    }

                    @Override
                    public void onConnected() {
                        runOnUiThread(() -> {
                            Toast.makeText(ForwardActivity.this, "Connected", Toast.LENGTH_SHORT).show();
                        });
                    }

                    @Override
                    public void onDisconnected() {
                        runOnUiThread(() -> {
                            Toast.makeText(ForwardActivity.this, "Disconnected", Toast.LENGTH_SHORT).show();
                        });
                    }

                    @Override
                    public void onError(String error) {
                        runOnUiThread(() -> {
                            Toast.makeText(ForwardActivity.this, "Error: " + error, Toast.LENGTH_LONG).show();
                        });
                    }
                });
            });

            findViewById(R.id.stopBtn).setOnClickListener(v -> {
                forwarder.stop();
            });
        }

        @Override
        protected void onDestroy() {
            super.onDestroy();
            forwarder.stop();
        }
    }
    */
}