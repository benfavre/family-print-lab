// The login and "set a password first" pages. They are plain server-rendered HTML with a normal form
// POST (no script): the app's root layout loads the whole workspace for every page, so these must not
// go through it before someone has logged in.
import type { AuthMode } from '$lib/shared/lan-auth';

const esc = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
	);

/** Only same-app paths, so the login page cannot be used to send people elsewhere. */
export function safeNext(next: string | null | undefined): string {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
	if (next.startsWith('/login') || next.startsWith('/api/')) return '/';
	return next;
}

const STYLE = `
@font-face{font-family:Geist;src:url('/fonts/Geist-Variable.woff2') format('woff2');font-weight:100 900;font-display:swap}
:root{color-scheme:dark;--bg:#080a0f;--panel:#10131b;--text:#e9f1ff;--muted:#8d9cb6;--line:rgb(255 255 255/.15);--accent:#5ee7ff;--on-accent:#04121a;--err:#ffb3bc}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f6fb;--panel:#fff;--text:#131a2a;--muted:#5a6780;--line:rgb(0 0 0/.14);--accent:#0b7fa3;--on-accent:#fff;--err:#b3261e}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:14px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
main{width:100%;max-width:380px;padding:28px 24px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
h1{margin:0 0 6px;font-size:22px}
p{margin:0 0 14px;color:var(--muted)}
label{display:flex;flex-direction:column;gap:5px;margin:0 0 14px;font-size:12.5px;font-weight:500;color:var(--muted)}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--text);font:inherit;font-size:16px}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
button{width:100%;height:40px;border:0;border-radius:10px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;cursor:pointer}
.error{color:var(--err)}
ol{margin:0 0 4px;padding-left:20px;color:var(--muted)}
li{margin-bottom:6px}
.brand{margin:0 0 18px;font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--muted)}
`;

/** No scripts at all; styles inline; the form posts to this app only. */
export const PAGE_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function shell(title: string, body: string) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<!-- With the app-wide no-referrer policy a form post sends "Origin: null", which the same-host check refuses. -->
<meta name="referrer" content="same-origin">
<title>${esc(title)} · Family Print Lab</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style>
</head>
<body><main>
<p class="brand">Family Print Lab</p>
${body}
</main></body>
</html>`;
}

export function loginPage(o: { mode: AuthMode; next: string; error?: string }): string {
	const pins = o.mode === 'profiles';
	return shell(
		'Log in',
		`<h1>Log in</h1>
<p>${pins ? 'Enter the household password, or your own PIN.' : 'Enter the household password.'}</p>
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(safeNext(o.next))}">
<label>${pins ? 'Password or PIN' : 'Password'}
<input type="password" name="secret" autocomplete="current-password" required autofocus maxlength="200"></label>
${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ''}
<button>Log in</button>
</form>`
	);
}

export function setupPage(): string {
	return shell(
		'Set a password first',
		`<h1>Set a password on the computer first</h1>
<p>Print Lab only opens on other devices once it has a household password.</p>
<ol>
<li>Open Print Lab on the computer it runs on.</li>
<li>Go to Integrations, then Access from other devices.</li>
<li>Choose a household password, then come back here.</li>
</ol>`
	);
}
