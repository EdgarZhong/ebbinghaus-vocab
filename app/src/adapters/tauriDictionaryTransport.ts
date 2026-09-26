/** Tauri 命令提供固定域名 HTTPS 出口；词典解析、并发和重试仍复用共享适配器。 */
import { invoke } from "@tauri-apps/api/core";
import {
  DictionaryLookupCancelledError, DictionaryLookupNetworkError,
  DictionaryLookupResponseError, DictionaryLookupTimeoutError,
} from "@ebbinghaus/application";
import type { DictionaryHttpTransport } from "@ebbinghaus/persistence/src/dictionary/onlineDictionary.ts";

export const tauriDictionaryTransport: DictionaryHttpTransport = {
  async get(source, normalizedWord, _timeoutMs, signal) {
    if (signal.aborted) throw new DictionaryLookupCancelledError("在线词典查询已取消");
    try {
      const body = await invoke<string>("dictionary_http_get", { source, normalizedWord });
      if (signal.aborted) throw new DictionaryLookupCancelledError("在线词典查询已取消");
      return body;
    } catch (error) {
      if (signal.aborted || error instanceof DictionaryLookupCancelledError) {
        throw new DictionaryLookupCancelledError("在线词典查询已取消");
      }
      // Rust command 只返回分类前缀与面向用户的文本；不把底层 URL/堆栈带进界面。
      const message = String(error);
      if (message.startsWith("timeout:")) throw new DictionaryLookupTimeoutError(message.slice(8));
      if (message.startsWith("response:")) throw new DictionaryLookupResponseError(message.slice(9));
      throw new DictionaryLookupNetworkError(message.startsWith("network:") ? message.slice(8) : "无法连接在线词典");
    }
  },
};
