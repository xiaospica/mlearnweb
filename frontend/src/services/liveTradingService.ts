import type { AxiosRequestConfig } from 'axios'
import apiClient from './apiClient'
import type {
  CorpActionEvent,
  DeleteRecordsStats,
  LiveTradingResponse,
  NodeStatus,
  StrategyCreatePayload,
  StrategyDetail,
  StrategyEditPayload,
  StrategyEngineInfo,
  StrategySummary,
  StrategyTrade,
} from '@/types/liveTrading'

// ─── Ops password storage ───────────────────────────────────────────────
//
// Threat model: the ops password is a single shared secret that gates write
// operations against live vnpy strategies. It is NOT per-user authentication;
// it exists to prevent misclicks from triggering real-money actions on a
// local research workstation.
//
// Storage choice: we keep the password in a **module-level closure**, not in
// sessionStorage / localStorage / cookies.
//   - No DOM storage surface: DevTools → Application → Storage shows nothing.
//   - Attack window is reduced to "from user entry until page reload/tab close";
//     any XSS that fires after a reload sees an empty string.
//   - httpOnly cookies were considered and rejected: they do not stop same-origin
//     XSS from calling fetch(..., {credentials: 'include'}), which for this API
//     is the actual threat. Cookies would add CORS/CSRF plumbing without any
//     real security gain in this single-user localhost deployment.
//   - Frontend encryption was considered and rejected: the key must live in JS
//     too, so XSS obtains both ciphertext and key — pure security theater.
//
// DO NOT persist this value to sessionStorage / localStorage / indexedDB.
let _opsPassword: string | null = null

export function setOpsPassword(pwd: string): void {
  _opsPassword = pwd || null
}

export function clearOpsPassword(): void {
  _opsPassword = null
}

export function hasOpsPassword(): boolean {
  return _opsPassword !== null && _opsPassword.length > 0
}

function withOpsPassword(config: AxiosRequestConfig = {}): AxiosRequestConfig {
  return {
    ...config,
    headers: { ...(config.headers || {}), 'X-Ops-Password': _opsPassword || '' },
  }
}

function enc(s: string): string {
  return encodeURIComponent(s)
}

export const liveTradingService = {
  // --- read endpoints -----------------------------------------------------
  listNodes(): Promise<LiveTradingResponse<NodeStatus[]>> {
    return apiClient.get('/live-trading/nodes').then((r) => r.data)
  },

  listStrategies(): Promise<LiveTradingResponse<StrategySummary[]>> {
    return apiClient.get('/live-trading/strategies').then((r) => r.data)
  },

  getStrategy(
    nodeId: string,
    engine: string,
    name: string,
    windowDays = 7,
  ): Promise<LiveTradingResponse<StrategyDetail>> {
    return apiClient
      .get(`/live-trading/strategies/${enc(nodeId)}/${enc(engine)}/${enc(name)}`, {
        params: { window_days: windowDays },
      })
      .then((r) => r.data)
  },

  listStrategyTrades(
    nodeId: string,
    engine: string,
    name: string,
  ): Promise<LiveTradingResponse<StrategyTrade[]>> {
    return apiClient
      .get(`/live-trading/strategies/${enc(nodeId)}/${enc(engine)}/${enc(name)}/trades`)
      .then((r) => r.data)
  },

  listEngines(nodeId: string): Promise<LiveTradingResponse<StrategyEngineInfo[]>> {
    return apiClient
      .get(`/live-trading/nodes/${enc(nodeId)}/engines`)
      .then((r) => r.data)
  },

  listEngineClasses(
    nodeId: string,
    engine: string,
  ): Promise<LiveTradingResponse<string[]>> {
    return apiClient
      .get(`/live-trading/nodes/${enc(nodeId)}/engines/${enc(engine)}/classes`)
      .then((r) => r.data)
  },

  getClassParams(
    nodeId: string,
    engine: string,
    className: string,
  ): Promise<LiveTradingResponse<Record<string, unknown>>> {
    return apiClient
      .get(
        `/live-trading/nodes/${enc(nodeId)}/engines/${enc(engine)}/classes/${enc(className)}/params`,
      )
      .then((r) => r.data)
  },

  listCorpActions(
    vtSymbols: string[],
    days = 30,
    thresholdPct = 0.5,
  ): Promise<LiveTradingResponse<CorpActionEvent[]>> {
    if (vtSymbols.length === 0) {
      return Promise.resolve({ success: true, data: [], warning: null, message: '' })
    }
    return apiClient
      .get('/live-trading/corp-actions', {
        params: {
          vt_symbols: vtSymbols.join(','),
          days,
          threshold_pct: thresholdPct,
        },
      })
      .then((r) => r.data)
  },

  // --- write endpoints (gated by ops password) ----------------------------
  createStrategy(
    nodeId: string,
    payload: StrategyCreatePayload,
  ): Promise<LiveTradingResponse<unknown>> {
    return apiClient
      .post(`/live-trading/strategies/${enc(nodeId)}`, payload, withOpsPassword())
      .then((r) => r.data)
  },

  initStrategy(
    nodeId: string,
    engine: string,
    name: string,
  ): Promise<LiveTradingResponse<unknown>> {
    return apiClient
      .post(
        `/live-trading/strategies/${enc(nodeId)}/${enc(engine)}/${enc(name)}/init`,
        null,
        withOpsPassword(),
      )
      .then((r) => r.data)
  },

  startStrategy(
    nodeId: string,
    engine: string,
    name: string,
  ): Promise<LiveTradingResponse<unknown>> {
    return apiClient
      .post(
        `/live-trading/strategies/${enc(nodeId)}/${enc(engine)}/${enc(name)}/start`,
        null,
        withOpsPassword(),
      )
      .then((r) => r.data)
  },

  stopStrategy(
    nodeId: string,
    engine: string,
    name: string,
  ): Promise<LiveTradingResponse<unknown>> {
    return apiClient
      .post(
        `/live-trading/strategies/${enc(nodeId)}/${enc(engine)}/${enc(name)}/stop`,
        null,
        withOpsPassword(),
      )
      .then((r) => r.data)
  },

  editStrategy(
    nodeId: string,
    engine: string,
    name: string,
    payload: StrategyEditPayload,
  ): Promise<LiveTradingResponse<unknown>> {
    return apiClient
      .patch(
        `/live-trading/strategies/${enc(nodeId)}/${enc(engine)}/${enc(name)}`,
        payload,
        withOpsPassword(),
      )
      .then((r) => r.data)
  },

  deleteStrategy(
    nodeId: string,
    engine: string,
    name: string,
  ): Promise<LiveTradingResponse<unknown>> {
    return apiClient
      .delete(
        `/live-trading/strategies/${enc(nodeId)}/${enc(engine)}/${enc(name)}`,
        withOpsPassword(),
      )
      .then((r) => r.data)
  },

  deleteStrategyRecords(
    nodeId: string,
    engine: string,
    name: string,
  ): Promise<LiveTradingResponse<DeleteRecordsStats>> {
    return apiClient
      .delete(
        `/live-trading/strategies/${enc(nodeId)}/${enc(engine)}/${enc(name)}/records`,
        withOpsPassword(),
      )
      .then((r) => r.data)
  },
}

export default liveTradingService
