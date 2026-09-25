import { redirect } from '@sveltejs/kit';

// Settings became the Integrations page.
export const load = () => redirect(308, '/integrations');
