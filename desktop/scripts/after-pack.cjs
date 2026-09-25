// electron-builder always drops `examples` folders from node_modules, but three.js keeps real modules
// there (examples/jsm: camera controls and loaders the server renders with). Put them back.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
	const appDir =
		context.electronPlatformName === 'darwin'
			? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app')
			: path.join(context.appOutDir, 'resources', 'app');
	const from = path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'jsm');
	fs.cpSync(from, path.join(appDir, 'node_modules', 'three', 'examples', 'jsm'), { recursive: true });
};
