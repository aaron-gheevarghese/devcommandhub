import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';


export function activate(context: vscode.ExtensionContext) {
   console.log('Congratulations, your extension "devcommandhub" is now active!');


   const disposable = vscode.commands.registerCommand('devcommandhub.openWindow', () => {
       vscode.window.showInformationMessage('Window Opened!');


       const panel = vscode.window.createWebviewPanel
       (
           'devcommandhub.panel',
           'DevCommandHub Panel',
           vscode.ViewColumn.Beside,
           { enableScripts : true }
       );


       const htmlPath = vscode.Uri.joinPath(
	   	context.extensionUri,
			'media.html'     // was: 'src','media','panel.html'
			);
		const html = fs.readFileSync(htmlPath.fsPath, 'utf-8');
		panel.webview.html = html;

   });


   context.subscriptions.push(disposable);
}


export function deactivate() {}



