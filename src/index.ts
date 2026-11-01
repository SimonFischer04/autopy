import { decompress as decompressZstd } from '@mongodb-js/zstd';
import { satisfies as pep440Satisfies } from '@renovatebot/pep440';
import { createHash } from 'crypto';
import decompress from 'decompress';
import type { Options as ExecaOptions } from 'execa';
import { execa } from 'execa';
import fse, { remove } from 'fs-extra';
import globalCacheDir from 'global-cache-dir';
import { Octokit } from 'octokit';
import { join } from 'path';
import lockfile from 'proper-lockfile';
import semverCompare from 'semver/functions/compare.js';
import semverSatifies from 'semver/functions/satisfies.js';
import { version as autopyVersion } from '../package.json';

/**
 * A semver version or range that specifies the desired Python version to download or use for a virtual environment. The
 * version or range should follow the format defined by [semver](https://www.npmjs.com/package/semver). As
 * [python-build-standalone](https://github.com/indygreg/python-build-standalone) doesn't offer all Python versions, one
 * should typically specify a range (usually a tilde or caret range). If not specified, the latest available version is
 * used.
 */
export type SemverVersionSpecifier = string | undefined;

const getPythonDownloadLink = async (versionRange: SemverVersionSpecifier) => {
    const version = versionRange ?? '>= 0';

    const targetMap = {
        darwin: {
            x64: 'x86_64-apple-darwin',
            arm64: 'aarch64-apple-darwin',
        },
        win32: {
            x64: 'x86_64-pc-windows-msvc-shared',
            ia32: 'i686-pc-windows-msvc-shared',
        },
        linux: {
            x64: 'x86_64-unknown-linux-gnu',
            ia32: 'i686-unknown-linux-gnu',
            arm64: 'aarch64-unknown-linux-gnu',
        },
    };
    const target = targetMap[process.platform as 'win32'][process.arch as 'x64'];
    if (!target) throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);

    const octokit = new Octokit({
        userAgent: `autopy/${autopyVersion} (https://github.com/tweaselORG/autopy)`,
        auth: process.env['GITHUB_TOKEN'],
    });

    const releasesIterator = octokit.paginate.iterator(octokit.rest.repos.listReleases, {
        owner: 'indygreg',
        repo: 'python-build-standalone',
        // eslint-disable-next-line camelcase
        per_page: versionRange === undefined ? 1 : 10,
    });

    for await (const { data: releases } of releasesIterator) {
        for (const release of releases) {
            // "Casual users will likely want to use the `install_only` archive, as most users do not need the build
            // artifacts present in the `full` archive."
            const assetRegex = new RegExp(
                `^cpython-(?<version>\\d+\\.\\d+\\.\\d+)\\+\\d+-${target}-install_only\\.tar\\.(?<ext>gz|zst)$`
            );

            const asset = release.assets
                .map((a) => ({ ...a, version: assetRegex.exec(a.name)?.groups?.['version'] }))
                .sort((a, b) => {
                    if (a.version && b.version) return semverCompare(b.version, a.version);
                    if (a.version) return -1;
                    if (b.version) return 1;
                    return 0;
                })
                .find((a) => a.version && semverSatifies(a.version, version));
            if (asset) {
                const checksumAsset =
                    release.assets.find((a) => a.name === 'SHA256SUMS') ??
                    release.assets.find((a) => a.name === `${asset.name}.sha256`);
                return {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    version: asset.version!,
                    pythonUrl: asset.browser_download_url,
                    checksumUrl: checksumAsset?.browser_download_url,
                    checksumFilename: checksumAsset?.name === 'SHA256SUMS' ? asset.name : undefined,
                };
            }
        }
    }

    throw new Error(`No release for Python ${version} found.`);
};

/**
 * Downloads and extracts a Python installation that satisfies the given version range from
 * [python-build-standalone](https://github.com/indygreg/python-build-standalone) releases. The installation is cached
 * in a global directory and reused if possible.
 *
 * @param versionRange A semver version or range that specifies the desired Python version. If not specified, the latest
 *   available version is used.
 * @returns The path to the Python installation directory.
 */
export const downloadPython = async (versionRange: SemverVersionSpecifier) => {
    const cacheDir = await globalCacheDir('autopy');
    await fse.ensureDir(join(cacheDir, 'python'));

    const releaseLock = await lockfile.lock(join(cacheDir, 'python'), { retries: 20, stale: 120000 });

    // Check if we already have a Python installation that satisfies the version range.
    const existingInstallations = await fse.readdir(join(cacheDir, 'python'));
    const matchingExistingVersion = existingInstallations
        .sort((a, b) => semverCompare(b, a))
        .find((v) => !versionRange || semverSatifies(v, versionRange));
    if (matchingExistingVersion) {
        const existingPythonDir = join(cacheDir, 'python', matchingExistingVersion);
        if (
            await fse.pathExists(
                process.platform === 'win32'
                    ? join(existingPythonDir, 'python.exe')
                    : join(existingPythonDir, 'bin', 'python3')
            )
        ) {
            await releaseLock();
            return existingPythonDir;
        }

        await fse.remove(existingPythonDir);
    }

    // Otherwise, download this Python version.
    const { version, pythonUrl, checksumUrl, checksumFilename } = await getPythonDownloadLink(versionRange);
    if (!checksumUrl) throw new Error(`No checksum URL for Python ${version} found.`);

    const checksumText = await fetch(checksumUrl).then((res) => {
        if (!res.ok) throw new Error(`Failed to download checksum for Python ${version}: HTTP ${res.status}.`);
        return res.text();
    });
    // SHA256SUMS uses the sha256sum format: a hash, a space, a text/binary marker, and the filename.
    const expectedHash = checksumFilename
        ? checksumText
              .split(/\r?\n/)
              .map((line) => /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line))
              .find((match) => match?.[2] === checksumFilename)?.[1]
        : checksumText.trim();
    if (!expectedHash || !/^[a-fA-F0-9]{64}$/.test(expectedHash))
        throw new Error(`No valid checksum for Python ${version} found.`);

    const pythonArchive = await fetch(pythonUrl).then((res) => res.arrayBuffer());

    const hash = createHash('sha256').update(Buffer.from(pythonArchive)).digest('hex');
    if (hash !== expectedHash.toLowerCase())
        throw new Error(`Checksum mismatch: Expected "${expectedHash}", got "${hash}".`);

    const pythonDir = join(cacheDir, 'python', version);
    await fse.ensureDir(pythonDir);

    const tarOrTarGz = pythonUrl.endsWith('.zst')
        ? await decompressZstd(Buffer.from(pythonArchive))
        : Buffer.from(pythonArchive);
    await decompress(tarOrTarGz, pythonDir, { strip: 1 });

    await releaseLock();
    return pythonDir;
};

/**
 * Normalizes a Python package name for comparison: drops extras (`package[extra]`) and applies the [PEP
 * 503](https://peps.python.org/pep-0503/#normalized-names) normalization, so e.g. `Foo_Bar[baz]` and `foo-bar` name the
 * same package.
 */
const normalizePackageName = (name: string) =>
    name
        .replace(/\[.*\]$/, '')
        .trim()
        .replace(/[-_.]+/g, '-')
        .toLowerCase();

/**
 * Asks pip whether a requirement, including the dependencies of its extras, is satisfied by the installed packages,
 * without installing anything or reaching the package index. Needs pip 22.2 or newer (`--dry-run`). Older pip versions
 * fail, so a requirement with extras is then installed on every call, as before names were normalized.
 */
const isSatisfiedByPip = (venvPythonBinary: string, r: { name: string; version: string }) =>
    execa(venvPythonBinary, ['-m', 'pip', 'install', '--dry-run', '--no-index', '--quiet', `${r.name}${r.version}`])
        .then(() => true)
        .catch(() => false);

const isVenv = async (dir: string) =>
    (await fse.pathExists(join(dir, 'pyvenv.cfg'))) &&
    (await fse.pathExists(
        process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python3')
    ));

/** Options for creating or getting a virtual environment with specific requirements. */
export type VenvOptions = {
    /** The name of the virtual environment. */
    name: string;
    /** The Python version to use for the virtual environment. Passed to {@link downloadPython}. */
    pythonVersion: SemverVersionSpecifier;
    /** The list of Python packages and their versions to install in the virtual environment. */
    requirements: {
        /** The name of the package to install. */
        name: string;
        /**
         * A [PEP 440 version specifier](https://peps.python.org/pep-0440/#version-specifiers) that defines the version
         * of the package to install.
         */
        version: string;
    }[];

    /**
     * Whether to check if the requirements are already satisfied and install them if necessary. Defaults to true. If
     * false, the virtual environment may not have (all) the specified packages installed.
     */
    checkRequirements?: boolean;
    /**
     * Whether to install all requirements with `pip install --upgrade` when at least one of them is missing or does not
     * satisfy its version specifier. Defaults to false, which only installs the missing requirements and leaves
     * installed packages that still satisfy their specifier untouched. With true, pip may also upgrade those, e.g. an
     * unversioned requirement, or one with a dependency that changed along with another requirement. If nothing is
     * missing, nothing is installed, so pip does not need to reach the package index.
     */
    upgrade?: boolean;
    /**
     * Whether to allow upgrading the Python version of the virtual environment if it is already created. Defaults to
     * true. If false, calling `getVenv()` on an existing venv with an older (non-matching) Python version will throw an
     * error. If true, the Python version will be upgraded if necessary. This will cause the venv to be recreated.
     */
    allowPythonUpgrade?: boolean;
};

/**
 * Creates or gets a virtual environment with the specified Python version and requirements. Returns a function for
 * running commands in the virtual environment.
 *
 * Note: If you need a specific version of pip, you can specify that in the requirements and it will be installed before
 * all other requirements.
 *
 * @param options The options for creating or getting the virtual environment. See {@link VenvOptions}.
 *
 * @returns A function that can be used to execute Python commands in the virtual environment, with all necessary
 *   environment variables set up correctly. The function is a wrapper around
 *   [`execa`](https://github.com/sindresorhus/execa).
 */
export const getVenv = async (options: VenvOptions) => {
    const cacheDir = await globalCacheDir('autopy');
    const venvDir = join(cacheDir, 'venv', options.name);
    await fse.ensureDir(venvDir);

    const releaseLock = await lockfile.lock(venvDir, { retries: 25, stale: 240000 });

    // Check whether the potentially existing venv has a matching Python version.
    if (options.pythonVersion && (await fse.pathExists(venvDir)) && (await isVenv(venvDir))) {
        const pyvenvCfg = await fse.readFile(join(venvDir, 'pyvenv.cfg'), 'utf-8');
        const venvPythonVersion = pyvenvCfg
            .split('\n')
            .find((l) => l.startsWith('version = '))
            ?.split('=')[1]
            ?.trim();

        if (venvPythonVersion && !semverSatifies(venvPythonVersion, options.pythonVersion)) {
            if (options.allowPythonUpgrade !== false) await fse.remove(venvDir);
            else
                throw new Error(
                    `The virtual environment "${options.name}" already exists, but has a different Python version (${venvPythonVersion}) than requested (${options.pythonVersion}) and upgrading is not allowed.`
                );
        }
    }

    if (!(await fse.pathExists(venvDir)) || !(await isVenv(venvDir))) {
        const pythonDir = await downloadPython(options.pythonVersion);
        const globalPythonBinary =
            process.platform === 'win32' ? join(pythonDir, 'python.exe') : join(pythonDir, 'bin', 'python3');

        await execa(globalPythonBinary, ['-m', 'venv', venvDir]);
    }

    const venvPythonBinary =
        process.platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python3');

    if (options.checkRequirements !== false) {
        // Some packages require a newer pip version than shipped by python-build-standalone (e.g.
        // https://github.com/tweaselORG/autopy/issues/5), so if the user pins a pip version, we need to install that
        // first.
        const pipVersion = options.requirements.find((r) => r.name === 'pip')?.version;
        if (pipVersion) await execa(venvPythonBinary, ['-m', 'pip', 'install', `pip${pipVersion}`]);

        // Then, we can proceed with installing the rest of the requirements with the correct pip version.
        const installedPackages = await execa(venvPythonBinary, [
            '-m',
            'pip',
            'list',
            '--local',
            '--format',
            'json',
        ]).then((r) => JSON.parse(r.stdout) as { name: string; version: string }[]);
        const missingPackages: VenvOptions['requirements'] = [];
        for (const r of options.requirements) {
            if (r.name === 'pip') continue;
            const installed = installedPackages.some(
                (p) =>
                    normalizePackageName(p.name) === normalizePackageName(r.name) &&
                    pep440Satisfies(p.version, r.version)
            );
            // `pip list` only shows that the package itself is installed, not whether the dependencies of the
            // requested extras are. Let pip check that without installing anything or reaching the package index.
            if (!installed || (/\[.*\]$/.test(r.name) && !(await isSatisfiedByPip(venvPythonBinary, r))))
                missingPackages.push(r);
        }

        if (missingPackages.length > 0) {
            const packagesToInstall = options.upgrade
                ? options.requirements.filter((r) => r.name !== 'pip')
                : missingPackages;
            await execa(venvPythonBinary, [
                '-m',
                'pip',
                'install',
                ...(options.upgrade ? ['--upgrade'] : []),
                ...packagesToInstall.map((r) => `${r.name}${r.version}`),
            ]);
        }
    }

    await releaseLock();

    const venvBinDir = join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
    return (file: string, args?: string[], options?: ExecaOptions) =>
        execa(file, args, {
            ...options,
            env: {
                PYTHONHOME: undefined,
                VIRTUAL_ENV: venvDir,
                PATH: `${venvBinDir}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH']}`,
                ...options?.env,
            },
        });
};

/**
 * Removes the virtual environment with the specified name.
 *
 * @param name The name of the virtual environment to remove.
 */
export const removeVenv = async (name: string) => remove(join(await globalCacheDir('autopy'), 'venv', name));
