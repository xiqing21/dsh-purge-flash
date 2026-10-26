/**
 * dsh-purge-flash —— 只做一件事：聊天场景的破甲。
 *
 * 四层，各自独立开关，任何一层挂掉不影响其余（宿主会因为一行 fiber 失败
 * 就报 "Failed to load plugins"，所以这里全程 try/catch，绝不外抛）。
 *
 *   L0 壳  提示词内核（薄，2000 tok 级，挂在 order -100000 最前）
 *   L1 面  宿主侧剥离 + 拒答修补 + prefill 锚
 *   L1.5   连拒换线（agent/request 改写 provider/model）
 *   L2 记  反撤回（llm/stream tee + session/event 镜像 + 遮蔽快照 + 自我撤回探针）
 *   L3 册  按需技能（runtime skill，平时 0 token）
 *
 * @module dsh-purge-flash
 */

import fs from "node:fs";
import path from "node:path";

import { normalizeConfig } from "./config.js";
import { log, setVerbose, warnOnce } from "./log.js";
import { pickFamily, renderKernel, renderTail } from "./kernel.js";
import { composeKernel, createOperatorReader, findOperatorFile } from "./operator.js";
import { classifyReply, estimateTokens, isRetraction } from "./detect.js";
import { createMirror, dshHome } from "./mirror.js";
import { installAssemble } from "./assemble.js";
import { installAdapter } from "./adapter.js";
import { installToolStrip } from "./toolstrip.js";
import { installPreStep } from "./prestep.js";
import { installRoute, noteRefusal } from "./route.js";
import { installStream } from "./stream.js";
import { installSkills } from "./skills.js";
import { installCommands } from "./commands.js";

export const name = "dsh-purge-flash";

/**
 * 必须 inject systemPrompt。
 *
 * cordis 的 ctx 是 Proxy：没写进 inject 的服务名，读属性直接抛
 * `cannot get property "X" without inject`。之前这里是 []，apply 里那句
 * `ctx.systemPrompt.section()` 被 try/catch 吞掉，内核静默降级成 no-service，
 * 一段都没注册 —— 表现就是「破甲完全没生效」。
 *
 * systemPrompt 由 dsh-base 提供，一定在位；真缺席时 cordis 让 fiber 等待而不是
 * 报错，事件层（镜像/撤回）不受影响。
 */
// Cordis 4 的 inject 只认数组或 name→null 映射，没有 optional。
// 对象形式 {required, optional} 会被当成服务名解析，导致插件永久 pending。
export const inject = ["systemPrompt", "llm"];

const KERNEL_SECTION = "purge-flash:kernel";
const TAIL_SECTION = "purge-flash:tail";

function makeState(cfg) {
  return {
    cfg,
    layers: {
      kernel: "off",
      tail: "off",
      operator: "off",
      assemble: "off",
      adapter: "off",
      toolStrip: cfg.msgStrip ? "on" : "off",
      msgStrip: cfg.msgStrip ? "on" : "off",
      preStep: "off",
      route: "off",
      stream: "off",
      mirror: "off",
      shadow: cfg.shadowRefusal === "on" ? "on" : "off",
      skills: "off",
      commands: "off",
    },
    stats: {
      repairs: 0,
      anchors: 0,
      routes: 0,
      retractions: 0,
      shadowed: 0,
      rewinds: 0,
      msgStrip: 0,
      prefill: 0,
      shots: 0,
      toolStrip: 0,
      refusalsShadowed: 0,
      leaves: 0,
      leafIds: {},
      retries: 0,
      retryExhausted: 0,
      escalations: 0,
      json: 0,
    },
    leaves: new Map(),
    escalation: new Map(),
    repairs: new Map(),
    refusals: new Map(),
    routeSlot: new Map(),
    kernelChars: 0,
    kernelTokens: 0,
    kernelFamily: "",
    tailChars: 0,
    operatorFile: "",
    operatorChars: 0,
    operatorTokens: 0,
    mergedChars: 0,
    mergedTokens: 0,
    startedAt: Date.now(),
    disposers: [],
  };
}

/** 内核文本：override 文件 > 内置。 */
function kernelText(cfg, family) {
  if (cfg.kernelOverrideFile) {
    try {
      const text = fs.readFileSync(cfg.kernelOverrideFile, "utf8");
      if (text.trim()) return text;
    } catch (e) {
      warnOnce("kernel-override", `内核覆盖文件读不到，回退内置：${String(e?.message || e)}`);
    }
  }
  return renderKernel(family);
}

function installKernel(ctx, cfg, state) {
  try {
    if (cfg.kernel === "off") {
      state.layers.kernel = "off";
      return false;
    }
    const prompt = ctx?.systemPrompt;
    if (!prompt || typeof prompt.section !== "function") {
      state.layers.kernel = "no-service";
      warnOnce("no-prompt", "拿不到 systemPrompt 服务：提示词内核没挂上，其余层照跑。");
      return false;
    }

    // 家族跟着当前路由走：request/header 一变就换一份。
    let family = cfg.kernel === "auto" ? "generic" : cfg.kernel;
    if (!["deepseek", "claude", "openai-compat", "generic"].includes(family)) family = "generic";

    // 操作稿：读 $DSH_HOME/prompt-inject.md。带 mtime+size 缓存，
    // 用户改文件后下一条消息就生效，不用重启。
    const readOperator = createOperatorReader(cfg.operatorHome || dshHome());
    const firstOp = readOperator();
    state.operatorFile = firstOp.file;
    state.operatorChars = firstOp.bytes;
    state.operatorTokens = estimateTokens(firstOp.text);
    if (firstOp.text) {
      state.layers.operator = "on";
      log("操作稿已加载", firstOp.file, firstOp.bytes, "字符");
    } else {
      state.layers.operator = "empty";
      warnOnce(
        "no-operator",
        `没找到操作稿（${findOperatorFile(cfg.operatorHome || dshHome()) || "$DSH_HOME/prompt-inject.md"} 不存在）：只有内核在跑，破甲强度会明显下降。`,
      );
    }

    const section = {
      name: KERNEL_SECTION,
      order: cfg.kernelOrder,
      interpolate: false,
      text: () => {
        if (state.cfg.enabled === false) return "";
        const op = readOperator();
        state.operatorChars = op.bytes;
        state.operatorTokens = estimateTokens(op.text);
        state.layers.operator = op.text ? "on" : "empty";
        const kernel = kernelText(cfg, family);
        state.kernelChars = kernel.length;
        state.kernelTokens = estimateTokens(kernel);
        state.kernelFamily = family;
        const merged = composeKernel(op.text, kernel);
        state.mergedChars = merged.length;
        state.mergedTokens = estimateTokens(merged);
        return merged;
      },
    };

    const disposer = prompt.section(section);
    if (typeof disposer === "function") state.disposers.push(disposer);
    state.layers.kernel = "on";

    // 尾部回声：同一份立场挂在 prompt 最末尾（近因权重最高）。
    // 挂不上不影响头段，只是少一次重申。
    if (cfg.kernelTail === "on") {
      try {
        const tail = {
          name: TAIL_SECTION,
          order: cfg.kernelTailOrder,
          interpolate: false,
          text: () => {
            if (state.cfg.enabled === false) return "";
            const text = renderTail(family);
            state.tailChars = text.length;
            return text;
          },
        };
        const offTail = prompt.section(tail);
        if (typeof offTail === "function") state.disposers.push(offTail);
        state.layers.tail = "on";
      } catch (e) {
        state.layers.tail = "failed";
        log("尾部回声注册失败", String(e?.message || e));
      }
    }

    // 路由变化 → 换家族。只换一次文本函数读的那个变量，不重注册段。
    try {
      const off = ctx.on("session/event", (session, event) => {
        try {
          if (event?.type !== "request/header") return;
          if (cfg.kernel !== "auto") return;
          const config = event?.data?.header?.config || {};
          const next = pickFamily(config.provider, config.model);
          if (next !== family) {
            family = next;
            log("内核换家族", next, config.provider, config.model);
          }
        } catch {
          /* ignore */
        }
      });
      if (typeof off === "function") state.disposers.push(off);
    } catch {
      /* ignore */
    }

    return true;
  } catch (e) {
    state.layers.kernel = "failed";
    log("installKernel 失败", String(e?.message || e));
    return false;
  }
}

function installMirror(ctx, cfg, state) {
  try {
    if (!cfg.mirror) {
      state.layers.mirror = "off";
      return null;
    }
    const home = dshHome();
    const mirror = createMirror(cfg, home);

    const off = ctx.on("session/event", (session, event) => {
      try {
        const sid = session?.id ?? session?.header?.id;
        if (typeof sid !== "string" || !sid) return;

        // 遮蔽前先抄原文，再放行。
        try {
          const file = mirror.snapshotShadowed(session, event);
          if (file) state.stats.shadowed += 1;
        } catch (e) {
          log("遮蔽快照失败", String(e?.message || e));
        }

        try {
          mirror.pushEvent(sid, event);
        } catch (e) {
          log("事件镜像失败", String(e?.message || e));
        }

        // 拒绝计数 + 自我撤回探针。
        if (event?.type === "assistant/message") {
          const msg = event?.data?.message;
          const content = Array.isArray(msg?.content) ? msg.content : [];
          const text = content
            .filter((b) => b && b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("");
          if (text) {
            try {
              if (classifyReply(text).refused) noteRefusal(state, sid, event?.data?.turn);
            } catch {
              /* ignore */
            }
            if (cfg.retractProbe) {
              try {
                const info = isRetraction(text);
                if (info.hit) {
                  mirror.recordRetraction(sid, info, text);
                  state.stats.retractions += 1;
                }
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (e) {
        log("session/event 处理失败", String(e?.message || e));
      }
    });

    if (typeof off === "function") state.disposers.push(off);
    state.mirror = mirror;
    state.layers.mirror = "on";

    // 启动补录一次
    try {
      const added = mirror.backfill(true);
      if (added > 0) log("启动补录", added, "条");
    } catch {
      /* ignore */
    }
    return mirror;
  } catch (e) {
    state.layers.mirror = "failed";
    log("installMirror 失败", String(e?.message || e));
    return null;
  }
}

function layerReport(state) {
  const c = state.cfg;
  return {
    enabled: c.enabled,
    kernel: state.layers.kernel,
    family: state.kernelFamily || "-",
    kernelChars: state.kernelChars,
    kernelTokens: state.kernelTokens,
    tail: state.layers.tail,
    tailChars: state.tailChars,
    operator: state.layers.operator,
    operatorFile: state.operatorFile || "-",
    operatorChars: state.operatorChars,
    operatorTokens: state.operatorTokens,
    mergedChars: state.mergedChars,
    mergedTokens: state.mergedTokens,
    assemble: state.layers.assemble,
    dedupeOperator: c.dedupeOperator,
    adapter: state.layers.adapter,
    adapterAlias: c.adapterAlias || "-",
    prefill: c.prefill,
    manyShot: c.manyShot,
    systemField: c.systemField,
    prefillGraded: c.prefillGraded,
    prefillLadder: c.prefillLadder,
    prefillLadderMax: c.prefillLadderMax,
    jsonMode: c.jsonMode,
    leafRouter: c.leafRouter,
    retryOnRefusal: c.retryOnRefusal,
    retryMax: c.retryMax,
    msgStrip: state.layers.msgStrip,
    toolStrip: state.layers.toolStrip,
    shadowRefusal: c.shadowRefusal,
    temperature: c.temperature,
    maxTokensFloor: c.maxTokensFloor,
    preStep: state.layers.preStep,
    route: state.layers.route,
    routeLadder: c.routeLadder.length,
    stream: state.layers.stream,
    shadow: state.layers.shadow,
    mirror: state.layers.mirror,
    skills: state.layers.skills,
    leaves: state.layers.leaves,
    commands: state.layers.commands,
    stats: { ...state.stats },
    mirrorStats: state.mirror ? state.mirror.stats() : null,
    patchTier: c.patches,
  };
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig);
  setVerbose(cfg.verbose);
  const state = makeState(cfg);
  state.report = () => layerReport(state);

  try {
    if (!cfg.enabled) {
      state.layers.kernel = "disabled";
      log("插件已禁用");
    } else {
      installKernel(ctx, cfg, state);
      installAssemble(ctx, cfg, state);
      installAdapter(ctx, cfg, state);
      installToolStrip(ctx, cfg, state);
      installPreStep(ctx, cfg, state);
      installRoute(ctx, cfg, state);
      const mirror = installMirror(ctx, cfg, state);
      installStream(ctx, cfg, mirror, state);
      installSkills(ctx, cfg, state);
      // 叶子的注入点挂在 pre-step（见 prestep.js），这里只记状态给 /armor status 看。
      state.layers.leaves = cfg.leafRouter === "auto" ? "on" : cfg.leafRouter;
    }
    // 命令层即使在 disabled 下也要挂：用户得能用 /armor on 打开。
    installCommands(ctx, cfg, state);
  } catch (e) {
    // 绝不让 apply 抛：一行 fiber 失败 = 整机 Failed to load plugins。
    log("apply 失败", String(e?.message || e));
    warnOnce("apply", `启用失败：${String(e?.message || e)}`);
  }

  try {
    ctx.effect(() => () => {
      for (const d of state.disposers) {
        try {
          if (typeof d === "function") d();
        } catch {
          /* ignore */
        }
      }
      state.disposers.length = 0;
      try {
        state.mirror?.dispose();
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* 无 effect 就随 ctx 回收 */
  }

  return state;
}

export { normalizeConfig, classifyReply, estimateTokens, renderKernel, pickFamily };
