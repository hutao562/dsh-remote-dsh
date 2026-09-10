# 为什么必须是本地回环端口

这是整个插件唯一需要理解的一件事,也是它和"直接填个公网地址"的本质区别。

## 机制

远程 DSH 的浏览器会话 cookie 由 [`packages/client/connection/src/browser-auth.ts`](https://github.com/deepseek-ai) 下发:

```
dsh-auth-<sha256(authority)>=…; HttpOnly; SameSite=Strict
```

两个后果,任何一个都足以致命:

1. **`SameSite=Strict` 是硬编码的**,插件改不了。跨 site 的 iframe 请求不会带上这个 cookie。
2. **远程连 `index.html` 本身就要求已认证** —— `authorizeIndex()` 在没有有效 cookie 时直接返回 `401` 纯文本,连 SPA 都加载不出来。

所以 iframe 能不能嵌,不取决于网络是否连通,而取决于**远程地址在浏览器眼里是不是和本地页面同一个 site**。SameSite 判定看 **scheme + 可注册域名,忽略端口**:

| 远程地址 | 与本地 `http://127.0.0.1:3080` 的关系 | 结果 |
|---|---|---|
| `http://127.0.0.1:3081`(ssh -L / frpc stcp·xtcp visitor) | **同 site**(端口不影响) | ✅ 可用 |
| `https://remote.example.com`(frps http/tcp 公网域名) | 跨 site | ❌ index 就 401 |
| `http://100.x.y.z:3080`(Tailscale IP 直连) | 跨 site,且 Host 不在 `trustedHosts` | ❌ 403 + 401 |
| `https://a.example.com` / `https://b.example.com`(同一域名下反代) | 同 site | ✅ 可用 |

## 一个实测旁证

cookie 名是 `dsh-auth-` + `sha256("127.0.0.1:3081")` —— **含端口**;而 `isTrustedApiRequest` 的 loopback 判定只看**不含端口的 hostname**。两者尺度不同,正是 3080 与 3081 能在同一个浏览器里各持一份 cookie、同时可用的原因。

```
$ curl -i 'http://127.0.0.1:3081/?token=…'
set-cookie: dsh-auth-w3iJaA6qw3qDSBs2Itl-h4S-Y-ZeYCC-N_iZO-eI_qw=…; HttpOnly; SameSite=Strict; Max-Age=2592000

$ node -e "…sha256('127.0.0.1:3081')…"
dsh-auth-w3iJaA6qw3qDSBs2Itl-h4S-Y-ZeYCC-N_iZO-eI_qw      ← 逐字符一致
```

## 所以:别用公网域名

**即使用 FRP,也要用 `stcp` / `xtcp` + frpc **visitor** 模式**,让远端以 `127.0.0.1:<本地端口>` 的形式出现,而不是拿 frps 暴露出来的公网域名。或者干脆 `ssh -L`。这样被控端一行配置都不用改。

面板会检测你填的地址:不是回环就当场给出警告,而不是让你对着白屏 401 猜。

## 确实需要公网域名怎么办

只有一条路:在**本地** DSH 的 `ctx.webServer` 上做同源反代 —— 由本地 Node 侧持有远程 cookie、剥掉响应的 `X-Frame-Options`,让 iframe 的 src 落在本地 origin 上。这样第三方 cookie、Host 闸门、Origin 闸门全部不适用。

代价是要透传 WebSocket / SSE 并做 cookie 续期,工作量约为当前实现的三四倍。当前版本没做。

## 相关:被控端的"桌面功能"误开

回环端口解决的是**嵌入**,和"被控端把桌面功能打开了"是两件独立的事 —— 后者会让文件夹对话框弹在你看不见的那台机器上。见 [remote-host-setup.md](remote-host-setup.md)。
