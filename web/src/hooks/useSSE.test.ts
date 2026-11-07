import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isGlobalScopedMessageStreamEvent, useSSE } from './useSSE'

describe('useSSE scope handling', () => {
    it('treats message stream events as global-scoped skips', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'message-received')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'messages-consumed')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'message-cancelled')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'scheduled-matured')).toBe(true)
    })

    it('does not skip session lifecycle events on the global connection', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'session-updated')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-added')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-removed')).toBe(false)
    })

    it('processes message stream events on full-scoped connections', () => {
        expect(isGlobalScopedMessageStreamEvent('full', 'message-received')).toBe(false)
    })
})

class TestEventSource {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    static instances: TestEventSource[] = []

    readyState: number = TestEventSource.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null

    constructor(readonly url: string) {
        TestEventSource.instances.push(this)
    }

    close = vi.fn(() => {
        this.readyState = TestEventSource.CLOSED
    })

    open() {
        this.readyState = TestEventSource.OPEN
        this.onopen?.(new Event('open'))
    }

    fail(readyState: number = TestEventSource.CLOSED) {
        this.readyState = readyState
        this.onerror?.(new Event('error'))
    }

    message(data: unknown) {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }))
    }
}

type SSEOptions = Parameters<typeof useSSE>[0]

function renderSSE(overrides: Partial<SSEOptions> = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const options = {
        enabled: true,
        token: 'test-token',
        baseUrl: 'http://hub.test',
        subscription: { sessionId: 'session-1' },
        onEvent: vi.fn(),
        onConnect: vi.fn(),
        onDisconnect: vi.fn(),
        ...overrides,
    }
    const hook = renderHook((props: SSEOptions) => useSSE(props), {
        initialProps: options,
        wrapper: ({ children }: { children: ReactNode }) => (
            createElement(QueryClientProvider, { client: queryClient }, children)
        ),
    })
    return { ...hook, options }
}

describe('useSSE connection recovery', () => {
    let visibility: DocumentVisibilityState

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        vi.spyOn(Math, 'random').mockReturnValue(0.5)
        visibility = 'visible'
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
        TestEventSource.instances = []
        vi.stubGlobal('EventSource', TestEventSource)
    })

    afterEach(() => {
        cleanup()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
        vi.useRealTimers()
    })

    const advance = (milliseconds: number) => {
        act(() => vi.advanceTimersByTime(milliseconds))
    }

    const setVisibility = (next: DocumentVisibilityState) => {
        act(() => {
            visibility = next
            document.dispatchEvent(new Event('visibilitychange'))
        })
    }

    it('replaces a silent CONNECTING source after ten seconds with only first-retry jitter', () => {
        const { options } = renderSSE()
        const first = TestEventSource.instances[0]!

        advance(9_999)
        expect(first.close).not.toHaveBeenCalled()
        advance(1)
        expect(first.close).toHaveBeenCalledTimes(1)
        expect(options.onDisconnect).toHaveBeenCalledWith('connect-timeout')
        expect(TestEventSource.instances).toHaveLength(1)

        advance(249)
        expect(TestEventSource.instances).toHaveLength(1)
        advance(1)
        expect(TestEventSource.instances).toHaveLength(2)
        expect(TestEventSource.instances[1]!.url).toBe(first.url)
        expect(new URL(first.url).searchParams.get('sessionId')).toBe('session-1')
    })

    it('clears the initial deadline on OPEN and keeps subscription events working', () => {
        const { options, result } = renderSSE()
        const source = TestEventSource.instances[0]!
        advance(9_000)
        act(() => {
            source.open()
            source.message({ type: 'connection-changed', data: { subscriptionId: 'connected-1' } })
        })
        expect(result.current.subscriptionId).toBe('connected-1')
        expect(options.onConnect).toHaveBeenCalledTimes(1)
        expect(options.onEvent).toHaveBeenCalledWith({
            type: 'connection-changed', data: { subscriptionId: 'connected-1' },
        })

        // A subsequent native retry must not be closed by the old initial deadline.
        act(() => source.fail(TestEventSource.CONNECTING))
        advance(1_500)
        expect(source.close).not.toHaveBeenCalled()
        expect(TestEventSource.instances).toHaveLength(1)
        expect(options.onDisconnect).toHaveBeenCalledTimes(1)
        expect(options.onDisconnect).toHaveBeenCalledWith('error')
        act(() => source.open())
        advance(10_000)
        expect(source.close).not.toHaveBeenCalled()
        expect(options.onConnect).toHaveBeenCalledTimes(2)
    })

    it('backs off repeated failed connections and resets the delay after OPEN', () => {
        renderSSE()
        act(() => TestEventSource.instances[0]!.fail())
        advance(250)
        expect(TestEventSource.instances).toHaveLength(2)

        act(() => TestEventSource.instances[1]!.fail())
        advance(1_249)
        expect(TestEventSource.instances).toHaveLength(2)
        advance(1)
        expect(TestEventSource.instances).toHaveLength(3)

        act(() => TestEventSource.instances[2]!.fail())
        advance(2_249)
        expect(TestEventSource.instances).toHaveLength(3)
        advance(1)
        expect(TestEventSource.instances).toHaveLength(4)

        act(() => {
            TestEventSource.instances[3]!.open()
            TestEventSource.instances[3]!.fail()
        })
        advance(250)
        expect(TestEventSource.instances).toHaveLength(5)
    })

    it('recovers on foreground resume at 45 seconds since the latest heartbeat', () => {
        const { options } = renderSSE()
        const source = TestEventSource.instances[0]!
        act(() => source.open())
        setVisibility('hidden')
        advance(30_000)
        act(() => source.message({ type: 'heartbeat' }))
        advance(44_999)
        setVisibility('visible')
        expect(source.close).not.toHaveBeenCalled()

        setVisibility('hidden')
        advance(1)
        setVisibility('visible')
        expect(source.close).toHaveBeenCalledTimes(1)
        expect(options.onDisconnect).toHaveBeenCalledWith('visibility-recovery')
        advance(250)
        expect(TestEventSource.instances).toHaveLength(2)
        expect(new URL(TestEventSource.instances[1]!.url).searchParams.get('visibility')).toBe('visible')
    })

    it('keeps the continuously foreground watchdog at 90 seconds', () => {
        const { options } = renderSSE()
        const source = TestEventSource.instances[0]!
        act(() => source.open())
        advance(89_999)
        expect(source.close).not.toHaveBeenCalled()
        advance(1)
        expect(source.close).toHaveBeenCalledTimes(1)
        expect(options.onDisconnect).toHaveBeenCalledWith('heartbeat-timeout')
        advance(250)
        expect(TestEventSource.instances).toHaveLength(2)
    })

    it.each(['unmount', 'disable', 'subscription'] as const)(
        'cancels pending connection deadlines on %s',
        (transition) => {
            const { options, unmount, rerender } = renderSSE()
            const oldSource = TestEventSource.instances[0]!
            advance(5_000)
            if (transition === 'unmount') {
                unmount()
            } else if (transition === 'disable') {
                rerender({ ...options, enabled: false })
            } else {
                rerender({ ...options, subscription: { sessionId: 'session-2' } })
                act(() => TestEventSource.instances[1]!.open())
            }

            advance(60_000)
            expect(oldSource.close).toHaveBeenCalledTimes(1)
            expect(options.onDisconnect).not.toHaveBeenCalled()
            expect(TestEventSource.instances).toHaveLength(transition === 'subscription' ? 2 : 1)
        },
    )

    it.each(['unmount', 'disable', 'subscription'] as const)(
        'cancels queued retries and ignores late source events on %s',
        (transition) => {
            const { options, unmount, rerender } = renderSSE()
            const oldSource = TestEventSource.instances[0]!
            act(() => oldSource.fail())
            advance(100)
            if (transition === 'unmount') {
                unmount()
            } else if (transition === 'disable') {
                rerender({ ...options, enabled: false })
            } else {
                rerender({ ...options, subscription: { sessionId: 'session-2' } })
                act(() => TestEventSource.instances[1]!.open())
            }
            const connectCount = transition === 'subscription' ? 1 : 0
            act(() => {
                oldSource.open()
                oldSource.fail()
            })

            advance(60_000)
            expect(TestEventSource.instances).toHaveLength(transition === 'subscription' ? 2 : 1)
            expect(options.onConnect).toHaveBeenCalledTimes(connectCount)
            expect(options.onDisconnect).toHaveBeenCalledTimes(1)
        },
    )

    it('does not let a late old OPEN cancel a replacement subscription deadline', () => {
        const { options, rerender } = renderSSE()
        const oldSource = TestEventSource.instances[0]!
        advance(5_000)
        rerender({ ...options, subscription: { sessionId: 'session-2' } })
        const replacement = TestEventSource.instances[1]!
        act(() => oldSource.open())

        advance(5_000)
        expect(options.onDisconnect).not.toHaveBeenCalled()
        expect(replacement.close).not.toHaveBeenCalled()
        advance(5_000)
        expect(options.onConnect).not.toHaveBeenCalled()
        expect(replacement.close).toHaveBeenCalledTimes(1)
        expect(options.onDisconnect).toHaveBeenCalledWith('connect-timeout')
        advance(250)
        expect(TestEventSource.instances).toHaveLength(3)
        expect(new URL(TestEventSource.instances[2]!.url).searchParams.get('sessionId')).toBe('session-2')
    })
})
