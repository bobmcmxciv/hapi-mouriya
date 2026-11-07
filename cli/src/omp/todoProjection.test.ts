import { describe, expect, it } from 'vitest';
import { AcpMessageHandler } from '../agent/backends/acp/AcpMessageHandler';
import { convertAgentMessage } from '../agent/messageConverter';
import { extractTodoWriteTodosFromMessageContent, type TodoItem } from '../../../hub/src/sync/todos';

describe('OMP ACP results projected into Tasks', () => {
    it('correlates interleaved calls and applies only completed todo snapshots in order', () => {
        let tasks: TodoItem[] | null = null;
        const snapshots: TodoItem[][] = [];
        const wireTypes: string[] = [];
        const handler = new AcpMessageHandler(message => {
            const data = convertAgentMessage(message);
            if (!data) return;
            wireTypes.push(data.type);
            const projected = extractTodoWriteTodosFromMessageContent({
                role: 'agent',
                content: { type: 'codex', data }
            });
            if (projected !== null) {
                tasks = projected;
                snapshots.push(projected);
            }
        });
        const snapshot = (status: string) => ({
            op: 'init',
            storage: 'session',
            phases: [{ name: 'Ship', tasks: [{ content: 'Project todo results', status }] }]
        });
        const call = (id: string, title: string, rawInput: unknown) => handler.handleUpdate({
            sessionUpdate: 'tool_call', toolCallId: id, title, rawInput, status: 'in_progress'
        });
        const complete = (id: string, rawOutput: unknown) => handler.handleUpdate({
            sessionUpdate: 'tool_call_update', toolCallId: id, rawOutput, status: 'completed'
        });

        call('todo-init', 'todo', { op: 'init', items: ['Project todo results'] });
        call('read', 'Read', { path: 'todo.json' });
        expect(tasks).toBeNull();
        complete('read', snapshot('completed'));
        expect(tasks).toBeNull();
        handler.handleUpdate({
            sessionUpdate: 'tool_call_update', toolCallId: 'todo-init',
            status: 'in_progress', rawOutput: snapshot('pending')
        });
        expect(tasks).toBeNull();
        complete('todo-init', { content: [{ type: 'text', text: 'Initialized' }], details: snapshot('pending') });
        expect(tasks).toEqual([{
            id: 'plan-1', content: 'Project todo results', status: 'pending', priority: 'medium'
        }]);

        call('todo-done', 'todo', { op: 'done', task: 'Project todo results' });
        expect(snapshots).toHaveLength(1);
        complete('todo-done', { ...snapshot('completed'), op: 'done' });
        expect(tasks).toEqual([{
            id: 'plan-1', content: 'Project todo results', status: 'completed', priority: 'medium'
        }]);

        call('todo-malformed', 'todo', { op: 'view' });
        complete('todo-malformed', { op: 'view', phases: [{ name: 'Ship', tasks: null }] });
        complete('unknown-call', { op: 'rm', phases: [], storage: 'session' });
        expect(snapshots).toHaveLength(2);

        call('todo-clear', 'todo', { op: 'rm' });
        complete('todo-clear', { content: [], details: { op: 'rm', phases: [], storage: 'session' } });
        expect(tasks).toEqual([]);
        expect(snapshots.map(snapshot => snapshot.map(task => task.status))).toEqual([
            ['pending'], ['completed'], []
        ]);
        expect(wireTypes.slice(0, 5)).toEqual([
            'tool-call', 'tool-call', 'tool-call-result', 'tool-call', 'tool-call-result'
        ]);
    });
});
