import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
const packageName = 'go-through-tabs';
const staging = resolve(dist, packageName);
const manifest = JSON.parse(await readFile(resolve(root, 'extension/manifest.json')));
if (manifest.manifest_version !== 3 || manifest.description.length > 132) {
  throw new Error('Store package requires Manifest V3 and a description of at most 132 characters.');
}
const archive = `${packageName}-${manifest.version}.zip`;
await mkdir(dist, {recursive: true});
await rm(staging, {recursive: true, force: true});
const copyOptions = {recursive: true, filter: source => !basename(source).startsWith('.')};
await cp(resolve(root, 'extension'), staging, copyOptions);
await cp(resolve(root, 'README.md'), resolve(staging, 'INSTALL.md'));
await cp(resolve(root, 'TESTING.md'), resolve(staging, 'TESTING.md'));
await cp(resolve(root, 'PRIVACY.md'), resolve(staging, 'PRIVACY.md'));
await cp(resolve(root, 'LICENSE'), resolve(staging, 'LICENSE'));
// Remove a previous generated archive so zip cannot retain obsolete entries.
await rm(resolve(dist, archive), {force: true});
execFileSync('/usr/bin/zip', ['-q', '-r', archive, packageName], {cwd: dist});
const checksum = createHash('sha256').update(await readFile(resolve(dist, archive))).digest('hex');
await writeFile(resolve(dist, `${archive}.sha256`), `${checksum}  ${archive}\n`);
console.log(`Extension: ${staging}`);
console.log(`ZIP: ${resolve(dist, archive)}`);
console.log(`Files: ${(await readdir(staging)).length}`);

// The Store uploader requires manifest.json at ZIP root, without an enclosing folder.
const storeStaging = resolve(dist, 'chrome-web-store');
const storeArchive = `go-through-tabs-chrome-web-store-${manifest.version}.zip`;
await rm(storeStaging, {recursive: true, force: true});
await cp(resolve(root, 'extension'), storeStaging, copyOptions);
await cp(resolve(root, 'LICENSE'), resolve(storeStaging, 'LICENSE'));
await rm(resolve(dist, storeArchive), {force: true});
execFileSync('/usr/bin/zip', ['-q', '-r', resolve(dist, storeArchive), '.'], {cwd: storeStaging});
const storeChecksum = createHash('sha256').update(await readFile(resolve(dist, storeArchive))).digest('hex');
await writeFile(resolve(dist, `${storeArchive}.sha256`), `${storeChecksum}  ${storeArchive}\n`);
console.log(`Chrome Web Store ZIP: ${resolve(dist, storeArchive)}`);
