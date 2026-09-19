/**
 * 测试辅助：确定性服务实例与渲染工具。
 *
 * - 时钟：固定在 2026-09-19T12:00:00Z 的确定性 Clock（学习日计算、LWW 时间戳
 *   全部可复现）；
 * - 设备本地 KV：内存 Map 实现（测试间互不影响，localStorage 已由 setup 复位）；
 * - ID：确定性递增 UUIDv4 形态生成器（形态必须过协议 uuidV4Schema 校验）。
 *
 * 每个 renderApp 都创建全新的 AppServices（含全新内存运行时），用例之间零共享。
 */

import { render, type RenderResult } from "@testing-library/react";
import {StrictMode} from "react";
import type { Clock, DeviceLocalStore, IdGenerator } from "@ebbinghaus/application";
import { App } from "../src/App.tsx";
import { createAppServices, type AppServices } from "../src/composition.ts";

/** 固定时刻时钟：2026-09-19 12:00:00 UTC（当日学习日与换日边界均确定）。 */
export const FIXED_NOW = new Date("2026-09-19T12:00:00.000Z");

export const fixedClock: Clock = {
  now: () => new Date(FIXED_NOW.getTime()),
};

/** 内存设备本地 KV（与 BrowserDeviceLocalStore 同端口）。 */
export class MemoryDeviceLocalStore implements DeviceLocalStore {
  private readonly values = new Map<string, string>();

  getString(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setString(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/** 确定性 UUIDv4 生成器：版本位 4、变体位 8，尾号递增，形态与 crypto.randomUUID 一致。 */
export function createSequenceIdGenerator(): IdGenerator {
  let counter = 0;
  return {
    nextId(): string {
      counter += 1;
      const tail = String(counter % 10000).padStart(4, "0");
      return `b7e2f9a8-1c4d-4e8f-9a2b-00000000${tail}`;
    },
  };
}

export interface TestServicesOptions {
  readonly clock?: Clock;
  readonly deviceLocal?: DeviceLocalStore;
}

/**
 * 可变确定性时钟：先"拨回过去"播种学习事实（录入、首过），再把时钟拨到固定
 * 现在（FIXED_NOW），使"录入次日起参与测试"的资格过滤自然满足。全部服务共享
 * 同一 clock 引用，setNow 对组合根内所有用例立即生效。
 */
export function createMutableClock(initial: Date): { clock: Clock; setNow(next: Date): void } {
  let currentMs = initial.getTime();
  return {
    clock: {
      now: () => new Date(currentMs),
    },
    setNow(next: Date): void {
      currentMs = next.getTime();
    },
  };
}

export function createTestServices(options: TestServicesOptions = {}): AppServices {
  return createAppServices({
    clock: options.clock ?? fixedClock,
    deviceLocal: options.deviceLocal ?? new MemoryDeviceLocalStore(),
    idGenerator: createSequenceIdGenerator(),
  });
}

export function renderApp(services: AppServices = createTestServices()): RenderResult {
  return render(
    <StrictMode>
      <App services={services} />
    </StrictMode>,
  );
}
