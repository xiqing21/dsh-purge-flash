<div align="center">

# dsh-purge-flash · NEXT 适配版

**让 DSH NEXT 上的模型不再推脱。**

[![upstream](https://img.shields.io/badge/upstream-jadezane6634--ops%2Fdsh-purge--flash-blue)](https://github.com/jadezane6634-ops/dsh-purge-flash)
[![DSH NEXT](https://img.shields.io/badge/DSH%20NEXT-2.0.19--next-green)](https://github.com/xiqing21/dsh-purge-flash)
[![license](https://img.shields.io/github/license/xiqing21/dsh-purge-flash?color=green)](LICENSE)
[![stars](https://img.shields.io/github/stars/xiqing21/dsh-purge-flash?color=yellow)](https://github.com/xiqing21/dsh-purge-flash/stargazers)

</div>

---

## 一句话

**12 层里 11 层在 DSH NEXT 上跑起来了。** 宿主文件一行没碰。

## 为什么需要这个仓库

[dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) 打 80 条宿主补丁，只适配 `DSH Desktop 0.2.1-rc.x`。
你在 **DSH NEXT 2.0.19-next** 上装它，会卡死在：

```
失败: Desktop CLI runtime repair failed; original archive retained.
runtime: not_official
```

因为它要找 `@deepseek-ai/dsh-desktop-host` —— NEXT 里根本没这个包。

而 [dsh-purge-flash](https://github.com/jadezane6634-ops/dsh-purge-flash) 走的是另一条路：**零宿主补丁，全部用 DSH 公开事件面**。
这条路理论上跨版本可用。**本仓库把它在 NEXT 上实际跑通了。**

## 实测结果

```
内核        ✓ on
尾部回声    ✓ on
操作稿      ✓ on  21194 字符 ≈ 5536 tok
宿主剥离    ✓ on（去重档 foreign）
请求体整形  — off          ← NEXT 不暴露 provider 枚举，这一层降级
消息剥离    ✓ on
结果改写    ✓ on
拒答擦除    ✓ on
拒答修补    ✓ on
按需手册    ✓ on
按需技能    ✓ auto（形态/父/叶三层）
token 重试  ✓ on
命令层      ✓ on
```

**11/12 层生效。**

## 和上游的差别

三处处改动，全部在插件内部，不碰宿主：

| 文件 | 改动 | 原因 |
|---|---|---|
| `lib/index.js` | `inject` 加 `"llm"` | Cordis 4 的 inject 没有 optional，缺声明会让插件永久 pending |
| `lib/adapter.js` | `ctx.llm` 读取加 try | NEXT 的 llm 服务经代理访问会抛错 |
| `cordis.patch.yml` | `adapterAlias: ''` | NEXT 拿不到 provider 注册表，关掉这层让其余照跑 |

细节和踩坑过程见 [NEXT-ADAPTER.md](NEXT-ADAPTER.md)。

## 安装（macOS）

```bash
git clone https://github.com/xiqing21/dsh-purge-flash.git
cd dsh-purge-flash
node scripts/install-next.mjs
```

脚本会：复制到 `~/.dsh/plugins/`、备份并修改 profile 的 `package.json`、建软链。

然后 **⌘Q 完全退出 DSH，再打开**，发：

```
/flash light
```

看到 `请求体整形 — off`、其余 `✓ on` 就成功了。

## 强度怎么再往上推

`~/.dsh/prompt-inject.md` 是破甲强度的主来源，默认约 1597 tok。

**放自己的操作稿进去，能推到 5000+ tok。** 这是本机文件，插件每轮读。

```bash
ls -la ~/.dsh/prompt-inject.md
```

## 卸载

```bash
rm ~/.dsh/profiles/desktop/node_modules/dsh-purge-flash
# 再删 package.json 里 dependencies 和 bundles 的两行
```

宿主零改动，删软链就干净了。

## 已知限制

- `请求体整形` 在 NEXT 上不可用（prefill 开头锚定、many-shot、请求体内拒答擦除）
- 上游 README、测试、技能册原样保留在 [docs/README-upstream.md](docs/README-upstream.md)

## 致谢

- 原始项目：[jadezane6634-ops/dsh-purge-flash](https://github.com/jadezane6634-ops/dsh-purge-flash) —— 零宿主补丁的架构设计
- 宿主补丁路线：[kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) / [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)
- MIT License

---

<div align="center">

**如果这个仓库帮你在 NEXT 上少踩了坑，点个 ⭐**

</div>
