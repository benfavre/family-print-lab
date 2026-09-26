// A saved printer as the browser sees it (never the access code), and one found on the network.
import type { ModelCode } from './models';

export interface PrinterInfo {
	id: string;
	name: string;
	model: ModelCode;
	host: string;
	serial: string;
	port: number;
	ftpPort: number;
	tls: boolean;
	simulated: boolean;
	enabled: boolean;
	sortOrder: number;
	hasAccessCode: boolean;
	/** 'ca': chain verified against the Bambu CA bundle; 'pinned': leaf fingerprint pinned on first use; null: not connected yet. */
	trust: 'ca' | 'pinned' | null;
	version: number;
	createdAt: string;
	updatedAt: string;
}

/** A printer announcing itself over SSDP (server/printer/discovery.ts). */
export interface DiscoveredPrinter {
	/** SSDP USN. */
	serial: string;
	/** SSDP Location (bare IPv4). */
	host: string;
	/** From DevModel.bambu.com. */
	model: ModelCode | null;
	/** Raw DevModel.bambu.com. */
	ssdpModel: string;
	/** DevName.bambu.com. */
	name: string;
	/** DevConnect.bambu.com === 'lan'. */
	lanOnly: boolean;
	/** DevVersion.bambu.com. */
	firmware: string | null;
	lastSeen: string;
	/** Already in the registry (same serial). */
	known: boolean;
}
