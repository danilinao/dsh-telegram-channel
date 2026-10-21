import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { resolveApiProxy } from './apiproxy.js'
import { hostService } from './catalog.js'

export interface ModelOption {
  provider: string
  model: string
  label: string
  efforts?: Array<{ id: string; name: string }>
}

export interface ModelSnapshot {
  current: { provider: string; model: string; reasoningEffort?: string }
  routable: boolean
  options: ModelOption[]
}

type ApiFn = (req: { rpcId: string; payload: unknown }) => Promise<unknown>

function unwrap<T>(res: unknown): T | undefined {
  const r = res as { result?: { ok?: boolean; value?: T; error?: { message?: string } } } | undefined
  if (r?.result?.ok === true) return r.result.value
  return undefined
}

function unwrapError(res: unknown): string | undefined {
  const r = res as { result?: { ok?: boolean; error?: { message?: string; code?: string } } } | undefined
  if (r?.result && r.result.ok === false) {
    const err = r.result.error
    if (!err) return 'rpc failed'
    return err.code ? `${err.code}: ${err.message ?? ''}`.trim() : (err.message ?? 'rpc failed')
  }
  return undefined
}

async function call(fn: ApiFn | undefined, payload: unknown): Promise<unknown> {
  if (typeof fn !== 'function') throw new Error('apiProxy sessions API unavailable')
  return fn({ rpcId: randomUUID(), payload })
}

/** `sessionController.modelCatalog()` on DSH >= 0.2 (the old apiProxy route is gone). */
interface HostModelCatalog {
  default?: { provider: string; model: string; reasoningEffort?: string }
  routableProviders?: string[]
  groups?: Array<{
    id: string
    name: string
    models: Array<{
      id: string
      name: string
      reasoning?: { efforts?: Array<{ id: string; name: string }> }
    }>
  }>
}

interface HostSessionController {
  modelCatalog?: () => Promise<HostModelCatalog>
  selectModel?: (request: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }) => Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }>
  create?: (request: {
    workspaceId?: string
    cwd?: string
    sessionId?: string
    agentPreset?: string
  }) => Promise<{ sessionId: string; agentPreset?: string }>
}

function hostController(ctx: Context): HostSessionController | undefined {
  return hostService<HostSessionController>(ctx, 'sessionController')
}

function optionsFromGroups(
  groups: HostModelCatalog['groups'],
): ModelOption[] {
  const options: ModelOption[] = []
  for (const group of groups ?? []) {
    for (const m of group.models ?? []) {
      options.push({
        provider: group.id,
        model: m.id,
        label: `${group.name}/${m.name}`,
        efforts: m.reasoning?.efforts?.map((e) => ({ id: e.id, name: e.name })),
      })
    }
  }
  return options
}

export async function loadSessionModels(ctx: Context, sessionId: string): Promise<ModelSnapshot> {
  const api = resolveApiProxy(ctx)
  if (!api?.sessions?.models) return loadSessionModelsFromHost(ctx)
  const raw = await call(api.sessions.models, { sessionId })
  const value = unwrap<{
    current: { provider: string; model: string; reasoningEffort?: string }
    routable: boolean
    groups: Array<{
      id: string
      name: string
      models: Array<{
        id: string
        name: string
        reasoning?: { efforts?: Array<{ id: string; name: string }> }
      }>
    }>
  }>(raw)
  if (!value) {
    throw new Error(unwrapError(raw) ?? 'failed to load session models')
  }

  const options: ModelOption[] = []
  for (const group of value.groups ?? []) {
    for (const m of group.models ?? []) {
      options.push({
        provider: group.id,
        model: m.id,
        label: `${group.name}/${m.name}`,
        efforts: m.reasoning?.efforts?.map((e) => ({ id: e.id, name: e.name })),
      })
    }
  }

  return {
    current: value.current,
    routable: value.routable,
    options,
  }
}

export async function selectSessionModel(
  ctx: Context,
  sessionId: string,
  selection: { provider: string; model: string; reasoningEffort?: string },
): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
  const api = resolveApiProxy(ctx)
  if (!api?.sessions?.selectModel) return selectSessionModelOnHost(ctx, sessionId, selection)
  // Omit undefined reasoningEffort — some validators treat explicit undefined as invalid.
  const payload: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  } = {
    sessionId,
    provider: selection.provider,
    model: selection.model,
  }
  if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== '') {
    payload.reasoningEffort = selection.reasoningEffort
  }
  const raw = await call(api.sessions.selectModel, payload)
  const value = unwrap<{ selected: { provider: string; model: string; reasoningEffort?: string } }>(raw)
  if (!value?.selected) {
    throw new Error(unwrapError(raw) ?? 'failed to select model')
  }
  return value.selected
}

/** Model catalog straight from the host service (no apiProxy on DSH 0.2). */
async function loadSessionModelsFromHost(ctx: Context): Promise<ModelSnapshot> {
  const controller = hostController(ctx)
  const callHost = controller?.modelCatalog
  if (typeof callHost !== 'function') {
    throw new Error('хост не отдал список моделей: нет ни apiProxy, ни sessionController.modelCatalog')
  }
  const catalog = await callHost.call(controller)
  const current = catalog?.default
  if (!current?.provider || !current?.model) {
    throw new Error('хост вернул пустой каталог моделей')
  }
  return {
    current,
    routable: (catalog?.routableProviders?.length ?? 0) > 0 || (catalog?.groups?.length ?? 0) > 0,
    options: optionsFromGroups(catalog?.groups),
  }
}

/** Install a model selection through the host service (no apiProxy on DSH 0.2). */
async function selectSessionModelOnHost(
  ctx: Context,
  sessionId: string,
  selection: { provider: string; model: string; reasoningEffort?: string },
): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
  const controller = hostController(ctx)
  const callHost = controller?.selectModel
  if (typeof callHost !== 'function') {
    throw new Error('хост не умеет переключать модель: нет ни apiProxy, ни sessionController.selectModel')
  }
  const request: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  } = { sessionId, provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== '') {
    request.reasoningEffort = selection.reasoningEffort
  }
  const res = await callHost.call(controller, request)
  if (!res?.selected) throw new Error('хост не подтвердил смену модели')
  return res.selected
}

export function formatModel(sel: { provider: string; model: string; reasoningEffort?: string }): string {
  const base = `${sel.provider}/${sel.model}`
  return sel.reasoningEffort ? `${base} (${sel.reasoningEffort})` : base
}
