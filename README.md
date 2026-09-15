# 箱庭射击 · Box Garden Shooter

一个**能立刻上手、单手就能玩明白**的小型 3D 箱庭波次射击游戏：你站在一块被围栏圈起的立体沙盘里，一边用步枪点掉成群扑上来的小敌人，一边等那只慢慢走过来的大块头，然后决定是继续清杂兵还是先把子弹喂给它。

一套代码两端发布：**浏览器里打开即玩**（也可以挂成一个网址，见 §2.3），或**双击 Windows `.exe` 直接进**。两端加载的是同一份 `dist/`、同一个固定步长模拟、同一张数值表。

> ## 🎮 在线游玩：<https://violet-sept.github.io/box-garden-shooter/>
>
> 点开即玩，不需要安装任何东西。首次进入**点一下画面**取得鼠标锁定（这是浏览器的硬性要求，桌面端也一样）。
>
> [![Deploy web build](https://github.com/violet-sept/box-garden-shooter/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/violet-sept/box-garden-shooter/actions/workflows/deploy-pages.yml) —— 推 `main` 即自动构建 + 全量测试 + 部署；线上 `index.html` 与两个分包已核对为**与本地 `dist/` 字节一致**（见 [`docs/交付说明.md`](docs/交付说明.md) §2.5）。

---

## 1. 操作

| 输入 | 行为 |
|---|---|
| `W` / `A` / `S` / `D` | 前 / 左 / 后 / 右移动（方向按**摄像机朝向**解算） |
| **移动鼠标** | 转视角（取得鼠标锁定之后；灵敏度与开镜倍率都在 `src/core/config.ts`） |
| **鼠标左键** | 射击（按住持续射击） |
| **鼠标右键** | 开镜瞄准（ADS，按住生效） |
| `R` | 换弹（可打断窗口 0.35s；空仓换弹更快） |
| `E` | 投掷道具（抛物线，1.4s 引信，5.5m 溅射） |
| `Shift` | 疾跑 |
| `Space` | 跳跃 |
| `M` | 静音 / 取消静音（设置会记住） |
| `F3` | 调试统计面板（含当前局种子） |
| `F4` | 命中日志 `[HITLOG]` |
| `Esc` | 释放鼠标（同时作为暂停） |

进入游戏需要**点一下画面**取得指针锁定——这是浏览器的硬性要求，桌面端同样如此。被围栏圈起的场地里没有出口，掉不出去。

角色的**身体朝向和镜头是分开的**：镜头转到哪，子弹就往哪飞；而身体会**用四分之一秒左右转过来**面向你正在走的方向（站住不动时才跟着镜头转）。场上的灯柱、天线、货箱堆和管路**都是实体**——它们既挡人也挡子弹。

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
| `dist/index.html` | 8.46 kB | 3.29 kB |
| `dist/assets/index-*.js` | 113.18 kB | 38.90 kB |
| `dist/assets/three-*.js` | 628.12 kB | 158.13 kB |

three 单独分包（`manualChunks`），因为它几乎不变、而游戏代码经常变；改一次游戏代码的玩家只需要重新下载那 113 kB。
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

**`src/core/config.ts` 是唯一的数值真源。** 手感、敌人、波次、道具、渲染、性能、**音频配方**全在那一个文件里；别处出现字面量就算 bug。

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
| **数值未经真人试玩定标** | `PLAYER` / `CAMERA` / `WEAPON` / `ENEMY` / `WARDEN` / `DIRECTOR` / `ITEMS` 是起始基线。没有读数就不调参——**"一局 10–15 分钟"仍是纸面推算**。转身速率与转身倾斜是后加的**新功能旋钮**（有单测钉住），不是对既有手感的重新定标 |
| **转身动作在占位体上是"代码补的"** | `player.glb` 未交付时用的是程序化胶囊体，它自带肩杠与面罩（`+Z`）当朝向特征——否则一个旋转对称的胶囊体转不转在画面上都一样。真实模型接进来之后用的是同一套角度（`characterTurn.ts`），不需要改代码 |
| **Bloom 后处理未开启** | 重开条件是拿到真机开 / 关两次帧率读数；没有读数就不开 |
| **Web 端只验到 HTTP 层** | 构建、相对引用、子目录托管（Pages 项目站的形状）与字节一致性都验过，但**开发机是受限沙箱、起不了任何 Chromium 进程**，所以"页面在浏览器里真的跑起来了吗"这一条一直只能靠你点一次。上一轮现场反馈的启动缺陷（静默失败 / 脱绑定方法调用 / **鼠标不能转视角**）都已修并补了回归测试，见 `docs/PROJECT_TECHNICAL_PLAN.md` §5.13 / §5.14 / §5.17。⚠️ **线上那份构建（`89c115e`）是"鼠标不能转视角"的版本**，必须等这次修复推上去、Actions 重新部署之后再点 |
| **GitHub Pages 的国内连通性** | `*.github.io` 在中国大陆时通时不通（DNS 污染 / SNI 阻断），**链接打不开不是包的问题**。同一个 `dist/` 换 Cloudflare Pages / Netlify / 对象存储即可，不需要改代码（`docs/交付说明.md` §2.5） |

---

## 7. 目录速查

```
src/
  core/        固定步长循环 · 输入语义 · 数值表(config.ts) · 数学/随机/射线 · 事件总线
  game/        纯逻辑：玩家 · 武器 · 敌人 AI · 导演与波次 · 投掷物 · 关卡几何
  render/      表现层：相机 · 场景 · 敌人视图 · 玩家身体（rig/转身）· HUD · 对象池 · 特效 · 模型加载器
  platform/    宿主机能力：音频（程序化合成）· 桌面端探测
  debug/       性能场景（?scene=perf）——只调用 World 的公开方法
electron/      桌面壳：main.cjs（窗口与导航守卫）· preload.cjs（一个冻结对象）
.github/       发布：workflows/deploy-pages.yml（推 main 即构建 + 测试 + 发到 GitHub Pages）
tools/         desktop-acceptance.mjs（验收入口）· make-icon.mjs · lib/png.mjs
tests/         Vitest：纯逻辑 + 交付面断言
docs/          PROJECT_TECHNICAL_PLAN.md（权威技术方案与全部决策）
```

深挖请读 **`docs/PROJECT_TECHNICAL_PLAN.md`**：§0 是进度快照与证据表，§5.6–§5.17 是各阶段实施纪要（§5.15 是 Web 上线，§5.17 是转身 / 鼠标视角 / 装饰物实体），§6.3 是全部定案决策。

---

## 8. 许可与仓库

**MIT License**，全文见 [`LICENSE`](LICENSE)（Copyright © 2026 violet-sept）。

仓库：<https://github.com/violet-sept/box-garden-shooter>。Web 端由 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) 发布到 GitHub Pages（推 `main` 即构建 + 测试 + 部署，步骤见 [`docs/交付说明.md`](docs/交付说明.md) §2.5）。
