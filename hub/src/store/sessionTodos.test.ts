import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('session todo snapshot timestamp policy', () => {
    it('preserves destination tasks on backfill or merge timestamp ties', () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('todo-merge-tie', {}, null, 'default')
            const target = [{ id: 'target', content: 'Keep destination task', status: 'pending', priority: 'medium' }]
            expect(store.sessions.setSessionTodos(session.id, target, 1000, 'default')).toBe(true)
            expect(store.sessions.setSessionTodos(session.id, [], 1000, 'default')).toBe(false)
            expect(store.sessions.getSession(session.id)?.todos).toEqual(target)
            expect(store.sessions.setSessionTodos(session.id, [], 1001, 'default')).toBe(true)
            expect(store.sessions.getSession(session.id)?.todos).toEqual([])
        } finally {
            store.close()
        }
    })

    it('allows live timestamp ties but still rejects older snapshots', () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('todo-live-tie', {}, null, 'default')
            const tasks = [{ id: 'task', content: 'Finish task', status: 'in_progress', priority: 'medium' }]
            const options = { replaceAtSameTimestamp: true }
            expect(store.sessions.setSessionTodos(session.id, tasks, 1000, 'default', options)).toBe(true)
            expect(store.sessions.setSessionTodos(session.id, [], 999, 'default', options)).toBe(false)
            expect(store.sessions.getSession(session.id)?.todos).toEqual(tasks)
            expect(store.sessions.setSessionTodos(session.id, [], 1000, 'default', options)).toBe(true)
            expect(store.sessions.getSession(session.id)?.todos).toEqual([])
            expect(store.sessions.setSessionTodos(session.id, tasks, 999, 'default', options)).toBe(false)
            expect(store.sessions.getSession(session.id)?.todos).toEqual([])
        } finally {
            store.close()
        }
    })
})
