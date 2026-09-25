<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorState, Compartment } from '@codemirror/state';
	import {
		EditorView,
		keymap,
		lineNumbers,
		highlightActiveLine,
		highlightActiveLineGutter,
		drawSelection
	} from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import {
		bracketMatching,
		indentOnInput,
		syntaxHighlighting,
		HighlightStyle,
		foldGutter,
		foldKeymap
	} from '@codemirror/language';
	import {
		autocompletion,
		closeBrackets,
		closeBracketsKeymap,
		completeFromList,
		completionKeymap
	} from '@codemirror/autocomplete';
	import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
	import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
	import { cpp } from '@codemirror/lang-cpp';
	import { tags as t } from '@lezer/highlight';

	export interface Diagnostic {
		level: 'error' | 'warning';
		message: string;
		line: number | null;
	}

	let {
		value,
		diagnostics = [],
		onchange,
		onsave
	}: {
		value: string;
		diagnostics?: Diagnostic[];
		onchange: (value: string) => void;
		onsave?: () => void;
	} = $props();

	let host: HTMLDivElement;
	let view: EditorView | null = null;
	const lint = new Compartment();

	// OpenSCAD vocabulary for autocomplete (the C++ grammar covers highlighting well enough).
	const WORDS: [string, string, string][] = [
		['cube', 'cube([x, y, z], center = false)', 'function'],
		['sphere', 'sphere(r = 10)', 'function'],
		['cylinder', 'cylinder(h = 10, r = 5, center = false)', 'function'],
		['polyhedron', 'polyhedron(points, faces)', 'function'],
		['square', 'square([x, y], center = false)', 'function'],
		['circle', 'circle(r = 5)', 'function'],
		['polygon', 'polygon(points)', 'function'],
		[
			'text',
			'text("Hi", size = 10, font = "Liberation Sans:style=Bold", halign = "center")',
			'function'
		],
		['translate', 'translate([x, y, z])', 'function'],
		['rotate', 'rotate([x, y, z])', 'function'],
		['scale', 'scale([x, y, z])', 'function'],
		['resize', 'resize([x, y, z])', 'function'],
		['mirror', 'mirror([1, 0, 0])', 'function'],
		['multmatrix', 'multmatrix(m)', 'function'],
		['color', 'color("red")', 'function'],
		['offset', 'offset(r = 1)', 'function'],
		['hull', 'hull()', 'function'],
		['minkowski', 'minkowski()', 'function'],
		['union', 'union()', 'function'],
		['difference', 'difference()', 'function'],
		['intersection', 'intersection()', 'function'],
		['linear_extrude', 'linear_extrude(height = 10, twist = 0, scale = 1)', 'function'],
		['rotate_extrude', 'rotate_extrude(angle = 360)', 'function'],
		['projection', 'projection(cut = false)', 'function'],
		['module', 'module name() { }', 'keyword'],
		['function', 'function name() = …;', 'keyword'],
		['for', 'for (i = [0 : n - 1])', 'keyword'],
		['if', 'if (condition)', 'keyword'],
		['else', 'else', 'keyword'],
		['let', 'let (a = 1)', 'keyword'],
		['each', 'each list', 'keyword'],
		['echo', 'echo(value)', 'function'],
		['assert', 'assert(condition, "message")', 'function'],
		['children', 'children()', 'function'],
		['$fn', 'Number of segments for circles', 'variable'],
		['$fa', 'Minimum angle per segment', 'variable'],
		['$fs', 'Minimum segment length', 'variable'],
		['$preview', 'true in preview', 'variable'],
		...[
			'abs',
			'sign',
			'sin',
			'cos',
			'tan',
			'asin',
			'acos',
			'atan',
			'atan2',
			'floor',
			'round',
			'ceil',
			'ln',
			'log',
			'pow',
			'sqrt',
			'exp',
			'min',
			'max',
			'norm',
			'cross',
			'len',
			'concat',
			'lookup',
			'str',
			'chr',
			'ord',
			'search',
			'rands',
			'is_num',
			'is_string',
			'is_list',
			'is_bool',
			'is_undef'
		].map((w): [string, string, string] => [w, `${w}()`, 'function'])
	];

	const highlight = HighlightStyle.define([
		{ tag: [t.keyword, t.controlKeyword, t.definitionKeyword], color: 'rgb(var(--c2))' },
		{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'rgb(var(--c1))' },
		{ tag: [t.number, t.bool, t.null], color: 'rgb(var(--c4))' },
		{ tag: [t.string, t.special(t.string)], color: 'rgb(var(--c3))' },
		{ tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--dim)', fontStyle: 'italic' },
		{ tag: [t.operator, t.punctuation, t.bracket], color: 'var(--muted)' },
		{ tag: [t.variableName, t.propertyName], color: 'var(--text)' },
		{ tag: t.special(t.variableName), color: 'rgb(var(--c6))' }
	]);

	const theme = EditorView.theme({
		'&': { height: '100%', fontSize: '12.5px', background: 'transparent', color: 'var(--text)' },
		'.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
		'.cm-content': { caretColor: 'var(--cyan)', padding: '8px 0' },
		'.cm-gutters': { background: 'transparent', border: 'none', color: 'var(--dim)' },
		'.cm-activeLine': { background: 'rgb(var(--hi) / 0.035)' },
		'.cm-activeLineGutter': { background: 'transparent', color: 'var(--text-2)' },
		'&.cm-focused': { outline: 'none' },
		'&.cm-focused .cm-cursor': { borderLeftColor: 'var(--cyan)' },
		'.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
			background: 'rgb(var(--c1) / 0.22) !important'
		},
		'.cm-matchingBracket': { background: 'rgb(var(--c1) / 0.18)', outline: 'none' },
		'.cm-tooltip': {
			background: 'var(--menu)',
			border: '1px solid var(--line-strong)',
			borderRadius: '8px',
			color: 'var(--text)'
		},
		'.cm-tooltip-autocomplete ul li[aria-selected]': {
			background: 'rgb(var(--c1) / 0.2)',
			color: 'var(--text)'
		},
		'.cm-diagnostic-error': { borderLeft: '3px solid var(--red)' },
		'.cm-diagnostic-warning': { borderLeft: '3px solid var(--amber)' },
		'.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--red)' },
		'.cm-panels': { background: 'var(--menu)', color: 'var(--text)' },
		'.cm-foldGutter span': { color: 'var(--dim)' }
	});

	function lintSource(list: Diagnostic[]) {
		return linter(
			(v): CmDiagnostic[] =>
				list
					.filter((d) => d.line && d.line <= v.state.doc.lines)
					.map((d) => {
						const line = v.state.doc.line(d.line!);
						return {
							from: line.from,
							to: Math.max(line.to, line.from),
							severity: d.level,
							message: d.message
						};
					}),
			{ delay: 0 }
		);
	}

	onMount(() => {
		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: value,
				extensions: [
					lineNumbers(),
					highlightActiveLineGutter(),
					foldGutter(),
					lintGutter(),
					history(),
					drawSelection(),
					indentOnInput(),
					bracketMatching(),
					closeBrackets(),
					highlightActiveLine(),
					highlightSelectionMatches(),
					autocompletion({
						override: [
							completeFromList(WORDS.map(([label, detail, type]) => ({ label, detail, type })))
						]
					}),
					cpp(),
					syntaxHighlighting(highlight),
					theme,
					lint.of(lintSource(diagnostics)),
					keymap.of([
						{ key: 'Mod-s', preventDefault: true, run: () => (onsave?.(), true) },
						indentWithTab,
						...closeBracketsKeymap,
						...defaultKeymap,
						...searchKeymap,
						...historyKeymap,
						...foldKeymap,
						...completionKeymap
					]),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) onchange(u.state.doc.toString());
					}),
					EditorView.contentAttributes.of({ 'aria-label': 'OpenSCAD source code' })
				]
			})
		});
		return () => view?.destroy();
	});

	// Outside changes (AI edits, restoring a version) replace the document.
	$effect(() => {
		const v = value;
		if (view && v !== view.state.doc.toString())
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
	});
	$effect(() => {
		const list = diagnostics;
		view?.dispatch({ effects: lint.reconfigure(lintSource(list)) });
	});

	/** Moves the cursor to a line (from the problems list). */
	export function goto(line: number) {
		if (!view || line > view.state.doc.lines) return;
		const pos = view.state.doc.line(line).from;
		view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
		view.focus();
	}
</script>

<div class="scad-editor" bind:this={host}></div>

<style>
	.scad-editor {
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}
	.scad-editor :global(.cm-editor) {
		height: 100%;
	}
</style>
