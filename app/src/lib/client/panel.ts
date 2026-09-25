// Lets content inside a floating panel (an editor, the AI design window) talk to its panel.
import { getContext, setContext } from 'svelte';

export interface PanelContext {
	key: string;
	setTitle(title: string): void;
	close(): void;
}
const KEY = Symbol('floating-panel');
export const setPanel = (ctx: PanelContext) => setContext(KEY, ctx);
export const usePanel = () => getContext<PanelContext | undefined>(KEY);
