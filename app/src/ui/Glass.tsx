/**
 * Glass —— 液态玻璃面板原语（liquid-glass-react 的唯一直引点与统一降级点）。
 *
 * 为什么封装（三个收口）：
 * 1. 依赖唯一直引点：全项目只有本文件 import "liquid-glass-react"，后续升级、
 *    调参或换库只改这里，页面/外壳永远只面对 Glass 这一个原语。
 * 2. 统一降级点：jsdom（无 ResizeObserver，Vitest 组件测试环境）、
 *    WebKit（能力检测全过但 SVG 位移滤镜渲染失真，2026-09-24 实证）、
 *    非浏览器环境（无 window）一律降级为
 *    .glass-fallback 半透明毛玻璃 div——测试与旧环境绝不崩溃、功能等价
 *    （children/onClick/data-testid 全部透传）。
 * 3. 库行为怪癖的收口处（读 dist/index.esm.js 源码确认的事实）：
 *    - 容器恒定 transform: translate(-50%, -50%)（库的"锚点居中"定位模型，
 *      elasticity=0 时不再附加弹性位移），所以正常路径必须是
 *      "已定位宿主 + 玻璃绝对居中"结构，宿主尺寸由消费方 CSS 决定；
 *    - 装饰层（暗色罩、高光、悬停光晕）的 position 取自 style.position，
 *      缺省 relative 会占文档流把布局撑坏，因此 style 必须含 absolute；
 *    - 不转发 data-testid 等额外 props（props 显式解构、无 rest 展开），
 *      testId 只能落在宿主 div 上（getByTestId 取到祖先，子内容照常可查）；
 *    - 库内层 .glass 自带演示用深投影、内容包裹层硬编码 font 与 text-shadow，
 *      已在 components.css"玻璃原语"一节用 !important 复位为设计令牌。
 *
 * 布局契约：Glass 是浮动层原语。.glass-host 绝对定位填满最近的已定位祖先
 * （position ≠ static，消费方必须先定位自己的容器，如移动端顶栏），
 * 玻璃面板在该祖先内水平垂直居中，尺寸由内容与 padding 决定。
 * 不要用 style 覆盖 position/top/left——装饰层锚定在宿主上，玻璃本体改锚点
 * 会与装饰层错位；需要别的位置就包一层新的已定位容器。
 * 降级路径是普通文档流 div，className/style 直接落在玻璃面上。
 */

import type { ComponentType, CSSProperties, ReactNode } from "react";
import LiquidGlassImport from "liquid-glass-react";

/**
 * CJS/ESM 双形态解包：Vite（dev/build/Tauri 产物）按 module 字段拿到 ESM，
 * import default 即组件函数；node 原生 ESM（vitest 对 node_modules 的外部化
 * 加载）与 nodenext 类型解析按 main 字段拿到 CJS，esbuild 产的 CJS 带
 * __esModule 标记，import default 得到的是整个 exports 对象、组件挂在
 * .default 上——类型层面同样如此（该包无 "type": "module"，nodenext 把
 * default import 解析成模块命名空间类型），因此这里不能用
 * typeof LiquidGlassImport 直接作组件类型，必须与运行时解包同构地取 .default。
 * 防御性解包保证两种解析模式下都拿到组件函数，正常路径在哪都不崩。
 * 组件 props 类型复用 GlassProps（本组件公开 props 即库 props 的超集，
 * 去掉库不认识的 testId），避免为库单独维护一份镜像声明。
 */
const LiquidGlass: ComponentType<Omit<GlassProps, "testId">> =
  typeof LiquidGlassImport === "function"
    ? (LiquidGlassImport as unknown as ComponentType<Omit<GlassProps, "testId">>)
    : (
        LiquidGlassImport as unknown as {
          default: ComponentType<Omit<GlassProps, "testId">>;
        }
      ).default;

/**
 * 能力检测（模块加载期一次，结果缓存）：浏览器 + ResizeObserver + backdrop-filter。
 * ResizeObserver 是 jsdom 的确定性缺席特征（jsdom 不提供），用它把测试环境
 * 稳定分流到降级路径；CSS.supports 检查带 -webkit 前缀兜底旧 WebKit。
 *
 * WebKit 一律走降级磨砂（2026-09-24 实证）：Playwright WebKit 26.6 三项能力
 * 检测（backdrop-filter / -webkit-backdrop-filter / filter:url()）全部通过，
 * 但深色主题下侧栏玻璃实际渲染成均匀奶灰亮板（headed 与 headless 一致，证据
 * 见 docs/autonomous-runs/ 第二轮验收记录）——SVG 位移滤镜与 backdrop-filter
 * 的组合在 WebKit 合成管线上失真，能力检测覆盖不了"渲染正确性"，只能按引擎
 * 降级。判定用 UA：Chromium 系 UA 必含 Chrome/Chromium/CriOS 等标记，剩余
 * AppleWebKit 即 WebKit（Safari 与 Tauri 的 WKWebView）；jsdom 已被上面的
 * ResizeObserver 检查先行拦截，不会误伤测试环境。代价如实接受：macOS 正式
 * App（WKWebView）将呈现磨砂而非液态玻璃，Phase 4/6 真实机验收时再评估是否
 * 换库或自研着色。
 */
const canUseLiquidGlass: boolean = (() => {
  if (typeof window === "undefined") {
    return false;
  }
  if (typeof ResizeObserver !== "function") {
    return false;
  }
  // 直接调用而非 .call：CSS.supports 在 DOM 类型里是重载函数，
  // 重载类型取 .call 只认最后一个签名（单参 conditionText），两参调用会报错。
  const css = window.CSS;
  if (!css || typeof css.supports !== "function") {
    return false;
  }
  const supportsBackdrop =
    css.supports("backdrop-filter", "blur(1px)") ||
    css.supports("-webkit-backdrop-filter", "blur(1px)");
  if (!supportsBackdrop) {
    return false;
  }
  const ua = window.navigator.userAgent;
  const isWebKit =
    /AppleWebKit/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/i.test(ua);
  return !isWebKit;
})();

export interface GlassProps {
  children: ReactNode;
  /** 追加在玻璃容器上的类名（正常路径落到库容器，降级路径落到玻璃 div）。 */
  className?: string;
  /** 追加在玻璃容器上的内联样式；正常路径勿覆盖 position/top/left（见文件头契约）。 */
  style?: CSSProperties;
  /** 玻璃内边距（CSS padding 语法）；缺省用库的 24px 32px，消费方按场景给定。 */
  padding?: string;
  /** 圆角（px），默认 16，与令牌 --radius-xlarge 对齐。 */
  cornerRadius?: number;
  onClick?: () => void;
  /** 测试定位：正常路径落在宿主 div，降级路径落在玻璃 div，均可用 getByTestId 找到。 */
  testId?: string;
  /** 边缘折射强度（库默认 70；面板调低到 40，折光克制）。 */
  displacementScale?: number;
  /** 背板模糊量（库默认 0.0625，本组件不覆盖）。 */
  blurAmount?: number;
  /** 背板饱和度 %（库默认 140；面板调低到 120，避免背景色透过玻璃发艳）。 */
  saturation?: number;
  /** 边缘色散强度（库默认 2，本组件不覆盖）。 */
  aberrationIntensity?: number;
  /** 弹性系数（库默认 0.15；面板固定为 0，浮动面板不晃动）。 */
  elasticity?: number;
  /** 玻璃位于亮色背景上时开启（库会减折射、改用亮态高光）。 */
  overLight?: boolean;
  /** 折射模式（库默认 standard；shader 最准但最不稳定，面板勿用）。 */
  mode?: "standard" | "polar" | "prominent" | "shader";
}

export default function Glass({
  children,
  className,
  style,
  padding,
  cornerRadius = 16,
  onClick,
  testId,
  displacementScale = 40,
  blurAmount,
  saturation = 120,
  aberrationIntensity,
  elasticity = 0,
  overLight,
  mode,
}: GlassProps) {
  // 降级路径：与正常路径功能等价（children/onClick/testId 透传），
  // 视觉用 .glass-fallback（半透明底 + 系统 backdrop-filter + 描边 + 投影）。
  if (!canUseLiquidGlass) {
    return (
      <div
        className={["glass-fallback", className].filter(Boolean).join(" ")}
        style={style}
        onClick={onClick}
        data-testid={testId}
      >
        {children}
      </div>
    );
  }

  // 正常路径：宿主绝对定位填满已定位祖先并放行指针事件（.glass-host），
  // 玻璃在其中居中；style 里的 absolute/50%/50% 是库"锚点居中"模型的必需项。
  return (
    <div className="glass-host" data-testid={testId}>
      <LiquidGlass
        className={["glass-surface", className].filter(Boolean).join(" ")}
        style={{ position: "absolute", top: "50%", left: "50%", ...style }}
        padding={padding}
        cornerRadius={cornerRadius}
        onClick={onClick}
        displacementScale={displacementScale}
        blurAmount={blurAmount}
        saturation={saturation}
        aberrationIntensity={aberrationIntensity}
        elasticity={elasticity}
        overLight={overLight}
        mode={mode}
      >
        {children}
      </LiquidGlass>
    </div>
  );
}
