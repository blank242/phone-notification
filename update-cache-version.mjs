import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(extensionDirectory, 'manifest.json');
const assetFiles = ['index.js', 'style.css'];

const version = Math.max(
    ...assetFiles.map((fileName) => Math.floor(fs.statSync(path.join(extensionDirectory, fileName)).mtimeMs / 1000)),
);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

for (const key of ['js', 'css']) {
    const value = String(manifest[key] ?? '');
    if (!value) {
        continue;
    }

    const [fileName] = value.split('?');
    manifest[key] = `${fileName}?v=${version}`;
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
console.log(`phone-notification cache version updated to ${version}`);
