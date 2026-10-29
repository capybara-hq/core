/**
 * 用户消息的幂等键：客户端的 `clientMessageId` 加前缀，与运行流水线自用的幂等键分开，
 * 避免客户端恰好选中内部键而命中别的事件。
 */
export const userMessageIdemKey = (clientMessageId: string): string => `msg:${clientMessageId}`;
