# 实现注记

README 里放不下的取舍、槽位选择、以及踩过的坑。

## 为什么是这三个 slot

插件的全部界面都通过 DSH 的官方 slot 挂载,**没有 DOM 扒取**(对比:社区里一些同类插件靠 `querySelector('[class*="sidebarCol"]')` 猜位置,上游一改标记就挂)。

| slot | 基数 / 作用域 | 用途 |
|---|---|---|
| `sidebar.panellist` | list / root | 侧边栏顶部的入口行。shell 自己拥有按钮、tooltip 和无障碍名 |
| `main` | keyed / root | **必须存在**,key 与 list 的 `id` 相同 —— 否则 ui-layout 直接拒绝选中("selecting a missing main entry throws")。它不渲染任何东西 |
| `shell.overlay` | list / root | 整页接管。它的层在 app frame 内是 `position:absolute; inset:0`,所以放一个元素就能盖住**整个页面(含侧边栏)** |

**为什么需要 Node 半面**:浏览器无法自己探测 `http://127.0.0.1:3081/` —— 它与页面同 site 但跨 origin,而远程不发 CORS 头,页面内 fetch 最多拿到 opaque 响应。从 Node 探测还能区分「隧道没通」(`ECONNREFUSED`)和「DSH 活着但浏览器还没配对」(带指纹的 401),这是顶栏最有价值的状态信号。

## 「远程」为什么在「新会话」上面

侧边栏 shell 按固定顺序画自己的块:**品牌行 → 新会话 → `sidebar.panellist`(本插件的位置)→ 工作区 → 底部**。也就是说 panellist 这个座位**天生在新会话下面**。

而品牌行里**没有座位**:`sidebar.brand.mark` / `sidebar.brand.name` 两个插槽都渲染在一个 `aria-hidden` 的 `<button onClick={startSession}>` **内部**,往里放可点击内容是错的(点击会连带触发新会话)。

所以这一处用了一条作用域收紧的 CSS 把整列顺序正过来:

```css
[data-slot="sidebar"] [class*="logoRow"]{order:-2}
[data-slot="sidebar"] [class*="panelList"]{order:-1}
```

- `[data-slot="sidebar"]` 是**官方锚点** —— 每个插槽渲染点都暴露一个 `[data-slot="<key>"]` 包装,源码注释原文是 "the addressable seam dynamic styles target",`display:contents` 让它不参与布局。
- 类名用子串匹配,是因为 CSS module 会加哈希前缀(构建产物是 `WNUpnq_panelList`),原名部分会保留。
- **失败模式是"不生效",不是"坏掉"**:shell 改了类名,规则不再匹配,按钮回到原位,没有别的副作用。
- 间距不用补:`.logoRow` 和 `.panelList` 本来就都是 `margin-bottom: 8px`,新会话也是,换序后 8px 节奏不变。
- 这条规则移动的是**整个 panellist 容器**,不是单独一行 —— 别的插件若也往这个座位放全局面板会一起上移。这个分组(全局面板都在本机新会话之上)正是想要的效果。

## 顶栏为什么这么空

默认只留**真正需要**的:「返回」+ 主机胶囊 +「＋ 添加」+「⚙」+ 一个状态点。

设置行(地址 / token / 配对 / 重载 / 新窗口 / 编辑 / 删除)**默认收起,「⚙」是唯一开关** —— 没有任何派生条件会覆盖它。唯一一次自动展开发生在你**刚添加完一台新主机**之后:那台必然还没配对,而配对就是下一步;这是由你的动作触发的,不是默认状态。配对成功后自动收起并记在 `localStorage`。

> 这里修过一个自己造的 bug:早先写成 `showSettings = settingsOpen || needsPairing`,于是"没配对过"的主机让 ⚙ **无法收起**。现在有 jsdom 真实点击测试守着这条不变量。

状态也压到一个点加两个字(`已连通` / `端口不通` / `未探测`),完整说明走 tooltip。注意 `已连通` 只证明**端口通、对面 DSH 活着** —— 这个探测看不到「本浏览器的 cookie 是否还有效」,所以文案不声称已配对。

## 切走再切回,不会重新加载

`shell.overlay` 的条目是常驻的。切换面板时组件**不卸载**,只用 `display: none` 隐藏。

原因是把 iframe 从文档里移除会销毁它的 browsing context,切回来就是一次全新的远程加载,会话状态和滚动位置全丢;`display: none` 保留文档、状态和滚动位置,所以返回是瞬时的。同时探测定时器在隐藏期间会停,不会有后台轮询。

代价:隐藏期间远程页面仍在后台运行(保留着自己的会话与流式连接)。要彻底释放只能真的销毁它,而那正是重新加载。

## HTTP 接口

全部挂在 `/api/remote-dsh`,带一道回环围栏(socket 对端 + Host 头必须是回环,拒绝 `Sec-Fetch-Site: cross-site`,有 Origin 就必须等于 Host)。

> 该前缀比 `/api` 长,按最长前缀匹配优先于 Connection 的 RPC 桥,所以这道围栏由本插件自己负责。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/hosts` | local | 列出远程主机 |
| POST | `/hosts` | local | 新增或更新(`{ id?, name, url }`),url 规范化为 origin |
| DELETE | `/hosts/<id>` | local | 删除 |
| POST | `/probe` | local | 探测 `{ url }` → `{ reachable, status, dshAuthRequired, loopback, elapsedMs }` |
| GET | `/self-status` | **peer** | 本机会话状态 `{ version: 5, available, sessions: [{ running, ageMs, pending?, completedAgeMs? }] }`(唯一接受回环跨源来源的路由,见 [peer-status-badge.md](peer-status-badge.md)) |

注册表落在 `$DSH_HOME/remote-dsh.json`,权限 `0600`,写入走临时文件 + rename。

## 源码安装(改代码时用)

以源码开发时,profile 的 `cordis.patch.yml` 处于 live watch 之下,所以这条路**首次插入就能热加载,不需要重启**:

```bash
LINK="$HOME/.dsh/profiles/node_modules/dsh-remote-dsh"
PATCH="$HOME/.dsh/profiles/web/cordis.patch.yml"

ln -sfn "$PWD" "$LINK"

cat >> "$PATCH" <<'EOF'

- insert:
    - id: remote-dsh
      name: 'dsh-remote-dsh'
EOF
```

> **注意**:这套装法**和 `dsh plugin add` 二选一**。同时用会让同一个 id 插入两次。`dsh plugin add`(README 里的推荐装法)走的是 bundle 层,需要重启。

## 模块重加载的实际行为

| 改什么 | 生效方式 |
|---|---|
| `cordis.patch.yml` | **热加载**,无需重启(live patch watch) |
| `lib/client.js` | **刷新页面**即可 —— 实测 bundle 的 rev 会自动重算,服务端发的是新字节 |
| `lib/index.js` | **需要重启 DSH** —— live patch watch 只监听 patch 文件,HMR 的模块根是空的(不重载模块) |
| 新增 bundle 层(`dsh plugin add`) | **需要重启** —— `composed.bundlePatches` 是启动时捕获的 |

## 已知限制

- **每个远端必须装了本插件的 peer 角色才有状态点**,否则归入「状态不可读」;琥珀色还要求对方是 v4 以上的 peer。
- **被控端的 pending 只在 Host 侧观察到的请求上成立。** 如果某个第三方插件把待处理状态放在纯浏览器侧、不经过 `approval/request` / `user-questions/request` 这两个 waterfall,peer 就看不到它。
- **接管时盖住本地侧边栏**,返回靠顶栏按钮;焦点进了 iframe 之后 **Esc 会失效**(键盘事件被远程文档吃掉)。想保留侧边栏可见、只让右侧整块变远程,改一行 inset 即可。
- **配对标记只是个本地记号。** `localStorage` 里记的是"提交过 token",不是"cookie 还有效"。30 天到期或你在远程侧清了 cookie,设置行不会自动重新展开 —— 点一下「⚙」即可。
- **每个远端必须装了本插件的 peer 角色才有状态点**,否则归入「状态不可读」。
- **不支持跨站嵌入** —— 原因见 [why-loopback.md](why-loopback.md)。
- 只做"用起来",没做 agent 集成:没有把远程主机暴露成模型工具或系统提示。
