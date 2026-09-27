import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { qrMatrix, qrPath } from './qr';

// SHA-256 of each matrix ("0"/"1" rows joined with newlines) from python-qrcode 8 (level M, byte
// mode, border 0, mask_pattern fixed), so the encoder matches an independent implementation.
const REFERENCE = [
	{
		text: 'hello',
		version: 1,
		sha: [
			'52a7aa67e7296ede539d6be86579c7180e3b6d417445712ae8bd314c1818458a',
			'b5607dcfbd80e2bc0b80d411972d3040856f159f49f2932fe5e9f24181ee1225',
			'f67f2bc632df800dbc2c111f69cd9af3812f0488abf74fb397641a9c00b86c64',
			'75b99c66edebbd9092e05881d5108e41c788e2e7f48bea1cc443b640895efa98',
			'c81027800a8044d0762e47033b67cf0ead403170b24e9e4ff25203a9f92c7020',
			'aab8a0a72b21c8c63c7d29fb79889a5cf663a94745c683d332f8ca36b6c93d79',
			'073eb88268c25799dc8d72588f97027756b7fedd3a9a09bcc7e81a54fb29d3ef',
			'683921f56b2988dd454e5f08cc85d949682bd846d510fe13aa028a95d1427918'
		]
	},
	{
		text: `https://cloud.example/phone-key#k=${'A'.repeat(43)}`,
		version: 5,
		sha: [
			'c2dcf51997b61b3ec978915f9b7316371dad1035b288a97ae7ae0f01bf02614c',
			'4ab123e2a6dbef6bbaf22f9e978ed99a015d47b900305928331beb9227c10d59',
			'9c8047e0fefcaa9d134b74e6f5c0654f493b347cfa0a63cefd6888f7468b63bf',
			'6ad797d4f2b85f1add0bd31301432f75ebe85df57a878c1023d359f66101c822',
			'6ba7eaa45030f902c72fe703a8836cef31314ebe6b3c47930da69b9507e16824',
			'7b3fd893346f90d6b6c331426c2cf7909a6fd60d55ee2baabd6c151d25b9dc26',
			'f01450a58f199190d9b9942fafc6d8f88bba91f0a86ea54a6f5b21a250d0e72f',
			'd6393b7e4e88302a88257e47e9ff1829d59ebcd335724731123dbd34879f144e'
		]
	},
	{
		text: 'x'.repeat(150),
		version: 8,
		sha: [
			'd04ffb513988abbe9860d07516694904bfb77e2ae758f942adbcc1de92a38c6c',
			'2f235dfb22f0ec6719d606ce859c57d319aca7eaf2b6ede026661eaf4f898790',
			'9782fa7f0642d3e6b22295c01fc9e2fe9a0f19d22af2cf7b3964dcb6a932e44e',
			'dd8bc6552402d546eac3223a890a1c66065984e643b6ecb8bc59a5859e4ae03b',
			'6ae0c5b8c35224583b9577e8c580e76318577a0a5c144eaec56548ca7a791dd4',
			'e17150c4a4f75f54d809a61e4855d3b4a7ddbe0426f02ef392806a7b5d1f779a',
			'75fb25cabde9039f5b030f40fb0ac2df799e59a76071ff2cb37405c16f1e34d0',
			'b768b07c6269a8395688a24e9baee645ccbe42bde97e2a34ef0c440783645e3a'
		]
	},
	{
		text: 'https://printlab.cloud/phone-key#k=q83vEjRWeJASNFZ4kBI0VniQEjRWeJASNFZ4kBI0Vng',
		version: 5,
		sha: [
			'f20c990fe65be85bb2a8ada2f8a04a7c356c1abd2b3bf618e66685ecfe2f385d',
			'd5582fcea6671c87b7bd51038df94e96ee1b542f5295c28edab3917e81e0f831',
			'f1ff908bf24a768544aee15762ef583c346632a52539af2f909b99f3b755344f',
			'812d110744b6d2b81765b8967c1c6ccc183bc15d0ce989199f6379ddb7c5b434',
			'fae579672d536335cccfa861dfa1266f2ce418d81570a2d05ee6bab34c97d148',
			'60f2ea7d2106c09bd93878c275931e7f8ddd4915b234c8967b5a694e711a3568',
			'c3302861057c4a3c3527a298196e1b1eb810db236ac7db173a32c285ea5c88df',
			'e367912188324da27e9b99e5b3d96e5d178f9f4573c8574693bf6442763d5ee4'
		]
	}
];

const hash = (m: boolean[][]) =>
	createHash('sha256')
		.update(m.map((r) => r.map((c) => (c ? '1' : '0')).join('')).join('\n'))
		.digest('hex');

describe('QR codes', () => {
	it('match python-qrcode for every mask and version used', () => {
		for (const ref of REFERENCE)
			ref.sha.forEach((sha, mask) => {
				const m = qrMatrix(ref.text, { mask });
				expect(m.length).toBe(ref.version * 4 + 17);
				expect(hash(m), `${ref.text.slice(0, 20)} mask ${mask}`).toBe(sha);
			});
	});

	it('picks one of the valid masks, and draws a path with a quiet zone', () => {
		const m = qrMatrix('hello');
		expect(REFERENCE[0].sha).toContain(hash(m));
		const { d, size } = qrPath(m);
		expect(size).toBe(29);
		expect(d.startsWith('M4 4h1v1h-1z')).toBe(true);
		expect(() => qrMatrix('x'.repeat(300))).toThrow(/Too long/);
	});
});
