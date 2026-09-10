# dsh-remote-dsh

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that adds a **「远程」/ Remote** tab at the top of the sidebar. Click it and the **whole page** becomes another host's DSH Web GUI; click 「← 返回本地 DSH」 to come back. It also puts a session-state badge on the rail row — blue while the remote is running something, green when activity arrived since you last looked.

The remote must be reachable at a **loopback** port (frpc stcp/xtcp visitor, `ssh -L`, …), because the remote DSH's session cookie is `HttpOnly; SameSite=Strict` — a public domain would be cross-site and its own index.html would answer 401. Everything else is explained below, in Chinese.

---

在 DeepSeek Harness 边栏顶部增加一个 **「远程」** 标签。点一下,**整个页面**变成另一台主机上的 DSH Web GUI;点「← 返回本地 DSH」切回来。

不是"在主会话区里再开一个小会话"—— 是整页接管。

## 行为

| | |
|---|---|
| 入口 | 侧边栏顶部、「New Session」下方的 globe 图标 +「远程」 |
| 点击后 | 一个覆盖整个 app frame 的层(含侧边栏)铺满,里面是远程 DSH 的 iframe |
| 返回 | 顶栏左侧「← 返回本地 DSH」,或按 Esc |
| 多主机 | 顶栏胶囊按钮切换;「＋ 添加」增删改 |
| 状态 | 顶栏实时显示连通性(端口通不通、对面是不是活着的 DSH) |
| 首次配对 | 把远程 `dsh web` 打印的 token 粘进设置行 → 点「配对」 |
| 位置 | 侧边栏最上方、紧贴品牌行之下、**「新会话」之上** |
| 会话状态徽标 | rail 上带彩色点与计数(`● 1`),聚合所有已配置远端的会话状态 |

### 远程会话状态徽标

rail 那一行会带上远端的状态点,配色取自远端侧边栏自己用的同一批 theme token:

| 含义 | 颜色 | 何时出现 | 何时消失 |
|---|---|---|---|
| 运行中 | **蓝** | 远端有会话正在跑(含子代理) | 跑完 |
| 有活动 | **绿** | 自你上次打开远程视图之后,有会话被改动过 | **你打开远程视图即清零** |
| 状态不可读 | 红 | 该远端没装 peer,或读不到 | 恢复后 |

展开时显示「点 + 计数」,例如 `●1 ●2`;收起成 36px rail 时只留一个点(按 蓝 > 绿 > 红 取最高优先级),完整分解在 tooltip 里(含每台主机的明细)。

**绿点为什么不是"空闲会话数"。** DSH 自己的状态点里 `done` 同时覆盖"已完成"和"空闲":

```js
if (node.completed) return [{ state: 'done', label: '已完成' }]
return [{ state: 'done', label: '空闲' }]
```

而"空闲"是会话的**持续属性**,不是事件 —— 按状态常驻来做,徽标会退化成"远端有几个会话"的计数器,**永远不会消失**。所以改成按**事件**算:绿点 = 自你上次打开远程视图之后有过改动的会话数。打开远程即视为已读,当场清零(不等下一次轮询)。

**琥珀色(等你处理)没有做**,原因写在下面。

#### 数据是怎么来的:peer 角色

这里有个绕不过去的约束:**DSH 全仓没有任何 CORS 头**。所以本地页面永远读不到远端 `/api`;而远端的会话 cookie 是 `HttpOnly`,页面也没法把它交给自己的 Host 半面代劳。要拿到远端状态,只有"本地持凭据"或"远端自己上报"两条路 —— 本项目选后者,因为它**不需要任何凭据**。

于是插件有两种角色:

```
- insert:
    - id: remote-dsh
      name: 'dsh-remote-dsh'
      config:
        role: 'peer'      # 被控端;省略即 local(默认)
```

- **`local`(默认)**:注册表 + hosts/probe 路由 + 界面。
- **`peer`**:只在回环上发布**本机自己的**会话计数,并且**不渲染任何界面** —— 因为这台机器的 GUI 正是本地面板要嵌的东西,在那里长出一个「远程」行等于把功能套进它自己。界面自禁是通过 `tapIndex` 注入一个同步标记做的(异步探测会先闪一下再消失)。

被控端要装这个插件(装了才有 peer 路由),用同一个命令,只是组合里那一行带上 `role: peer`:

```bash
# 在被控端执行
dsh plugin --profile web add github:hutao562/dsh-remote-dsh
```

然后在被控端的 profile `cordis.patch.yml` 里把角色改成 peer(就是上面那段)。**装完要重启被控端的 dsh** —— Node 半面的改动不会热加载。

> Windows 上有个坑:实测 `Stop-ScheduledTask` **不会**连带结束 node 子进程,任务状态显示 `Ready` 但老进程还在跑。要显式 `Stop-Process` 那个 `dsh/lib/bin.js` 进程,再 `Start-ScheduledTask`。

#### 为什么不比较两台机器的时钟

peer 上报的是 `ageMs`(**距今多久**),不是 `updatedAt`(绝对时间戳);读的那一侧比较的是"这个会话多久前被改过"和"我多久前看过" —— **两边都是时长**,所以结论不依赖两台机器的时钟是否一致。

这不是洁癖。实测这套部署里,**被控端的时钟比本地快约 2.96 秒**(已抵消 SSH 往返测得)。如果按绝对时间戳比,一个"你看之前 2 秒刚被改过"的会话会被算成"你看之后发生的",绿点于是**清不掉** —— 正是这个功能要避免的那个症状。

#### 唯一一处围栏放宽,以及它有多大

peer 的 `self-status` 路由接受**回环来源**的跨源读取,并回 `access-control-allow-origin`。这是全项目唯一主动放宽的安全边界,所以把范围写清楚:

- 只在 `/api/remote-dsh/self-status` 这一条**只读**路由上放宽,其它路由的 Origin 仍必须等于 Host。
- 只接受 **loopback hostname** 的来源(本地 GUI 在 `127.0.0.1:3080`,peer 在 `127.0.0.1:3081` —— 同 site 但跨源,Origin 不可能等于 Host,这正是需要放宽的原因)。非回环来源、以及带 `Sec-Fetch-Site: cross-site` 的请求**依旧 403**。
- 返回的载荷**只有计数**,没有会话 id、标题或内容。
- DSH 自己的 `/api` **不受影响**,依旧不发 CORS 头。

替代方案是让本地 Host 半面做代理(不动围栏),但那要求本地 Host 模块重新加载 —— 也就是重启 DSH。实测确认过:Host 半面的改动**不会**热加载。为了不打断会话,选了前者。


### 为什么「远程」在「新会话」上面,以及为什么不能真的并进品牌行

侧边栏 shell 按固定顺序画自己的块:**品牌行 → 新会话 → `sidebar.panellist`(本插件的位置)→ 工作区 → 底部**。也就是说 panellist 这个座位**天生在新会话下面**。

而品牌行里没有座位:`sidebar.brand.mark` / `sidebar.brand.name` 两个插槽都渲染在一个 `aria-hidden` 的 `<button onClick={startSession}>` **内部**,往里放可点击内容是错的(点击会连带触发新会话)。

所以这一处用了一条作用域收紧的 CSS,把整列的顺序正过来:

```css
[data-slot="sidebar"] [class*="logoRow"]{order:-2}
[data-slot="sidebar"] [class*="panelList"]{order:-1}
```

- `[data-slot="sidebar"]` 是 **官方锚点** —— 每个插槽渲染点都暴露一个 `[data-slot="<key>"]` 包装(注释原文:"the addressable seam dynamic styles target"),`display:contents` 让它不参与布局。
- 类名用子串匹配是因为 CSS module 会加哈希前缀(构建产物是 `WNUpnq_panelList`),原名的部分会保留下来。
- **失败模式是"不生效",不是"坏掉"**:如果 shell 改了类名,规则不再匹配,按钮就回到今天的位置。
- 间距不用补:`.logoRow` 和 `.panelList` 本来就都是 `margin-bottom: 8px`,新会话也是,换序后 8px 节奏不变。
- 这条规则移动的是**整个 panellist 容器**,不是单独一行 —— 别的插件若也往这个座位放全局面板,会一起上移。这个分组(全局面板都在本机新会话之上)正是想要的效果。

顶栏默认只留**真正需要**的东西:「返回」+ 主机胶囊 +「＋ 添加」+「⚙」+ 一个状态点。设置行(地址 / token / 配对 / 重载 / 新窗口 / 编辑 / 删除)**默认收起,「⚙」是唯一开关** —— 没有任何派生条件会覆盖它。唯一一次自动展开发生在你**刚添加完一台新主机**之后:那台主机必然还没配对,而配对就是下一步;这是由你的动作触发的,不是默认状态。配对成功后自动收起并记在 `localStorage`,所以之后再进来就是干净的一条。

状态也压到一个点加两个字(`已连通` / `端口不通` / `未探测`),完整说明走 tooltip。注意 `已连通` 只证明**端口通、对面 DSH 活着** —— 这个探测看不到「本浏览器的 cookie 是否还有效」,所以文案不声称已配对。

### 切走再切回,不会重新加载

`shell.overlay` 的条目是常驻的。切换面板时这个组件**不卸载**,只用 `display: none` 隐藏。原因是把 iframe 从文档里移除会销毁它的 browsing context,切回来就是一次全新的远程加载,会话状态和滚动位置全丢;`display: none` 保留文档、状态和滚动位置,所以返回是瞬时的。同时探测定时器在隐藏期间会停,不会有后台轮询。

## 为什么必须走本地回环端口

这是整个插件唯一需要理解的一件事,也是它和"直接填个公网地址"的本质区别。

远程 DSH 的浏览器会话 cookie 由 `packages/client/connection/src/browser-auth.ts` 下发:

```
dsh-auth-<sha256(authority)>=…; HttpOnly; SameSite=Strict
```

`SameSite=Strict` 是硬编码的,插件改不了,而且远程连 `index.html` 本身都要求已认证(未认证直接返回 401 纯文本)。于是:

| 远程在浏览器里的地址 | 与本地 GUI 的关系 | iframe 结果 |
|---|---|---|
| `http://127.0.0.1:<端口>`(frpc **stcp/xtcp visitor**、`ssh -L`、任何本地转发) | **同 site**(SameSite 忽略端口) | ✅ 可用 |
| `https://remote.example.com`(frps http/tcp 公网域名) | 跨 site | ❌ index 就 401 |
| `http://100.x.y.z:3080`(Tailscale IP 直连) | 跨 site,且 Host 不在 `trustedHosts` | ❌ 403 + 401 |

**即使你用 FRP,也要用 stcp/xtcp + frpc visitor 模式把远端映射成本地的 `127.0.0.1:<端口>`**,而不是拿公网域名。这样远程 DSH 侧一行配置都不用改。

一个实测的旁证:cookie 名是 `dsh-auth-` + `sha256("127.0.0.1:3081")`,**含端口**;而 `isTrustedApiRequest` 的 loopback 判定只看**不含端口的 hostname**。两者尺度不同,正是 3080 与 3081 能在同一浏览器里各持一份 cookie、同时可用的原因。

面板检测到非回环地址会直接给出这条警告,而不是让你对着一个白屏 401 猜。

## 安装

### 从 npm(推荐)

```bash
dsh plugin --profile web add dsh-remote-dsh
```

`dsh plugin` 会把包装进 profile 并自动加上插件层(本包在 `package.json` 里声明了 `dsh.bundle.patch`),无需手改配置。**然后重启一次 DSH** —— bundle 层是启动时组合的,`patchReload: live` 管不到它。

后续升级同理:

```bash
dsh plugin --profile web update dsh-remote-dsh   # 再重启一次
```

### 从 GitHub(等价,想跟 main 分支时用)

```bash
dsh plugin --profile web add github:hutao562/dsh-remote-dsh
```

### 从源码(开发用,不需要重启)

以源码开发时,profile 的 `cordis.patch.yml` 处于 live watch 之下,所以这条路**首次插入就能热加载**:

```bash
LINK="$HOME/.dsh/profiles/node_modules/dsh-remote-dsh"
PATCH="$HOME/.dsh/profiles/web/cordis.patch.yml"

ln -sfn "$PWD" "$LINK"          # 指向本仓库的工作副本

cat >> "$PATCH" <<'EOF'

- insert:
    - id: remote-dsh
      name: 'dsh-remote-dsh'
EOF
```

改完 `cordis.patch.yml` 后 Node 半面会热加载,可用 `curl http://127.0.0.1:3080/api/remote-dsh/hosts` 验证(应返回 `{"hosts":[]}`)。

然后**刷新浏览器页面**,Client 半面才会进入 boot graph。

> **两种装法二选一。** 上面的 `dsh plugin add` 会通过包自带的 `cordis.patch.yml` 插入同一行;再手工插一次会导致同一 id 插入两次。
>
> 另外注意一个已经踩过的坑:**Node 半面的改动不会热加载**(live patch watch 只监听 `cordis.patch.yml`,HMR 的模块根是空的)。首次插入行会加载,之后的 `lib/index.js` 改动需要重启 DSH;`lib/client.js` 的改动刷新页面即可 —— 实测 bundle 的 rev 会自动重算。

## 使用

1. 在另一台主机上装好 DSH 并跑 `dsh web`(它会打印带 `?token=` 的 URL)。
2. 在本机把它转发到回环端口,例如:
   ```bash
   ssh -L 3081:127.0.0.1:3080 you@remote-host
   ```
   或 frpc visitor 模式绑本地端口。
3. 侧边栏点「远程」→ 顶栏「＋ 添加」→ 名称随意,地址填 `http://127.0.0.1:3081`。
4. 顶栏状态显示「已连通」。
5. 把远程 `dsh web` 打印的 **token** 粘进设置行 → 点「配对」。远程下发 cookie,iframe 随即进入远程 GUI。
6. 之后只要 cookie 没过期(默认 30 天),点开「远程」就是已登录状态。

> cookie 的签名密钥是持久化的,所以**远程重启 DSH 不会让你掉线**;但重新配对需要**当前这次** `dsh web` 打印的 token(launch token 是每进程生成的)。
>
> 嫌配对按钮麻烦的话,也可以直接在浏览器新标签页打开 `http://127.0.0.1:3081/?token=…` 一次 —— cookie 一旦落下,面板里的 iframe 就直接是已登录状态。
>
> 想要 rail 上的会话状态徽标,被控端还要再装一次本插件并以 **peer** 角色运行,见下文。

## 远程实例部署清单(必读)

DSH 用一个判据推断「操作者是否坐在本机显示器前」:`launchedThroughSsh`(进程环境里有没有 `SSH_CONNECTION` / `SSH_TTY`)。**这一个信号驱动三处行为**:

| 由该信号驱动 | 经 SSH 启动 | 本机 / 服务启动 |
|---|---|---|
| `directory-picker-auto` | 挂 `browse`(应用内浏览器) | 挂 `native`(**宿主机系统对话框**) |
| `open-in-app` | 目录为空 →「Open In…」**按钮根本不渲染** | 列出宿主机已装的编辑器 / 终端 / 文件管理器 |
| `web-app` | 不做浏览器交接 | 启动时**在宿主机桌面弹一个浏览器** |

**被远程访问的机器通常由服务或计划任务启动,而不是 SSH 启动** —— 于是 DSH 把它当成本机工作站,这三处全部打开。再加上两处不查该信号的宿主机打开动作,一共五组要在**被控端**的 profile patch 层里钉死:

```yaml
# 1) 目录选择器 —— 钉成应用内浏览器
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'

# 2) 「Open In…」—— 会在宿主机桌面上启动编辑器 / 终端 / 文件管理器
- id: open-in-app
  disabled: true
- id: ui-open-in-app
  disabled: true

# 3) 启动时的浏览器交接(另两个字段一并复述,别依赖 config 的合并方式)
- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true

# 4) 在宿主机上打开文件 / 文件夹 / 设置文件 / 预设目录(不看 SSH 信号,必须显式关)
- id: session-controller
  config:
    nativeOpen: false
- id: settings-controller
  config:
    nativeOpen: false
```

第 4 组的效果是**干净的**:客户端本就为此准备了 `menuDisabled = … || !host.available`,并显示本地化说明「此主机没有可用的桌面,无法打开文件或文件夹」,而不是留一个点了才报错的按钮。

`patchReload: live`(web 模板默认值)下改完即生效,不用重启被控端。验证两处:抓被控端 index 看 boot graph 里 client 行的增减,以及 `dsh --profile web --dump-config` 看组合树里每条的 `disabled` / `config`。

### 展开:目录选择器为什么必须插两行

**症状**:在远程视图里点「打开工作区」,文件夹对话框弹在**被控那台机器的桌面上**,你在这边什么都看不到。

**原因**不在本插件,也不在 iframe。web bundle 里的那一行是:

```yaml
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
```

`-auto` 在启动时采样一次:`native` 要求 **loopback 绑定 + 非 SSH 启动 + 有可用的显示会话**。一台被远程访问的 Windows/Linux 主机通常三条全中(loopback 绑定、服务/计划任务启动、有桌面会话),于是挂上 `native` —— 而 native 的文档原文就是:

> Only viable when the operator sits at the host's display — remote deployments compose the browse backend instead.

**修复**是在**被控端**的 profile patch 层固定成 browse(这是官方 `apps/web/tests/pin-browse-picker.overlay.yml` 的写法):

```yaml
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

**两条必须一起加。** `-auto` 是唯一会顺带挂载浏览器半面的行(`directory-picker-browse` 自己不声明 `dsh.client`),只插 host 那行会得到一个没有对话框的 picker。profile 若是 `patchReload: live`(web 模板的默认值),改完热加载,不用重启被控端。

## 架构

```
你的浏览器
├─ 本地 DSH Web GUI (127.0.0.1:3080)
│   ├─ sidebar.panellist  → globe 图标 +「远程」        ┐
│   ├─ main[key=remote-dsh] → 占位(不渲染内容)          ├ 三个官方 slot,
│   └─ shell.overlay[id] → RemoteWorkspace(整页接管)     ┘ 不碰 DOM
│        ├─ fetch /api/remote-dsh/*  ──────────────┐
│        └─ <iframe src="http://127.0.0.1:3081/">  │
└─────────────────────────────────────────────────┼──────────
   本地 DSH Host 进程                               │
   └─ /api/remote-dsh(回环围栏)←───────────────────┘
        ├─ 注册表 $DSH_HOME/remote-dsh.json
        └─ 存活探测(node:http,标定 401 + "dsh web authentication required")
                    │
                    ▼  ssh -L / frpc visitor
           另一台主机上的 DSH (127.0.0.1:3080)
```

### 为什么是这三个 slot

- **`sidebar.panellist`**(root list)贡献入口。shell 自己拥有按钮、tooltip 和无障碍名;该列表渲染在侧边栏**顶部**(brand 与 New Session 之后、会话列表之前)。
- **`main`**(root keyed)必须存在且 key 与 list 的 `id` 相同,否则 ui-layout 直接拒绝选中("selecting a missing main entry throws")。它**不渲染任何东西** —— 可见表面是下面的 overlay。
- **`shell.overlay`**(root list)画整页接管。它的层在 app frame 内是 `position:absolute; inset:0`,所以放在那里的一个元素就能盖住**整个页面(含侧边栏)**,这正是"点一下整页切过去"的实现方式。

**为什么需要 Node 半面**:浏览器无法自己探测 `http://127.0.0.1:3081/` —— 它与页面同 site 但跨 origin,而远程不发 CORS 头,页面内 fetch 最多拿到 opaque 响应。从 Node 探测还能区分「隧道没通」(`ECONNREFUSED`)和「DSH 活着但浏览器还没配对」(带指纹的 401),这是顶栏最有价值的状态信号。

### 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Node 半面:注册表、`/api/remote-dsh` 路由族、回环围栏、探测 |
| `lib/client.js` | 浏览器半面:手写的 `__ModuleLoader__` bundle,注册三个官方 slot |
| `cordis.patch.yml` | bundle 层插入行(走 `dsh plugin add` 时才生效) |
| `.verify/client-smoke.mjs` | Client 半面冒烟测试:模拟 module loader + 真 React 渲染全部组件 |

两个半面都**没有构建步骤**,`lib/` 就是源码。

跑客户端自测:

```bash
node .verify/client-smoke.mjs /path/to/deepseek-harness
```

## HTTP 接口

全部挂在 `/api/remote-dsh`,并带一道回环围栏(socket 对端 + Host 头必须是回环,拒绝 `Sec-Fetch-Site: cross-site`,有 Origin 就必须等于 Host)。注意该前缀比 `/api` 长,按最长前缀匹配优先于 Connection 的 RPC 桥,所以这道围栏由本插件自己负责。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/hosts` | 列出远程主机 |
| POST | `/hosts` | 新增或更新(`{ id?, name, url }`);url 会被规范化成 origin |
| DELETE | `/hosts/<id>` | 删除 |
| POST | `/probe` | 探测 `{ url }` → `{ reachable, status, dshAuthRequired, loopback, elapsedMs }` |

注册表落在 `$DSH_HOME/remote-dsh.json`,权限 `0600`,写入走临时文件 + rename。

## 已知限制与实现注记

- **琥珀色(等你处理)没有做。** `pendingInteraction` 在 DSH 里是**纯客户端概念** —— 它由 approval / user-questions 这些客户端包注册的 pending domain 汇总(`uiSession.pendingInteractions`),**Host 侧没有任何服务暴露它**。peer 只跑在 Host 侧,所以拿不到。要做到,得让被控端的浏览器半面也参与上报,是另一套设计。
- **被控端那份是拷贝,不是链接。** 本地改了插件要重新同步到被控端才有 peer 路由的新行为;而且被控端的 Host 半面改动同样需要重启那台的 dsh(实测 `Stop-ScheduledTask` 不会连带结束 node 子进程,要显式 kill)。
- **每个远端必须装了这个插件才有状态。** 只装了 DSH、没装 peer 的远端会被记进「状态不可读」那一类,而不是绿点。
- **接管时会盖住本地侧边栏**,所以返回靠顶栏按钮(或 Esc)。若你更希望保留侧边栏可见、只让右侧整块变成远程,改一行 inset 即可。
- **隐藏期间远程页面仍在后台运行**(这正是"切回来不重载"的代价):它在 iframe 里保留着自己的会话与流式连接。要彻底释放只能真的销毁它,代价就是重新加载。
- **配对标记只是个本地记号。** `localStorage` 里记的是"提交过 token",不是"cookie 还有效"。如果 30 天到期或你在远程侧清了 cookie,设置行不会自动重新展开 —— 点一下「⚙」即可。
- **Esc 在焦点进入 iframe 后失效** —— 键盘事件被远程文档吃掉,所以返回按钮是主路径。
- **改了 `lib/index.js` 需要重启 DSH 才生效。** live patch watch 只监听 `cordis.patch.yml`,HMR 的模块根是空的(不重载模块),首次插入行会热加载但之后的 Node 半面改动不会。
- **`lib/client.js` 的改动刷新页面即可生效** —— 实测 bundle 的 rev 会自动重算(见下),服务端发的就是新字节。
- **不支持跨站嵌入。** 上面那张表的原因,不是 bug 是浏览器的 cookie 策略。若确实需要公网域名,得在本机 DSH 的 `ctx.webServer` 上做同源反代(由 Node 侧持有远程 cookie),工作量约为当前的三四倍。
- 只做"用起来",没做 agent 集成:没有把远程主机暴露成模型工具或系统提示。要做 DSH 之间的派活,那是 A2A/子代理层的另一件事。
