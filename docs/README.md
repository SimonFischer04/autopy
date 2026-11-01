@simonfischer04/autopy

# @simonfischer04/autopy

## Table of contents

### Type Aliases

- [SemverVersionSpecifier](README.md#semverversionspecifier)
- [VenvOptions](README.md#venvoptions)

### Functions

- [clearCache](README.md#clearcache)
- [downloadPython](README.md#downloadpython)
- [getCacheDir](README.md#getcachedir)
- [getVenv](README.md#getvenv)
- [removeVenv](README.md#removevenv)

## Type Aliases

### SemverVersionSpecifier

Ƭ **SemverVersionSpecifier**: `string` \| `undefined`

A semver version or range that specifies the desired Python version to download or use for a virtual environment. The
version or range should follow the format defined by [semver](https://www.npmjs.com/package/semver). As
[python-build-standalone](https://github.com/indygreg/python-build-standalone) doesn't offer all Python versions, one
should typically specify a range (usually a tilde or caret range). If not specified, the latest available version is
used.

#### Defined in

[index.ts:23](https://github.com/SimonFischer04/autopy/blob/main/src/index.ts#L23)

___

### VenvOptions

Ƭ **VenvOptions**: `Object`

Options for creating or getting a virtual environment with specific requirements.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `allowPythonUpgrade?` | `boolean` | Whether to allow upgrading the Python version of the virtual environment if it is already created. Defaults to true. If false, calling `getVenv()` on an existing venv with an older (non-matching) Python version will throw an error. If true, the Python version will be upgraded if necessary. This will cause the venv to be recreated. |
| `checkRequirements?` | `boolean` | Whether to check if the requirements are already satisfied and install them if necessary. Defaults to true. If false, the virtual environment may not have (all) the specified packages installed. |
| `name` | `string` | The name of the virtual environment. |
| `pythonVersion` | [`SemverVersionSpecifier`](README.md#semverversionspecifier) | The Python version to use for the virtual environment. Passed to [downloadPython](README.md#downloadpython). |
| `requirements` | { `name`: `string` ; `version`: `string`  }[] | The list of Python packages and their versions to install in the virtual environment. |
| `upgrade?` | `boolean` | Whether to install all requirements with `pip install --upgrade` when at least one of them is missing or does not satisfy its version specifier. Defaults to false, which only installs the missing requirements and leaves installed packages that still satisfy their specifier untouched. With true, pip may also upgrade those, e.g. an unversioned requirement, or one with a dependency that changed along with another requirement. If nothing is missing, nothing is installed, so pip does not need to reach the package index. |

#### Defined in

[index.ts:179](https://github.com/SimonFischer04/autopy/blob/main/src/index.ts#L179)

## Functions

### clearCache

▸ **clearCache**(): `Promise`<`void`\>

Removes the whole autopy cache directory, i.e. all downloaded Python distributions and all virtual environments. They
are downloaded and created again on the next call of [downloadPython](README.md#downloadpython) or [getVenv](README.md#getvenv).

Don't call this while [downloadPython](README.md#downloadpython) or [getVenv](README.md#getvenv) is running, or while a process started in one of the
virtual environments is still running.

#### Returns

`Promise`<`void`\>

#### Defined in

[index.ts:352](https://github.com/SimonFischer04/autopy/blob/main/src/index.ts#L352)

___

### downloadPython

▸ **downloadPython**(`versionRange`): `Promise`<`string`\>

Downloads and extracts a Python installation that satisfies the given version range from
[python-build-standalone](https://github.com/indygreg/python-build-standalone) releases. The installation is cached
in a global directory and reused if possible.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `versionRange` | [`SemverVersionSpecifier`](README.md#semverversionspecifier) | A semver version or range that specifies the desired Python version. If not specified, the latest available version is used. |

#### Returns

`Promise`<`string`\>

The path to the Python installation directory.

#### Defined in

[index.ts:99](https://github.com/SimonFischer04/autopy/blob/main/src/index.ts#L99)

___

### getCacheDir

▸ **getCacheDir**(): `Promise`<`string`\>

Returns the directory where autopy stores the downloaded Python distributions (`python/`) and the virtual
environments (`venv/`). It depends on the platform:

- On Linux and other POSIX systems: `$XDG_CACHE_HOME/autopy`, or `~/.cache/autopy` if `XDG_CACHE_HOME` is not set.
- On macOS: `~/Library/Caches/autopy`
- On Windows: `%LOCALAPPDATA%\autopy\Cache`

The directory is created if it doesn't exist yet.

#### Returns

`Promise`<`string`\>

The absolute path to the autopy cache directory.

#### Defined in

[index.ts:343](https://github.com/SimonFischer04/autopy/blob/main/src/index.ts#L343)

___

### getVenv

▸ **getVenv**(`options`): `Promise`<(`file`: `string`, `args?`: `string`[], `options?`: `Options`) => `ExecaChildProcess`<`string`\>\>

Creates or gets a virtual environment with the specified Python version and requirements. Returns a function for
running commands in the virtual environment.

Note: If you need a specific version of pip, you can specify that in the requirements and it will be installed before
all other requirements.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `options` | [`VenvOptions`](README.md#venvoptions) | The options for creating or getting the virtual environment. See [VenvOptions](README.md#venvoptions). |

#### Returns

`Promise`<(`file`: `string`, `args?`: `string`[], `options?`: `Options`) => `ExecaChildProcess`<`string`\>\>

A function that can be used to execute Python commands in the virtual environment, with all necessary
  environment variables set up correctly. The function is a wrapper around
  [`execa`](https://github.com/sindresorhus/execa).

#### Defined in

[index.ts:229](https://github.com/SimonFischer04/autopy/blob/main/src/index.ts#L229)

___

### removeVenv

▸ **removeVenv**(`name`): `Promise`<`void`\>

Removes the virtual environment with the specified name.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `name` | `string` | The name of the virtual environment to remove. |

#### Returns

`Promise`<`void`\>

#### Defined in

[index.ts:329](https://github.com/SimonFischer04/autopy/blob/main/src/index.ts#L329)
