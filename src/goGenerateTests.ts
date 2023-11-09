/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable eqeqeq */
/* eslint-disable @typescript-eslint/no-explicit-any */
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import cp = require('child_process');
import path = require('path');
import vscode = require('vscode');
import { getGoConfig } from './config';
import { toolExecutionEnvironment } from './goEnv';
import { promptForMissingTool } from './goInstallTools';
import { GoDocumentSymbolProvider } from './goDocumentSymbols';
import { outputChannel } from './goStatus';
import { getBinPath, resolvePath } from './util';
import { CommandFactory } from './commands';
import { GoExtensionContext } from './context';
import * as fs from 'fs-extra';

const generatedWord = 'Generated ';

/**
 * If current active editor has a Go file, returns the editor.
 */
function checkActiveEditor(): vscode.TextEditor | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage('Cannot generate unit tests. No editor selected.');
		return;
	}
	if (!editor.document.fileName.endsWith('.go') && !editor.document.fileName.endsWith('.gop')) {
		vscode.window.showInformationMessage('Cannot generate unit tests. File in the editor is not a Go or Gop file.');
		return;
	}
	if (editor.document.isDirty) {
		vscode.window.showInformationMessage('File has unsaved changes. Save and try again.');
		return;
	}
	return editor;
}

/**
 * Toggles between file in current active editor and the corresponding test file.
 */
export const toggleTestFile: CommandFactory = () => () => {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage('Cannot toggle test file. No editor selected.');
		return;
	}
	const currentFilePath = editor.document.fileName;
	if (!currentFilePath.endsWith('.go')  &&  !currentFilePath.endsWith('.gop')) {
		vscode.window.showInformationMessage('Cannot toggle test file. File in the editor is not a Go file.');
		return;
	}
	let targetFilePath = '';
	if(currentFilePath.endsWith('.go') ){
		if (currentFilePath.endsWith('_test.go')) {
			targetFilePath = currentFilePath.substr(0, currentFilePath.lastIndexOf('_test.go')) + '.go';
		} else {
			targetFilePath = currentFilePath.substr(0, currentFilePath.lastIndexOf('.go')) + '_test.go';
		}
	}else{
		if (currentFilePath.endsWith('_test.gop')) {
			targetFilePath = currentFilePath.substr(0, currentFilePath.lastIndexOf('_test.gop')) + '.gop';
		} else {
			targetFilePath = currentFilePath.substr(0, currentFilePath.lastIndexOf('.gop')) + '_test.gop';
		}
	}
	
	for (const doc of vscode.window.visibleTextEditors) {
		if (doc.document.fileName === targetFilePath) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.file(targetFilePath), doc.viewColumn);
			return;
		}
	}
	vscode.commands.executeCommand('vscode.open', vscode.Uri.file(targetFilePath));
};

export const generateTestCurrentPackage: CommandFactory = (ctx, goCtx) => () => {
	const editor = checkActiveEditor();
	if (!editor) {
		return false;
	}
	return generateTests(
		ctx,
		goCtx,
		{
			dir: path.dirname(editor.document.uri.fsPath),
			isTestFile: editor.document.fileName.endsWith('_test.go') || editor.document.fileName.endsWith('_test.gop')
		},
		getGoConfig(editor.document.uri)
	);
};

export const generateTestCurrentFile: CommandFactory = (ctx, goCtx) => () => {
	const editor = checkActiveEditor();
	if (!editor) {
		return false;
	}

	return generateTests(
		ctx,
		goCtx,
		{
			dir: editor.document.uri.fsPath,
			isTestFile: editor.document.fileName.endsWith('_test.go') || editor.document.fileName.endsWith('_test.gop')
		},
		getGoConfig(editor.document.uri)
	);
};

export const generateTestCurrentFunction: CommandFactory = (ctx, goCtx) => async () => {
	const editor = checkActiveEditor();
	if (!editor) {
		return false;
	}

	const functions = await getFunctions(goCtx, editor.document);
	const selection = editor.selection;
	const currentFunction = functions.find((func) => selection && func.range.contains(selection.start));

	if (!currentFunction) {
		vscode.window.showInformationMessage('No function found at cursor.');
		return Promise.resolve(false);
	}
	let funcName = currentFunction.name;
	const funcNameParts = funcName.match(/^\(\*?(.*)\)\.(.*)$/);
	if (funcNameParts != null && funcNameParts.length === 3) {
		// receiver type specified
		const rType = funcNameParts[1].replace(/^\w/, (c) => c.toUpperCase());
		const fName = funcNameParts[2].replace(/^\w/, (c) => c.toUpperCase());
		funcName = rType + fName;
	}



	return generateTests(
		ctx,
		goCtx,
		{
			dir: editor.document.uri.fsPath,
			func: funcName,
			isTestFile: editor.document.fileName.endsWith('_test.go') || editor.document.fileName.endsWith('_test.gop')
		},
		getGoConfig(editor.document.uri)
	);
};

/**
 * Input to goTests.
 */
interface Config {
	/**
	 * The working directory for `gotests`.
	 */
	dir: string;
	/**
	 * Specific function names to generate tests skeleton.
	 */
	func?: string;

	/**
	 * Whether or not the file to generate test functions for is a test file.
	 */
	isTestFile?: boolean;
}





function generateTests(
	ctx: vscode.ExtensionContext,
	goCtx: GoExtensionContext,
	conf: Config,
	goConfig: vscode.WorkspaceConfiguration
): Promise<boolean> {



	return new Promise<boolean>((resolve, reject) => {



		const gopcmd = getBinPath('gop');
		let gopargs = ['go', path.dirname(conf.dir)];
		const stdout = cp.execFileSync(gopcmd, gopargs, { env: toolExecutionEnvironment() });
		outputChannel.appendLine('generateGocode Tests: ' + gopcmd + ' ' + gopargs.join(' ') + ' ' +  stdout );
		let gofile_autogen = path.dirname(conf.dir) + "/gop_autogen.go";
		if(fs.existsSync(gofile_autogen) == false){
			return reject('Cannot gop go generate test due to errors');
		}


		let gofile = path.dirname(conf.dir) +"/"+path.basename(conf.dir).replace(path.extname(conf.dir),'')+".go"
		fs.moveSync(gofile_autogen, gofile)



		const cmd =  getBinPath('gotests');
		let args = ['-w'];
		const goGenerateTestsFlags: string[] = goConfig['generateTestsFlags'] || [];

		for (let i = 0; i < goGenerateTestsFlags.length; i++) {
			const flag = goGenerateTestsFlags[i];
			if (flag === '-w' || flag === 'all') {
				continue;
			}
			if (flag === '-only') {
				i++;
				continue;
			}
			if (i + 1 < goGenerateTestsFlags.length && (flag === '-template_dir' || flag === '-template_params_file')) {
				const configFilePath = resolvePath(goGenerateTestsFlags[i + 1]);
				args.push(flag, configFilePath);
				i++;
				continue;
			}
			args.push(flag);
		}

		if (conf.func) {
			args = args.concat(['-only', `^${conf.func}$`, gofile]);
		} else {
			args = args.concat(['-all', gofile]);
		}

		cp.execFile(cmd, args, { env: toolExecutionEnvironment() }, (err, stdout, stderr) => {
			outputChannel.appendLine('Generating Tests: ' + cmd + ' ' + args.join(' '));

			try {
				if (err && (<any>err).code === 'ENOENT') {
					promptForMissingTool('gotests');
					return resolve(false);
				}
				if (err) {
					console.log(err);
					outputChannel.appendLine(err.message);
					return reject('Cannot generate test due to errors');
				}

				let message = stdout;
				let testsGenerated = false;

				// Expected stdout is of the format "Generated TestMain\nGenerated Testhello\n"
				if (stdout.startsWith(generatedWord)) {
					const lines = stdout
						.split('\n')
						.filter((element) => {
							return element.startsWith(generatedWord);
						})
						.map((element) => {
							return element.substr(generatedWord.length);
						});
					message = `Generated ${lines.join(', ')}`;
					testsGenerated = true;
				}

				vscode.window.showInformationMessage(message);
				outputChannel.append(message);

				if (testsGenerated && !conf.isTestFile) {
					toggleTestFile(ctx, goCtx)();
				}

				fs.removeSync(gofile);

				return resolve(true);
			} catch (e) {
				vscode.window.showInformationMessage((e as any).msg);
				outputChannel.append((e as any).msg);
				reject(e);
			}
		});
	});
}

async function getFunctions(goCtx: GoExtensionContext, doc: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
	const documentSymbolProvider = GoDocumentSymbolProvider(goCtx);
	const symbols = await documentSymbolProvider.provideDocumentSymbols(doc);
	return symbols[0].children.filter((sym) =>
		[vscode.SymbolKind.Function, vscode.SymbolKind.Method].includes(sym.kind)
	);
}
