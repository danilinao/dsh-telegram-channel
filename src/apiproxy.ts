import type { Context } from '@deepseek-ai/cordis'

/** Loose ApiProxy surface used by catalog + model helpers. */
export type ApiProxySessions = {
  list?: (req: { rpcId: string; payload: unknown }) => Promise<unknown>
  history?: (req: { rpcId: string; payload: unknown }) => Promise<unknown>
  models?: (req: { rpcId: string; payload: unknown }) => Promise<unknown>
  selectModel?: (req: { rpcId: string; payload: unknown }) => Promise<unknown>
  /** Per-session projections (title, stats, ...) for cold sessions too. */
  projections?: (req: { rpcId: string; payload: unknown }) => Promise<unknown>
  /** Create a session (used by /new; payload: workspaceId | cwd). */
  create?: (req: { rpcId: string; payload: unknown }) => Promise<unknown>
  /**
   * Prompt dispatch (Web 端同通道)：文本 + 图片字节(base64)经宿主附件服务持久化后
   * 进入会话；含图片时会校验当前模型是否支持图像输入。
   */
  prompt?: (req: { rpcId: string; payload: unknown }) => Promise<unknown>
}

export type ApiProxyLike = {
  workspace?: {
    list?: (req: { rpcId: string; payload: unknown }) => Promise<unknown>
  }
  sessions?: ApiProxySessions
}

/**
 * Resolve host apiProxy without requiring Cordis inject.
 * Direct `ctx.apiProxy` throws "cannot get property without inject" on real fibers.
 */
export function resolveApiProxy(ctx: Context): ApiProxyLike | undefined {
  const c = ctx as Context & {
    get?: (name: string, strict?: boolean) => unknown
    apiProxy?: ApiProxyLike
  }

  if (typeof c.get === 'function') {
    try {
      const viaGet = c.get('apiProxy') as ApiProxyLike | undefined
      if (viaGet) return viaGet
    } catch {
      // ignore and try own-property fallback (tests / plain mocks)
    }
  }

  try {
    // Own property on plain mocks only — Cordis proxy throws without inject.
    if (Object.prototype.hasOwnProperty.call(c, 'apiProxy') && c.apiProxy) {
      return c.apiProxy
    }
  } catch {
    return undefined
  }
  return undefined
}
