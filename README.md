# dsh-remote-dsh

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin. It adds a **「远程」** row at the top of the sidebar; clicking it turns the **whole page** into another host's DSH Web GUI. The row also carries a session-state dot for that remote — **blue** while it is running something, **green** when activity arrived since you last looked.

```
┌────────────┬──────────────────────────────────┐
│ DSH        │                                  │
│ 🌐 远程 ●1  │                                  │
│ ＋ 新会话   │      另一台主机上的 DSH           │
│ 会话列表…   │      (整个页面都是它)             │
└────────────┴──────────────────────────────────┘
```

## 装

```bash
dsh plugin --profile web add dsh-remote-dsh
```

**然后重启一次 DSH。** 想跟 main 分支的话,换成 `github:hutao562/dsh-remote-dsh` 也一样。

## 用

1. 在另一台主机上装好 DSH 并跑 `dsh web`(它会打印带 `?token=` 的 URL)。
2. 把它映射到本机的**回环端口**:
   ```bash
   ssh -L 3081:127.0.0.1:3080 you@remote-host
   ```
3. 侧边栏点「远程」→「＋ 添加」→ 地址填 `http://127.0.0.1:3081`。
4. 点「⚙」展开设置行,把远程 `dsh web` 打印的 **token** 粘进去 →「配对」。

之后只要 cookie 没过期(默认 30 天)就直接进。cookie 能扛远程重启;但 token 是每进程生成的,重新配对要用**当前这次**的。

## 一条硬规则:必须是本地回环端口

远程 DSH 的会话 cookie 是 `HttpOnly; SameSite=Strict`,跨 site 的 iframe **连它的 index.html 都取不到**,直接 401:

| 远程在浏览器里的地址 | 结果 |
|---|---|
| `http://127.0.0.1:<端口>`(ssh -L,或 frpc **stcp / xtcp + visitor**) | ✅ 可用 |
| `https://remote.example.com`(frps http/tcp 公网域名) | ❌ 401 |
| `http://100.x.y.z:3080`(Tailscale IP 直连) | ❌ 403 + 401 |

**即使用 FRP,也要用 stcp/xtcp + frpc visitor 模式映射成本地回环端口。** 这样被控端一行配置都不用改。

原因、推论,以及确实需要公网域名时的做法 → **[docs/why-loopback.md](docs/why-loopback.md)**

## rail 上的状态点

| 颜色 | 含义 | 何时消失 |
|---|---|---|
| **琥珀** | 远端有会话**卡在等你回答**(批准 / 提问 / 计划评审) | 在那边答完 |
| **蓝** | 远端正跑着东西(含子代理) | 跑完 |
| **绿** | 自你上次打开远程视图之后,**有会话跑完了一轮** | **打开远程即清零** |
| **红** | 读不到(该远端没装 peer) | 恢复后 |

配色和形状都取自远端侧边栏自己那套状态点 —— 蓝色就是会话列表里那个 **8 格追逐动画**,不是另画一个圆点。

琥珀是唯一一个"看一眼不会消失"的状态 —— 它是阻塞,不是通知。点进远程视图就能看到那边弹出的批准框或提问,答完即灭。

绿点按**会话**计数:一个会话即便既被提示过、又刚跑完,也只算一个。

要让状态点工作,**被控端也要装本插件并以 `peer` 角色运行**。它只发布匿名计数(没有会话 id、标题或内容),而且**不需要任何凭据** —— 这是它相比"本地保存 token"的关键优势。

角色配置、为什么不比时钟、以及唯一一处围栏放宽的范围 → **[docs/peer-status-badge.md](docs/peer-status-badge.md)**

## 被控端还要做的配置

被远程访问的机器很容易被 DSH 判定成"本机工作站",于是几处面向**它自己桌面**的功能会打开:文件夹对话框弹在它的屏幕上、Open In 在它那边启动程序、每次启动在它桌面弹一个浏览器……这些都得在被控端关掉,否则你只会对着白屏和 401 猜。

一份可直接抄的清单(五组配置,附原因和验证方法)→ **[docs/remote-host-setup.md](docs/remote-host-setup.md)**

## 文件

| | |
|---|---|
| `lib/index.js` | Node 半面:主机注册表、`/api/remote-dsh` 路由、回环围栏、存活探测 |
| `lib/client.js` | 浏览器半面:手写 `__ModuleLoader__` bundle,注册三个官方 slot |
| `cordis.patch.yml` | bundle 层插入行(走 `dsh plugin add` 时生效) |
| `docs/` | 上面链接的深度说明 |
| `.verify/host-pending.mjs` | Node 半面自检:`pending` 的记账与归因 |
| `.verify/client-smoke.mjs` | 浏览器半面冒烟测试 |

**没有构建步骤** —— `lib/` 就是源码,改完即生效。

## 开发

```bash
npm install
npm test          # 112 项断言
npm run test:host   # 只跑 Node 半面:waterfall 记账、resolve / reject / 同步抛出、子代理归因
npm run test:client # 只跑浏览器半面:module loader 契约 + 真 React 渲染 + jsdom 真实点击
```

想在源码目录里改并让本机 DSH 立刻加载(首次插入即热加载,不需要重启)→ [docs/implementation.md](docs/implementation.md)

## 已知限制

- **琥珀色只在被控端装了 v4 以上的 peer 时才出现。** 旧版 peer 不上报 `pending`,不会因此变红,但也不会有琥珀。
- **接管时会盖住本地侧边栏**,返回靠顶栏按钮;焦点进了 iframe 之后 Esc 会失效。
- **改 `lib/index.js` 需要重启 DSH**;`lib/client.js` 的改动刷新页面即可。
- 只做"用起来",没做 agent 集成 —— 没有把远程主机暴露成模型工具。

其余取舍与实现细节 → **[docs/implementation.md](docs/implementation.md)**
