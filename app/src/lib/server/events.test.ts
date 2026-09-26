import { describe, expect, it } from 'vitest';
import { EventBus } from './events';

describe('EventBus', () => {
	it('calls listeners in order, stamps events, keeps the last 200 and survives failing listeners', () => {
		const logs: string[] = [];
		const bus = new EventBus((m) => logs.push(m));
		const seen: string[] = [];
		bus.on('printer.online', (d) => seen.push(`a:${d.printerId}:${typeof d.at}`));
		bus.on('printer.online', () => {
			throw new Error('boom');
		});
		const off = bus.on('printer.online', () => seen.push('c'));
		bus.onAny((e) => seen.push(`any:${e.name}`));
		bus.emit('printer.online', { printerId: 'p1', printerName: 'X2D' });
		expect(seen).toEqual(['a:p1:string', 'c', 'any:printer.online']);
		expect(logs[0]).toMatch(/boom/);
		off();
		for (let i = 0; i < 250; i++)
			bus.emit('printer.online', { printerId: `p${i}`, printerName: '' });
		expect(bus.recent()).toHaveLength(200);
		expect(bus.recent().at(-1)?.data).toMatchObject({ printerId: 'p249' });
		expect(seen.filter((s) => s === 'c')).toHaveLength(1);
	});
});
