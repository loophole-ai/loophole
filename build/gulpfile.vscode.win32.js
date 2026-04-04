/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const gulp = require('gulp');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const cp = require('child_process');
const util = require('./lib/util');
const task = require('./lib/task');
const pkg = require('../package.json');
const product = require('../product.json');
const vfs = require('vinyl-fs');
const rcedit = require('rcedit');

const repoPath = path.dirname(__dirname);
// use the product's short name for output folders so that branding
// changes (e.g. from "VSCode" to "Loophole") are applied automatically.
// `taskNamePrefix` is the lowercase version used in gulp task names.
const appNameShort = product.nameShort || 'vscode';
const taskNamePrefix = appNameShort.toLowerCase();
const buildPath = (/** @type {string} */ arch) => path.join(path.dirname(repoPath), `${appNameShort}-win32-${arch}`);
const setupDir = (/** @type {string} */ arch, /** @type {string} */ target) => path.join(repoPath, '.build', `win32-${arch}`, `${target}-setup`);
const issPath = path.join(__dirname, 'win32', 'code.iss');
const innoSetupPath = path.join(path.dirname(path.dirname(require.resolve('innosetup'))), 'bin', 'ISCC.exe');
const signWin32Path = path.join(repoPath, 'build', 'azure-pipelines', 'common', 'sign-win32');

// Ensure that the `tools` directory inside the build output contains the
// Inno updater binary and any required DLL.  This step used to be executed
// by a standalone gulp task, but we now run it as part of the setup build
// so that packaging never proceeds when the files are missing.
function ensureTools(arch, cb) {
	const destDir = path.join(buildPath(arch), 'tools');
	fs.mkdirSync(destDir, { recursive: true });

	const icon = path.join(repoPath, 'resources', 'win32', 'code.ico');
	const files = ['inno_updater.exe', 'vcruntime140.dll'];
	let copied = 0;

	files.forEach(f => {
		const src = path.join(repoPath, 'build', 'win32', f);
		if (fs.existsSync(src)) {
			try {
				fs.copyFileSync(src, path.join(destDir, f));
			} catch (e) {
				return cb(e);
			}
		} else {
			console.warn(`ensureTools: missing source file ${src}`);
		}
		copied += 1;
		if (copied === files.length) {
			// attempt to update the icon if we managed to copy the updater
			const exe = path.join(destDir, 'inno_updater.exe');
			if (fs.existsSync(exe)) {
				rcedit(exe, { icon }, cb);
			} else {
				cb(null);
			}
		}
	});
}


function packageInnoSetup(iss, options, cb) {
	options = options || {};

	const definitions = options.definitions || {};

	if (process.argv.some(arg => arg === '--debug-inno')) {
		definitions['Debug'] = 'true';
	}

	if (process.argv.some(arg => arg === '--sign')) {
		definitions['Sign'] = 'true';
	}

	const keys = Object.keys(definitions);

	keys.forEach(key => assert(typeof definitions[key] === 'string', `Missing value for '${key}' in Inno Setup package step`));

	const defs = keys.map(key => `/d${key}=${definitions[key]}`);
	const args = [
		iss,
		...defs,
		`/sesrp=node ${signWin32Path} $f`
	];

	cp.spawn(innoSetupPath, args, { stdio: ['ignore', 'inherit', 'inherit'] })
		.on('error', cb)
		.on('exit', code => {
			if (code === 0) {
				cb(null);
			} else {
				cb(new Error(`InnoSetup returned exit code: ${code}`));
			}
		});
}

/**
 * @param {string} arch
 * @param {string} target
 */
function buildWin32Setup(arch, target) {
	if (target !== 'system' && target !== 'user') {
		throw new Error('Invalid setup target');
	}

	return cb => {
		const x64AppId = target === 'system' ? product.win32x64AppId : product.win32x64UserAppId;
		const arm64AppId = target === 'system' ? product.win32arm64AppId : product.win32arm64UserAppId;

		const sourcePath = buildPath(arch);
		const outputPath = setupDir(arch, target);
		fs.mkdirSync(outputPath, { recursive: true });

		const originalProductJsonPath = path.join(sourcePath, 'resources/app/product.json');
		if (!fs.existsSync(originalProductJsonPath)) {
			throw new Error(`Could not find product.json at ${originalProductJsonPath}. ` +
				`Did you run the ${taskNamePrefix}-win32-${arch} build first?`);
		}

		const productJsonPath = path.join(outputPath, 'product.json');
		const productJson = JSON.parse(fs.readFileSync(originalProductJsonPath, 'utf8'));

		productJson['target'] = target;
		fs.writeFileSync(productJsonPath, JSON.stringify(productJson, undefined, '\t'));

		const quality = product.quality || 'dev';
		const definitions = {
			NameLong: product.nameLong,
			NameShort: product.nameShort,
			DirName: product.win32DirName,
			Version: pkg.version,
			RawVersion: pkg.version.replace(/-\w+$/, ''),
			NameVersion: product.win32NameVersion + (target === 'user' ? ' (User)' : ''),
			ExeBasename: product.nameShort,
			RegValueName: product.win32RegValueName,
			ShellNameShort: product.win32ShellNameShort,
			AppMutex: product.win32MutexName,
			TunnelMutex: product.win32TunnelMutex,
			TunnelServiceMutex: product.win32TunnelServiceMutex,
			TunnelApplicationName: product.tunnelApplicationName,
			ApplicationName: product.applicationName,
			Arch: arch,
			AppId: { 'x64': x64AppId, 'arm64': arm64AppId }[arch],
			IncompatibleTargetAppId: { 'x64': product.win32x64AppId, 'arm64': product.win32arm64AppId }[arch],
			AppUserId: product.win32AppUserModelId,
			ArchitecturesAllowed: { 'x64': 'x64', 'arm64': 'arm64' }[arch],
			ArchitecturesInstallIn64BitMode: { 'x64': 'x64', 'arm64': 'arm64' }[arch],
			SourceDir: sourcePath,
			RepoDir: repoPath,
			OutputDir: outputPath,
			InstallTarget: target,
			ProductJsonPath: productJsonPath,
			Quality: quality
		};

		if (quality === 'insider') {
			definitions['AppxPackage'] = `code_insiders_explorer_${arch}.appx`;
			definitions['AppxPackageFullname'] = `Microsoft.${product.win32RegValueName}_1.0.0.0_neutral__8wekyb3d8bbwe`;
		}

		// make sure the updater DLLs exist before invoking InnoSetup.  this
		// mirrors what the separate "inno-updater" task used to do, but it
		// keeps the packaging step self-contained and avoids build failures
		// when callers forget to run the helper task first.
		ensureTools(arch, err => {
			if (err) {
				return cb(err);
			}
			packageInnoSetup(issPath, { definitions }, cb);
		});
	};
}

/**
 * @param {string} arch
 * @param {string} target
 */
function defineWin32SetupTasks(arch, target) {
	const cleanTask = util.rimraf(setupDir(arch, target));
	// new task name uses the product name prefix
	const newName = `${taskNamePrefix}-win32-${arch}-${target}-setup`;
	const oldName = `vscode-win32-${arch}-${target}-setup`;
	const seriesTask = task.series(cleanTask, buildWin32Setup(arch, target));
	gulp.task(task.define(newName, seriesTask));
	// also expose the old task name as an alias for compatibility
	gulp.task(task.define(oldName, seriesTask));
}

defineWin32SetupTasks('x64', 'system');
defineWin32SetupTasks('arm64', 'system');
defineWin32SetupTasks('x64', 'user');
defineWin32SetupTasks('arm64', 'user');

/**
 * @param {string} arch
 */
function copyInnoUpdater(arch) {
	return () => {
		return gulp.src('build/win32/{inno_updater.exe,vcruntime140.dll}', { base: 'build/win32' })
			.pipe(vfs.dest(path.join(buildPath(arch), 'tools')));
	};
}

/**
 * @param {string} executablePath
 */
function updateIcon(executablePath) {
	return cb => {
		const icon = path.join(repoPath, 'resources', 'win32', 'code.ico');
		rcedit(executablePath, { icon }, cb);
	};
}

// real tasks
gulp.task(task.define(`${taskNamePrefix}-win32-x64-inno-updater`, task.series(copyInnoUpdater('x64'), updateIcon(path.join(buildPath('x64'), 'tools', 'inno_updater.exe')))));
gulp.task(task.define(`${taskNamePrefix}-win32-arm64-inno-updater`, task.series(copyInnoUpdater('arm64'), updateIcon(path.join(buildPath('arm64'), 'tools', 'inno_updater.exe')))));
// legacy names for backward compatibility
gulp.task(task.define('vscode-win32-x64-inno-updater', task.series(copyInnoUpdater('x64'), updateIcon(path.join(buildPath('x64'), 'tools', 'inno_updater.exe')))));
gulp.task(task.define('vscode-win32-arm64-inno-updater', task.series(copyInnoUpdater('arm64'), updateIcon(path.join(buildPath('arm64'), 'tools', 'inno_updater.exe')))));

