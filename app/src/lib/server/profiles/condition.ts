// compatible_printers_condition / compatible_prints_condition: the boolean subset of Bambu Studio's
// PlaceholderParser (src/libslic3r/PlaceholderParser.cpp, evaluate_boolean_expression) that preset
// conditions use: config variables (with [index] for vectors), string, number and regex literals,
// == != <> < > <= >=, =~ and !~ against /regex/, and or && || not !, + - * /, parentheses, and the
// functions min, max, int, one_of. Upstream treats a condition that fails to parse as "compatible with
// everything" (Preset.cpp is_compatible_with_printer); callers do the same with ConditionError.
// At the pinned tag every condition in the BBL vendor set is empty, which parses to `true`.
import type { ConfigMap, ConfigValue } from '$lib/shared/slicer/project';

export class ConditionError extends Error {}

type Value = number | string | boolean | RegExp;

type Token =
	| { t: 'num'; v: number }
	| { t: 'str'; v: string }
	| { t: 're'; v: RegExp }
	| { t: 'id'; v: string }
	| { t: 'op'; v: string };

const OPS = [
	'==',
	'!=',
	'<>',
	'<=',
	'>=',
	'=~',
	'!~',
	'&&',
	'||',
	'<',
	'>',
	'!',
	'(',
	')',
	'[',
	']',
	',',
	'+',
	'-',
	'*',
	'/'
];

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	// A "/" starts a regex only where an operand is expected (after =~ / !~, "(", "," or at the start).
	const expectOperand = () => {
		const last = out.at(-1);
		return !last || (last.t === 'op' && last.v !== ')' && last.v !== ']');
	};
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === '"') {
			let s = '';
			i++;
			while (i < src.length && src[i] !== '"') {
				if (src[i] === '\\' && i + 1 < src.length) i++;
				s += src[i++];
			}
			if (src[i] !== '"') throw new ConditionError('Unterminated string.');
			i++;
			out.push({ t: 'str', v: s });
			continue;
		}
		if (c === '/' && expectOperand()) {
			let s = '';
			i++;
			while (i < src.length && src[i] !== '/') {
				if (src[i] === '\\' && i + 1 < src.length) s += src[i++];
				s += src[i++];
			}
			if (src[i] !== '/') throw new ConditionError('Unterminated regular expression.');
			i++;
			try {
				out.push({ t: 're', v: new RegExp(s) });
			} catch {
				throw new ConditionError(`Invalid regular expression /${s}/.`);
			}
			continue;
		}
		const num = src.slice(i).match(/^\d+(\.\d+)?([eE][-+]?\d+)?/);
		if (num) {
			out.push({ t: 'num', v: Number(num[0]) });
			i += num[0].length;
			continue;
		}
		const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
		if (id) {
			out.push({ t: 'id', v: id[0] });
			i += id[0].length;
			continue;
		}
		const op = OPS.find((o) => src.startsWith(o, i));
		if (!op) throw new ConditionError(`Unexpected "${c}".`);
		out.push({ t: 'op', v: op });
		i += op.length;
	}
	return out;
}

/** A config value as the parser sees it: numbers where they parse, else text. */
function scalar(v: string): Value {
	const n = Number(v);
	return v.trim() !== '' && Number.isFinite(n) ? n : v;
}

const truthy = (v: Value) =>
	typeof v === 'boolean'
		? v
		: typeof v === 'number'
			? v !== 0
			: typeof v === 'string'
				? v !== '' && v !== '0' && v.toLowerCase() !== 'false'
				: true;

function compare(a: Value, b: Value): number {
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'boolean' || typeof b === 'boolean')
		return Number(truthy(a)) - Number(truthy(b));
	const x = String(a);
	const y = String(b);
	return x < y ? -1 : x > y ? 1 : 0;
}

class Parser {
	private i = 0;
	constructor(
		private tokens: Token[],
		private vars: (name: string) => ConfigValue | undefined
	) {}

	private peek(v?: string) {
		const t = this.tokens[this.i];
		return v === undefined ? t : t && (t.t === 'op' || t.t === 'id') && t.v === v ? t : undefined;
	}
	private eat(v: string) {
		if (!this.peek(v)) throw new ConditionError(`Expected "${v}".`);
		this.i++;
	}

	parse(): boolean {
		if (!this.tokens.length) return true;
		const v = this.or();
		if (this.i < this.tokens.length)
			throw new ConditionError('Unexpected text after the condition.');
		return truthy(v);
	}

	private or(): Value {
		let v = this.and();
		while (this.peek('or') || this.peek('||')) {
			this.i++;
			const r = this.and();
			v = truthy(v) || truthy(r);
		}
		return v;
	}
	private and(): Value {
		let v = this.not();
		while (this.peek('and') || this.peek('&&')) {
			this.i++;
			const r = this.not();
			v = truthy(v) && truthy(r);
		}
		return v;
	}
	private not(): Value {
		if (this.peek('not') || this.peek('!')) {
			this.i++;
			return !truthy(this.not());
		}
		return this.comparison();
	}
	private comparison(): Value {
		const a = this.sum();
		const t = this.peek();
		if (t?.t !== 'op') return a;
		switch (t.v) {
			case '=~':
			case '!~': {
				this.i++;
				const re = this.sum();
				if (!(re instanceof RegExp)) throw new ConditionError('Expected a /regex/ after =~.');
				const hit = re.test(String(a));
				return t.v === '=~' ? hit : !hit;
			}
			case '==':
				this.i++;
				return compare(a, this.sum()) === 0;
			case '!=':
			case '<>':
				this.i++;
				return compare(a, this.sum()) !== 0;
			case '<':
				this.i++;
				return compare(a, this.sum()) < 0;
			case '>':
				this.i++;
				return compare(a, this.sum()) > 0;
			case '<=':
				this.i++;
				return compare(a, this.sum()) <= 0;
			case '>=':
				this.i++;
				return compare(a, this.sum()) >= 0;
		}
		return a;
	}
	private sum(): Value {
		let v = this.product();
		while (this.peek('+') || this.peek('-')) {
			const op = (this.tokens[this.i++] as { v: string }).v;
			const r = this.product();
			if (op === '+' && (typeof v === 'string' || typeof r === 'string')) v = `${v}${r}`;
			else v = op === '+' ? num(v) + num(r) : num(v) - num(r);
		}
		return v;
	}
	private product(): Value {
		let v = this.unary();
		while (this.peek('*') || this.peek('/')) {
			const op = (this.tokens[this.i++] as { v: string }).v;
			const r = this.unary();
			v = op === '*' ? num(v) * num(r) : num(v) / num(r);
		}
		return v;
	}
	private unary(): Value {
		if (this.peek('-')) {
			this.i++;
			return -num(this.unary());
		}
		return this.primary();
	}
	private primary(): Value {
		const t = this.tokens[this.i++];
		if (!t) throw new ConditionError('The condition ends too early.');
		if (t.t === 'num' || t.t === 'str' || t.t === 're') return t.v;
		if (t.t === 'op' && t.v === '(') {
			const v = this.or();
			this.eat(')');
			return v;
		}
		if (t.t !== 'id') throw new ConditionError(`Unexpected "${t.v}".`);
		if (t.v === 'true') return true;
		if (t.v === 'false') return false;
		if (this.peek('(')) return this.call(t.v);
		const value = this.vars(t.v);
		if (value === undefined) throw new ConditionError(`Unknown variable ${t.v}.`);
		if (this.peek('[')) {
			this.i++;
			const index = num(this.or());
			this.eat(']');
			if (!Array.isArray(value)) throw new ConditionError(`${t.v} is not a vector.`);
			const item = value[Math.trunc(index)];
			if (item === undefined) throw new ConditionError(`${t.v}[${index}] is out of range.`);
			return scalar(item);
		}
		// A vector without an index reads its first value.
		return scalar(Array.isArray(value) ? (value[0] ?? '') : value);
	}
	private call(name: string): Value {
		this.eat('(');
		const args: Value[] = [];
		if (!this.peek(')'))
			for (;;) {
				args.push(this.or());
				if (!this.peek(',')) break;
				this.i++;
			}
		this.eat(')');
		switch (name) {
			case 'min':
			case 'max':
				if (args.length !== 2) throw new ConditionError(`${name}() takes two values.`);
				return Math[name](num(args[0]), num(args[1]));
			case 'int':
				if (args.length !== 1) throw new ConditionError('int() takes one value.');
				return Math.trunc(num(args[0]));
			case 'one_of': {
				const [v, ...options] = args;
				if (v === undefined) throw new ConditionError('one_of() needs a value.');
				return options.some((o) => (o instanceof RegExp ? o.test(String(v)) : compare(v, o) === 0));
			}
		}
		throw new ConditionError(`Unknown function ${name}().`);
	}
}

function num(v: Value): number {
	if (typeof v === 'number') return v;
	if (typeof v === 'boolean') return v ? 1 : 0;
	const n = Number(v);
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(n)) return n;
	throw new ConditionError(`Not a number: ${String(v)}.`);
}

/** Checks a condition parses (ConditionError otherwise): every variable reads as the vector ["0"]. */
export function parseCondition(src: string): void {
	new Parser(tokenize(src), () => ['0']).parse();
}

/** Evaluates a condition against a printer's config plus extra variables. Throws ConditionError. */
export function evaluateCondition(src: string, config: ConfigMap, extra: ConfigMap = {}): boolean {
	return new Parser(tokenize(src), (name) => extra[name] ?? config[name]).parse();
}
