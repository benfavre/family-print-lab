// Kid mode templates: OpenSCAD sources behind the shared descriptions in $lib/shared/kid, plus the
// server-side rules that keep what a child makes safe to print and handle: values are clamped to the
// level's ranges, text is limited to plain letters, every outline has rounded corners, and parts for
// little makers must not fit the small-parts (choking hazard) cylinder.
import type { KidLevel } from '$lib/shared/domain';
import { kidTemplate, smallPartsHazard, type KidTemplate } from '$lib/shared/kid';
import type { ParamValues } from '$lib/shared/cad';
import { renderScad } from '../cad/openscad';
import { stats, type Soup } from '../cad/mesh';
import { AppError } from '../validation';

/** 2D shapes shared by the templates, each about `s` mm across, with rounded corners. */
const SHAPES = `
module rounded2d(r) { offset(r = r) offset(delta = -r) children(); }
module star2d(s, inner = 0.48) {
  rounded2d(s * 0.04)
    polygon([for (i = [0:9]) let(r = (i % 2 == 0 ? 1 : inner) * s / 2, a = 90 + i * 36) [r * cos(a), r * sin(a)]]);
}
module heart2d(s) {
  rounded2d(s * 0.03) resize([s, s * 0.915])
    translate([0, -7.8]) rotate(45) union() { square(10); translate([5, 10]) circle(5); translate([10, 5]) circle(5); }
}
module flower2d(s) {
  r = s / 2;
  union() { circle(r * 0.64); for (a = [0:60:359]) rotate(a) translate([r * 0.64, 0]) circle(r * 0.36); }
}
module moon2d(s) {
  rounded2d(s * 0.05) difference() { circle(d = s); translate([s * 0.28, s * 0.12]) circle(d = s * 0.82); }
}
module shape2d(name, s) {
  if (name == "star") star2d(s);
  else if (name == "heart") heart2d(s);
  else if (name == "flower") flower2d(s);
  else if (name == "moon") moon2d(s);
  else circle(d = s);
}
`;

const FONT = 'Liberation Sans:style=Bold';
/** Largest part (mm) a kid can make: fits common beds (256 mm) with room to spare. */
const MAX_SIZE = 240;

const SOURCES: Record<string, string> = {
	'name-sign': `// Name sign (kid mode template)
name = "Maker";
wanted_letter = 18; // [10:1:26]
shape = "rounded"; // [rounded, bubble]
extra = "none"; // [none, border, hole]
/* [Hidden] */
min_width = 60;
base = 3;
raised = 2;
$fn = 48;
// Long names get smaller letters so the sign stays on the bed: 170 mm of text plus the rounded margin.
// A bold W is 1.31 letter sizes wide, the widest character, so 1.35 per character always fits.
letter = min(wanted_letter, 170 / (max(len(name), 1) * 1.35));
${SHAPES}
module words() text(name, size = letter, font = "${FONT}", halign = "center", valign = "center");
// Mirrored copies make the outline symmetric, so both ends match whatever the first and last letters are.
module core() hull() {
  for (mx = [0, 1], my = [0, 1]) mirror([mx, 0]) mirror([0, my]) words();
  square([min_width - letter * 1.6, letter], center = true);
  if (extra == "hole") translate([0, letter * 0.5 + 7]) circle(d = 1);
}
module plate() {
  if (shape == "bubble") offset(r = letter * 0.8) core();
  else offset(r = letter * 0.3) offset(delta = letter * 0.5) core();
}
difference() {
  linear_extrude(base) plate();
  if (extra == "hole") translate([0, letter * 0.5 + 6, -1]) cylinder(d = 5, h = base + 2);
}
translate([0, 0, base - 0.01]) linear_extrude(raised) words();
if (extra == "border")
  translate([0, 0, base - 0.01]) linear_extrude(raised) difference() { plate(); offset(delta = -2.4) plate(); }
`,
	'pencil-cup': `// Pencil cup (kid mode template)
height = 80; // [60:5:110]
width = 70; // [50:5:90]
sides = "hexagon"; // [round, hexagon, star]
twist = "yes"; // [no, yes]
/* [Hidden] */
wall = 2.4;
floor_t = 2.4;
$fn = 96;
${SHAPES}
module outline() {
  if (sides == "hexagon") rounded2d(4) circle(d = width, $fn = 6);
  else if (sides == "star") star2d(width, 0.8);
  else circle(d = width);
}
tw = twist == "yes" && sides != "round" ? 60 : 0;
module outer() linear_extrude(height, twist = tw, slices = 40) outline();
union() {
  difference() {
    outer();
    linear_extrude(height + 1, twist = tw * (height + 1) / height, slices = 40) offset(delta = -wall) outline();
  }
  intersection() { outer(); cylinder(h = floor_t, d = width * 2); }
}
`,
	'treasure-dish': `// Treasure dish (kid mode template)
shape = "star"; // [star, heart, circle, flower, moon]
size = 90; // [60:5:130]
depth = 15; // [8:1:30]
/* [Hidden] */
wall = 2.4;
floor_t = 2;
$fn = 64;
${SHAPES}
difference() {
  linear_extrude(depth) shape2d(shape, size);
  translate([0, 0, floor_t]) linear_extrude(depth) offset(delta = -wall) shape2d(shape, size);
}
`,
	stencil: `// Drawing stencil (kid mode template)
shape = "heart"; // [star, heart, circle, flower, moon]
size = 70; // [40:5:100]
/* [Hidden] */
thick = 2;
$fn = 64;
${SHAPES}
plate = size + 36;
difference() {
  linear_extrude(thick) rounded2d(8) square(plate, center = true);
  translate([0, 0, -1]) linear_extrude(thick + 2) shape2d(shape, size);
  translate([plate / 2 - 10, plate / 2 - 10, -1]) cylinder(d = 7, h = thick + 2);
}
`,
	keychain: `// Keychain tag (kid mode template)
name = "Maker";
shape = "circle"; // [star, heart, circle, flower]
size = 50; // [40:5:60]
/* [Hidden] */
base = 3;
raised = 1.4;
$fn = 64;
${SHAPES}
// Typical names are about 1.0 letter size per character; anything wider is clipped to the tag.
letter = min(size * 0.26, size * 0.62 / max(len(name), 1));
module tag() union() { shape2d(shape, size); translate([0, size * 0.5]) circle(d = 13); }
difference() {
  linear_extrude(base) tag();
  translate([0, size * 0.5 + 1, -1]) cylinder(d = 5, h = base + 2);
}
translate([0, 0, base - 0.01]) linear_extrude(raised) intersection() {
  offset(delta = -2) shape2d(shape, size);
  text(name, size = letter, font = "${FONT}", halign = "center", valign = "center");
}
`
};

/** Values the child cannot change, per level (thicker stencils for little hands). */
const FIXED: Record<string, Partial<Record<KidLevel, ParamValues>>> = {
	stencil: { little: { thick: 2.4 }, junior: { thick: 1.6 } },
	'name-sign': { little: { min_width: 70 }, junior: { min_width: 50 } }
};

/** Letters (any language), digits, spaces and a little punctuation; no quotes, symbols or emoji. */
export function cleanKidText(value: unknown, max: number) {
	return String(value ?? '')
		.normalize('NFC')
		.replace(/[^\p{L}\p{N} .!?&'-]/gu, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
}

export function templateSource(id: string) {
	const source = SOURCES[id];
	if (!source) throw new AppError(404, 'That template does not exist.');
	return source;
}

export function usableTemplate(id: string, level: KidLevel): KidTemplate {
	const template = kidTemplate(id);
	if (!template || !SOURCES[id]) throw new AppError(404, 'That template does not exist.');
	if (!template.levels.includes(level))
		throw new AppError(403, 'That one is for older makers. Pick another!');
	return template;
}

/**
 * Turns what the child chose into safe OpenSCAD parameters: unknown keys are dropped, numbers are
 * clamped and snapped to the level's range, choices must be listed, and empty text falls back to
 * `fallbackText` (the child's name).
 */
export function kidParams(
	template: KidTemplate,
	level: KidLevel,
	input: Record<string, unknown>,
	fallbackText: string
): ParamValues {
	const params: ParamValues = {};
	for (const control of template.controls) {
		const raw = input[control.name] ?? template.defaults[control.name];
		if (control.kind === 'text') {
			const max = control.max[level];
			params[control.name] = cleanKidText(raw, max) || cleanKidText(fallbackText, max) || 'Hi';
		} else if (control.kind === 'size') {
			const [min, max] = control.range[level];
			const n = Number(raw);
			const value = Number.isFinite(n) ? n : min;
			params[control.name] = Math.min(
				max,
				Math.max(min, Math.round(value / control.step) * control.step)
			);
		} else {
			const allowed = control.options.map((o) => o.value);
			params[control.name] = allowed.includes(String(raw)) ? String(raw) : allowed[0];
		}
	}
	return { ...params, ...FIXED[template.id]?.[level] };
}

export interface KidRender {
	source: string;
	params: ParamValues;
	soup: Soup;
	size: [number, number, number];
	volume: number;
	/** Small enough to be a choking hazard for children under 3 (only possible for junior makers). */
	smallParts: boolean;
}

/** Renders a template for a child, refusing results that break the level's safety rules. */
export async function renderKid(
	templateId: string,
	level: KidLevel,
	input: Record<string, unknown>,
	fallbackText: string
): Promise<KidRender> {
	const template = usableTemplate(templateId, level);
	const params = kidParams(template, level, input, fallbackText);
	const source = templateSource(templateId);
	const render = await renderScad(source, params);
	if (!render.soup)
		throw new AppError(422, 'That one did not work. Try different letters or a different size.');
	const s = stats(render.soup);
	if (Math.max(...s.size) > MAX_SIZE)
		throw new AppError(422, 'That is too big for the printer. Make it a bit smaller!');
	const smallParts = smallPartsHazard(s.size);
	if (smallParts && level === 'little')
		throw new AppError(422, 'That would be too small to be safe. Make it bigger!');
	return { source, params, soup: render.soup, size: s.size, volume: s.volume, smallParts };
}
