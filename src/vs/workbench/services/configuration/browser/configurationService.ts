/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { Event, Emitter } from 'vs/base/common/event';
import { ResourceMap } from 'vs/base/common/map';
import { equals } from 'vs/base/common/objects';
import { Disposable } from 'vs/base/common/lifecycle';
import { Queue, Barrier, runWhenIdle } from 'vs/base/common/async';
import { IJSONContributionRegistry, Extensions as JSONExtensions } from 'vs/platform/jsonschemas/common/jsonContributionRegistry';
import { IWorkspaceContextService, Workspace, WorkbenchState, IWorkspaceFolder, toWorkspaceFolders, IWorkspaceFoldersChangeEvent, WorkspaceFolder, toWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { ConfigurationModel, DefaultConfigurationModel, ConfigurationChangeEvent, AllKeysConfigurationChangeEvent, mergeChanges } from 'vs/platform/configuration/common/configurationModels';
import { IConfigurationChangeEvent, ConfigurationTarget, IConfigurationOverrides, keyFromOverrideIdentifier, isConfigurationOverrides, IConfigurationData, IConfigurationService, IConfigurationValue, IConfigurationChange } from 'vs/platform/configuration/common/configuration';
import { Configuration } from 'vs/workbench/services/configuration/common/configurationModels';
import { FOLDER_CONFIG_FOLDER_NAME, defaultSettingsSchemaId, userSettingsSchemaId, workspaceSettingsSchemaId, folderSettingsSchemaId, IConfigurationCache, machineSettingsSchemaId, LOCAL_MACHINE_SCOPES } from 'vs/workbench/services/configuration/common/configuration';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationRegistry, Extensions, allSettings, windowSettings, resourceSettings, applicationSettings, machineSettings, machineOverridableSettings } from 'vs/platform/configuration/common/configurationRegistry';
import { IWorkspaceIdentifier, isWorkspaceIdentifier, IStoredWorkspaceFolder, isStoredWorkspaceFolder, IWorkspaceFolderCreationData, ISingleFolderWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, IWorkspaceInitializationPayload, isSingleFolderWorkspaceInitializationPayload, ISingleFolderWorkspaceInitializationPayload, IEmptyWorkspaceInitializationPayload, useSlashForPath, getStoredWorkspaceFolder } from 'vs/platform/workspaces/common/workspaces';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ConfigurationEditingService, EditableConfigurationTarget } from 'vs/workbench/services/configuration/common/configurationEditingService';
import { WorkspaceConfiguration, FolderConfiguration, RemoteUserConfiguration, UserConfiguration } from 'vs/workbench/services/configuration/browser/configuration';
import { JSONEditingService } from 'vs/workbench/services/configuration/common/jsonEditingService';
import { IJSONSchema } from 'vs/base/common/jsonSchema';
import { isEqual, dirname } from 'vs/base/common/resources';
import { mark } from 'vs/base/common/performance';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { IFileService } from 'vs/platform/files/common/files';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';

export class WorkspaceService extends Disposable implements IConfigurationService, IWorkspaceContextService {

	public _serviceBrand: undefined;

	private workspace!: Workspace;
	private completeWorkspaceBarrier: Barrier;
	private readonly configurationCache: IConfigurationCache;
	private _configuration: Configuration;
	private initialized: boolean = false;
	private defaultConfiguration: DefaultConfigurationModel;
	private localUserConfiguration: UserConfiguration;
	private remoteUserConfiguration: RemoteUserConfiguration | null = null;
	private workspaceConfiguration: WorkspaceConfiguration;
	private cachedFolderConfigs: ResourceMap<FolderConfiguration>;
	private workspaceEditingQueue: Queue<void>;

	private readonly fileService: IFileService;

	protected readonly _onDidChangeConfiguration: Emitter<IConfigurationChangeEvent> = this._register(new Emitter<IConfigurationChangeEvent>());
	public readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent> = this._onDidChangeConfiguration.event;

	protected readonly _onDidChangeWorkspaceFolders: Emitter<IWorkspaceFoldersChangeEvent> = this._register(new Emitter<IWorkspaceFoldersChangeEvent>());
	public readonly onDidChangeWorkspaceFolders: Event<IWorkspaceFoldersChangeEvent> = this._onDidChangeWorkspaceFolders.event;

	protected readonly _onDidChangeWorkspaceName: Emitter<void> = this._register(new Emitter<void>());
	public readonly onDidChangeWorkspaceName: Event<void> = this._onDidChangeWorkspaceName.event;

	protected readonly _onDidChangeWorkbenchState: Emitter<WorkbenchState> = this._register(new Emitter<WorkbenchState>());
	public readonly onDidChangeWorkbenchState: Event<WorkbenchState> = this._onDidChangeWorkbenchState.event;

	// TODO@sandeep debt with cyclic dependencies
	private configurationEditingService!: ConfigurationEditingService;
	private jsonEditingService!: JSONEditingService;
	private cyclicDependencyReady!: Function;
	private cyclicDependency = new Promise<void>(resolve => this.cyclicDependencyReady = resolve);

	constructor(
		{ remoteAuthority, configurationCache }: { remoteAuthority?: string, configurationCache: IConfigurationCache },
		environmentService: IWorkbenchEnvironmentService,
		fileService: IFileService,
		remoteAgentService: IRemoteAgentService
	) {
		super();

		this.completeWorkspaceBarrier = new Barrier();
		this.defaultConfiguration = new DefaultConfigurationModel();
		this.configurationCache = configurationCache;
		this.fileService = fileService;
		this._configuration = new Configuration(this.defaultConfiguration, new ConfigurationModel(), new ConfigurationModel(), new ConfigurationModel(), new ResourceMap(), new ConfigurationModel(), new ResourceMap<ConfigurationModel>(), this.workspace);
		this.cachedFolderConfigs = new ResourceMap<FolderConfiguration>();
		this.localUserConfiguration = this._register(new UserConfiguration(environmentService.settingsResource, remoteAuthority ? LOCAL_MACHINE_SCOPES : undefined, fileService));
		this._register(this.localUserConfiguration.onDidChangeConfiguration(userConfiguration => this.onLocalUserConfigurationChanged(userConfiguration)));
		if (remoteAuthority) {
			this.remoteUserConfiguration = this._register(new RemoteUserConfiguration(remoteAuthority, configurationCache, fileService, remoteAgentService));
			this._register(this.remoteUserConfiguration.onDidChangeConfiguration(userConfiguration => this.onRemoteUserConfigurationChanged(userConfiguration)));
		}
		this.workspaceConfiguration = this._register(new WorkspaceConfiguration(configurationCache, fileService));
		this._register(this.workspaceConfiguration.onDidUpdateConfiguration(() => {
			this.onWorkspaceConfigurationChanged();
			if (this.workspaceConfiguration.loaded) {
				this.releaseWorkspaceBarrier();
			}
		}));

		this._register(Registry.as<IConfigurationRegistry>(Extensions.Configuration).onDidSchemaChange(e => this.registerConfigurationSchemas()));
		this._register(Registry.as<IConfigurationRegistry>(Extensions.Configuration).onDidUpdateConfiguration(configurationProperties => this.onDefaultConfigurationChanged(configurationProperties)));

		this.workspaceEditingQueue = new Queue<void>();
	}

	// Workspace Context Service Impl

	public getCompleteWorkspace(): Promise<Workspace> {
		return this.completeWorkspaceBarrier.wait().then(() => this.getWorkspace());
	}

	public getWorkspace(): Workspace {
		return this.workspace;
	}

	public getWorkbenchState(): WorkbenchState {
		// Workspace has configuration file
		if (this.workspace.configuration) {
			return WorkbenchState.WORKSPACE;
		}

		// Folder has single root
		if (this.workspace.folders.length === 1) {
			return WorkbenchState.FOLDER;
		}

		// Empty
		return WorkbenchState.EMPTY;
	}

	public getWorkspaceFolder(resource: URI): IWorkspaceFolder | null {
		return this.workspace.getFolder(resource);
	}

	public addFolders(foldersToAdd: IWorkspaceFolderCreationData[], index?: number): Promise<void> {
		return this.updateFolders(foldersToAdd, [], index);
	}

	public removeFolders(foldersToRemove: URI[]): Promise<void> {
		return this.updateFolders([], foldersToRemove);
	}

	public updateFolders(foldersToAdd: IWorkspaceFolderCreationData[], foldersToRemove: URI[], index?: number): Promise<void> {
		return this.cyclicDependency.then(() => {
			return this.workspaceEditingQueue.queue(() => this.doUpdateFolders(foldersToAdd, foldersToRemove, index));
		});
	}

	public isInsideWorkspace(resource: URI): boolean {
		return !!this.getWorkspaceFolder(resource);
	}

	public isCurrentWorkspace(workspaceIdentifier: ISingleFolderWorkspaceIdentifier | IWorkspaceIdentifier): boolean {
		switch (this.getWorkbenchState()) {
			case WorkbenchState.FOLDER:
				return isSingleFolderWorkspaceIdentifier(workspaceIdentifier) && isEqual(workspaceIdentifier, this.workspace.folders[0].uri);
			case WorkbenchState.WORKSPACE:
				return isWorkspaceIdentifier(workspaceIdentifier) && this.workspace.id === workspaceIdentifier.id;
		}
		return false;
	}

	private async doUpdateFolders(foldersToAdd: IWorkspaceFolderCreationData[], foldersToRemove: URI[], index?: number): Promise<void> {
		if (this.getWorkbenchState() !== WorkbenchState.WORKSPACE) {
			return Promise.resolve(undefined); // we need a workspace to begin with
		}

		if (foldersToAdd.length + foldersToRemove.length === 0) {
			return Promise.resolve(undefined); // nothing to do
		}

		let foldersHaveChanged = false;

		// Remove first (if any)
		let currentWorkspaceFolders = this.getWorkspace().folders;
		let newStoredFolders: IStoredWorkspaceFolder[] = currentWorkspaceFolders.map(f => f.raw).filter((folder, index): folder is IStoredWorkspaceFolder => {
			if (!isStoredWorkspaceFolder(folder)) {
				return true; // keep entries which are unrelated
			}

			return !this.contains(foldersToRemove, currentWorkspaceFolders[index].uri); // keep entries which are unrelated
		});

		const slashForPath = useSlashForPath(newStoredFolders);

		foldersHaveChanged = currentWorkspaceFolders.length !== newStoredFolders.length;

		// Add afterwards (if any)
		if (foldersToAdd.length) {

			// Recompute current workspace folders if we have folders to add
			const workspaceConfigPath = this.getWorkspace().configuration!;
			const workspaceConfigFolder = dirname(workspaceConfigPath);
			currentWorkspaceFolders = toWorkspaceFolders(newStoredFolders, workspaceConfigPath);
			const currentWorkspaceFolderUris = currentWorkspaceFolders.map(folder => folder.uri);

			const storedFoldersToAdd: IStoredWorkspaceFolder[] = [];

			await Promise.all(foldersToAdd.map(async folderToAdd => {
				const folderURI = folderToAdd.uri;
				if (this.contains(currentWorkspaceFolderUris, folderURI)) {
					return; // already existing
				}
				try {
					const result = await this.fileService.resolve(folderURI);
					if (!result.isDirectory) {
						return;
					}
				} catch (e) { /* Ignore */ }
				storedFoldersToAdd.push(getStoredWorkspaceFolder(folderURI, folderToAdd.name, workspaceConfigFolder, slashForPath));
			}));

			// Apply to array of newStoredFolders
			if (storedFoldersToAdd.length > 0) {
				foldersHaveChanged = true;

				if (typeof index === 'number' && index >= 0 && index < newStoredFolders.length) {
					newStoredFolders = newStoredFolders.slice(0);
					newStoredFolders.splice(index, 0, ...storedFoldersToAdd);
				} else {
					newStoredFolders = [...newStoredFolders, ...storedFoldersToAdd];
				}
			}
		}

		// Set folders if we recorded a change
		if (foldersHaveChanged) {
			return this.setFolders(newStoredFolders);
		}

		return Promise.resolve(undefined);
	}

	private setFolders(folders: IStoredWorkspaceFolder[]): Promise<void> {
		return this.cyclicDependency.then(() => {
			return this.workspaceConfiguration.setFolders(folders, this.jsonEditingService)
				.then(() => this.onWorkspaceConfigurationChanged());
		});
	}

	private contains(resources: URI[], toCheck: URI): boolean {
		return resources.some(resource => isEqual(resource, toCheck));
	}

	// Workspace Configuration Service Impl

	getConfigurationData(): IConfigurationData {
		return this._configuration.toData();
	}

	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	getValue(arg1?: any, arg2?: any): any {
		const section = typeof arg1 === 'string' ? arg1 : undefined;
		const overrides = isConfigurationOverrides(arg1) ? arg1 : isConfigurationOverrides(arg2) ? arg2 : undefined;
		return this._configuration.getValue(section, overrides);
	}

	updateValue(key: string, value: any): Promise<void>;
	updateValue(key: string, value: any, overrides: IConfigurationOverrides): Promise<void>;
	updateValue(key: string, value: any, target: ConfigurationTarget): Promise<void>;
	updateValue(key: string, value: any, overrides: IConfigurationOverrides, target: ConfigurationTarget): Promise<void>;
	updateValue(key: string, value: any, overrides: IConfigurationOverrides, target: ConfigurationTarget, donotNotifyError: boolean): Promise<void>;
	updateValue(key: string, value: any, arg3?: any, arg4?: any, donotNotifyError?: any): Promise<void> {
		return this.cyclicDependency.then(() => {
			const overrides = isConfigurationOverrides(arg3) ? arg3 : undefined;
			const target = this.deriveConfigurationTarget(key, value, overrides, overrides ? arg4 : arg3);
			return target ? this.writeConfigurationValue(key, value, target, overrides, donotNotifyError)
				: Promise.resolve();
		});
	}

	reloadConfiguration(folder?: IWorkspaceFolder, key?: string): Promise<void> {
		if (folder) {
			return this.reloadWorkspaceFolderConfiguration(folder, key);
		}
		return this.reloadUserConfiguration()
			.then(({ local, remote }) => this.reloadWorkspaceConfiguration()
				.then(() => this.loadConfiguration(local, remote)));
	}

	inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T> {
		return this._configuration.inspect<T>(key, overrides);
	}

	keys(): {
		default: string[];
		user: string[];
		workspace: string[];
		workspaceFolder: string[];
	} {
		return this._configuration.keys();
	}

	initialize(arg: IWorkspaceInitializationPayload): Promise<any> {
		mark('willInitWorkspaceService');
		return this.createWorkspace(arg)
			.then(workspace => this.updateWorkspaceAndInitializeConfiguration(workspace)).then(() => {
				mark('didInitWorkspaceService');
			});
	}

	acquireInstantiationService(instantiationService: IInstantiationService): void {
		this.configurationEditingService = instantiationService.createInstance(ConfigurationEditingService);
		this.jsonEditingService = instantiationService.createInstance(JSONEditingService);

		if (this.cyclicDependencyReady) {
			this.cyclicDependencyReady();
		} else {
			this.cyclicDependency = Promise.resolve(undefined);
		}
	}

	private createWorkspace(arg: IWorkspaceInitializationPayload): Promise<Workspace> {
		if (isWorkspaceIdentifier(arg)) {
			return this.createMultiFolderWorkspace(arg);
		}

		if (isSingleFolderWorkspaceInitializationPayload(arg)) {
			return this.createSingleFolderWorkspace(arg);
		}

		return this.createEmptyWorkspace(arg);
	}

	private createMultiFolderWorkspace(workspaceIdentifier: IWorkspaceIdentifier): Promise<Workspace> {
		return this.workspaceConfiguration.load({ id: workspaceIdentifier.id, configPath: workspaceIdentifier.configPath })
			.then(() => {
				const workspaceConfigPath = workspaceIdentifier.configPath;
				const workspaceFolders = toWorkspaceFolders(this.workspaceConfiguration.getFolders(), workspaceConfigPath);
				const workspaceId = workspaceIdentifier.id;
				const workspace = new Workspace(workspaceId, workspaceFolders, workspaceConfigPath);
				if (this.workspaceConfiguration.loaded) {
					this.releaseWorkspaceBarrier();
				}
				return workspace;
			});
	}

	private createSingleFolderWorkspace(singleFolder: ISingleFolderWorkspaceInitializationPayload): Promise<Workspace> {
		const workspace = new Workspace(singleFolder.id, [toWorkspaceFolder(singleFolder.folder)]);
		this.releaseWorkspaceBarrier(); // Release barrier as workspace is complete because it is single folder.
		return Promise.resolve(workspace);
	}

	private createEmptyWorkspace(emptyWorkspace: IEmptyWorkspaceInitializationPayload): Promise<Workspace> {
		const workspace = new Workspace(emptyWorkspace.id);
		this.releaseWorkspaceBarrier(); // Release barrier as workspace is complete because it is an empty workspace.
		return Promise.resolve(workspace);
	}

	private releaseWorkspaceBarrier(): void {
		if (!this.completeWorkspaceBarrier.isOpen()) {
			this.completeWorkspaceBarrier.open();
		}
	}

	private updateWorkspaceAndInitializeConfiguration(workspace: Workspace): Promise<void> {
		const hasWorkspaceBefore = !!this.workspace;
		let previousState: WorkbenchState;
		let previousWorkspacePath: string | undefined;
		let previousFolders: WorkspaceFolder[];

		if (hasWorkspaceBefore) {
			previousState = this.getWorkbenchState();
			previousWorkspacePath = this.workspace.configuration ? this.workspace.configuration.fsPath : undefined;
			previousFolders = this.workspace.folders;
			this.workspace.update(workspace);
		} else {
			this.workspace = workspace;
		}

		return this.initializeConfiguration().then(() => {

			// Trigger changes after configuration initialization so that configuration is up to date.
			if (hasWorkspaceBefore) {
				const newState = this.getWorkbenchState();
				if (previousState && newState !== previousState) {
					this._onDidChangeWorkbenchState.fire(newState);
				}

				const newWorkspacePath = this.workspace.configuration ? this.workspace.configuration.fsPath : undefined;
				if (previousWorkspacePath && newWorkspacePath !== previousWorkspacePath || newState !== previousState) {
					this._onDidChangeWorkspaceName.fire();
				}

				const folderChanges = this.compareFolders(previousFolders, this.workspace.folders);
				if (folderChanges && (folderChanges.added.length || folderChanges.removed.length || folderChanges.changed.length)) {
					this._onDidChangeWorkspaceFolders.fire(folderChanges);
				}

			} else {
				// Not waiting on this validation to unblock start up
				this.validateWorkspaceFoldersAndReload();
			}

			if (!this.localUserConfiguration.hasTasksLoaded) {
				// Reload local user configuration again to load user tasks
				runWhenIdle(() => this.reloadLocalUserConfiguration().then(configurationModel => this.onLocalUserConfigurationChanged(configurationModel)), 5000);
			}
		});
	}

	private compareFolders(currentFolders: IWorkspaceFolder[], newFolders: IWorkspaceFolder[]): IWorkspaceFoldersChangeEvent {
		const result: IWorkspaceFoldersChangeEvent = { added: [], removed: [], changed: [] };
		result.added = newFolders.filter(newFolder => !currentFolders.some(currentFolder => newFolder.uri.toString() === currentFolder.uri.toString()));
		for (let currentIndex = 0; currentIndex < currentFolders.length; currentIndex++) {
			let currentFolder = currentFolders[currentIndex];
			let newIndex = 0;
			for (newIndex = 0; newIndex < newFolders.length && currentFolder.uri.toString() !== newFolders[newIndex].uri.toString(); newIndex++) { }
			if (newIndex < newFolders.length) {
				if (currentIndex !== newIndex || currentFolder.name !== newFolders[newIndex].name) {
					result.changed.push(currentFolder);
				}
			} else {
				result.removed.push(currentFolder);
			}
		}
		return result;
	}

	private initializeConfiguration(): Promise<void> {
		this.registerConfigurationSchemas();
		return this.initializeUserConfiguration()
			.then(({ local, remote }) => this.loadConfiguration(local, remote));
	}

	private initializeUserConfiguration(): Promise<{ local: ConfigurationModel, remote: ConfigurationModel }> {
		return Promise.all([this.localUserConfiguration.initialize(), this.remoteUserConfiguration ? this.remoteUserConfiguration.initialize() : Promise.resolve(new ConfigurationModel())])
			.then(([local, remote]) => ({ local, remote }));
	}

	private reloadUserConfiguration(key?: string): Promise<{ local: ConfigurationModel, remote: ConfigurationModel }> {
		return Promise.all([this.reloadLocalUserConfiguration(), this.reloadRemoeUserConfiguration()]).then(([local, remote]) => ({ local, remote }));
	}

	private reloadLocalUserConfiguration(key?: string): Promise<ConfigurationModel> {
		return this.localUserConfiguration.reload();
	}

	private reloadRemoeUserConfiguration(key?: string): Promise<ConfigurationModel> {
		return this.remoteUserConfiguration ? this.remoteUserConfiguration.reload() : Promise.resolve(new ConfigurationModel());
	}

	private reloadWorkspaceConfiguration(key?: string): Promise<void> {
		const workbenchState = this.getWorkbenchState();
		if (workbenchState === WorkbenchState.FOLDER) {
			return this.onWorkspaceFolderConfigurationChanged(this.workspace.folders[0], key);
		}
		if (workbenchState === WorkbenchState.WORKSPACE) {
			return this.workspaceConfiguration.reload().then(() => this.onWorkspaceConfigurationChanged());
		}
		return Promise.resolve(undefined);
	}

	private reloadWorkspaceFolderConfiguration(folder: IWorkspaceFolder, key?: string): Promise<void> {
		return this.onWorkspaceFolderConfigurationChanged(folder, key);
	}

	private loadConfiguration(userConfigurationModel: ConfigurationModel, remoteUserConfigurationModel: ConfigurationModel): Promise<void> {
		// reset caches
		this.cachedFolderConfigs = new ResourceMap<FolderConfiguration>();

		const folders = this.workspace.folders;
		return this.loadFolderConfigurations(folders)
			.then((folderConfigurations) => {

				let workspaceConfiguration = this.getWorkspaceConfigurationModel(folderConfigurations);
				const folderConfigurationModels = new ResourceMap<ConfigurationModel>();
				folderConfigurations.forEach((folderConfiguration, index) => folderConfigurationModels.set(folders[index].uri, folderConfiguration));

				const currentConfiguration = this._configuration;
				this._configuration = new Configuration(this.defaultConfiguration, userConfigurationModel, remoteUserConfigurationModel, workspaceConfiguration, folderConfigurationModels, new ConfigurationModel(), new ResourceMap<ConfigurationModel>(), this.workspace);

				if (this.initialized) {
					const change = this._configuration.compare(currentConfiguration);
					this.triggerConfigurationChange(change, { data: currentConfiguration.toData(), workspace: this.workspace }, ConfigurationTarget.WORKSPACE);
				} else {
					this._onDidChangeConfiguration.fire(new AllKeysConfigurationChangeEvent(this._configuration, this.workspace, ConfigurationTarget.WORKSPACE, this.getTargetConfiguration(ConfigurationTarget.WORKSPACE)));
					this.initialized = true;
				}
			});
	}

	private getWorkspaceConfigurationModel(folderConfigurations: ConfigurationModel[]): ConfigurationModel {
		switch (this.getWorkbenchState()) {
			case WorkbenchState.FOLDER:
				return folderConfigurations[0];
			case WorkbenchState.WORKSPACE:
				return this.workspaceConfiguration.getConfiguration();
			default:
				return new ConfigurationModel();
		}
	}

	private onDefaultConfigurationChanged(keys: string[]): void {
		this.defaultConfiguration = new DefaultConfigurationModel();
		this.registerConfigurationSchemas();
		if (this.workspace) {
			const previousData = this._configuration.toData();
			const change = this._configuration.compareAndUpdateDefaultConfiguration(this.defaultConfiguration, keys);
			if (this.remoteUserConfiguration) {
				this._configuration.updateLocalUserConfiguration(this.localUserConfiguration.reprocess());
				this._configuration.updateRemoteUserConfiguration(this.remoteUserConfiguration.reprocess());
			}
			if (this.getWorkbenchState() === WorkbenchState.FOLDER) {
				this._configuration.updateWorkspaceConfiguration(this.cachedFolderConfigs.get(this.workspace.folders[0].uri)!.reprocess());
			} else {
				this._configuration.updateWorkspaceConfiguration(this.workspaceConfiguration.reprocessWorkspaceSettings());
				this.workspace.folders.forEach(folder => this._configuration.updateFolderConfiguration(folder.uri, this.cachedFolderConfigs.get(folder.uri)!.reprocess()));
			}
			this.triggerConfigurationChange(change, { data: previousData, workspace: this.workspace }, ConfigurationTarget.DEFAULT);
		}
	}

	private registerConfigurationSchemas(): void {
		if (this.workspace) {
			const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);
			const allSettingsSchema: IJSONSchema = { properties: allSettings.properties, patternProperties: allSettings.patternProperties, additionalProperties: true, allowTrailingCommas: true, allowComments: true };
			const userSettingsSchema: IJSONSchema = this.remoteUserConfiguration ? { properties: { ...applicationSettings.properties, ...windowSettings.properties, ...resourceSettings.properties }, patternProperties: allSettings.patternProperties, additionalProperties: true, allowTrailingCommas: true, allowComments: true } : allSettingsSchema;
			const machineSettingsSchema: IJSONSchema = { properties: { ...machineSettings.properties, ...machineOverridableSettings.properties, ...windowSettings.properties, ...resourceSettings.properties }, patternProperties: allSettings.patternProperties, additionalProperties: true, allowTrailingCommas: true, allowComments: true };
			const workspaceSettingsSchema: IJSONSchema = { properties: { ...machineOverridableSettings.properties, ...windowSettings.properties, ...resourceSettings.properties }, patternProperties: allSettings.patternProperties, additionalProperties: true, allowTrailingCommas: true, allowComments: true };

			jsonRegistry.registerSchema(defaultSettingsSchemaId, allSettingsSchema);
			jsonRegistry.registerSchema(userSettingsSchemaId, userSettingsSchema);
			jsonRegistry.registerSchema(machineSettingsSchemaId, machineSettingsSchema);

			if (WorkbenchState.WORKSPACE === this.getWorkbenchState()) {
				const folderSettingsSchema: IJSONSchema = { properties: { ...machineOverridableSettings.properties, ...resourceSettings.properties }, patternProperties: allSettings.patternProperties, additionalProperties: true, allowTrailingCommas: true, allowComments: true };
				jsonRegistry.registerSchema(workspaceSettingsSchemaId, workspaceSettingsSchema);
				jsonRegistry.registerSchema(folderSettingsSchemaId, folderSettingsSchema);
			} else {
				jsonRegistry.registerSchema(workspaceSettingsSchemaId, workspaceSettingsSchema);
				jsonRegistry.registerSchema(folderSettingsSchemaId, workspaceSettingsSchema);
			}
		}
	}

	private onLocalUserConfigurationChanged(userConfiguration: ConfigurationModel): void {
		const previous = { data: this._configuration.toData(), workspace: this.workspace };
		const change = this._configuration.compareAndUpdateLocalUserConfiguration(userConfiguration);
		this.triggerConfigurationChange(change, previous, ConfigurationTarget.USER);
	}

	private onRemoteUserConfigurationChanged(userConfiguration: ConfigurationModel): void {
		const previous = { data: this._configuration.toData(), workspace: this.workspace };
		const change = this._configuration.compareAndUpdateRemoteUserConfiguration(userConfiguration);
		this.triggerConfigurationChange(change, previous, ConfigurationTarget.USER);
	}

	private async onWorkspaceConfigurationChanged(): Promise<void> {
		if (this.workspace && this.workspace.configuration) {
			const previous = { data: this._configuration.toData(), workspace: this.workspace };
			const change = this._configuration.compareAndUpdateWorkspaceConfiguration(this.workspaceConfiguration.getConfiguration());
			let configuredFolders = await this.toValidWorkspaceFolders(toWorkspaceFolders(this.workspaceConfiguration.getFolders(), this.workspace.configuration));
			const changes = this.compareFolders(this.workspace.folders, configuredFolders);
			if (changes.added.length || changes.removed.length || changes.changed.length) {
				this.workspace.folders = configuredFolders;
				return this.onFoldersChanged()
					.then(change => {
						this.triggerConfigurationChange(change, previous, ConfigurationTarget.WORKSPACE_FOLDER);
						this._onDidChangeWorkspaceFolders.fire(changes);
					});
			} else {
				this.triggerConfigurationChange(change, previous, ConfigurationTarget.WORKSPACE);
			}
		}
		return Promise.resolve(undefined);
	}

	private onWorkspaceFolderConfigurationChanged(folder: IWorkspaceFolder, key?: string): Promise<void> {
		return this.loadFolderConfigurations([folder])
			.then(([folderConfiguration]) => {
				const previous = { data: this._configuration.toData(), workspace: this.workspace };
				const folderConfiguraitonChange = this._configuration.compareAndUpdateFolderConfiguration(folder.uri, folderConfiguration);
				if (this.getWorkbenchState() === WorkbenchState.FOLDER) {
					const workspaceConfigurationChange = this._configuration.compareAndUpdateWorkspaceConfiguration(folderConfiguration);
					this.triggerConfigurationChange(mergeChanges(folderConfiguraitonChange, workspaceConfigurationChange), previous, ConfigurationTarget.WORKSPACE);
				} else {
					this.triggerConfigurationChange(folderConfiguraitonChange, previous, ConfigurationTarget.WORKSPACE_FOLDER);
				}
			});
	}

	private async onFoldersChanged(): Promise<IConfigurationChange> {
		const changes: IConfigurationChange[] = [];

		// Remove the configurations of deleted folders
		for (const key of this.cachedFolderConfigs.keys()) {
			if (!this.workspace.folders.filter(folder => folder.uri.toString() === key.toString())[0]) {
				const folderConfiguration = this.cachedFolderConfigs.get(key);
				folderConfiguration!.dispose();
				this.cachedFolderConfigs.delete(key);
				changes.push(this._configuration.compareAndDeleteFolderConfiguration(key));
			}
		}

		const toInitialize = this.workspace.folders.filter(folder => !this.cachedFolderConfigs.has(folder.uri));
		if (toInitialize.length) {
			const folderConfigurations = await this.loadFolderConfigurations(toInitialize);
			folderConfigurations.forEach((folderConfiguration, index) => {
				changes.push(this._configuration.compareAndUpdateFolderConfiguration(toInitialize[index].uri, folderConfiguration));
			});
		}
		return mergeChanges(...changes);
	}

	private loadFolderConfigurations(folders: IWorkspaceFolder[]): Promise<ConfigurationModel[]> {
		return Promise.all([...folders.map(folder => {
			let folderConfiguration = this.cachedFolderConfigs.get(folder.uri);
			if (!folderConfiguration) {
				folderConfiguration = new FolderConfiguration(folder, FOLDER_CONFIG_FOLDER_NAME, this.getWorkbenchState(), this.fileService, this.configurationCache);
				this._register(folderConfiguration.onDidChange(() => this.onWorkspaceFolderConfigurationChanged(folder)));
				this.cachedFolderConfigs.set(folder.uri, this._register(folderConfiguration));
			}
			return folderConfiguration.loadConfiguration();
		})]);
	}

	private async validateWorkspaceFoldersAndReload(): Promise<void> {
		const validWorkspaceFolders = await this.toValidWorkspaceFolders(this.workspace.folders);
		const { removed } = this.compareFolders(this.workspace.folders, validWorkspaceFolders);
		if (removed.length) {
			return this.onWorkspaceConfigurationChanged();
		}
	}

	private async toValidWorkspaceFolders(workspaceFolders: WorkspaceFolder[]): Promise<WorkspaceFolder[]> {
		const validWorkspaceFolders: WorkspaceFolder[] = [];
		for (const workspaceFolder of workspaceFolders) {
			try {
				const result = await this.fileService.resolve(workspaceFolder.uri);
				if (!result.isDirectory) {
					continue;
				}
			} catch (e) { /* Ignore */ }
			validWorkspaceFolders.push(workspaceFolder);
		}
		return validWorkspaceFolders;
	}

	private writeConfigurationValue(key: string, value: any, target: ConfigurationTarget, overrides: IConfigurationOverrides | undefined, donotNotifyError: boolean): Promise<void> {
		if (target === ConfigurationTarget.DEFAULT) {
			return Promise.reject(new Error('Invalid configuration target'));
		}

		if (target === ConfigurationTarget.MEMORY) {
			const previous = { data: this._configuration.toData(), workspace: this.workspace };
			this._configuration.updateValue(key, value, overrides);
			this.triggerConfigurationChange({ keys: overrides?.overrideIdentifier ? [keyFromOverrideIdentifier(overrides.overrideIdentifier), key] : [key], overrides: overrides?.overrideIdentifier ? [[overrides?.overrideIdentifier, [key]]] : [] }, previous, target);
			return Promise.resolve(undefined);
		}

		const editableConfigurationTarget = this.toEditableConfigurationTarget(target, key);
		if (!editableConfigurationTarget) {
			return Promise.reject(new Error('Invalid configuration target'));
		}

		if (editableConfigurationTarget === EditableConfigurationTarget.USER_REMOTE && !this.remoteUserConfiguration) {
			return Promise.reject(new Error('Invalid configuration target'));
		}

		return this.configurationEditingService.writeConfiguration(editableConfigurationTarget, { key, value }, { scopes: overrides, donotNotifyError })
			.then(() => {
				switch (editableConfigurationTarget) {
					case EditableConfigurationTarget.USER_LOCAL:
						return this.reloadLocalUserConfiguration().then(local => this.onLocalUserConfigurationChanged(local));
					case EditableConfigurationTarget.USER_REMOTE:
						return this.reloadRemoeUserConfiguration().then(remote => this.onRemoteUserConfigurationChanged(remote));
					case EditableConfigurationTarget.WORKSPACE:
						return this.reloadWorkspaceConfiguration();
					case EditableConfigurationTarget.WORKSPACE_FOLDER:
						const workspaceFolder = overrides && overrides.resource ? this.workspace.getFolder(overrides.resource) : null;
						if (workspaceFolder) {
							return this.reloadWorkspaceFolderConfiguration(workspaceFolder, key);
						}
				}
				return Promise.resolve();
			});
	}

	private deriveConfigurationTarget(key: string, value: any, overrides: IConfigurationOverrides | undefined, target: ConfigurationTarget): ConfigurationTarget | undefined {
		if (target) {
			return target;
		}

		if (value === undefined) {
			// Ignore. But expected is to remove the value from all targets
			return undefined;
		}

		const inspect = this.inspect(key, overrides);
		if (equals(value, inspect.value)) {
			// No change. So ignore.
			return undefined;
		}

		if (inspect.workspaceFolderValue !== undefined) {
			return ConfigurationTarget.WORKSPACE_FOLDER;
		}

		if (inspect.workspaceValue !== undefined) {
			return ConfigurationTarget.WORKSPACE;
		}

		return ConfigurationTarget.USER;
	}

	private triggerConfigurationChange(change: IConfigurationChange, previous: { data: IConfigurationData, workspace?: Workspace } | undefined, target: ConfigurationTarget): void {
		if (change.keys.length) {
			const configurationChangeEvent = new ConfigurationChangeEvent(change, previous, this._configuration, this.workspace);
			configurationChangeEvent.source = target;
			configurationChangeEvent.sourceConfig = this.getTargetConfiguration(target);
			this._onDidChangeConfiguration.fire(configurationChangeEvent);
		}
	}

	private getTargetConfiguration(target: ConfigurationTarget): any {
		switch (target) {
			case ConfigurationTarget.DEFAULT:
				return this._configuration.defaults.contents;
			case ConfigurationTarget.USER:
				return this._configuration.userConfiguration.contents;
			case ConfigurationTarget.WORKSPACE:
				return this._configuration.workspaceConfiguration.contents;
		}
		return {};
	}

	private toEditableConfigurationTarget(target: ConfigurationTarget, key: string): EditableConfigurationTarget | null {
		if (target === ConfigurationTarget.USER) {
			if (this.inspect(key).userRemoteValue !== undefined) {
				return EditableConfigurationTarget.USER_REMOTE;
			}
			return EditableConfigurationTarget.USER_LOCAL;
		}
		if (target === ConfigurationTarget.USER_LOCAL) {
			return EditableConfigurationTarget.USER_LOCAL;
		}
		if (target === ConfigurationTarget.USER_REMOTE) {
			return EditableConfigurationTarget.USER_REMOTE;
		}
		if (target === ConfigurationTarget.WORKSPACE) {
			return EditableConfigurationTarget.WORKSPACE;
		}
		if (target === ConfigurationTarget.WORKSPACE_FOLDER) {
			return EditableConfigurationTarget.WORKSPACE_FOLDER;
		}
		return null;
	}
}
