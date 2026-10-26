# DSH NEXT 适配指南

> 本文档记录让 dsh-purge-flash 在 **DSH NEXT 2.0.x-next** 上跑起来的所有改动。
> 原始项目：[jadezane6634-ops/dsh-purge-flash](https://github.com/jadezane6634-ops/dsh-purge-flash)

## 为什么需要适配

DSH NEXT 换掉了宿主结构：

| 项目 | DSH Desktop 0.2.x | DSH NEXT 2.0.x |
|---|---|---|
| 宿主包 | `@deepseek-ai/dsh-desktop-host` | 不存在 |
| CLI 入口 | `dsh-desktop-host/lib/cli.js` | `lib/desktop-cli.js` |
| 宿主位置 | `resources/app/dsh/…` | 封在 `app.asar` 里 |
| provider 注册表 | 可枚举 | 私有 Map，代理层挡住 |

dsh-purge-flash 的 12 层里，**11 层用的是 DSH 公开事件面**（systemPrompt、tools、llm/stream……），这些在 NEXT 上完全能用。只有 `请求体整形` 这一层依赖 provider 注册表，NEXT 拿不到。

## 本仓库改了什么

三个文件，改动都很小：

### 1. `lib/index.js` — inject 声明

```diff
- export const inject = ["systemPrompt"];
+ export const inject = ["systemPrompt", "llm"];
```

Cordis 4 的 `inject` 只认数组或 `name → null` 映射，**没有 optional 概念**。写成 `{required:[], optional:[]}` 会导致插件 `pending (waiting for services: required, optional)` 永远不加载。

### 2. `lib/adapter.js` — llm 访问保护

```diff
- const llm = ctx?.llm;
+ let llm = null;
+ try { llm = ctx?.llm ?? null; } catch { llm = null; }
```

NEXT 的 `llm` 服务在 Cordis 代理下访问会抛错，用 try 包住让降级正常发生。

### 3. `cordis.patch.yml` — 关闭 adapter 层

```diff
- adapterAlias: deepseek-armor
+ adapterAlias: ''
```

NEXT 不暴露 provider 枚举，adapter 层挂不上。关掉它，其余 11 层照跑。

## 安装（macOS）

```bash
# 1. 克隆
git clone https://github.com/xiqing21/dsh-purge-flash.git
cd dsh-purge-flash

# 2. 放到位
mkdir -p ~/.dsh/plugins
cp -r . ~/.dsh/plugins/dsh-purge-flash

# 3. 登记到 profile
node scripts/install-next.mjs
```

或者手动：

```bash
# package.json 的 dependencies 加：
"dsh-purge-flash": "link:/Users/YOU/.dsh/plugins/dsh-purge-flash"

# dsh.profile.bundles 数组加：
"dsh-purge-flash"

# 建软链
ln -s ~/.dsh/plugins/dsh-purge-flash ~/.dsh/profiles/desktop/node_modules/dsh-purge-flash
```

然后 **完全退出 DSH，再打开**，发 `/flash light`。

## 验证

```
/flash light
```

期望输出：

```
内核        ✓ on
尾部回声    ✓ on
操作稿      ✓ on
宿主剥离    ✓ on
请求体整形  — off      ← NEXT 上正常
消息剥离    ✓ on
结果改写    ✓ on
拒答擦除    ✓ on
拒答修补    ✓ on
```

`请求体整形` 显示 `— off` 是对的。如果显示 `? failed:...`，检查 `cordis.patch.yml` 里的 `adapterAlias` 是否为空字符串。

## 操作稿（强度关键）

`$DSH_HOME/prompt-inject.md` 是破甲强度的主要来源。默认 1597 tok，你放自己的进去可以到 5000+ tok。

```bash
# 确认它在
ls -la ~/.dsh/prompt-inject.md
```

没有这个文件插件照样跑，但强度会明显下降。

## 卸载

```bash
rm ~/.dsh/profiles/desktop/node_modules/dsh-purge-flash
# 然后从 package.json 删掉 dependencies 和 bundles 里那一行
```

宿主文件一行都没动过，所以卸载就是删软链和两行配置。

## 已知限制

- `请求体整形` 在 NEXT 上不可用（prefill 开头锚定、many-shot、请求体内拒答擦除）
- 其余 11 层全部可用
