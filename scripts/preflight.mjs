#!/usr/bin/env node
/**
 * Startup preflight: verifies the toolchain and dependencies needed to run
 * the MeshLink dev server. It never downloads anything and never touches
 * the network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];
const notes = [];

function major(version) {
  return Number.parseInt(version.replace(/^v/, '').split('.')[0], 10);
}

if (major(process.version) < 20) {
  problems.push(`Node 20+ required; found ${process.version}.`);
}

const pkgPath = join(root, 'package.json');
if (!existsSync(pkgPath)) {
  problems.push('package.json is missing; run this from the project root.');
} else {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const required = ['expo', 'react-native', 'expo-router', 'react-native-tcp-socket'];
  for (const name of required) {
    if (!pkg.dependencies?.[name]) problems.push(`Dependency "${name}" is missing from package.json.`);
  }
}

if (!existsSync(join(root, 'node_modules'))) {
  problems.push('node_modules is missing. Run "npm install" or use ./start.sh.');
} else {
  for (const name of ['expo', 'react-native', 'expo-router', 'react-native-tcp-socket']) {
    if (!existsSync(join(root, 'node_modules', name))) {
      problems.push(`Dependency "${name}" is not installed. Run "npm install".`);
    }
  }
}

if (!existsSync(join(root, 'src', 'app', '_layout.tsx'))) {
  problems.push('src/app/_layout.tsx is missing; the Expo Router tree is incomplete.');
}

notes.push('Expo Go cannot run this app: react-native-tcp-socket is not bundled in it.');
notes.push('Use a development build: npx expo run:android, or npx eas build --profile development.');

console.log('MeshLink preflight');
console.log(`  Node: ${process.version}`);
console.log(`  Platform: ${process.platform} ${process.arch}`);
console.log(`  Project: ${root}`);

if (notes.length > 0) {
  console.log('\nNotes:');
  for (const n of notes) console.log(`  - ${n}`);
}

if (problems.length > 0) {
  console.error('\nBlocking issues:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\nReady. Starting the Expo dev server…');
