/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChannel, IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { Event, Emitter } from 'vs/base/common/event';
import { IStorageChangeEvent, IStorageMainService } from 'vs/platform/storage/node/storageMainService';
import { IUpdateRequest, IStorageDatabase, IStorageItemsChangeEvent } from 'vs/base/parts/storage/common/storage';
import { mapToSerializable, serializableToMap, values } from 'vs/base/common/map';
import { Disposable, IDisposable, dispose } from 'vs/base/common/lifecycle';
import { ILogService } from 'vs/platform/log/common/log';
import { generateUuid } from 'vs/base/common/uuid';
import { instanceStorageKey, firstSessionDateStorageKey, lastSessionDateStorageKey, currentSessionDateStorageKey, crashReporterIdStorageKey } from 'vs/platform/telemetry/common/telemetry';

type Key = string;
type Value = string;
type Item = [Key, Value];

interface ISerializableUpdateRequest {
	insert?: Item[];
	delete?: Key[];
}

interface ISerializableItemsChangeEvent {
	readonly changed?: Item[];
	readonly deleted?: Key[];
}

export class GlobalStorageDatabaseChannel extends Disposable implements IServerChannel {

	private static readonly STORAGE_CHANGE_DEBOUNCE_TIME = 100;

	private readonly _onDidChangeItems = this._register(new Emitter<ISerializableItemsChangeEvent>());
	readonly onDidChangeItems = this._onDidChangeItems.event;

	private readonly whenReady = this.init();

	constructor(
		private logService: ILogService,
		private storageMainService: IStorageMainService
	) {
		super();
	}

	private async init(): Promise<void> {
		try {
			await this.storageMainService.initialize();
		} catch (error) {
			this.logService.error(`[storage] init(): Unable to init global storage due to ${error}`);
		}

		// This is unique to the application instance and thereby
		// should be written from the main process once.
		//
		// THIS SHOULD NEVER BE SENT TO TELEMETRY.
		//
		const crashReporterId = this.storageMainService.get(crashReporterIdStorageKey, undefined);
		if (crashReporterId === undefined) {
			this.storageMainService.store(crashReporterIdStorageKey, generateUuid());
		}

		// Apply global telemetry values as part of the initialization
		// These are global across all windows and thereby should be
		// written from the main process once.
		this.initTelemetry();

		// Setup storage change listeners
		this.registerListeners();
	}

	private initTelemetry(): void {
		const instanceId = this.storageMainService.get(instanceStorageKey, undefined);
		if (instanceId === undefined) {
			this.storageMainService.store(instanceStorageKey, generateUuid());
		}

		const firstSessionDate = this.storageMainService.get(firstSessionDateStorageKey, undefined);
		if (firstSessionDate === undefined) {
			this.storageMainService.store(firstSessionDateStorageKey, new Date().toUTCString());
		}

		const lastSessionDate = this.storageMainService.get(currentSessionDateStorageKey, undefined); // previous session date was the "current" one at that time
		const currentSessionDate = new Date().toUTCString(); // current session date is "now"
		this.storageMainService.store(lastSessionDateStorageKey, typeof lastSessionDate === 'undefined' ? null : lastSessionDate);
		this.storageMainService.store(currentSessionDateStorageKey, currentSessionDate);
	}

	private registerListeners(): void {

		// Listen for changes in global storage to send to listeners
		// that are listening. Use a debouncer to reduce IPC traffic.
		this._register(Event.debounce(this.storageMainService.onDidChangeStorage, (prev: IStorageChangeEvent[] | undefined, cur: IStorageChangeEvent) => {
			if (!prev) {
				prev = [cur];
			} else {
				prev.push(cur);
			}

			return prev;
		}, GlobalStorageDatabaseChannel.STORAGE_CHANGE_DEBOUNCE_TIME)(events => {
			if (events.length) {
				this._onDidChangeItems.fire(this.serializeEvents(events));
			}
		}));
	}

	private serializeEvents(events: IStorageChangeEvent[]): ISerializableItemsChangeEvent {
		const changed = new Map<Key, Value>();
		const deleted = new Set<Key>();
		events.forEach(event => {
			const existing = this.storageMainService.get(event.key);
			if (typeof existing === 'string') {
				changed.set(event.key, existing);
			} else {
				deleted.add(event.key);
			}
		});

		return { changed: mapToSerializable(changed), deleted: values(deleted) };
	}

	listen(_: unknown, event: string): Event<any> {
		switch (event) {
			case 'onDidChangeItems': return this.onDidChangeItems;
		}

		throw new Error(`Event not found: ${event}`);
	}

	async call(_: unknown, command: string, arg?: any): Promise<any> {

		// ensure to always wait for ready
		await this.whenReady;

		// handle call
		switch (command) {
			case 'getItems': {
				return mapToSerializable(this.storageMainService.items);
			}

			case 'updateItems': {
				const items: ISerializableUpdateRequest = arg;
				if (items.insert) {
					for (const [key, value] of items.insert) {
						this.storageMainService.store(key, value);
					}
				}

				if (items.delete) {
					items.delete.forEach(key => this.storageMainService.remove(key));
				}

				break;
			}

			default:
				throw new Error(`Call not found: ${command}`);
		}
	}
}

export class GlobalStorageDatabaseChannelClient extends Disposable implements IStorageDatabase {

	_serviceBrand: undefined;

	private readonly _onDidChangeItemsExternal = this._register(new Emitter<IStorageItemsChangeEvent>());
	readonly onDidChangeItemsExternal = this._onDidChangeItemsExternal.event;

	private onDidChangeItemsOnMainListener: IDisposable | undefined;

	constructor(private channel: IChannel) {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {
		this.onDidChangeItemsOnMainListener = this.channel.listen<ISerializableItemsChangeEvent>('onDidChangeItems')((e: ISerializableItemsChangeEvent) => this.onDidChangeItemsOnMain(e));
	}

	private onDidChangeItemsOnMain(e: ISerializableItemsChangeEvent): void {
		if (Array.isArray(e.changed) || Array.isArray(e.deleted)) {
			this._onDidChangeItemsExternal.fire({
				changed: e.changed ? serializableToMap(e.changed) : undefined,
				deleted: e.deleted ? new Set<string>(e.deleted) : undefined
			});
		}
	}

	async getItems(): Promise<Map<string, string>> {
		const items: Item[] = await this.channel.call('getItems');

		return serializableToMap(items);
	}

	updateItems(request: IUpdateRequest): Promise<void> {
		const serializableRequest: ISerializableUpdateRequest = Object.create(null);

		if (request.insert) {
			serializableRequest.insert = mapToSerializable(request.insert);
		}

		if (request.delete) {
			serializableRequest.delete = values(request.delete);
		}

		return this.channel.call('updateItems', serializableRequest);
	}

	close(): Promise<void> {

		// when we are about to close, we start to ignore main-side changes since we close anyway
		dispose(this.onDidChangeItemsOnMainListener);

		return Promise.resolve(); // global storage is closed on the main side
	}

	dispose(): void {
		super.dispose();

		dispose(this.onDidChangeItemsOnMainListener);
	}
}
