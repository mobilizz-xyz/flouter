import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, zip } from '../site/zip.js';

test('crc32 : valeur de référence', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip : archive lisible par unzip, contenus intacts', async () => {
  const files = [
    new File(['bonjour'], 'anonyme-a.jpg'),
    new File([new Uint8Array(100_000).map((_, i) => i % 251)], 'anonyme-b.mp4'),
  ];
  const dir = mkdtempSync(join(tmpdir(), 'flouter-'));
  const path = join(dir, 'test.zip');
  writeFileSync(path, new Uint8Array(await (await zip(files)).arrayBuffer()));
  execFileSync('unzip', ['-tq', path]); // vérifie les CRC
  assert.equal(execFileSync('unzip', ['-p', path, 'anonyme-a.jpg']).toString(), 'bonjour');
  assert.equal(execFileSync('unzip', ['-p', path, 'anonyme-b.mp4']).length, 100_000);
});
