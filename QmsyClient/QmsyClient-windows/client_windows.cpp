// Copyright (c) 2026-present, 秋冥散雨_GenOuka
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
//#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#pragma comment(lib, "ws2_32.lib")

// 设置socket为非阻塞
int set_nonblocking(SOCKET fd) {
    u_long mode = 1;  // 1 = non-blocking, 0 = blocking
    return ioctlsocket(fd, FIONBIO, &mode);
}

// 解析IP:端口字符串
int parse_addr(char *addr_str, char *ip, int ip_size, int *port) {
    char *colon = strrchr(addr_str, ':');
    if (!colon) {
        fprintf(stderr, "Invalid address format. Expected ip:port\n");
        return -1;
    }
    
    int ip_len = (int)(colon - addr_str);
    if (ip_len >= ip_size) {
        fprintf(stderr, "IP address too long\n");
        return -1;
    }
    
    strncpy(ip, addr_str, ip_len);
    ip[ip_len] = '\0';
    
    *port = atoi(colon + 1);
    if (*port <= 0 || *port > 65535) {
        fprintf(stderr, "Invalid port number\n");
        return -1;
    }
    
    return 0;
}

// 连接到指定地址
SOCKET connect_to(const char *ip, int port) {
    SOCKET sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd == INVALID_SOCKET) {
        fprintf(stderr, "socket failed: %d\n", WSAGetLastError());
        return INVALID_SOCKET;
    }
    
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    
    // 尝试转换IP地址
    if (inet_pton(AF_INET, ip, &addr.sin_addr) != 1) {
        // 尝试DNS解析
        struct addrinfo hints, *result = NULL;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        
        char port_str[16];
        sprintf(port_str, "%d", port);
        
        if (getaddrinfo(ip, port_str, &hints, &result) != 0) {
            fprintf(stderr, "Failed to resolve %s\n", ip);
            closesocket(sockfd);
            return INVALID_SOCKET;
        }
        
        memcpy(&addr.sin_addr, &((struct sockaddr_in*)result->ai_addr)->sin_addr, sizeof(struct in_addr));
        freeaddrinfo(result);
    }
    
    // 设置为非阻塞以支持超时
    set_nonblocking(sockfd);
    
    int ret = connect(sockfd, (struct sockaddr *)&addr, sizeof(addr));
    if (ret == SOCKET_ERROR) {
        int err = WSAGetLastError();
        if (err != WSAEWOULDBLOCK && err != WSAEINPROGRESS) {
            fprintf(stderr, "connect failed: %d\n", err);
            closesocket(sockfd);
            return INVALID_SOCKET;
        }
    }
    
    // 使用select等待连接完成
    fd_set write_fds;
    FD_ZERO(&write_fds);
    FD_SET(sockfd, &write_fds);
    
    struct timeval tv;
    tv.tv_sec = 10;
    tv.tv_usec = 0;
    
    ret = select(0, NULL, &write_fds, NULL, &tv);
    if (ret <= 0) {
        fprintf(stderr, "Connection timeout or error\n");
        closesocket(sockfd);
        return INVALID_SOCKET;
    }
    
    // 检查连接是否成功
    int so_error;
    int len = sizeof(so_error);
    if (getsockopt(sockfd, SOL_SOCKET, SO_ERROR, (char*)&so_error, &len) == SOCKET_ERROR) {
        fprintf(stderr, "getsockopt failed: %d\n", WSAGetLastError());
        closesocket(sockfd);
        return INVALID_SOCKET;
    }
    
    if (so_error != 0) {
        fprintf(stderr, "Connection failed: %d\n", so_error);
        closesocket(sockfd);
        return INVALID_SOCKET;
    }
    
    return sockfd;
}

// 创建监听socket
SOCKET create_listener(int port) {
    SOCKET sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd == INVALID_SOCKET) {
        fprintf(stderr, "socket failed: %d\n", WSAGetLastError());
        return INVALID_SOCKET;
    }
    
    int opt = 1;
    if (setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt)) == SOCKET_ERROR) {
        fprintf(stderr, "setsockopt failed: %d\n", WSAGetLastError());
        closesocket(sockfd);
        return INVALID_SOCKET;
    }
    
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons((u_short)port);
    
    if (bind(sockfd, (struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR) {
        fprintf(stderr, "bind failed: %d\n", WSAGetLastError());
        closesocket(sockfd);
        return INVALID_SOCKET;
    }
    
    if (listen(sockfd, SOMAXCONN) == SOCKET_ERROR) {
        fprintf(stderr, "listen failed: %d\n", WSAGetLastError());
        closesocket(sockfd);
        return INVALID_SOCKET;
    }
    
    return sockfd;
}

// 双向转发数据
void bidirectional_forward(SOCKET fd1, SOCKET fd2) {
    fd_set read_fds;
    char buffer[4096];
    
    // 确保都是非阻塞
    set_nonblocking(fd1);
    set_nonblocking(fd2);
    
    while (1) {
        FD_ZERO(&read_fds);
        FD_SET(fd1, &read_fds);
        FD_SET(fd2, &read_fds);
        
        struct timeval tv;
        tv.tv_sec = 1;
        tv.tv_usec = 0;
        
        int ret = select(0, &read_fds, NULL, NULL, &tv);
        if (ret == SOCKET_ERROR) {
            if (WSAGetLastError() == WSAEINTR) continue;
            break;
        }
        
        if (ret == 0) continue;  // 超时，继续循环
        
        // fd1 -> fd2
        if (FD_ISSET(fd1, &read_fds)) {
            int n = recv(fd1, buffer, sizeof(buffer), 0);
            if (n == SOCKET_ERROR) {
                int err = WSAGetLastError();
                if (err == WSAEWOULDBLOCK) {
                    // 无数据，继续
                } else {
                    break;  // 连接错误
                }
            } else if (n == 0) {
                break;  // 连接关闭
            } else {
                int total = 0;
                while (total < n) {
                    int w = send(fd2, buffer + total, n - total, 0);
                    if (w == SOCKET_ERROR) {
                        int err = WSAGetLastError();
                        if (err == WSAEWOULDBLOCK) {
                            Sleep(1);
                            continue;
                        }
                        if (err == WSAEINTR) continue;
                        goto cleanup;
                    }
                    total += w;
                }
            }
        }
        
        // fd2 -> fd1
        if (FD_ISSET(fd2, &read_fds)) {
            int n = recv(fd2, buffer, sizeof(buffer), 0);
            if (n == SOCKET_ERROR) {
                int err = WSAGetLastError();
                if (err == WSAEWOULDBLOCK) {
                    // 无数据，继续
                } else {
                    break;  // 连接错误
                }
            } else if (n == 0) {
                break;  // 连接关闭
            } else {
                int total = 0;
                while (total < n) {
                    int w = send(fd1, buffer + total, n - total, 0);
                    if (w == SOCKET_ERROR) {
                        int err = WSAGetLastError();
                        if (err == WSAEWOULDBLOCK) {
                            Sleep(1);
                            continue;
                        }
                        if (err == WSAEINTR) continue;
                        goto cleanup;
                    }
                    total += w;
                }
            }
        }
    }
    
cleanup:
    closesocket(fd1);
    closesocket(fd2);
}

// 检查IP是否是本机地址
int is_local_address(const char *ip) {
    if (strcmp(ip, "127.0.0.1") == 0 || 
        strcmp(ip, "0.0.0.0") == 0 ||
        strcmp(ip, "localhost") == 0 ||
        strcmp(ip, "::1") == 0) {
        return 1;
    }
    return 0;
}

int main(int argc, char *argv[]) {
    if (argc != 3) {
        fprintf(stderr, "Usage: %s <ip:port_a> <forward_ip:port>\n", argv[0]);
        fprintf(stderr, "Example: %s 192.168.1.100:61009 127.0.0.1:8080\n", argv[0]);
        fprintf(stderr, "         %s 192.168.1.100:61009 192.168.1.200:9090\n", argv[0]);
        return 1;
    }
    
    // 初始化Winsock
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        fprintf(stderr, "WSAStartup failed: %d\n", WSAGetLastError());
        return 1;
    }
    
    char ip_a[256], ip_fwd[256];
    int port_a, port_fwd;
    
    // 解析参数1：程序A的地址
    if (parse_addr(argv[1], ip_a, sizeof(ip_a), &port_a) < 0) {
        WSACleanup();
        return 1;
    }
    
    // 解析参数2：转发目标地址
    if (parse_addr(argv[2], ip_fwd, sizeof(ip_fwd), &port_fwd) < 0) {
        WSACleanup();
        return 1;
    }
    
    printf("Connecting to program A at %s:%d\n", ip_a, port_a);
    printf("Will forward to %s:%d\n", ip_fwd, port_fwd);
    
    // 1. 连接到程序A的端口a
    SOCKET conn_a = connect_to(ip_a, port_a);
    if (conn_a == INVALID_SOCKET) {
        fprintf(stderr, "Failed to connect to program A\n");
        WSACleanup();
        return 1;
    }
    printf("Connected to program A (port a)\n");
    
    SOCKET conn_fwd = INVALID_SOCKET;
    
    // 2. 判断转发目标是本地还是远程
    if (is_local_address(ip_fwd)) {
        // 本地模式：监听端口等待连接
        printf("Local forward mode: listening on %s:%d\n", ip_fwd, port_fwd);
        
        SOCKET listen_fwd = create_listener(port_fwd);
        if (listen_fwd == INVALID_SOCKET) {
            fprintf(stderr, "Failed to create listener on port %d\n", port_fwd);
            closesocket(conn_a);
            WSACleanup();
            return 1;
        }
        printf("Listening on port %d for forward connections\n", port_fwd);
        
        // 3. 接受本地连接
        printf("Waiting for connection on port %d...\n", port_fwd);
        struct sockaddr_in client_addr;
        int addr_len = sizeof(client_addr);
        
        // 使用select等待连接，同时检查程序A的连接是否断开
        fd_set read_fds;
        struct timeval tv;
        
        while (conn_fwd == INVALID_SOCKET) {
            FD_ZERO(&read_fds);
            FD_SET(listen_fwd, &read_fds);
            FD_SET(conn_a, &read_fds);
            
            tv.tv_sec = 1;
            tv.tv_usec = 0;
            
            int ret = select(0, &read_fds, NULL, NULL, &tv);
            
            if (ret == SOCKET_ERROR) {
                if (WSAGetLastError() == WSAEINTR) continue;
                fprintf(stderr, "select failed: %d\n", WSAGetLastError());
                closesocket(conn_a);
                closesocket(listen_fwd);
                WSACleanup();
                return 1;
            }
            
            // 检查程序A是否断开
            if (FD_ISSET(conn_a, &read_fds)) {
                char check_buf[1];
                int n = recv(conn_a, check_buf, 1, MSG_PEEK);
                if (n == 0) {
                    fprintf(stderr, "Program A disconnected\n");
                    closesocket(conn_a);
                    closesocket(listen_fwd);
                    WSACleanup();
                    return 1;
                }
            }
            
            // 检查是否有新连接
            if (FD_ISSET(listen_fwd, &read_fds)) {
                conn_fwd = accept(listen_fwd, (struct sockaddr *)&client_addr, &addr_len);
                if (conn_fwd == INVALID_SOCKET) {
                    int err = WSAGetLastError();
                    if (err != WSAEWOULDBLOCK) {
                        fprintf(stderr, "accept failed: %d\n", err);
                        closesocket(conn_a);
                        closesocket(listen_fwd);
                        WSACleanup();
                        return 1;
                    }
                } else {
                    printf("Accepted forward connection from %s:%d\n",
                           inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port));
                }
            }
        }
        
        // 关闭监听socket，不再需要
        closesocket(listen_fwd);
        
    } else {
        // 远程模式：主动连接到转发目标
        printf("Remote forward mode: connecting to %s:%d\n", ip_fwd, port_fwd);
        
        conn_fwd = connect_to(ip_fwd, port_fwd);
        if (conn_fwd == INVALID_SOCKET) {
            fprintf(stderr, "Failed to connect to forward target %s:%d\n", ip_fwd, port_fwd);
            closesocket(conn_a);
            WSACleanup();
            return 1;
        }
        printf("Connected to forward target %s:%d\n", ip_fwd, port_fwd);
    }
    
    // 4. 双向转发：conn_a <-> conn_fwd
    printf("Starting bidirectional forwarding...\n");
    bidirectional_forward(conn_a, conn_fwd);
    
    printf("Connection closed\n");
    
    // 清理Winsock
    WSACleanup();
    return 0;
}