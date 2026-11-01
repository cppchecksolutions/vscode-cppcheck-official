// util/statusBar.ts
import * as vscode from 'vscode';
import { ProjectFileStore } from './files';

export class StatusBar implements vscode.Disposable {
    private readonly progress = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    private readonly severity = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
    private readonly hiddenTypes = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
    private readonly fullAnalysis = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);

    constructor(private readonly projectFileStore: ProjectFileStore) {
        this.severity.command = 'cppcheck-official.selectMinSeverity';
        this.hiddenTypes.command = 'cppcheck-official.revealHiddenTypes';
        this.fullAnalysis.command = 'cppcheck-official.runFullAnalysis';
        this.fullAnalysis.text = '$(play) Full Analysis';
        this.updateMinSeverity();
        this.setHiddenTypesCount(0);
        if (this.projectFileStore.getUri()) {
            this.fullAnalysis.show();
        }
    }

    // Was checksRunning = x; updateProgressIndicator()
    setRunning(running: boolean) {
        if (running) {
            this.progress.text = '$(loading~spin) Cppcheck Running ..';
            this.progress.show();
            // To avoid crowding status bar we alternate between progress indicator and severity option item
            this.severity.hide();
            this.fullAnalysis.hide();
        } else {
            this.progress.hide();
            this.severity.show();
            // If a project file exists, show full analysis status bar item
            if (this.projectFileStore.getUri()) {
                this.fullAnalysis.show();
            } else {
                this.fullAnalysis.hide();
            }
        }
    }

    updateMinSeverity() {
        const mode = vscode.workspace.getConfiguration('cppcheck-official').get<string>('minSeverity', 'info');
        this.severity.text = `$(gear) Cppcheck severity: ${mode}`;
        this.severity.tooltip = 'Select minimum level of warning severity for cppcheck analysis';
        this.severity.show();
    }

    setHiddenTypesCount(count: number) {
        this.hiddenTypes.text = `$(bell) Hidden types: ${count}`;
        this.hiddenTypes.tooltip = 'Select hidden warning types to reveal';
        this.hiddenTypes.show();
    }

    dispose() {
        [this.progress, this.severity, this.hiddenTypes, this.fullAnalysis].forEach(i => i.dispose());
    }
}