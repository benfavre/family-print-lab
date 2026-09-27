// origin: BambuStudio src/libslic3r/Format/bbs_3mf.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// origin: BambuStudio src/libslic3r/Slicing.cpp @ 926a7192574bcb9b3a732e1ec59a46d79cb45466
// The pinned importer rejects <=4 values (bbs_3mf.cpp:3035), although Slicing.cpp:794 accepts
// two points. A collinear midpoint preserves generate_object_layers' linear interpolation.

export function twoPointProfile(profile: number[] | undefined): profile is number[] {
	return (
		!!profile &&
		profile.length === 4 &&
		profile.every(Number.isFinite) &&
		profile[2] > profile[0] &&
		profile[1] > 0 &&
		profile[3] > 0
	);
}

/** Studio needs three points; print_lab.json keeps the exact two-point representation for us. */
export function studioLayerProfile(profile: number[]): number[] {
	return twoPointProfile(profile)
		? [
				profile[0],
				profile[1],
				profile[0] / 2 + profile[2] / 2,
				profile[1] / 2 + profile[3] / 2,
				profile[2],
				profile[3]
			]
		: profile;
}

/** Never restore private metadata over a profile another editor has changed. */
export function restoreLayerProfile(
	current: number[] | undefined,
	saved: number[] | null | undefined
): number[] | undefined {
	if (!saved || !twoPointProfile(saved)) return current;
	const expanded = studioLayerProfile(saved);
	return current?.length === expanded.length && current.every((n, i) => n === expanded[i])
		? saved
		: current;
}
