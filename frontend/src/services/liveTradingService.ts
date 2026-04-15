import type { AxiosRequestConfig } from 'axios'
import apiClient from './apiClient'
import type {
  LiveTradingResponse,
  NodeStatus,
  StrategyCreatePayload,
  StrategyDetail,
  StrategyEditPayload,
  StrategyEngineInfo,
  StrategySummary,
} from '@/types/liveTrading'

const OPS_PASSWORD_KEY = 'live_trading_ops_password'

function withOpsPassword(config: AxiosRequestConfig = {}): AxiosRequestConfig {
  const pwd = typeof window !== 'undefined' ? sessionStorage.getItem(OPS_PASSWORD_KEY) || '' : ''
  return {
    ...config,
    headers: { ...(config.headers || {}), 'X-Ops-Password': pwd },
  }
}

function enc(s: string): string {
  return encodeURIComponent(s)
}

export const liveTradingService = {
  OPS_PASSWORD_KEY,

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
}

export default liveTradingService
