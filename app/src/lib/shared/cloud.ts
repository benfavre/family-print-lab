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
	/** Send the printer's progress (state, title, percent, time left) for the phone. Off by default. */
	shareProgress: boolean;
	/** While linking: the code to enter and where. */
	pairing: { userCode: string; verifyUrl: string; expiresAt: string } | null;
	error: string | null;
	linkedAt: string | null;
}

export const CLOUD_OFF: CloudStatus = {
	configured: false,
	url: '',
	state: 'unlinked',
	account: null,
	plan: false,
	shareNames: true,
	shareProgress: false,
	pairing: null,
	error: null,
	linkedAt: null
};
