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
#include <sys/select.h>
#include <sys/wait.h>

#define PORT_A_START 61009
#define PORT_A_END 61119
#define PORT_B_START 62009
#define PORT_B_END 62119  // 注意：原题21119可能是笔误，应为62119

// 设置socket为非阻塞
int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags == -1) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

// 创建监听socket，返回socket fd，port输出实际绑定的端口
int create_listener(int start_port, int end_port, int *port, int non_block) {
    int sockfd;
    int opt = 1;
    struct sockaddr_in addr;
    
    for (int p = start_port; p <= end_port; p++) {
        sockfd = socket(AF_INET, SOCK_STREAM, 0);
        if (sockfd < 0) {
            perror("socket");
            continue;
        }
        
        // 允许端口复用
        if (setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
            perror("setsockopt");
            close(sockfd);
            continue;
        }
        
        memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = INADDR_ANY;
        addr.sin_port = htons(p);
        
        if (bind(sockfd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
            close(sockfd);
            continue;  // 端口被占用，尝试下一个
        }
        
        if (listen(sockfd, 5) < 0) {
            perror("listen");
            close(sockfd);
            continue;
        }
        
        // 绑定成功
        *port = p;
        
        if (non_block) {
            if (set_nonblocking(sockfd) < 0) {
                perror("set_nonblocking");
                close(sockfd);
                continue;
            }
        }
        
        return sockfd;
    }
    
    return -1;  // 没有找到可用端口
}

// 接受连接（阻塞或非阻塞）
int accept_connection(int listen_fd, int non_block) {
    struct sockaddr_in client_addr;
    socklen_t addr_len = sizeof(client_addr);
    
    int conn_fd = accept(listen_fd, (struct sockaddr *)&client_addr, &addr_len);
    
    if (conn_fd < 0) {
        if (non_block && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return -2;  // 非阻塞模式下无连接
        }
        perror("accept");
        return -1;
    }
    
    return conn_fd;
}

// 转发数据线程/进程使用的函数
void forward_data(int src_fd, int dst_fd) {
    char buffer[4096];
    ssize_t n;
    
    while ((n = read(src_fd, buffer, sizeof(buffer))) > 0) {
        ssize_t total_written = 0;
        while (total_written < n) {
            ssize_t written = write(dst_fd, buffer + total_written, n - total_written);
            if (written < 0) {
                if (errno == EINTR) continue;
                return;  // 写入失败，退出
            }
            total_written += written;
        }
    }
}

// 双向转发
void bidirectional_forward(int fd1, int fd2) {
    fd_set read_fds;
    char buffer[4096];
    int max_fd = (fd1 > fd2) ? fd1 : fd2;
    
    // 设置非阻塞
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
        
        if (ret == 0) continue;  // 超时
        
        // fd1 有数据，转发到 fd2
        if (FD_ISSET(fd1, &read_fds)) {
            ssize_t n = read(fd1, buffer, sizeof(buffer));
            if (n <= 0) {
                if (n < 0 && errno == EAGAIN) {
                    // 继续
                } else {
                    break;  // 连接关闭或错误
                }
            } else {
                ssize_t total = 0;
                while (total < n) {
                    ssize_t w = write(fd2, buffer + total, n - total);
                    if (w < 0) {
                        if (errno == EAGAIN || errno == EINTR) continue;
                        goto cleanup;
                    }
                    total += w;
                }
            }
        }
        
        // fd2 有数据，转发到 fd1
        if (FD_ISSET(fd2, &read_fds)) {
            ssize_t n = read(fd2, buffer, sizeof(buffer));
            if (n <= 0) {
                if (n < 0 && errno == EAGAIN) {
                    // 继续
                } else {
                    break;  // 连接关闭或错误
                }
            } else {
                ssize_t total = 0;
                while (total < n) {
                    ssize_t w = write(fd1, buffer + total, n - total);
                    if (w < 0) {
                        if (errno == EAGAIN || errno == EINTR) continue;
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

// 执行shell命令，返回状态
int execute_command(const char *cmd) {
    printf("Executing: %s\n", cmd);
    int status = system(cmd);
    if (status == -1) {
        perror("system");
        return -1;
    }
    return WEXITSTATUS(status);
}

int main() {
    int listen_a, listen_b;
    int port_a, port_b;
    int conn_a = -1, conn_b = -1;
    pid_t forward_pid = -1;
    
    // 1) 阻塞监听端口a (61009-61119)
    listen_a = create_listener(PORT_A_START, PORT_A_END, &port_a, 0);
    if (listen_a < 0) {
        fprintf(stderr, "Failed to find available port in range %d-%d\n", PORT_A_START, PORT_A_END);
        return 1;
    }
    
    // 标准输出第1行输出占用的端口
    printf("%d\n", port_a);
    fflush(stdout);
    
    // 阻塞等待a的连接
    conn_a = accept_connection(listen_a, 0);
    if (conn_a < 0) {
        fprintf(stderr, "Failed to accept connection on port %d\n", port_a);
        close(listen_a);
        return 1;
    }
    
    // 2) 非阻塞监听端口b (62009-62119)
    listen_b = create_listener(PORT_B_START, PORT_B_END, &port_b, 1);
    if (listen_b < 0) {
        fprintf(stderr, "Failed to find available port in range %d-%d\n", PORT_B_START, PORT_B_END);
        close(conn_a);
        close(listen_a);
        return 1;
    }
    
    // 创建子进程进行双向转发 (a <-> b)
    // 父进程继续执行hdc命令，子进程处理转发
    
    // 先尝试非阻塞接受b的连接（可能还没有）
    conn_b = accept_connection(listen_b, 1);
    
    // 3) 执行 "hdc tconn 127.0.0.1:b"
    char cmd[256];
    snprintf(cmd, sizeof(cmd), "hdc tconn 127.0.0.1:%d", port_b);
    int connect_status = execute_command(cmd);
    
    // 4) 检查b端口是否建立连接
    // 如果之前没有accept到，现在再尝试（给hdc一些时间）
    if (conn_b < 0) {
        // 等待一小段时间让hdc连接
        usleep(500000);  // 500ms
        
        // 再次尝试accept（仍为非阻塞）
        conn_b = accept_connection(listen_b, 1);
        
        // 如果还是没有，阻塞等待一段时间
        if (conn_b < 0) {
            // 临时改为阻塞模式等待连接
            int flags = fcntl(listen_b, F_GETFL, 0);
            fcntl(listen_b, F_SETFL, flags & ~O_NONBLOCK);
            
            struct timeval tv;
            tv.tv_sec = 3;  // 最多等待3秒
            tv.tv_usec = 0;
            
            fd_set read_fds;
            FD_ZERO(&read_fds);
            FD_SET(listen_b, &read_fds);
            
            int ret = select(listen_b + 1, &read_fds, NULL, NULL, &tv);
            if (ret > 0 && FD_ISSET(listen_b, &read_fds)) {
                conn_b = accept_connection(listen_b, 0);
            }
            
            // 恢复非阻塞（其实不需要了，后面会关闭）
        }
    }
    
    if (conn_b < 0) {
        fprintf(stderr, "Port b (%d) did not establish connection after hdc connect\n", port_b);
        close(conn_a);
        close(listen_a);
        close(listen_b);
        return 1;
    }
    
    // 创建子进程进行双向转发
    forward_pid = fork();
    if (forward_pid < 0) {
        perror("fork");
        close(conn_a);
        close(conn_b);
        close(listen_a);
        close(listen_b);
        return 1;
    }
    
    if (forward_pid == 0) {
        // 子进程：执行双向转发
        close(listen_a);  // 子进程不需要监听socket
        close(listen_b);
        
        bidirectional_forward(conn_a, conn_b);
        exit(0);
    } else {
        // 父进程：关闭连接socket，继续执行命令
        close(conn_a);
        close(conn_b);
        close(listen_a);
        close(listen_b);
    }
    
    // 5) 执行安装命令
    int shell_status = execute_command("hdc install test0.hap");
    
    // 6) 断开连接，清理
    // 终止转发子进程
    if (forward_pid > 0) {
        kill(forward_pid, SIGTERM);
        // 等待子进程结束，最多等120秒
        int status;
        waitpid(forward_pid, &status, WNOHANG);
        usleep(12000000);
        // 如果还在运行，强制结束
        kill(forward_pid, SIGKILL);
        waitpid(forward_pid, &status, 0);
    }
    
    // 断开hdc连接
    execute_command("hdc kill");
    
    return 0;
}