// Copyright (c) 2026-present, 秋冥散雨_GenOuka
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/select.h>
#include <signal.h>

// 设置socket为非阻塞
int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags == -1) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

// 解析IP:端口字符串
int parse_addr(char *addr_str, char *ip, int ip_size, int *port) {
    char *colon = strrchr(addr_str, ':');
    if (!colon) {
        fprintf(stderr, "Invalid address format. Expected ip:port\n");
        return -1;
    }
    
    int ip_len = colon - addr_str;
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
int connect_to(const char *ip, int port) {
    int sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd < 0) {
        perror("socket");
        return -1;
    }
    
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    
    if (inet_pton(AF_INET, ip, &addr.sin_addr) <= 0) {
        // 尝试DNS解析
        struct hostent *he = gethostbyname(ip);
        if (!he) {
            fprintf(stderr, "Failed to resolve %s\n", ip);
            close(sockfd);
            return -1;
        }
        memcpy(&addr.sin_addr, he->h_addr_list[0], sizeof(struct in_addr));
    }
    
    // 设置为非阻塞以支持超时
    set_nonblocking(sockfd);
    
    int ret = connect(sockfd, (struct sockaddr *)&addr, sizeof(addr));
    if (ret < 0 && errno != EINPROGRESS) {
        perror("connect");
        close(sockfd);
        return -1;
    }
    
    // 使用select等待连接完成
    fd_set write_fds;
    FD_ZERO(&write_fds);
    FD_SET(sockfd, &write_fds);
    
    struct timeval tv;
    tv.tv_sec = 10;
    tv.tv_usec = 0;
    
    ret = select(sockfd + 1, NULL, &write_fds, NULL, &tv);
    if (ret <= 0) {
        fprintf(stderr, "Connection timeout or error\n");
        close(sockfd);
        return -1;
    }
    
    // 检查连接是否成功
    int so_error;
    socklen_t len = sizeof(so_error);
    getsockopt(sockfd, SOL_SOCKET, SO_ERROR, &so_error, &len);
    if (so_error != 0) {
        fprintf(stderr, "Connection failed: %s\n", strerror(so_error));
        close(sockfd);
        return -1;
    }
    
    // 恢复为阻塞模式（或保持非阻塞，这里选择保持非阻塞以便select使用）
    return sockfd;
}

// 创建监听socket
int create_listener(int port) {
    int sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd < 0) {
        perror("socket");
        return -1;
    }
    
    int opt = 1;
    if (setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
        perror("setsockopt");
        close(sockfd);
        return -1;
    }
    
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
    
    if (bind(sockfd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(sockfd);
        return -1;
    }
    
    if (listen(sockfd, 5) < 0) {
        perror("listen");
        close(sockfd);
        return -1;
    }
    
    return sockfd;
}

// 双向转发数据
void bidirectional_forward(int fd1, int fd2) {
    fd_set read_fds;
    char buffer[4096];
    int max_fd = (fd1 > fd2) ? fd1 : fd2;
    
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
        
        int ret = select(max_fd + 1, &read_fds, NULL, NULL, &tv);
        if (ret < 0) {
            if (errno == EINTR) continue;
            break;
        }
        
        if (ret == 0) continue;  // 超时，继续循环
        
        // fd1 -> fd2
        if (FD_ISSET(fd1, &read_fds)) {
            ssize_t n = read(fd1, buffer, sizeof(buffer));
            if (n <= 0) {
                if (n < 0 && errno == EAGAIN) {
                    // 无数据，继续
                } else {
                    break;  // 连接关闭
                }
            } else {
                ssize_t total = 0;
                while (total < n) {
                    ssize_t w = write(fd2, buffer + total, n - total);
                    if (w < 0) {
                        if (errno == EAGAIN) {
                            usleep(1000);
                            continue;
                        }
                        if (errno == EINTR) continue;
                        goto cleanup;
                    }
                    total += w;
                }
            }
        }
        
        // fd2 -> fd1
        if (FD_ISSET(fd2, &read_fds)) {
            ssize_t n = read(fd2, buffer, sizeof(buffer));
            if (n <= 0) {
                if (n < 0 && errno == EAGAIN) {
                    // 无数据，继续
                } else {
                    break;  // 连接关闭
                }
            } else {
                ssize_t total = 0;
                while (total < n) {
                    ssize_t w = write(fd1, buffer + total, n - total);
                    if (w < 0) {
                        if (errno == EAGAIN) {
                            usleep(1000);
                            continue;
                        }
                        if (errno == EINTR) continue;
                        goto cleanup;
                    }
                    total += w;
                }
            }
        }
    }
    
cleanup:
    close(fd1);
    close(fd2);
}

// 检查IP是否是本机地址（简化判断：127.0.0.1、0.0.0.0、或包含本地网卡IP）
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
    
    char ip_a[256], ip_fwd[256];
    int port_a, port_fwd;
    
    // 解析参数1：程序A的地址
    if (parse_addr(argv[1], ip_a, sizeof(ip_a), &port_a) < 0) {
        return 1;
    }
    
    // 解析参数2：转发目标地址
    if (parse_addr(argv[2], ip_fwd, sizeof(ip_fwd), &port_fwd) < 0) {
        return 1;
    }
    
    printf("Connecting to program A at %s:%d\n", ip_a, port_a);
    printf("Will forward to %s:%d\n", ip_fwd, port_fwd);
    
    // 1. 连接到程序A的端口a
    int conn_a = connect_to(ip_a, port_a);
    if (conn_a < 0) {
        fprintf(stderr, "Failed to connect to program A\n");
        return 1;
    }
    printf("Connected to program A (port a)\n");
    
    int conn_fwd = -1;
    
    // 2. 判断转发目标是本地还是远程
    if (is_local_address(ip_fwd)) {
        // 本地模式：监听端口等待连接
        printf("Local forward mode: listening on %s:%d\n", ip_fwd, port_fwd);
        
        int listen_fwd = create_listener(port_fwd);
        if (listen_fwd < 0) {
            fprintf(stderr, "Failed to create listener on port %d\n", port_fwd);
            close(conn_a);
            return 1;
        }
        printf("Listening on port %d for forward connections\n", port_fwd);
        
        // 3. 接受本地连接
        printf("Waiting for connection on port %d...\n", port_fwd);
        struct sockaddr_in client_addr;
        socklen_t addr_len = sizeof(client_addr);
        
        // 使用select等待连接，同时检查程序A的连接是否断开
        fd_set read_fds;
        struct timeval tv;
        
        while (conn_fwd < 0) {
            FD_ZERO(&read_fds);
            FD_SET(listen_fwd, &read_fds);
            FD_SET(conn_a, &read_fds);
            
            tv.tv_sec = 1;
            tv.tv_usec = 0;
            
            int max_fd = (listen_fwd > conn_a) ? listen_fwd : conn_a;
            int ret = select(max_fd + 1, &read_fds, NULL, NULL, &tv);
            
            if (ret < 0) {
                if (errno == EINTR) continue;
                perror("select");
                close(conn_a);
                close(listen_fwd);
                return 1;
            }
            
            // 检查程序A是否断开
            if (FD_ISSET(conn_a, &read_fds)) {
                char check_buf[1];
                ssize_t n = recv(conn_a, check_buf, 1, MSG_PEEK);
                if (n == 0) {
                    fprintf(stderr, "Program A disconnected\n");
                    close(conn_a);
                    close(listen_fwd);
                    return 1;
                }
            }
            
            // 检查是否有新连接
            if (FD_ISSET(listen_fwd, &read_fds)) {
                conn_fwd = accept(listen_fwd, (struct sockaddr *)&client_addr, &addr_len);
                if (conn_fwd < 0) {
                    if (errno != EAGAIN && errno != EWOULDBLOCK) {
                        perror("accept");
                        close(conn_a);
                        close(listen_fwd);
                        return 1;
                    }
                } else {
                    printf("Accepted forward connection from %s:%d\n",
                           inet_ntoa(client_addr.sin_addr), ntohs(client_addr.sin_port));
                }
            }
        }
        
        // 关闭监听socket，不再需要
        close(listen_fwd);
        
    } else {
        // 远程模式：主动连接到转发目标
        printf("Remote forward mode: connecting to %s:%d\n", ip_fwd, port_fwd);
        
        conn_fwd = connect_to(ip_fwd, port_fwd);
        if (conn_fwd < 0) {
            fprintf(stderr, "Failed to connect to forward target %s:%d\n", ip_fwd, port_fwd);
            close(conn_a);
            return 1;
        }
        printf("Connected to forward target %s:%d\n", ip_fwd, port_fwd);
    }
    
    // 4. 双向转发：conn_a <-> conn_fwd
    printf("Starting bidirectional forwarding...\n");
    bidirectional_forward(conn_a, conn_fwd);
    
    printf("Connection closed\n");
    return 0;
}