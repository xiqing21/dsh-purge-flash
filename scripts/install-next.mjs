#!/usr/bin/env node
/**
 * DSH NEXT 一键登记 — 把仓库登记进 ~/.dsh/profiles/desktop。
 * 不碰任何宿主文件，只改 profile 的 package.json 并建软链。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const PROFILE = process.env.DSH_PROFILE || "desktop";
const PROFILE_DIR = path.join(HOME, "profiles", PROFILE);
const PLUGIN_DIR = path.join(HOME, "plugins", "dsh-purge-flash");
const SRC = path.resolve(process.argv[2] || process.cwd());

const log = (m) => console.log("  " + m);

if (!fs.existsSync(path.join(PROFILE_DIR, "package.json"))) {
  console.error(`未找到 profile：${PROFILE_DIR}`);
  console.error("先打开一次 DSH，让它初始化 profile。");
  process.exit(1);
}
if (!fs.existsSync(path.join(SRC, "package.json"))) {
  console.error(`源目录不是插件：${SRC}`);
  process.exit(1);
}

// 1. 复制到 ~/.dsh/plugins
fs.mkdirSync(path.dirname(PLUGIN_DIR), { recursive: true });
if (path.resolve(SRC) !== PLUGIN_DIR) {
  fs.rmSync(PLUGIN_DIR, { recursive: true, force: true });
  fs.cpSync(SRC, PLUGIN_DIR, {
    recursive: true,
    filter: (s) => !s.includes("/.git") && !s.includes("/node_modules"),
  });
}
log(`插件 → ${PLUGIN_DIR}`);

// 2. 备份并改 profile package.json
const manifest = path.join(PROFILE_DIR, "package.json");
const raw = fs.readFileSync(manifest, "utf8");
fs.writeFileSync(`${manifest}.bak-${Date.now()}`, raw);

const pkg = JSON.parse(raw);
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies["dsh-purge-flash"] = `link:${PLUGIN_DIR}`;
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = (pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []);
if (!bundles.includes("dsh-purge-flash")) bundles.push("dsh-purge-flash");
fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + "\n");
log(`已登记 → ${manifest}`);

// 3. 软链
const link = path.join(PROFILE_DIR, "node_modules", "dsh-purge-flash");
fs.mkdirSync(path.dirname(link), { recursive: true });
try { fs.rmSync(link, { force: true }); } catch {}
fs.symlinkSync(PLUGIN_DIR, link, "dir");
log(`已链接 → ${link}`);

// 4. 自检
const cfg = fs.readFileSync(path.join(PLUGIN_DIR, "cordis.patch.yml"), "utf8");
const adapterOff = /adapterAlias:\s*(''|"")\s*$/.test(cfg) || /adapterAlias:\s*(''|"")/.test(cfg);
log(`adapterAlias 已关闭：${adapterOff ? "是" : "否（NEXT 上应为空）"}`);

console.log("\n完成。完全退出 DSH 再打开，然后发 /flash light 验证。\n");
