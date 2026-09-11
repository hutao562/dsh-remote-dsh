# 状态徽标与 peer 角色

rail 上那个彩色点是怎么来的、为什么这么设计,以及它唯一一处放宽的安全边界。

## 徽标语义

| 颜色 | 含义 | 何时出现 | 何时消失 |
|---|---|---|---|
| **琥珀** | 远端有会话正卡在**等你回答**(批准 / 提问 / 计划评审) | 请求发出 | 那边被回答 |
| **蓝** | 远端有会话正在跑 | 开始运行 | 跑完 |
| **绿** | 自你上次打开远程视图之后,有会话被改动过 | 有活动 | **打开远程视图即清零** |
| **红** | 该远端的状态读不到 | 读不到 | 恢复后 |

展开时,每个状态是一枚**计数胶囊**(点 + 数字,底色是该状态色的 16% 淡染),整个胶囊组贴在行的**最右端**;收起成 36px rail 时标签没地方放了,就只留一个点挂在图标**右上角**(按 琥珀 > 蓝 > 绿 > 红 取最高优先级),完整分解在 tooltip 里,含每台主机的明细。

**为什么在最右端,而不是紧跟图标**:外壳把面板行渲染成 `[图标槽][文字]`,`renderSlot` 的内容住在图标槽里 —— 徽标只要还在文档流里,就排在文字**前面**,把「远程」两个字顶到右边、和别的行对不齐(第一版就是这样,用户一眼就看出来了)。`SIDEBAR_SEAM_CSS` 因此用 `:has([data-dsh-remote-badge])` **只对本行**把外壳的图标槽 `display:contents` 掉,图标和胶囊才成为行本身的 flex item,胶囊再用 `margin-left:auto` 落到最右。那一列不是随手取的:会话行的时间戳同样距行右缘 8px,两者在同一条竖线上。

胶囊的字号/行高/内边距**照抄设计系统的胶囊规格**(`Tag.module.css` 里那句 "a tag reads as one size everywhere":11px/17px、weight 500、`1px 8px`、全圆角),字体走 UI 栈而不是等宽栈,并加 `tabular-nums` —— 计数是"数量"不是"标识符",设计系统自己的数字胶囊(`StatsPills` / `TurnUsagePanel`)就是这么写的。理由见 [implementation.md](implementation.md#字体是选出来的不是继承来的)。

**琥珀不会因为"你看过了"而消失** —— 它是活的阻塞状态,不是通知。得在远端那边真的把问题答了它才灭。这个优先级和远端自己侧边栏的行一致:一个正等你的会话不是"忙",是"停住了"。

### 绿点为什么不是"空闲会话数"

DSH 自己的状态点里,`done` 同时覆盖"已完成"和"空闲":

```js
// packages/client/ui-workspace/src/client/rows/Rows.tsx
if (node.completed) return [{ state: 'done', label: '已完成' }]
return [{ state: 'done', label: '空闲' }]
```

而"空闲"是会话的**持续属性**,不是事件。按状态常驻来做,徽标会退化成"远端有几个会话"的计数器 —— **永远不会消失**,也就没有信息量。所以这里按**事件**算,而且对准的正是远端侧边栏自己那个 `completed` 提醒:**跑完了一轮、而你还没打开看过**。

### 绿点为什么不能用 `ageMs` 算(踩过的坑)

peer 上报的 `ageMs` 是 **`SessionSummary.updatedAt`**,而它是:

```js
// packages/api/session-controller/src/list.ts
function updatedAt(header, metadata) {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}
// lastPromptAt 只在 event.type === 'user/message' && data.source.kind === 'user' 时推进
```

也就是**最后一次"人"发消息的时间**。跑完一轮**不会**动它。实测这套部署里:

```
08:52:44  running:true   ageMs: 381518   ← 提示发生在 6.4 分钟前
08:53:50  running:false  ageMs: 447228   ← 跑完了,但 ageMs 还在从"提示"起算
09:01:01  running:false  ageMs: 878482   ← 而且继续涨
```

于是"一个 7 分钟前被提示、刚跑完的会话"和"一个闲着没跑的会话"**在单次快照里长得一模一样**。按 `ageMs < 你上次查看距今` 判定,只要你是**在提示之后、跑完之前**打开过远程视图(很正常 —— 你就是去看它干活的),绿点就永远不会亮。

**只有 running→idle 这个边沿能说出这件事,而边沿需要两次观测。** 所以 peer 半面在自己的 register 里盯着它:

```js
// packages/interaction/... —— 不是;这是 lib/index.js 里的 createPeerTracker
observeRunning(sessionId, live, now) {
  const previous = prevRunning.get(sessionId)
  prevRunning.set(sessionId, live)
  if (live) { completedAt.delete(sessionId); return }   // 又跑起来了 → 撤销提醒
  if (previous === true) completedAt.set(sessionId, now) // 衰落沿 → 记一笔
}
```

然后每一行按同一个形状上报`completedAgeMs`(距今多久跑完的),客户端取**这一行上两个时长里较小的那个**:

```js
function activityAgeMs(session) {
  var age = Number.isFinite(Number(session.ageMs)) ? Number(session.ageMs) : Infinity;
  var finished = Number(session.completedAgeMs);
  return Number.isFinite(finished) && finished < age ? finished : age;
}
```

几个刻意的选择:

- **寄存器按真实 session id 记,而 id 从不出网。** 这是把计数做成"会话数"而不是"信号数"的关键:一个会话同时满足"提示过"和"跑完了"时,两个时长落在**同一行**上,取小值就合成一个。反过来,如果让读的那一侧自己数边沿,它就分不清"一个会话跑完两次"和"两个会话各跑完一次",也分不清"只是被提示过"和"确实跑过"。
- **"活着"包含卡在等你的会话。** 一个会话从"在跑"变成"等你回答"不该被当成跑完 —— 那种情况已经在闪琥珀了。
- **第一次观测只记位、不记完成。** 加载时就已经闲着的会话不会补一条提醒,和远端自己的侧边栏一致。
- **会话再次运行会撤销提醒**,也和浏览器的 session manager 一致。
- 寄存器在 peer 进程里,所以**刷新页面不会丢**;而 peer 重启后它自然为空,不会假装所有会话刚跑完。

`ageMs` 那条规则还在,管的是另一种事:"有人在别处提示了这台远端" —— 那种情况你浏览器可能根本没开着,任何边沿都观测不到。它和 `completedAgeMs` 各自都是 peer 测出的**时长**,所以判定依旧不依赖两台机器的时钟一致。

> **这里踩过一个坑:绿点后面的数字出现过 2,而实际上只有一个会话跑完。** 原因是当时读的那一侧把两个信号**相加**了 —— "提示过"算一个、"跑完边沿"算一个,同一个会话就占了两个;而那个用来兜底的"不超过会话总数"上限,在一个有两台会话的 peer 上恰好是 2,完全挡不住。现在两个信号落在同一行上取小值,结构上就不可能再加起来。

配色和形状取自远端侧边栏自己用的同一批 theme token 和同一套画法,所以和它的会话列表完全一致:

- **琥珀 / 绿 / 红**是实心点 —— 和 `StateDot` 一样,一圈 0.10 不透明度的光晕 + 中间 6/10 大小的实心核。
- **蓝**就是会话列表里那个 **8 格追逐动画**:10px 网格上八个 2px 方块,从左上角起顺时针各占一格,每格停在四档离散亮度之一(峰值 1 → 0.6 → 0.35 → 0.15),逐格错开 125ms。关键帧和 `StateDot.module.css` 逐字一致。

关键帧没法用 React 内联样式表达,所以这份 CSS 单独注入一张带 `status-dot` 标记的 `<style>`;格子类名带前缀,因为它是全文档生效的。

### 琥珀色(等你处理)是怎么拿到的

`pendingInteraction` 在浏览器那边确实是**拼出来的**:它由 approval / user-questions 这些客户端包注册的 pending domain 汇总(见 `uiSession.pendingInteractions`),**Host 侧没有任何服务把它当数据暴露出来**。

但 Host 侧有**请求本身**。这两个包都是发一个 scope-filtered 的 waterfall,只有等某个 answerer 返回才结算:

```js
// packages/interaction/user-approval/src/index.ts
this.ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, () => 'unavailable')

// packages/interaction/user-questions/src/types.ts —— 同一个形状
'user-questions/request'(request, next): Promise<AskUserQuestionAnswer>
```

所以 peer 半面在根 context 上挂两个监听(**和 Remote-event 桥接用的是同一个挂法**),把 waterfall 攥在手里直到它结算:

```js
ctx.on('approval/request', function (request, next) {
  return holdPending(tracker, requestSessionId(request), 'approval', next)
})
ctx.on('user-questions/request', function (request, next) {
  return holdPending(tracker, requestSessionId(request), questionKind(request), next)
})
```

`holdPending` 是**透明的链节**:记录 → `next()` → 结算时释放。它不回答、不吞异常、不改结果(下游同步抛出的异常照样同步抛出),唯一的副作用是这段时间里这个会话被标成"等你"。请求该到哪个浏览器还是到哪个浏览器。

三个细节:

- **一次会话可能同时挂着多个请求**(嵌套提问),所以每个请求按 token 记,一个会话对外只报**优先级最高的那个** —— 和客户端 pending domain 的排序一致:计划评审 > 提问 > 批准。
- **子代理的请求归到它的顶层祖先**。sidebar 不把子代理当独立行显示,所以一个卡住的子代理如果不往上归,读者就什么也看不到 —— 而它确实把父会话的任务堵住了。
- 只在 `role: 'peer'` 时挂。本地那一侧不需要,也就不进它的 listener 链。

契约版本随之从 3 升到 4(多一个**可选**的 `pending` 字段)。**读的一侧同时接受 3 和 4**:一台还没升级的 peer 只是永远不上报 `pending`,不会因此变成红的。

## 数据怎么过来的:peer 角色

### 绕不过去的约束

**DSH 全仓没有任何 CORS 头**(`grep access-control-allow-origin` 零命中)。于是:

- 本地页面跨源读远端 `/api` → 浏览器不会把响应交给 JS。
- 远端的会话 cookie 是 `HttpOnly` → 页面读不到,也就没法交给自己的 Host 半面代劳。

所以只有两条路:**本地持凭据**,或**远端自己上报**。本项目选后者,因为它**不需要任何凭据**。

### 两种角色

```yaml
- insert:
    - id: remote-dsh
      name: 'dsh-remote-dsh'
      config:
        role: 'peer'      # 被控端;省略即 local(默认)
```

| 角色 | 行为 |
|---|---|
| `local`(默认) | 主机注册表 + `hosts` / `probe` 路由 + 完整界面 |
| `peer` | 只在**回环**上发布本机自己的会话状态,**不渲染任何界面** |

peer 不渲染界面是刻意的:这台机器的 GUI 正是本地实例要嵌的东西,在它里面长出一个「远程」行等于把功能套进它自己。自禁是通过 `tapIndex` 往 index 注入一个同步标记做的 —— 异步探测会先闪一下行再消失。

### 被控端怎么装

```bash
dsh plugin --profile web add dsh-remote-dsh
```

然后在被控端的 profile `cordis.patch.yml` 里做一次 **id 定向的 config 覆盖**(注意是覆盖,不是再插一行 —— 包自带的 patch 插入的是默认 `local` 角色):

```yaml
- id: remote-dsh
  config:
    role: 'peer'
```

装完要重启被控端的 dsh —— Node 半面的改动不会热加载。

## 为什么不比较两台机器的时钟

peer 上报的是 **`ageMs`(距今多久)**,不是 `updatedAt`(绝对时间戳);读的那一侧比较的是"这个会话多久前被改过"和"我多久前看过" —— **两边都是时长**,所以结论不依赖两台机器的时钟是否一致。

这不是洁癖。实测这套部署里,**被控端的时钟比本地快约 2.96 秒**(已抵消 SSH 往返测得):

```
SSH 往返     : 1018 ms
远端 - 中点  : 2960 ms   ← 真实偏差
```

如果按绝对时间戳比,一个"你看之前 2 秒刚被改过"的会话会被算成"你看之后发生的",**绿点于是清不掉** —— 正是这个功能要避免的症状。

## 唯一一处围栏放宽,以及它有多大

peer 的 `self-status` 路由接受**回环来源**的跨源读取,并回 `access-control-allow-origin`。这是全项目唯一主动放宽的安全边界,范围如下:

- 只在 `/api/remote-dsh/self-status` 这一条**只读**路由上放宽;其它路由的 Origin 仍必须等于 Host。
- 只接受 **loopback hostname** 的来源(本地 GUI 在 `127.0.0.1:3080`,peer 在 `127.0.0.1:3081` —— 同 site 但跨源,Origin 不可能等于 Host,这正是需要放宽的原因)。
- 非回环来源、以及带 `Sec-Fetch-Site: cross-site` 的请求**依旧 403**。
- 返回的载荷**只有计数**:`{ version, available, sessions: [{ running, ageMs, pending?, completedAgeMs? }] }` —— 没有会话 id、标题或内容,`pending` 也只是 `approval` / `question` / `plan-review` 三个词之一。
- DSH 自己的 `/api` **不受影响**,依旧不发 CORS 头。

**替代方案**是让本地 Host 半面做代理(不动围栏),但那要求本地 Host 模块重新加载 —— 也就是重启 DSH。实测确认 Host 半面的改动**不会**热加载,为了不打断会话,选了前者。
