/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import * as vscode from 'vscode';
import { apiClient } from '../terraformCloud';
import { TerraformCloudAuthenticationProvider } from './authenticationProvider';

export class TerraformCloudFeature implements vscode.Disposable {
  private organizationStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);

  constructor(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      vscode.authentication.registerAuthenticationProvider(
        TerraformCloudAuthenticationProvider.providerID,
        TerraformCloudAuthenticationProvider.providerLabel,
        new TerraformCloudAuthenticationProvider(ctx.secrets, ctx),
        { supportsMultipleAccounts: false },
      ),
    );

    this.organizationStatusBar.name = 'TFCOrganization';
    this.organizationStatusBar.command = {
      command: 'terraform.cloud.organization.picker',
      title: 'Choose your Terraform Cloud Organization',
      tooltip: '',
    };

    const org = ctx.workspaceState.get('terraform.cloud.organization', '');
    if (org) {
      this.organizationStatusBar.text = org;
      this.organizationStatusBar.show();
    }

    vscode.commands.registerCommand('terraform.cloud.organization.picker', async () => {
      const response = await apiClient.listOrganizations();
      const orgs = response.data;

      const items: string[] = [];
      for (let index = 0; index < orgs.length; index++) {
        const element = orgs[index];
        items.push(element.attributes.name);
      }

      const answer = await vscode.window.showQuickPick(items, {
        canPickMany: false,
        ignoreFocusOut: true,
        placeHolder: 'Choose and organization. Hit enter to select the first organization.',
        title: 'Welcome to Terraform Cloud',
      });

      if (answer === undefined) {
        // TODO use default org?
        return;
      }

      this.organizationStatusBar.text = answer;
      this.organizationStatusBar.show();

      vscode.window.showInformationMessage(`Chose ${answer} organization`);
      ctx.globalState.update('terraform.cloud.organization', answer);

      // TODO: refresh workspaces view
    });

    const runDataProvider = new RunTreeDataProvider(ctx);
    const workspaceDataProvider = new WorkspaceTreeDataProvider(ctx, runDataProvider);
    ctx.subscriptions.push(workspaceDataProvider, runDataProvider);

    const workspaceView = vscode.window.createTreeView('terraform.cloud.workspaces', {
      canSelectMany: false,
      showCollapseAll: true,
      treeDataProvider: workspaceDataProvider,
    });
    workspaceView.onDidChangeSelection((event) => {
      const workspaceItem = event.selection[0] as WorkspaceTreeItem;

      // call the TFC Run view with the workspaceID
      runDataProvider.refresh(workspaceItem);
    });
    workspaceView.onDidChangeVisibility((event) => {
      if (event.visible) {
        // the view is visible so show the status bar
        this.organizationStatusBar.show();
      } else {
        // hide statusbar because user isn't looking at our views
        this.organizationStatusBar.hide();
      }
    });
    ctx.subscriptions.push(workspaceView);
  }

  dispose() {
    this.organizationStatusBar.dispose();
  }
}

export class WorkspaceTreeDataProvider implements vscode.TreeDataProvider<WorkspaceTreeItem>, vscode.Disposable {
  private readonly didChangeTreeData = new vscode.EventEmitter<void | WorkspaceTreeItem>();
  public readonly onDidChangeTreeData = this.didChangeTreeData.event;

  private projectID = '';

  constructor(private ctx: vscode.ExtensionContext, private runDataProvider: RunTreeDataProvider) {
    vscode.commands.registerCommand('terraform.cloud.workspaces.filterByProject', async () => {
      const organization = this.ctx.globalState.get('terraform.cloud.organization', '');
      if (organization === '') {
        return [];
      }

      const response = await apiClient.listProjects({
        params: {
          organization_name: organization,
        },
      });
      const orgs = response.data;

      const items: vscode.QuickPickItem[] = [];
      for (let index = 0; index < orgs.length; index++) {
        const element = orgs[index];
        items.push({
          label: element.attributes.name,
          detail: element.id,
        });
      }

      const answer = await vscode.window.showQuickPick(items, {
        canPickMany: false,
        ignoreFocusOut: true,
        placeHolder: 'Choose a Project to filter Workspaces. Hit enter to select the first',
        title: 'Choose a Project',
      });

      if (answer === undefined) {
        return;
      }

      vscode.window.showInformationMessage(`Chose ${answer} project`);
      // this.projectID = answer;

      this.refresh(answer.detail);
      this.runDataProvider.refresh();
    });
    vscode.commands.registerCommand('terraform.cloud.workspaces.listAll', () => {
      this.projectID = '';
      // TODO This refreshes the workspace list without a project filter, but still
      // leaves the Project View 'ghost' selected on the last project selected.
      // There isn't a 'unselect' method on TreeView, apparently by design.
      // Following a web search trail lands on https://github.com/microsoft/vscode/issues/48754, among others
      // We could call projectView.reveal(item, { focus: false }), but that requires implementing getParent
      // and having both a reference to projectView as well as the ProjectItem and that seems a bridge too
      // far at the moment.

      this.refresh();
      this.runDataProvider.refresh();
    });
    vscode.commands.registerCommand('terraform.cloud.workspaces.refresh', (item: WorkspaceTreeItem) => {
      // A user activating this may either have selected a project to view, or not.
      // Refresh the current list of workspaces
      // If there is a projectID, use that, otherwise list all
      this.refresh(this.projectID);
      // tell the Runs view to refresh based on the select workspace

      this.runDataProvider.refresh(item);
    });
  }

  refresh(projectID?: string): void {
    this.projectID = projectID ?? '';
    this.didChangeTreeData.fire();
  }

  getTreeItem(element: WorkspaceTreeItem): WorkspaceTreeItem | Thenable<WorkspaceTreeItem> {
    return element;
  }

  getChildren(element?: WorkspaceTreeItem | undefined): vscode.ProviderResult<WorkspaceTreeItem[]> {
    const organization = this.ctx.globalState.get('terraform.cloud.organization', '');
    if (organization === '') {
      return [];
    }

    try {
      return this.getWorkspaces(organization);
    } catch (error) {
      return [];
    }
  }

  private async getWorkspaces(organization: string) {
    // TODO: handle projectid if present better
    let response = undefined;
    if (this.projectID !== '') {
      response = await apiClient.listWorkspaces({
        params: {
          organization_name: organization,
        },
        queries: {
          'filter[project][id]': this.projectID,
        },
      });
    } else {
      response = await apiClient.listWorkspaces({
        params: {
          organization_name: organization,
        },
      });
    }

    const workspaces = response.data;

    const items: WorkspaceTreeItem[] = [];
    for (let index = 0; index < workspaces.length; index++) {
      const element = workspaces[index];
      items.push(new WorkspaceTreeItem(element.attributes.name, element.id));
    }

    return items;
  }

  dispose() {
    //
  }
}

export class RunTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly didChangeTreeData = new vscode.EventEmitter<void | vscode.TreeItem>();
  public readonly onDidChangeTreeData = this.didChangeTreeData.event;

  private workspace: WorkspaceTreeItem | undefined;

  constructor(private ctx: vscode.ExtensionContext) {
    const runView = vscode.window.createTreeView('terraform.cloud.runs', {
      canSelectMany: false,
      showCollapseAll: true,
      treeDataProvider: this,
    });
    vscode.commands.registerCommand('terraform.cloud.runs.refresh', () => this.refresh());
    vscode.commands.registerCommand('terraform.cloud.runs.openRunInBrowser', (item: RunTreeItem) => {
      // open in browser
      vscode.env.openExternal(vscode.Uri.parse(item.url));
    });
    ctx.subscriptions.push(runView);
  }

  refresh(workspace?: WorkspaceTreeItem): void {
    if (workspace) {
      this.workspace = workspace;
    }
    this.didChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: vscode.TreeItem | undefined): vscode.ProviderResult<vscode.TreeItem[]> {
    if (this.workspace === undefined) {
      return [];
    }

    try {
      return this.getRuns(this.workspace);
    } catch (error) {
      return [];
    }
  }

  private async getRuns(workspace: WorkspaceTreeItem) {
    const organization = this.ctx.globalState.get('terraform.cloud.organization', '');

    const response = await apiClient.listRuns({
      params: {
        workspace_id: workspace.id,
      },
    });

    const projects = response.data;

    const items: vscode.TreeItem[] = [];
    for (let index = 0; index < projects.length; index++) {
      const element = projects[index];
      const url = `https://app.staging.terraform.io/app/${organization}/workspaces/${workspace.name}/runs/${element.id}`;
      const treeItem = new RunTreeItem(element.attributes.message, element.id, url);
      items.push(treeItem);
    }

    return items;
  }

  dispose() {
    //
  }
}

class WorkspaceTreeItem extends vscode.TreeItem {
  /**
   * @param id This is the workspaceID as well as the unique ID for the treeitem
   */
  constructor(public name: string, public id: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
  }
}

class RunTreeItem extends vscode.TreeItem {
  constructor(name: string, public id: string, public url: string) {
    super(name, vscode.TreeItemCollapsibleState.None);
  }
}
