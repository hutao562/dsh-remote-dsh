# 状态徽标与 peer 角色

rail 上那个彩色点是怎么来的、为什么这么设计,以及它唯一一处放宽的安全边界。

## 徽标语义

| 颜色 | 含义 | 何时出现 | 何时消失 |
|---|---|---|---|
| **琥珀** | 远端有会话正卡在**等你回答**(批准 / 提问 / 计划评审) | 请求发出 | 那边被回答 |
| **蓝** | 远端有会话正在跑 | 开始运行 | 跑完 |
| **绿** | 自你上次打开远程视图之后,有会话被改动过 | 有活动 | **打开远程视图即清零** |
| **红** | 该远端的状态读不到 | 读不到 | 恢复后 |

展开时显示「点 + 计数」(例如 `●1 ●2 ●3`);收起成 36px rail 时只留一个点(按 琥珀 > 蓝 > 绿 > 红 取最高优先级),完整分解在 tooltip 里,含每台主机的明细。

**琥珀不会因为"你看过了"而消失** —— 它是活的阻塞状态,不是通知。得在远端那边真的把问题答了它才灭。这个优先级和远端自己侧边栏的行一致:一个正等你的会话不是"忙",是"停住了"。

### 绿点为什么不是"空闲会话数"

DSH 自己的状态点里,`done` 同时覆盖"已完成"和"空闲":

```js
// packages/client/ui-workspace/src/client/rows/Rows.tsx
if (node.completed) return [{ state: 'done', label: '已完成' }]
return [{ state: 'done', label: '空闲' }]
```

而"空闲"是会话的**持续属性**,不是事件。按状态常驻来做,徽标会退化成"远端有几个会话"的计数器 —— **永远不会消失**,也就没有信息量。所以这里改成按**事件**算:绿点 = 自你上次打开远程视图之后有过改动的会话数。打开远程即视为已读,当场清零(不等下一次轮询)。

配色取自远端侧边栏自己用的同一批 theme token,所以和它的会话列表完全一致。

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
- 返回的载荷**只有计数**:`{ version, available, sessions: [{ running, ageMs, pending? }] }` —— 没有会话 id、标题或内容,`pending` 也只是 `approval` / `question` / `plan-review` 三个词之一。
- DSH 自己的 `/api` **不受影响**,依旧不发 CORS 头。

**替代方案**是让本地 Host 半面做代理(不动围栏),但那要求本地 Host 模块重新加载 —— 也就是重启 DSH。实测确认 Host 半面的改动**不会**热加载,为了不打断会话,选了前者。
