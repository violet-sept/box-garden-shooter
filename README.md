# 箱庭射击 · Box Garden Shooter

一个**能立刻上手、单手就能玩明白**的小型 3D 箱庭射击游戏：你站在一块被围栏圈起的立体沙盘里，先用步枪点掉分五批落下来的 30 只小敌人，再去面对那只慢慢走过来的大块头——它会用**一条黄色的直线**把你从掩体后面逼出来。

**一局的形状是固定的脚本，不再是按曲线加码的波次**：开局先给你 **10 秒空场**（屏幕顶上一条倒计时 `第一批敌人还有 N 秒到达战场`），然后 **30 只潜袭者分五批、每隔 10 秒落一批**（5 / 5 / 5 / 5 / 10，最后一批在 t = 50 s，都带 0.9 s 的落地预警）；**把最后一只也清掉、场上没有任何别的东西之后**，典狱长才出场——一条命里只有它一只，而且**没有超时兜底**：不去清掉最后一只潜袭者，就永远见不到它。

> **屏幕上的标题是 `DARKSHOOTER`**（启动遮罩上的大字与浏览器标签页都是它）。**项目名与桌面端产品名仍然是「箱庭射击」**：`productName`、快捷方式名与 NSIS 安装包名一个字都没改。

一套代码两端发布：**浏览器里打开即玩**（也可以挂成一个网址，见 §2.3），或**双击 Windows `.exe` 直接进**。两端加载的是同一份 `dist/`、同一个固定步长模拟、同一张数值表。

> ## 🎮 在线游玩：<https://violet-sept.github.io/box-garden-shooter/>
>
> 点开即玩，不需要安装任何东西。首次进入**点一下画面**取得鼠标锁定（这是浏览器的硬性要求，桌面端也一样）。
>
> [![Deploy web build](https://github.com/violet-sept/box-garden-shooter/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/violet-sept/box-garden-shooter/actions/workflows/deploy-pages.yml) —— 推 `main` 即自动构建 + 全量测试 + 部署；**阶段 5 那次发布时**，线上 `index.html` 与两个分包已核对为与**当时**的本地 `dist/` 字节一致（见 [`docs/交付说明.md`](docs/交付说明.md) §2.5）。⚠️ **线上至今仍是那一份旧构建**（"鼠标不能转视角"的 `89c115e`），阶段 6 起的修复都还没发布——想玩到当前版本要推一次 `main`，或者先用 `npm run preview`。

---

## 1. 操作

| 输入 | 行为 |
|---|---|
| `W` / `A` / `S` / `D` | 前 / 左 / 后 / 右移动（方向按**摄像机朝向**解算） |
| **移动鼠标** | 转视角（取得鼠标锁定之后；灵敏度与开镜倍率都在 `src/core/config.ts`） |
| **鼠标左键** | 射击（按住持续射击） |
| **鼠标右键** | 开镜瞄准（ADS，按住生效）：视野 78°→45°（目标被拉近），准心**变大**并换成高亮加粗的瞄准环，移速 ×0.55、扩散 3.4°→0.35°。右键**不会打开浏览器菜单**——整页的 `contextmenu` 都被吃掉，只有在游戏中（指针锁定后）才会变成开镜 |
| `R` | 换弹（可打断窗口 0.35s；空仓换弹更快） |
| `E` | 投掷道具（抛物线，1.4s 引信，5.5m 溅射） |
| `Shift` | 疾跑 |
| `Space` | 跳跃（**二段跳**：空中再按一次；按住不放只有一段，每两次落地之间最多 2 段） |
| `M` | 静音 / 取消静音（设置会记住） |
| `V` | **切换第一 / 第三人称**（点按切换；**刚进游戏是第一人称**，每次重新开始也回到第一人称） |
| `F3` | 调试统计面板（含当前局种子） |
| `F4` | 命中日志 `[HITLOG]` |
| `Esc` | 暂停：弹出**半透明暂停窗口**，里面从上到下是 `结束暂停` / `重新开始` / `返回主界面`（返回标题页） |

进入游戏需要**点一下画面**取得指针锁定——这是浏览器的硬性要求，桌面端同样如此。**这一下点击也是这一局的 t = 0**：标题遮罩挂着的时候世界是**冻结**的（画面照常渲染，但模拟一步都不走），所以开局的 10 秒空场与整局的时钟不会花在标题页上，也不会有敌人偷偷在遮罩后面落地。被围栏圈起的场地里没有出口，掉不出去。

角色的**身体朝向和镜头是分开的**：镜头转到哪，子弹就往哪飞；而身体会**用四分之一秒左右转过来**面向你正在走的方向（站住不动时才跟着镜头转）。场上的灯柱、天线、货箱堆和管路**都是实体**——它们既挡人也挡子弹。每个敌人**头顶有一条红色血条**（潜袭者短、典狱长长，长度跟体型走），玩家**右手边握着一把枪**（黑色握把 / 枪托 / 扳机，枪管前段与枪口是橙色）。

**开局那 10 秒，屏幕顶上有一条倒计时**（`第一批敌人还有 N 秒到达战场`，从 10 数到 1，警告色）：它只属于开局——后面四批不再倒数，按阶段 3 以来的老规矩用**地面光环 + 提示音**宣告落点。

**典狱长的攻击是一条黄色的直线**：蓄力 1.35 秒期间，从它身上会拉出一条**黄色瞄准线**指向你，并在最后 0.35 秒开始快闪；线一亮起来它就不再改主意——**发射瞬间方向就被冻住**，之后是一枚沿这条直线飞的黄色弹丸，只要你还**站在这条线上**就会被 34 点伤害正面打中，**挪开就完全打不到**。这条线会被货箱挡住（挡在箱子后面是安全的），也**只打玩家**，不会误伤它自己的小兵。

**典狱长有 4800 点血**（阶段 10 从 2400 翻倍）。这个数字现在是一道硬门槛：躯干射击要 `ceil(4800 / 22) = 219` 发，而一局总共只带 30 + 210 = 240 发子弹，其中 30 只潜袭者还要吃掉大约 90 发；打弱点则是 `ceil(4800 / (22 × 1.6)) = 137` 发。**也就是说只打躯干是打不完它的——它现在是一场打弱点的仗。** 想把这道门槛放松，动的是 `WEAPON.reserveAmmo`，不是这个血量。（抬手 1.35 s / 出招 0.25 s / 收招 1.5 s / 冷却 2.8 s / 34 伤害 / 26 m 交战距离 / 狂暴 ×0.75 都没有变。）

`V` 只改**你从哪儿看**：第一人称把相机放到眼睛上、把身体藏起来、把同一把枪挪到镜头前；第三人称是那个过肩机位。**两种视角的弹道完全相同**（同一份瞄准解算），所以切换视角不需要重新适应准星。视角数字在 `src/core/config.ts` 的 `VIEW` 里，默认视角是 `CAMERA.defaultView`。

---

## 2. 跑起来

### 2.1 环境

| 项 | 要求 |
|---|---|
| Node | **≥ 22.15.0**（Vite 8 本身只要求 ≥ 22.12，但这道坎是 `tests/preload.mjs` 的 `module.registerHooks`——**Node v22.15.0 才引入**，低于它的版本 `npm test` 会直接崩；本仓库在 Node v24.18.0 上验证） |
| 桌面端目标平台 | **Windows x64**（只有 Windows 打包配置，见 §6） |
| 依赖安装 | `npm install`（无原生模块，无需编译工具链） |

### 2.2 Web 端

```powershell
npm install        # 安装依赖（纯 JS，无原生编译）
npm run dev        # 开发服务器 → http://localhost:5173
npm run build      # 类型检查 + 生产构建 → dist/
npm run preview    # 用生产构建起本地服务 → http://localhost:4173
```

`npm run preview` 是"上传前先过一遍"的本地等价物：它托管的就是 `dist/` 里那几样东西。

产物体积（`npm run build` 实测输出，即 Vite 自报的数）：

| 文件 | 原始 | gzip |
|---|---|---|
| `dist/index.html` | 10.73 kB | 3.92 kB |
| `dist/assets/index-B1tVGo8u.js` | 124.51 kB | 42.73 kB |
| `dist/assets/three-DQQBLnPL.js` | 630.37 kB | 158.80 kB |

three 单独分包（`manualChunks`），因为它几乎不变、而游戏代码经常变；改一次游戏代码的玩家只需要重新下载那 124 kB。
（逐字节的原始 / gzip / brotli 读数在 [`docs/交付说明.md`](docs/交付说明.md) §1；那里用的是本地 `node:zlib`，与 Vite 自报的 gzip 略有出入，属口径差异。）

### 2.3 发布成一个网址（GitHub Pages，不需要终端）

**这个仓库已经是一个"点开就玩"的链接**：**<https://violet-sept.github.io/box-garden-shooter/>**

它不是另做的一份打包，而是**同一份产物 + 一次仓库设置**：产物纯静态、所有引用都是相对的（`base: './'`），所以能直接挂在子目录下。要在别处（fork 到另一个账号、换自定义域名）复现，只有两件事：

1. 仓库必须是 **public**（免费账户的 Pages 只对公开仓库开放）。
2. **Settings → Pages → Source 选 “GitHub Actions”**。

之后每次推 `main`，[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) 会自动 `npm ci` → `npm test` → `npm run build` → 把 `dist/` 发到 Pages：

| 仓库名 | 站点地址 |
|---|---|
| `<user>.github.io` | `https://<user>.github.io/` |
| 其它（如 `box-garden-shooter`） | `https://<user>.github.io/box-garden-shooter/` |

自定义子域名（如 `game.example.com`）在 **Settings → Pages → Custom domain** 里配 + DNS 加一条指向 `<user>.github.io` 的 CNAME；**不要在仓库里加 `CNAME` 文件**（Actions 发布时它会被忽略）。完整说明、Pages 不支持自定义缓存头这件事、以及国内连通性的实话，都在 [`docs/交付说明.md`](docs/交付说明.md) §2.5。

### 2.4 桌面端

```powershell
npm run desktop:dev      # 直接起 Electron 壳（加载磁盘上的 dist/）
npm run desktop:build    # 先 npm run build，再用 electron-builder 打包
npm run desktop:accept   # 启动真实外壳与打包产物，逐项断言并截图
```

打包产出：

| 产物 | 路径 |
|---|---|
| 免安装 | `release\win-unpacked\box-garden-shooter.exe` |
| NSIS 安装包 | `release\箱庭射击-1.0.0-win-x64.exe` |
| 验收证据 | `.tmp-accept\report-{shell,packaged}.json` · `screenshot-*.png` · `stdout-*.log` / `stderr-*.log` |

> **`desktop:build` 与 `desktop:accept` 必须在普通（非受限沙箱）终端里跑。**
> 受限沙箱会拒绝 Chromium 的命名管道 IPC（`platform_channel.cc ... 拒绝访问 (0x5)`），
> 任何 Electron 进程都起不来；`electron-builder` 的模块收集器还会 `spawn EPERM`。
> 判据很直接：**只要还看到 `platform_channel.cc`，就说明还在沙箱里。**

打包卡在下载 Electron 框架时（GitHub 超时），用**已经解压好的那份**离线打包。注意要用**长参数形式**——短的 `-c.electronDist=` 会被解析成一个名为 `.electronDist=...` 的配置文件：

```powershell
# 离线打包（推荐；Electron 直接用 node_modules 里已解压的 246 MB）
npm run desktop:build -- --config.electronDist=node_modules/electron/dist

# NSIS / winCodeSign 是另一批下载，走镜像兜底
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```

### 2.5 验收脚本在验什么

`npm run desktop:accept` 通过 CDP 连上真实渲染进程，断言：进程没有早退 · `document` 加载完成 · WebGL2 上下文可用且未丢失 · 启动遮罩盖着画面且 HUD 隐藏 · **点击后拿到指针锁定、遮罩隐藏、HUD 显示** · 帧时钟在跑 · **截图像素里真的有画面**（整帧 + 一条不含 HUD 的场景带，两条都要有对比度）· 零 console error · 零未捕获异常 · 零非 `file://` 请求（即无 CDN 依赖）· 零加载失败（唯一的白名单是尚未交付的人物模型）。

`--scene perf` 会打开性能场景（120 实体 + 满射速），额外给出 `fps` / `stepMs` / `renderMs` / 最长帧：

```powershell
npm run desktop:accept -- --scene perf
```

> 脚本会在连上之后**强制 reload 一次**页面：只有这样，`requestWillBeSent` 才观察得到请求（否则"零外部请求"这条断言什么都没测到），失败加载也才带得上 URL。

---

## 3. 数值在哪

**`src/core/config.ts` 是唯一的数值真源。** 手感、敌人、投放节奏、道具、渲染、性能、**音频配方**全在那一个文件里；别处出现字面量就算 bug。

顺带几条容易踩的约定：

- 模拟走 `src/core/loop.ts` 的固定步长（60 tick/s），所有与时间相关的量都乘 `dt`。
- 随机一律用 `src/core/math` 里可播种的 `Rng`，**不用 `Math.random()`**——这是 `?scene=perf` 双端一致性的前提。
- `src/game/**` 不得 import Three.js 的渲染类；`src/render/**` 不得包含游戏规则判断；只有 `src/main.ts` 接触 `document` / `window`。

---

## 4. 接入人物模型（唯一需要外部交付的资产）

程序化占位体已经能玩，模型是**运行时加载**的增强项——放进目录就生效，**不需要改任何代码**。

```
public/assets/models/player/
  ├─ player.glb            # 必需，单个文件，动画内嵌
  └─ (可选) player_ads.glb # 专用开镜姿态；没有就用动画混合
```

`public/` 目录**当前不存在**，需要自己建。把模型放到完整路径 **`public/assets/models/player/player.glb`**；加载地址是 **`./assets/models/player/player.glb`（相对当前页面，`src/render/models/CharacterLoader.ts` 的 `PLAYER_MODEL_URL`）**——相对而不是 `/assets/...` 是刻意的：桌面端跑在 `file://` 下、GitHub Pages 项目站跑在 `/<repo>/` 下，绝对路径在这两种情况下都会去错地方，而"模型缺失"是**被支持的降级路径**，于是它会静默换成程序化占位体、什么提示都没有。

| 约定 | 值 |
|---|---|
| 单位 | 米；身高约 1.75 m；站立时脚底在局部 `y=0`；面朝 `+Z` |
| 格式 | `.glb`（不是 `.gltf` + 外部 bin）。Draco 可选，但要一并提供 decoder |
| 面数 | 建议 ≤ 30k 三角面 |
| 动画 Clip 命名 | 大小写不敏感的关键字匹配（见下表） |

| 状态 | 匹配的关键字 | 缺失时的降级 |
|---|---|---|
| `idle` | `idle` · `breath` · `stand` | —（兜底状态） |
| `walk` | `walk` | → `run` → `idle` |
| `run` | `run` · `sprint` · `jog` | → `walk` → `idle` |
| `shoot` | `shoot` · `fire` · `attack` | → `idle` |
| `reload` | `reload` · `reloads` | → `idle` |
| `death` | `death` · `die` · `dead` | → `idle`（并保持最后一帧） |

降级链的写法是 **`run → walk → idle`**：任何一个 Clip 缺失，游戏自动回落到最接近的状态，并**在控制台明确告警一次**——绝不崩、绝不静默。

其它两个事实，避免白找：

- **模型没到货时跑的是程序化占位体**（胶囊体）。这是预期行为，不是"资源丢了"；验收脚本对这条路径有专门的白名单。
- **音频零文件**：全部程序化合成（`src/platform/audio/`），所以**不要去找 `.mp3` / `.ogg` / `.wav`**，一个都没有，也不需要有。

> 可选的模型压缩（把源模型压成 webp 贴图 + 量化）：`npm run assets:optimize`。
> 它读 `public/assets/models/in/`、写 `public/assets/models/out/`；**本项目从未跑过它**（没有输入目录），接入资产后才会用上。

---

## 5. 测试与开发

```powershell
npm run typecheck   # tsc --noEmit
npm run test        # Vitest 全量
npm run test:watch  # 监听模式
npm run assets:icon # 重新生成 build/icon.{ico,png}（零依赖，纯代码画的）
                    # 顺带产出 build/icon-preview.png：七个尺寸并排放大，用来看小尺寸下还认不认得出
```

只测**纯逻辑**：模拟层没有 WebGL、没有 DOM、没有 `three`，所以测试跑在纯 Node 环境里。渲染靠人工目视 + `desktop:accept` 的截图像素断言。

测试文件用 **`#/...`** 导入源码（`package.json` 的 `imports` 映射，Node 原生支持），不要用 `@/...`（那只有打包器认识）。受限沙箱下的四处适配（`tests/preload.mjs` · `vitest.config.mjs` 的 `pool: 'threads'` · `.npmrc` 的 `node-options`）都是为了让 `npm test` 开箱可用，**不需要为此提权**。

---

## 6. 已知限制（诚实口径）

| 限制 | 说明 |
|---|---|
| **未做代码签名** | 首次运行会出现 Windows SmartScreen 的"Windows 已保护你的电脑"。这是未签名安装包的预期行为，不是配置错误——点"更多信息 → 仍要运行"即可。不要为了消掉它去关系统的安全设置 |
| **只打包 Windows x64** | 没有 macOS / Linux 的打包配置（不在本版本范围内） |
| **不支持移动端** | Web 端只支持键鼠；检测到触屏设备会在启动画面上给出明确提示 |
| **人物模型未交付** | 见 §4。加载器与接入约定都已就位并有单测，但**真实 `.glb` 从未端到端加载过**——当前每次启动走的都是程序化占位分支 |
| **源码映射（S1）** | Web 产物**带** `.map`（浏览器只在打开 devtools 时才下载它，普通玩家下载量为 0，而报障时能拿到真实堆栈）；桌面安装包**不含** `.map`（`electron-builder.yml` 里 `!**/*.map`）——`file://` + asar 里没人能就地调试，白白背 3.7 MB |
| **数值未经真人试玩定标** | `PLAYER` / `CAMERA` / `WEAPON` / `ENEMY` / `WARDEN` / `DIRECTOR` / `ITEMS` 是起始基线。没有读数就不调参——**"一局 10–15 分钟"仍是纸面推算**（而且它本来是围绕 8 波曲线推的，阶段 10 换成固定脚本之后更需要重新量）。转身速率与转身倾斜是后加的**新功能旋钮**（有单测钉住），不是对既有手感的重新定标。**阶段 10 唯一的数值变化是 `ENEMY_LARGE.maxHealth` 2400 → 4800**：`DIRECTOR` 的老波次旋钮（`totalWaves` / 喘息波 / 并发上限 / 出生间隔 / 血量成长 / Boss 计时器）被整块换成固定的五批投放表，`DIRECTOR_REWARDS` 折进 `ITEMS.chargesPerClear`；血量翻倍把典狱长从"两个弹匣"变成"**必须打弱点**"——**这一改同样没有人试玩过** |
| **阶段 10 的节奏改动一条都没被人看过** | 开局那条倒计时读不读得清、**30 只潜袭者分五批（5 / 5 / 5 / 5 / 10）落下来扛不扛得住**、**4800 血的典狱长在实际操作里打不打得死**、以及"世界从第一次点击才 t = 0"这个手感对不对——四项判据都是"看一眼 + 打一局"，单测只能证明接线与算术。需要调的话，第一旋钮是 `WEAPON.reserveAmmo`，其次才是 `DIRECTOR.openingCountdown` / `batchInterval` / `batchSizes` |
| **转身动作在占位体上是"代码补的"** | `player.glb` 未交付时用的是程序化胶囊体，它自带肩杠与面罩（`+Z`）当朝向特征——否则一个旋转对称的胶囊体转不转在画面上都一样。真实模型接进来之后用的是同一套角度（`characterTurn.ts`），不需要改代码 |
| **Bloom 后处理未开启** | 重开条件是拿到真机开 / 关两次帧率读数；没有读数就不开 |
| **第一人称的枪位是推算出来的** | `VIEW.firstPersonWeapon` 的六个数（枪在镜头前多远、偏右多少、下压多少、俯仰 / 偏航）没有任何截图核对过——本机起不了浏览器。它只被断言到"在相机坐标系里位于右下方、离眼不到 1 m、不穿近裁剪面"。**觉得挡准星或太大 / 太小，改的就是这一处**（`src/core/config.ts`）。同样没被看过的还有第一人称下的移动手感与"切换时画面直接跳过去"这件事本身（刻意的，不做过渡） |
| **Web 端只验到 HTTP 层** | 构建、相对引用、子目录托管（Pages 项目站的形状）与字节一致性都验过，但**开发机是受限沙箱、起不了任何 Chromium 进程**，所以"页面在浏览器里真的跑起来了吗"这一条一直只能靠你点一次。上一轮现场反馈的启动缺陷（静默失败 / 脱绑定方法调用 / **鼠标不能转视角**）都已修并补了回归测试，见 `docs/PROJECT_TECHNICAL_PLAN.md` §5.13 / §5.14 / §5.17。⚠️ **线上那份构建（`89c115e`）是"鼠标不能转视角"的版本**，必须等这次修复推上去、Actions 重新部署之后再点 |
| **GitHub Pages 的国内连通性** | `*.github.io` 在中国大陆时通时不通（DNS 污染 / SNI 阻断），**链接打不开不是包的问题**。同一个 `dist/` 换 Cloudflare Pages / Netlify / 对象存储即可，不需要改代码（`docs/交付说明.md` §2.5） |

---

## 7. 目录速查

```
src/
  core/        固定步长循环 · 输入语义 · 数值表(config.ts) · 数学/随机/射线 · 事件总线
  game/        纯逻辑：玩家 · 武器 · 敌人 AI · 导演与投放（`director/deployment.ts`）· 投掷物 · 关卡几何
  render/      表现层：相机 · 场景 · 敌人视图 · 玩家身体（rig/转身）· HUD · 对象池 · 特效 · 模型加载器
  platform/    宿主机能力：音频（程序化合成）· 桌面端探测
  debug/       性能场景（?scene=perf）——只调用 World 的公开方法
electron/      桌面壳：main.cjs（窗口与导航守卫）· preload.cjs（一个冻结对象）
.github/       发布：workflows/deploy-pages.yml（推 main 即构建 + 测试 + 发到 GitHub Pages）
tools/         desktop-acceptance.mjs（验收入口）· make-icon.mjs · lib/png.mjs
tests/         Vitest：纯逻辑 + 交付面断言
docs/          PROJECT_TECHNICAL_PLAN.md（权威技术方案与全部决策）
```

深挖请读 **`docs/PROJECT_TECHNICAL_PLAN.md`**：§0 是进度快照与证据表，§5.6–§5.19 是各阶段实施纪要（§5.15 是 Web 上线，§5.17 是转身 / 鼠标视角 / 装饰物实体，§5.19 是 `V` 键的第一 / 第三人称切换），§6.3 是全部定案决策。

---

## 8. 许可与仓库

**MIT License**，全文见 [`LICENSE`](LICENSE)（Copyright © 2026 violet-sept）。

仓库：<https://github.com/violet-sept/box-garden-shooter>。Web 端由 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) 发布到 GitHub Pages（推 `main` 即构建 + 测试 + 部署，步骤见 [`docs/交付说明.md`](docs/交付说明.md) §2.5）。
