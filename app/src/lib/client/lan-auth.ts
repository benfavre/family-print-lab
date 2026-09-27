// Logging this browser out (lan-auth), shared by the top bar button and the command palette.

/** Ends this browser's session and goes to the login page (or home, if this computer needs none). */
export async function logOut() {
	await fetch('/api/auth/logout', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}'
	}).catch(() => {});
	location.assign('/login');
}
