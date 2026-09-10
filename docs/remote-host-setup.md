# 被控端配置清单

被远程访问的那台机器,除了装 DSH 和本插件的 peer 角色,还要关掉几处**面向它自己桌面**的功能。否则你会遇到这类现象:点「打开工作区」,文件夹对话框弹在那台机器的屏幕上,你这边什么都没有。

## 根因:一个判据,三处受害

DSH 判断"操作者是否坐在本机显示器前"只用**一个信号** —— `launchedThroughSsh`(进程环境里有没有 `SSH_CONNECTION` / `SSH_TTY`)。全仓只有三处消费它,而这三处全是面向宿主机桌面的:

| 由该信号驱动 | 经 SSH 启动 | 本机 / 服务启动 |
|---|---|---|
| `directory-picker-auto` | 挂 `browse` | 挂 `native`(**宿主机系统对话框**) |
| `open-in-app` | 目录为空 →「Open In…」**按钮根本不渲染** | 列出宿主机已装的编辑器 / 终端 / 文件管理器 |
| `web-app` | 不做浏览器交接 | 启动时**在宿主机桌面弹一个浏览器** |

**被远程访问的机器通常由 systemd / 计划任务启动,而不是 SSH 启动** —— 于是 DSH 把它当成本机工作站,这三处全部打开。再加上两处不查该信号的宿主机打开动作,一共五组要钉死。

## 可直接抄的配置

写进**被控端** profile 的 `cordis.patch.yml`:

```yaml
# 1) 目录选择器 —— 钉成应用内浏览器
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'

# 2) 「Open In…」—— 否则会在宿主机桌面上启动编辑器 / 终端 / 文件管理器
- id: open-in-app
  disabled: true
- id: ui-open-in-app
  disabled: true

# 3) 启动时的浏览器交接
#    另两个字段一并复述,别依赖 config 的合并方式
- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true

# 4) 在宿主机上打开文件 / 文件夹 / 设置文件 / 预设目录
#    这两处不看 SSH 信号,必须显式关
- id: session-controller
  config:
    nativeOpen: false
- id: settings-controller
  config:
    nativeOpen: false
```

第 4 组的效果是**干净的**:客户端本就为此准备了 `menuDisabled = … || !host.available`,并显示本地化说明「此主机没有可用的桌面,无法打开文件或文件夹」,而不是留一个点了才报错的按钮。

`patchReload: live`(web 模板默认值)下改完即生效 —— **不需要重启被控端**。

## 怎么验证

两处互相印证:

```bash
# 组合树:每条的 disabled / config 是否如你所愿
dsh --profile web --dump-config | grep -A3 -E "id: (directory-picker|open-in-app|web-runtime|session-controller|settings-controller)"

# 实际下发的界面:client 行的增减
curl -s -H "Cookie: <被控端 cookie>" http://127.0.0.1:3081/ | grep -o 'dsh-client-ui-[a-z-]*picker-[a-z]*' | sort -u
# 期望:directory-picker-browse 在,directory-picker-native 不在
```

## 展开:目录选择器为什么必须插两行

**症状**:点「打开工作区」,文件夹对话框弹在**被控那台机器的桌面上**。

**原因**不在本插件,也不在 iframe。web bundle 里的那一行是:

```yaml
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
```

`-auto` 在启动时采样一次:`native` 要求 **loopback 绑定 + 非 SSH 启动 + 有可用的显示会话**。一台被远程访问的主机通常三条全中,于是挂上 `native` —— 而 native 的文档原文就是:

> Only viable when the operator sits at the host's display — remote deployments compose the browse backend instead.

**两条必须一起加。** `-auto` 是唯一会顺带挂载浏览器半面的行(`directory-picker-browse` 自己不声明 `dsh.client`),只插 host 那行会得到一个**没有对话框的 picker** —— 组合看着没问题,点下去毫无反应。这就是官方 `apps/web/tests/pin-browse-picker.overlay.yml` 要写两行的原因。

## Windows 上的重启陷阱

如果被控端是 Windows 且用计划任务托管,**`Stop-ScheduledTask` 不会连带结束 node 子进程**:任务状态显示 `Ready`,老的 dsh 进程却还在跑,于是你改的 Host 半面代码根本没加载。

要显式结束那个进程:

```powershell
Stop-ScheduledTask -TaskName dsh-web
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*dsh*bin.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName dsh-web
```

顺带一个同类细节:计划任务的 `ExecutionTimeLimit` 默认是 **3 天**,到点会静默杀掉服务。设成 `PT0S`(无限制)。
