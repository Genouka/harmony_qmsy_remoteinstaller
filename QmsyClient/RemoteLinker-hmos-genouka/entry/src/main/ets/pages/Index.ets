// index.ets
import socket from '@ohos.net.socket';
import promptAction from '@ohos.promptAction';
import util from '@ohos.util';
import systemDateTime from '@ohos.systemDateTime';

// 执行TCP通讯的对象
let socketA: socket.TCPSocket | null = null
let socketFwd: socket.TCPSocket | null = null
let serverSocket: socket.TCPSocketServer | null = null

// 连接状态
enum ConnState {
  IDLE = '空闲',
  CONNECTING_A = '正在连接服务提供者...',
  LISTENING = '正在监听转发端口...',
  CONNECTING_FWD = '正在连接转发目标...',
  FORWARDING = '数据转发中...',
  DISCONNECTED = '已断开',
  ERROR = '错误'
}

@Entry
@Component
struct Index {
  // 输入参数
  @State ipA: string = '192.168.1.100'
  @State portA: number = 61009
  @State ipFwd: string = '127.0.0.1'
  @State portFwd: number = 8080
  // 状态显示
  @State status: string = ConnState.IDLE
  @State msgHistory: string = ''
  @State isRunning: boolean = false
  scroller: Scroller = new Scroller()

  build() {
    List() {
      ListItem() {
        Text("RemoteLinker")
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .width('100%')
          .textAlign(TextAlign.Center)
          .padding(10)
      }

      ListItem() {
        Text("By 秋冥散雨_GenOuka\n禁止用于非法用途\n使用本程序有风险，后果自负")
          .fontSize(14)
          .width('100%')
          .textAlign(TextAlign.Center)
          .padding(10)
      }

      ListItem() {
        // 状态显示
        Flex({ justifyContent: FlexAlign.Center, alignItems: ItemAlign.Center }) {
          Text(`状态: ${this.status}`)
            .fontSize(14)
            .fontColor(this.isRunning ? '#52c41a' : '#999999')
        }
        .width('100%')
        .padding(5)
      }

      ListItem() {
        Text("本地转发地址：")
          .fontSize(14)
      }

      ListItem() {
        // 转发目标地址配置
        Row() {
          TextInput({ text: this.ipFwd })
            .onChange((value) => {
              this.ipFwd = value
            })
            .width('60%')
            .fontSize(12)
            .flexGrow(1)

          Text(":")
            .width('10%')
            .flexGrow(0)

          TextInput({ text: this.portFwd.toString() })
            .type(InputType.Number)
            .width('30%')
            .onChange((value) => {
              this.portFwd = parseInt(value) || 0
            })
            .fontSize(12)
            .flexGrow(0)
        }
        .width('100%')
        .padding(10)
      }

      ListItem() {
        Text("服务提供者地址")
          .fontSize(14)
      }

      ListItem() {
        // 程序A地址配置
        Row() {
          TextInput({ text: this.ipA })
            .onChange((value) => {
              this.ipA = value
            })
            .width('60%')
            .fontSize(12)
            .flexGrow(1)

          Text(":")
            .width('10%')
            .flexGrow(0)

          TextInput({ text: this.portA.toString() })
            .type(InputType.Number)
            .onChange((value) => {
              this.portA = parseInt(value) || 0
            })
            .width('30%')
            .fontSize(12)
        }
        .padding(10)
      }

      ListItem() {
        // 控制按钮
        Flex({ justifyContent: FlexAlign.SpaceAround, alignItems: ItemAlign.Center }) {
          Button(this.isRunning ? "停止" : "启动")
            .onClick(() => {
              if (this.isRunning) {
                this.stopForward()
              } else {
                this.startForward()
              }
            })
            .width(120)
            .fontSize(14)
            .backgroundColor(this.isRunning ? '#ff4d4f' : '#1890ff')
        }
        .width('100%')
        .padding(10)
      }

      ListItem() {
        // 日志显示区域
        Text(this.msgHistory)
          .textAlign(TextAlign.Start)
          .padding(10)
          .width('100%')
          .fontSize(12)
      }
      .margin({ bottom: 150 })
    }
    .height('100%')
    .padding({
      left: 20,
      right: 20
    })
  }

  // 检查是否本地地址
  isLocalAddress(ip: string): boolean {
    return ip === '127.0.0.1' || ip === '0.0.0.0' ||
      ip === 'localhost' || ip === '::1'
  }

  // 添加日志
  async addLog(msg: string) {
    let time = await getCurrentTimeString()
    this.msgHistory += `[${time}] ${msg}\r\n`
    this.scroller.scrollEdge(Edge.Bottom)
  }

  // 启动转发
  async startForward() {
    if (this.isRunning) {
      promptAction.showToast({ message: '转发已在运行中' })
      return
    }

    // 验证端口
    if (this.portA <= 0 || this.portA > 65535 ||
      this.portFwd <= 0 || this.portFwd > 65535) {
      promptAction.showToast({ message: '端口号必须在1-65535之间' })
      return
    }

    this.isRunning = true
    this.msgHistory = ''
    await this.addLog('=== 启动端口转发 ===')

    // 1. 连接程序A
    const connectedA = await this.connectToA()
    if (!connectedA) {
      this.isRunning = false
      this.status = ConnState.ERROR
      return
    }

    // 2. 处理转发端（本地监听或远程连接）
    let connectedFwd = false
    connectedFwd = await this.startRemoteMode()

    if (!connectedFwd) {
      this.cleanup()
      this.isRunning = false
      this.status = ConnState.ERROR
      return
    }

    // 3. 开始双向转发
    this.status = ConnState.FORWARDING
    await this.addLog('✓ 开始双向数据转发')
    this.setupBidirectionalForward()
  }

  // 连接程序A
  async connectToA(): Promise<boolean> {
    this.status = ConnState.CONNECTING_A
    await this.addLog(`正在连接程序A: ${this.ipA}:${this.portA}`)

    try {
      socketA = socket.constructTCPSocketInstance()

      // 绑定本地地址
      let localAddress: socket.NetAddress = {
        address: "0.0.0.0",
        port: 0,
        family: 1
      }
      await socketA.bind(localAddress)

      // 连接到程序A
      let serverAddress: socket.NetAddress = {
        address: this.ipA,
        port: this.portA,
        family: 1
      }

      await socketA.connect({
        address: serverAddress,
        timeout: 10000
      })

      await this.addLog('✓ 已连接到程序A')
      return true

    } catch (e) {
      await this.addLog(`✗ 连接程序A失败: ${e.message}`)
      return false
    }
  }

  // 远程模式：主动连接转发目标
  async startRemoteMode(): Promise<boolean> {
    this.status = ConnState.CONNECTING_FWD
    await this.addLog(`远程模式：连接 ${this.ipFwd}:${this.portFwd}`)

    try {
      socketFwd = socket.constructTCPSocketInstance()

      let localAddress: socket.NetAddress = {
        address: "0.0.0.0",
        port: 0,
        family: 1
      }
      await socketFwd.bind(localAddress)

      let fwdAddress: socket.NetAddress = {
        address: this.ipFwd,
        port: this.portFwd,
        family: 1
      }

      await socketFwd.connect({
        address: fwdAddress,
        timeout: 10000
      })

      await this.addLog('✓ 已连接到转发目标')
      return true

    } catch (e) {
      await this.addLog(`✗ 连接转发目标失败: ${e.message}`)
      return false
    }
  }

  // 设置双向转发
  setupBidirectionalForward() {
    if (!socketA || !socketFwd) {
      return
    }

    // A -> Fwd 方向：监听A的消息，发送到Fwd
    socketA.on('message', async (value) => {
      if (!socketFwd) {
        return
      }

      try {
        // 转发数据
        await socketFwd.send({ data: value.message })
        let size = value.message.byteLength
        await this.addLog(`A->Fwd: ${size} bytes`)
      } catch (e) {
        await this.addLog(`A->Fwd 转发失败: ${e.message}`)
        this.stopForward()
      }
    })

    // Fwd -> A 方向：监听Fwd的消息，发送到A
    socketFwd.on('message', async (value) => {
      if (!socketA) {
        return
      }

      try {
        // 转发数据
        await socketA.send({ data: value.message })
        let size = value.message.byteLength
        await this.addLog(`Fwd->A: ${size} bytes`)
      } catch (e) {
        await this.addLog(`Fwd->A 转发失败: ${e.message}`)
        this.stopForward()
      }
    })

    // 监听连接关闭事件
    socketA.on('close', async () => {
      await this.addLog('程序A连接关闭')
      this.stopForward()
    })

    socketFwd.on('close', async () => {
      await this.addLog('转发端连接关闭')
      this.stopForward()
    })
  }

  // 停止转发
  stopForward() {
    if (!this.isRunning) {
      return
    }

    this.isRunning = false
    this.status = ConnState.DISCONNECTED
    this.addLog('=== 停止转发 ===')

    this.cleanup()
  }

  // 清理资源
  cleanup() {
    socketA?.close()
    socketFwd?.close()
    serverSocket?.close()

    socketA = null
    socketFwd = null
    serverSocket = null
  }
}

// 同步获取当前时间的字符串形式
async function getCurrentTimeString(): Promise<string> {
  let time = ""
  await systemDateTime.getDate().then(
    (date) => {
      time = date.getHours().toString().padStart(2, '0') + ":" +
      date.getMinutes().toString().padStart(2, '0') + ":" +
      date.getSeconds().toString().padStart(2, '0')
    }
  )
  return time
}