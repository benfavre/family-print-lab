// Default care tasks per printer, from the Bambu Lab wiki maintenance pages (fetched 2026-09-27). Each
// entry cites its page and quotes the wiki's words for its interval. Where the wiki gives no fixed
// interval (per print, per roll of filament, "when you see dust"), the interval stays empty for the user
// to set rather than inventing one; the wiki's advice goes in the task's notes. When the wiki gives an
// interval by usage level (P2S, X2D), the "regular usage (1–5 hours a day)" row is used.
import type { ModelCode, Series } from '$lib/shared/printers/models';

export interface DefaultTask {
	kind: string;
	label: string;
	intervalHours: number | null;
	intervalDays: number | null;
	/** The wiki page. */
	source: string;
	/** The wiki's own words for when to do it (review aid; also shown as the task's notes). */
	quote: string;
}

const WIKI = 'https://wiki.bambulab.com/en';
const X1 = `${WIKI}/x1/maintenance/basic-maintenance`;
const X1_FILTER = `${WIKI}/x1/maintenance/replace-carbon-filter`;
const P1 = `${WIKI}/p1/maintenance/p1p-maintenance`;
const A1 = `${WIKI}/a1/maintenance/basic-maintenance`;
const A1_MINI = `${WIKI}/a1-mini/maintenance/period-maintenance`;
const A2L = `${WIKI}/a2l/maintenance/period-maintenance`;
const P2S = `${WIKI}/p2s/maintenance/period-maintenance`;
const X2D = `${WIKI}/x2d/maintenance/periodic-maintenance`;
const P2_FILTER = `${WIKI}/p2s/maintenance/replace-air-filter`;
const H2D = `${WIKI}/h2/maintenance/period-maintenance`;
const H2S = `${WIKI}/h2s/maintenance/period-maintenance`;
const H2C = `${WIKI}/h2c/maintenance/period-maintenance`;
const H2_FILTER = `${WIKI}/h2/maintenance/replace-air-filter`;
const DESICCANT = `${WIKI}/knowledge-sharing/desiccant-status`;
const AMS = `${WIKI}/ams/maintenance/basic-maintenance`;
const AMS_LITE = `${WIKI}/ams-lite/maintenance/basic-maintenance`;

const task = (
	kind: string,
	label: string,
	interval: { hours?: number; days?: number },
	source: string,
	quote: string
): DefaultTask => ({
	kind,
	label,
	intervalHours: interval.hours ?? null,
	intervalDays: interval.days ?? null,
	source,
	quote
});

const CUTTER_X1_P1 =
	'For regular filaments like PLA/PETG/ABS/PC, the blade should be checked every 3-5 rolls.';
const WIPER =
	'The nozzle wiper needs to be checked before starting any print, to ensure it is free of any filament debris and the PTFE side is not damaged.';

const X1_TASKS = (filter: boolean): DefaultTask[] => [
	task(
		'x_carbon_rods',
		'Clean the X-axis carbon rods',
		{ days: 30 },
		X1,
		'The x-axis carbon rods should be checked once a month for any dust and particle buildup.'
	),
	task(
		'yz_rods',
		'Clean the Y and Z linear rods',
		{ days: 30 },
		X1,
		'Y-axis and Z-axis linear rods should be checked once a month for any dust and particle buildup.'
	),
	task(
		'yz_rods_rust',
		'Anti-rust the Y and Z linear rods',
		{ days: 90 },
		X1,
		'Y-axis and Z-axis rods should be anti-rust every three months.'
	),
	task(
		'z_lead_screws',
		'Grease the Z-axis lead screws',
		{ days: 90 },
		X1,
		'The z-axis lead screws should be checked and greased every three months.'
	),
	task(
		'extruder',
		'Clean the extruder gear',
		{ days: 7 },
		X1,
		'We recommend checking and cleaning the extruder gear assembly once a week.'
	),
	task(
		'fans',
		'Clean the fans',
		{ days: 7 },
		X1,
		'We recommend checking the fans every week to clean any debris or dust that might have built up around the blades.'
	),
	...(filter
		? [
				task(
					'carbon_filter',
					'Replace the carbon filter',
					{ hours: 1440 },
					X1_FILTER,
					"Each one's Working Life: 1440 hours (60 days) cumulative printing time."
				)
			]
		: []),
	task('nozzle_wiper', 'Check the nozzle wiper', {}, X1, WIPER),
	task('cutter', 'Check the filament cutter blade', {}, X1, CUTTER_X1_P1)
];

const P1_TASKS: DefaultTask[] = [
	task(
		'x_carbon_rods',
		'Clean the X-axis carbon rods',
		{ days: 30 },
		P1,
		'The x-axis carbon rods should be checked once a month for any dust and particle buildup.'
	),
	task(
		'yz_rods',
		'Clean the Y and Z linear rods',
		{ days: 30 },
		P1,
		'Y-axis and Z-axis linear rods should be checked once a month for any dust and particle buildup.'
	),
	task(
		'yz_rods_rust',
		'Anti-rust the Y and Z linear rods',
		{ days: 90 },
		P1,
		'Y-axis and Z-axis rods should also have an anti-rust treatment every three months.'
	),
	task(
		'z_lead_screws',
		'Grease the Z-axis lead screws',
		{ days: 90 },
		P1,
		'The z-axis lead screws should be checked and greased every three months.'
	),
	task(
		'fans',
		'Clean the fans',
		{ days: 7 },
		P1,
		'We recommend checking the fans every week to clean any debris or dust that might have built up around the blades.'
	),
	task('nozzle_wiper', 'Check the nozzle wiper', {}, P1, WIPER),
	task('cutter', 'Check the filament cutter blade', {}, P1, CUTTER_X1_P1),
	task(
		'ptfe_tube',
		'Check the PTFE tube',
		{},
		P1,
		'When printing regular filaments, we recommend checking the tubes after about 10 rolls of material.'
	)
];

const A1_TASKS = (mini: boolean): DefaultTask[] => {
	const src = mini ? A1_MINI : A1;
	return [
		task('x_rail', 'Clean and oil the X rail', { days: 30 }, src, 'X rail — When: Every month'),
		task('y_rail', 'Clean and oil the Y rails', { days: 30 }, src, 'Y rail — When: Every month'),
		...(mini
			? [
					task(
						'z_rail',
						'Clean and oil the Z rail',
						{ days: 30 },
						src,
						'Z rail — When: Every month'
					)
				]
			: []),
		task(
			'z_lead_screws',
			mini ? 'Grease the lead screw' : 'Grease the lead screws',
			{ days: 90 },
			src,
			'Lead screw — When: Every 3 months'
		),
		task(
			'idlers',
			'Oil the idler pulleys',
			{ days: 90 },
			src,
			'Idler pulley — When: Every 3 months'
		),
		task(
			'hotend_clean',
			'Clean the hotend heating assembly',
			{ days: 30 },
			src,
			'Hotend Heating Assembly — When: Every month'
		),
		task('fans', 'Clean the fans', { days: 7 }, src, 'Part cooling fan — When: Every week'),
		task(
			'cutter',
			'Check the filament cutter blade',
			{},
			src,
			'Check the blade once every 3 rolls of PLA\\ABS\\PETG'
		),
		task(
			'ptfe_tube',
			'Replace the PTFE tube',
			{},
			src,
			'PLA and other non-carbon fiber materials, every 6 rolls'
		)
	];
};

const A2_TASKS: DefaultTask[] = [
	task(
		'x_rail',
		'Clean and oil the X axis',
		{ days: 30 },
		A2L,
		'For the X-axis, we recommend performing maintenance once a month.'
	),
	task(
		'y_rail',
		'Clean and oil the Y axis',
		{ hours: 200 },
		A2L,
		'For the Y-axis, maintenance is required after the initial unboxing and setup, and then every 200 print hours.'
	),
	task('fans', 'Clean the fans', { days: 30 }, A2L, 'Fans — Maintenance cycle: Monthly'),
	task(
		'cutter',
		'Check the filament cutter blade',
		{},
		A2L,
		'Check the blade once every 3 spools for PLA\\ABS\\PETG materials'
	),
	task(
		'ptfe_tube',
		'Replace the PTFE tube',
		{},
		A2L,
		'For non-carbon fiber filaments like PLA, every 6 spools'
	)
];

const P2_TASKS = (src: string): DefaultTask[] => [
	task(
		'xy_axes',
		'Clean and oil the X and Y axes',
		{ days: 60 },
		src,
		'Regular usage (average daily printing 1–5 hours): Maintain XY-axis every 2 months'
	),
	task(
		'z_axis',
		'Clean and grease the Z axis',
		{ days: 120 },
		src,
		'Regular usage (average daily printing 1–5 hours): maintain Z-axis every 4 months'
	),
	task(
		'carbon_filter',
		'Replace the air filter',
		{ hours: 1440 },
		P2_FILTER,
		'Replace after about 1,440 hours of printing time'
	),
	task(
		'camera',
		'Clean the live view camera',
		{ days: 180 },
		src,
		'Clean the camera every 6 months.'
	),
	task(
		'cutter',
		'Check the filament cutter blade',
		{},
		src,
		'Regular filaments (such as PLA, PETG, ABS, PC): check the blade every 8–12 rolls of filament.'
	)
];

const H2_EXTRUDER =
	'We recommend checking and cleaning the extruder gear assembly once a week. If any wear is observed on the extruder gear, it should be replaced.';
const H2_CUTTER =
	'For regular filaments like PLA/PETG/ABS/PC, the blade should be checked every 3-5 rolls.';
const H2_FILTER_TASK = task(
	'carbon_filter',
	'Replace the air filter',
	{ hours: 1440 },
	H2_FILTER,
	'If you are using only the printing function, it is advisable to replace the air filter after a total printing time of 1440 hours (or 60 days).'
);

const H2D_TASKS: DefaultTask[] = [
	task('x_axis', 'Clean and oil the X axis', { days: 30 }, H2D, 'X-axis assembly — 1 months'),
	task(
		'y_rods',
		'Clean and oil the Y linear rods',
		{ days: 30 },
		H2D,
		'Y-axis linear rods — 1 months'
	),
	task(
		'z_axis',
		'Clean and grease the Z rods and lead screws',
		{ days: 30 },
		H2D,
		'Z-axis linear rods and leadscrews — 1 months'
	),
	task(
		'nozzle_lift',
		'Clean the left nozzle lift rail',
		{ days: 30 },
		H2D,
		'Left nozzle lift linear rail — 1 months'
	),
	task('heatbed', 'Clean the heatbed', { days: 90 }, H2D, 'Heatbed — 3 months'),
	task(
		'exhaust_fan',
		'Clean the chamber exhaust fan',
		{ days: 90 },
		H2D,
		'Chamber exhaust fan — 3 months'
	),
	task('extruder', 'Clean the extruder gear', { days: 7 }, H2D, H2_EXTRUDER),
	H2_FILTER_TASK,
	task('cutter', 'Check the filament cutter blade', {}, H2D, H2_CUTTER)
];

const H2S_TASKS: DefaultTask[] = [
	task('heatbed', 'Clean the heatbed', { days: 90 }, H2S, 'Heatbed — Every 3 months'),
	task('toolhead', 'Clean the toolhead', { days: 90 }, H2S, 'Toolhead — Every 3 months'),
	task(
		'exhaust_fan',
		'Clean the chamber exhaust fan',
		{ days: 90 },
		H2S,
		'Chamber Exhaust Fan — Every 3 months'
	),
	task(
		'extruder',
		'Clean the extruder gear',
		{ days: 7 },
		H2S,
		'It is recommended to check and clean the Extruder Gear once a week.'
	),
	H2_FILTER_TASK,
	task('cutter', 'Check the filament cutter blade', {}, H2S, H2_CUTTER)
];

const H2C_TASKS: DefaultTask[] = [
	task('x_axis', 'Clean and oil the X rail', { days: 30 }, H2C, 'X-axis rail — 1 months'),
	task(
		'y_rods',
		'Clean and oil the Y linear rod',
		{ days: 90 },
		H2C,
		'Y-axis linear rod — 3 months'
	),
	task(
		'z_axis',
		'Clean and grease the Z lead screw and rod',
		{ days: 90 },
		H2C,
		'Z-axis lead screw and linear rod — 3 months'
	),
	task(
		'nozzle_lift',
		'Clean the left nozzle lifting rail',
		{ days: 30 },
		H2C,
		'Left nozzle lifting rail — 1 months'
	),
	task(
		'hotend_rack',
		'Clean the induction hotend rack',
		{ days: 30 },
		H2C,
		'Induction Hotend rack — 1 months'
	),
	task('heatbed', 'Clean the heatbed', { days: 90 }, H2C, 'Heatbed — 3 months'),
	task(
		'exhaust_fan',
		'Clean the exhaust fan',
		{ days: 90 },
		H2C,
		'External exhaust fan — 3 months'
	),
	H2_FILTER_TASK
];

/** The default tasks for a model (one list per wiki page). */
export function defaultTasksFor(code: ModelCode, series: Series): DefaultTask[] {
	switch (series) {
		case 'X1':
			// The 1440-hour filter life is on the X1/X1C page; the X1E's filters have their own guide.
			return X1_TASKS(code !== 'C13');
		case 'P1':
			return P1_TASKS;
		case 'A1':
			return A1_TASKS(code === 'N1');
		case 'A2':
			return A2_TASKS;
		case 'P2':
			return P2_TASKS(P2S);
		case 'X2':
			return P2_TASKS(X2D);
		case 'H2':
			return code === 'O1S' ? H2S_TASKS : code === 'O1C' || code === 'O1C2' ? H2C_TASKS : H2D_TASKS;
	}
}

/**
 * Tasks added the first time a printer reports an AMS. The desiccant check applies to the sealed units
 * (AMS, AMS 2 Pro, AMS HT), not the open AMS Lite.
 */
export function amsTasks(units: { model: string }[]): DefaultTask[] {
	const sealed = units.some((u) => u.model !== 'AMS Lite');
	const lite = units.length > 0 && !sealed;
	return [
		...(sealed
			? [
					task(
						'ams_desiccant',
						'Check the AMS desiccant',
						{ days: 14 },
						DESICCANT,
						'It is recommended to check the condition of the desiccant every two weeks and replace it immediately if it becomes ineffective.'
					)
				]
			: []),
		task(
			'ams_ptfe',
			'Replace the AMS PTFE tubes',
			{ days: 60 },
			lite ? AMS_LITE : AMS,
			'Under normal usage conditions, the PTFE tubes should be replaced every two months.'
		)
	];
}

/** Firmware release notes per model on the Bambu Lab wiki (each page checked to exist). */
export const RELEASE_NOTES: Record<ModelCode, string> = {
	'BL-P001': `${WIKI}/x1/manual/X1-X1C-firmware-release-history`,
	'BL-P002': `${WIKI}/x1/manual/X1-X1C-firmware-release-history`,
	C13: `${WIKI}/x1/manual/X1E-firmware-release-history`,
	C11: `${WIKI}/p1/manual/p1p-firmware-release-history`,
	C12: `${WIKI}/p1/manual/p1p-firmware-release-history`,
	N1: `${WIKI}/a1-mini/manual/a1-mini-firmware-release-history`,
	N2S: `${WIKI}/a1/manual/a1-firmware-release-history`,
	N9: `${WIKI}/a2l/manual/a2l-firmware-release-history`,
	N7: `${WIKI}/p2s/manual/p2s-firmware-release-history`,
	N6: `${WIKI}/x2d/manual/X2D-firmware-release-history`,
	O1D: `${WIKI}/h2d/manual/h2d-firmware-release-history`,
	O1E: `${WIKI}/h2d-pro/manual/firmware-release-history`,
	O1S: `${WIKI}/h2s/manual/h2s-firmware-release-history`,
	O1C: `${WIKI}/h2c/manual/h2c-firmware-release-history`,
	O1C2: `${WIKI}/h2c/manual/h2c-firmware-release-history`
};
