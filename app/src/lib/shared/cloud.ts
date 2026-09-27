// Print Lab Cloud link status, shared by the server connector and the Family page.

export interface CloudStatus {
	/** Whether this installation has a cloud address (CLOUD_URL). */
	configured: boolean;
	url: string;
	state: 'unlinked' | 'pairing' | 'connecting' | 'online' | 'offline';
	/** The cloud account this computer is linked to. */
	account: string | null;
	/** Whether that account has the Family plan (needed to answer from the phone). */
	plan: boolean;
	/** Send kids' first names with their requests (otherwise "Your child"). */
	shareNames: boolean;
	/** Send the printers' status (state, title, percent, time left) for the phone. Off by default. */
	shareProgress: boolean;
	/** Send the printers' active alerts (code, severity, text) with their status. */
	shareAlerts: boolean;
	/** Send the print queue (titles, order, why each waits). */
	shareQueue: boolean;
	/** Camera snapshots and live view on the phone, sealed with the phone key. */
	snapshots: boolean;
	/** Pause, resume and stop from the phone, signed with the phone key (Family plan). */
	remoteControl: boolean;
	/** The household phone key's id (never the key) and when it was made; null until first shown. */
	phoneKey: { id: string; createdAt: string } | null;
	/** Protocol spoken with the cloud: 1 for an older cloud (one printer, no remote control). */
	protocol: 1 | 2;
	/** Encrypted backups in the cloud (Family plan). The recovery key never leaves this computer. */
	backup: {
		enabled: boolean;
		last: { at: string; size: number } | null;
		error: string | null;
	};
	/** Kid mode template packs installed from the cloud (Family plan). */
	packs: { id: string; title: string; icon: string; templates: number }[];
	/** While linking: the code to enter and where. */
	pairing: { userCode: string; verifyUrl: string; expiresAt: string } | null;
	error: string | null;
	linkedAt: string | null;
}

/** A backup stored in the cloud (from any computer linked to the account). */
export interface CloudBackup {
	id: string;
	device: string;
	createdAt: string;
	size: number;
	/** Whether this computer's recovery key opens it. */
	ours: boolean;
}

export const CLOUD_OFF: CloudStatus = {
	configured: false,
	url: '',
	state: 'unlinked',
	account: null,
	plan: false,
	shareNames: true,
	shareProgress: false,
	shareAlerts: false,
	shareQueue: false,
	snapshots: false,
	remoteControl: false,
	phoneKey: null,
	protocol: 2,
	backup: { enabled: false, last: null, error: null },
	packs: [],
	pairing: null,
	error: null,
	linkedAt: null
};
