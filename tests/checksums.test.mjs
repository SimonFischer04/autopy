/* eslint-env node */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Load the actual download code with isolated filesystem, release, and network dependencies.
const sourceUrl = new URL('../src/index.ts', import.meta.url);
const require = createRequire(sourceUrl);
const compiled = ts.transpileModule(readFileSync(sourceUrl, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const filename = 'cpython-3.13.5+20250708-x86_64-unknown-linux-gnu-install_only.tar.gz';
const archive = Buffer.from('Python archive fixture');
const hash = createHash('sha256').update(archive).digest('hex');
// eslint-disable-next-line camelcase
const asset = (name) => ({ name, browser_download_url: `https://example.com/${encodeURIComponent(name)}` });

const setup = (checksumText, { legacy = false, missingAsset = false, status = 200 } = {}) => {
    const requests = [];
    const extractions = [];
    const checksumAsset = asset(legacy ? `${filename}.sha256` : 'SHA256SUMS');
    const mocks = {
        '@mongodb-js/zstd': {},
        '@renovatebot/pep440': {},
        execa: {},
        'fs-extra': { ensureDir: async () => undefined, readdir: async () => [] },
        'global-cache-dir': async () => '/autopy-test-cache',
        'proper-lockfile': { lock: async () => async () => undefined },
        decompress: async (...args) => extractions.push(args),
        octokit: {
            Octokit: class {
                rest = { repos: { listReleases: () => undefined } };
                paginate = {
                    iterator: async function* () {
                        yield { data: [{ assets: [asset(filename), ...(missingAsset ? [] : [checksumAsset])] }] };
                    },
                };
            },
        },
    };
    const exports = {};
    runInNewContext(compiled, {
        exports,
        require: (name) => mocks[name] ?? require(name),
        Buffer,
        process: { platform: 'linux', arch: 'x64', env: {} },
        fetch: async (url) => {
            requests.push(url);
            if (url === checksumAsset.browser_download_url)
                return { ok: status === 200, status, text: async () => checksumText };
            assert.equal(url, asset(filename).browser_download_url);
            return { arrayBuffer: async () => archive };
        },
    });
    return { download: () => exports.downloadPython('3.13.5'), requests, extractions, checksumAsset };
};

test('downloads and verifies the exact archive entry in SHA256SUMS', async () => {
    const fixture = setup(
        `${'0'.repeat(64)}  ${filename}.other\n${hash}  ${filename}\n${'1'.repeat(64)}  other.tar.gz\n`
    );
    assert.equal(await fixture.download(), join('/autopy-test-cache', 'python', '3.13.5'));
    assert.deepEqual(fixture.requests, [
        fixture.checksumAsset.browser_download_url,
        asset(filename).browser_download_url,
    ]);
    assert.equal(fixture.extractions.length, 1);
    assert.deepEqual(fixture.extractions[0][0], archive);
});

test('supports CRLF, binary markers, and uppercase hashes', async () => {
    const fixture = setup(`\r\n${hash.toUpperCase()} *${filename}\r\n`);
    await fixture.download();
    assert.equal(fixture.extractions.length, 1);
});

test('supports individual checksum files from older releases', async () => {
    const fixture = setup(`${hash}\n`, { legacy: true });
    await fixture.download();
    assert.equal(fixture.extractions.length, 1);
});

for (const [name, checksumText] of [
    ['missing entry', `${hash}  ${filename}.other\n`],
    ['malformed hash', `invalid  ${filename}\n`],
    ['missing manifest', ''],
]) {
    test(`rejects a ${name} before downloading the archive`, async () => {
        const fixture = setup(checksumText);
        await assert.rejects(fixture.download(), /No valid checksum for Python 3\.13\.5 found/);
        assert.equal(fixture.requests.length, 1);
        assert.equal(fixture.extractions.length, 0);
    });
}

test('rejects a checksum mismatch without extracting', async () => {
    const fixture = setup(`${'0'.repeat(64)}  ${filename}\n`);
    await assert.rejects(fixture.download(), /Checksum mismatch/);
    assert.equal(fixture.extractions.length, 0);
});

test('rejects a failed checksum HTTP response before downloading the archive', async () => {
    const fixture = setup(`${hash}  ${filename}\n`, { status: 404 });
    await assert.rejects(fixture.download(), /Failed to download checksum.*HTTP 404/);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.extractions.length, 0);
});

test('rejects releases without a checksum asset', async () => {
    const fixture = setup('', { missingAsset: true });
    await assert.rejects(fixture.download(), /No checksum URL for Python 3\.13\.5 found/);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.extractions.length, 0);
});
