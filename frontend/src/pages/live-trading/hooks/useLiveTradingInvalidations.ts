import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { liveTradingService } from '@/services/liveTradingService'
import type { LiveTradingEvent } from '@/types/liveTrading'
import { invalidateLiveTradingEventQueries } from '../liveTradingRefresh'

const LIVE_EVENT_TYPES = [
  'node.changed',
  'strategy.state.changed',
  'strategy.position.changed',
  'strategy.equity.changed',
  'strategy.order_trade.changed',
  'strategy.risk.changed',
  'strategy.log.changed',
  'strategy.ml.changed',
  'strategy.history.changed',
]

export function useLiveTradingInvalidations(): { eventsConnected: boolean } {
  const queryClient = useQueryClient()
  const [eventsConnected, setEventsConnected] = useState(false)

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setEventsConnected(false)
      return undefined
    }

    const source = new EventSource(liveTradingService.eventsUrl())
    source.onopen = () => setEventsConnected(true)
    source.onerror = () => setEventsConnected(false)
    source.addEventListener('hello', () => setEventsConnected(true))
    source.addEventListener('heartbeat', () => setEventsConnected(true))

    const handlers = LIVE_EVENT_TYPES.map((eventType) => {
      const handler = (ev: Event) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as LiveTradingEvent
          void invalidateLiveTradingEventQueries(queryClient, data)
        } catch (error) {
          console.warn('[live-trading] SSE event parse failed:', error)
        }
      }
      source.addEventListener(eventType, handler)
      return [eventType, handler] as const
    })

    return () => {
      for (const [eventType, handler] of handlers) {
        source.removeEventListener(eventType, handler)
      }
      source.close()
      setEventsConnected(false)
    }
  }, [queryClient])

  return { eventsConnected }
}
