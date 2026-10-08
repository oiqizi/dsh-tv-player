# dsh-tv-player

> **非官方、社区维护项目**：本插件与 DeepSeek Harness 官方无任何关联，仅作为个人学习/自用工具提供。

[![npm](https://img.shields.io/npm/v/dsh-tv-player)](https://www.npmjs.com/package/dsh-tv-player)
[![GitHub](https://img.shields.io/github/stars/oiqizi/dsh-tv-player?style=social)](https://github.com/oiqizi/dsh-tv-player)

- **npm**：https://www.npmjs.com/package/dsh-tv-player
- **GitHub**：https://github.com/oiqizi/dsh-tv-player

DSH 电视插件 —— 在 DeepSeek Harness 里直播 **8 个确定稳定的频道**（浙江 / 延边 / 香港 / 内蒙古 / 河北 / 东方卫视 + CCTV-9 纪录 / CCTV-12 社会与法），白底黑字的播放条与全宽电视画面，写代码时把电视放在聊天输入框上方，是 **Vibe coding 时的好伴侣**。

参考 `dsh-music-player` 的双面结构：Host 端跑频道目录 + 同源直播流代理 + `tv_play` 模型工具，Web 端用 `<video>` + hls.js 播放。

## 特性

- **8 个精选频道**：浙江 / 延边 / 香港 / 内蒙古 / 河北 / 东方卫视走各台官方 CDN、音轨为浏览器可解码的 AAC；CCTV-9 纪录 / CCTV-12 社会与法走公开中继源（含备用源）；每个频道带多个候选流 URL，失效自动切换。
- **临时频道搜索**：频道面板标题栏 🔍 一键展开，自动列出公开 IPTV 源里可播放的频道（央视/卫视/凤凰）；点结果加入底部「📌 临时频道」栏，可播放/移除。
- **白底黑字 + 中英双语**：播放条、电视画面区、频道面板统一白底黑字；所有按键提示与面板文字均为「中文 English」双语。
- **频道面板**：锚定在电视画面区内右侧（不遮挡输入框），含「★ 我的收藏」「卫视」「央视」分组、🔍 临时频道搜索与「📌 临时频道」栏。
- **收藏夹**：频道行尾 ⭐ 一键收藏/取消，持久化在 Host（`~/.dsh/tv-player-favs.json`）。
- **EPG 节目单**：频道列表显示「现在 · 节目名」（fanmingming e.xml，XMLTV 格式，落盘缓存 6 小时）。
- **定时（换台 / 关电视 / 关电脑）**：面板底部配置「每天/指定星期 · 时刻」的自动动作——切到某频道、停止播放、或关机（`shutdown /s /t 30`，30 秒内可 `shutdown /a` 取消）；Host 端 Node 定时器自维护、脱离会话存活，持久化 `~/.dsh/tv-player-schedule.json`。
- **多源容灾**：同名频道累积多个候选流 URL，播放中某个源失效时自动切换下一源。
- **多标签页统一播放器**：同时开多个 DSH 标签页时只有一页出声（BroadcastChannel 协同 + 心跳失效检测）。
- **初始为关电视状态**：启动/刷新后不自动恢复频道、不显示画面；需要时点 ▶（随机播一个频道）或选台开播。
- **`tv_play` 模型工具**：在对话框说「播放浙江卫视」即可开播；支持 pause/resume/stop/mute/unmute/next/prev 动作。
- **同源流代理**：Host 端重写 m3u8 分片 URL 到同源 `/dsh-tv/segment`，规避上游无 CORS 的跨域问题；纯透传、不转码、不落盘。

## 安装

### 方式一：编辑 profile（推荐，已发布到 npm）

1. 打开目标 profile 的 `package.json`（例如 `~/.dsh/profiles/<profile>/package.json`），把 `dsh-tv-player` 同时加到 `dependencies` 和 `dsh.profile.bundles`：

   ```json
   {
     "dependencies": { "dsh-tv-player": "^1.4.0" },
     "dsh": { "profile": { "bundles": [ "...", "dsh-tv-player" ] } }
   }
   ```

   > ⚠️ `dependencies` 和 `dsh.profile.bundles` **两个都要加**——漏了 `bundles` 插件不会被加载，界面/路由都不会出现。

2. 在 profile 目录执行：

   ```sh
   pnpm install
   ```

3. 重启 DSH。

### 方式二：本地 tgz（自用 / 内部分发）

```sh
# 1) 打包
npm pack            # 产出 dsh-tv-player-<version>.tgz
```

然后编辑目标 profile 的 `package.json`（例如 `~/.dsh/profiles/<profile>/package.json`）：

1. 在 `dependencies` 里加：
   ```json
   "dsh-tv-player": "file:D:/绝对路径/dsh-tv-player-<version>.tgz"
   ```
2. **务必**在 `dsh.profile.bundles` 里加 `"dsh-tv-player"`（漏了它插件不会被加载，界面/路由都不会出现）：
   ```json
   "dsh": { "profile": { "bundles": [ "...", "dsh-tv-player" ] } }
   ```
3. 安装并重启：
   ```sh
   pnpm install        # 在 profile 目录执行
   # 然后重启 DSH
   ```

### 方式三：从 GitHub 安装（git 依赖 / 源码）

把 `dsh-tv-player` 的依赖写进 profile 的 `package.json`，二选一：

```json
// 3a. 直接拉 main 分支（最新源码）
"dependencies": { "dsh-tv-player": "github:oiqizi/dsh-tv-player" }

// 3b. 指定版本 tag（已发布版本）
"dependencies": { "dsh-tv-player": "github:oiqizi/dsh-tv-player#v1.4.2" }
```

并同样在 `dsh.profile.bundles` 里加 `"dsh-tv-player"`，然后在 profile 目录执行：

```sh
pnpm install
```

或者 **clone 后本地打包**（离线/自用）：

```sh
git clone https://github.com/oiqizi/dsh-tv-player.git
cd dsh-tv-player && npm pack   # 产出 dsh-tv-player-<version>.tgz
```

再把 tgz 按「方式二」的 `file:` 方式加到 profile。

安装后重启 DSH，打开 Web GUI：聊天输入框上方会出现「DSH 电视」播放条。

## 使用

### 对话开播

- 「**播放浙江卫视**」「**播放东方卫视**」→ agent 调 `tv_play` 匹配频道并开播。
- 「**暂停电视 / 继续 / 停止 / 静音 / 下一个频道**」→ agent 调 `tv_play` 的传输动作。
- 首次可能被浏览器拦截自动播放，在播放条点一次 ▶ 解锁即可。

### 播放条

- ▶/⏸ 播放暂停、🔊 静音、音量滑块、⏮ ⏭ 上/下一个频道、⏹ 停止、👁/🙈 显示/隐藏电视画面、📺 频道列表。
- 无当前频道时点 ▶ 会**随机播放一个频道**。

### 频道面板

- 播放条「📺」打开频道面板（锚定在电视画面区内右侧）。
- 点任意频道即播放；行尾 ⭐ 收藏/取消收藏；当前频道高亮并带「LIVE」徽标。
- 底部「⏰ 定时」添加三类规则：**换台 / 关电视 / 关电脑**。

## 配置

`cordis.patch.yml` 里可覆盖（Schemastery 校验字段）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 主开关，`false` 不挂载任何能力 |
| `sources` | `[]`（空） | 在线 m3u 目录源列表；默认关闭（精选 8 频道模式） |
| `epgUrl` | fanmingming e.xml | EPG（XMLTV）数据源 |
| `epgTtlMs` | `21600000` | EPG 落盘缓存 TTL（毫秒） |
| `catalogTtlMs` | `1800000` | 目录缓存 TTL（毫秒） |
| `timeoutMs` | `15000` | 单次上游请求超时 |
| `retries` | `1` | 目录/播放列表拉取重试次数 |
| `maxChannels` | `400` | 收录频道上限 |

## 架构

```
Host（lib/index.js + channels.js + proxy.js + config.js + epg.js）
 ├─ 频道目录：内置 8 个精选频道（多候选 URL）→ 归类去重 → 缓存
 ├─ /dsh-tv/playlist  拉上游 m3u8 并重写分片/子列表/密钥 URL 到同源
 ├─ /dsh-tv/segment   分片逐字节透传（附 Referer/UA 防盗链）
 ├─ /dsh-tv/vendor/hls.min.js  内嵌 hls.js（客户端 <script> 注入）
 ├─ 定时器：换台 / 关电视（下发 stop）/ 关电脑（shutdown）
 └─ tv_play 工具 → pendingIntent → 客户端轮询 /dsh-tv/intent 领取

Web（lib/client.js）
 ├─ <video> + hls.js（Safari 回退原生 HLS）
 ├─ 电视画面 + 播放条（conversation.input.dock，白底黑字）
 └─ 频道面板（锚定电视画面区内右侧，含定时规则）
```

与音乐播放器一致：Host 端 `webServer.register({ kind:'prefix', path:'/dsh-tv', handler })` 挂路由，`ctx.tools.register` 挂工具；Web 端 `slots.inject` 注入 UI，轮询 `/dsh-tv/intent` 接收播放意图。

> **为什么需要同源代理**：IPTV 直播多为 HLS，上游通常不返回 CORS 头，浏览器 `<video>`+hls.js 直接跨域拉流会被同源策略拦截；Host 端把分片 URL 重写到同源路径后即可直接播放，同时给上游补 `Referer`/`User-Agent` 满足防盗链。

## 合规声明

- 播放的是各电视台 / 运营商**公开直播流**（卫视走各台官方 CDN，CCTV-9/12 走公开中继源），目录为开放数据（社区维护）；**不录制、不二次分发、不绕过付费墙 / DRM**，内容版权归电视台 / 版权方。
- 仅供**个人收看 / 学习研究**使用，请遵守各台站服务条款与**所在国家 / 地区法律**；本项目作者不承担由此产生的任何责任。
- **不保证频道持续可用**：直播源由第三方公开提供（含中继源），可能随时变更、失效、受地理限制或存在画质/稳定性差异，插件作者不对此负责。
- 「定时关电脑」会调用系统 `shutdown` 命令，属**明确授权的本地操作**，请谨慎使用。
- 本插件内含第三方组件 **hls.js**（Apache-2.0），详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

> 以上为合规提示，不构成法律意见。

## 开发

```sh
npm pack            # 产出 dsh-tv-player-<version>.tgz
# 手动安装：编辑 profile 的 package.json（dependencies + dsh.profile.bundles），然后 pnpm install
```

修改 `lib/` 后**升版本号**重新打包安装（pnpm 对同版本 file 依赖不重取）；仅客户端改动可刷新页面生效，Host 改动需重启 DSH。

## 回滚（卸载）

```sh
# 1) 编辑 profile 的 package.json：从 dependencies 和 dsh.profile.bundles 里都删掉 "dsh-tv-player"
# 2) 在 profile 目录执行 pnpm install
# 3) 重启 DSH
```

或直接用面板：设置 → 插件管理 → 停用/移除 `dsh-tv-player`。改动仅限该 profile，卸载后即恢复原状。

## License

[MIT](LICENSE)
