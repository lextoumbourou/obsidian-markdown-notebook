/**
 * Bump the version in manifest.json and versions.json.
 * Usage: npm run version -- <new-version>
 * Or run directly: node version-bump.mjs 0.2.0
 */
import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.argv[2] ?? process.env.npm_package_version;
if (!targetVersion) {
  console.error('Usage: node version-bump.mjs <version>');
  process.exit(1);
}

// Update manifest.json
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t'));

// Update versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));

console.log(`Bumped to ${targetVersion}`);
