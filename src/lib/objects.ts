import type * as utils from '@iobroker/adapter-core';

export type StateSpec = Omit<ioBroker.StateCommon, 'read' | 'write'> & {
    read?: boolean;
    write?: boolean;
};

/** State specs the adapter creates, keyed by short name; `def` is filled in from the type. */
export type Val = ioBroker.StateValue | undefined;

/**
 * All object and state writes go through here. It
 * - creates each object once per run (extendObject, so changed metadata reaches upgraded installs
 *   and user `common.custom` settings survive),
 * - skips values that were not reported instead of writing a placeholder,
 * - only writes changed values,
 * - drops every write after unload.
 */
export class ObjectWriter {
    private readonly created = new Set<string>();
    /** Every own object id (relative) known to exist, loaded at start and kept current. */
    private readonly existing = new Set<string>();

    /**
     * @param adapter - the adapter instance
     * @param isUnloaded - returns true once the adapter is stopping
     */
    public constructor(
        private readonly adapter: utils.AdapterInstance,
        private readonly isUnloaded: () => boolean,
    ) {}

    /** Loads the ids of all existing own objects; needed for stale-entity cleanup. */
    public async load(): Promise<void> {
        const objs = await this.adapter.getAdapterObjectsAsync();
        const prefix = `${this.adapter.namespace}.`;
        for (const full of Object.keys(objs)) {
            if (full.startsWith(prefix)) {
                this.existing.add(full.slice(prefix.length));
            }
        }
    }

    /** True when the object exists (from the start-up load or created in this run). */
    public has(id: string): boolean {
        return this.existing.has(id) || this.created.has(id);
    }

    /** Ids of existing objects that are direct children of `parent`. */
    public childKeys(parent: string): string[] {
        const prefix = `${parent}.`;
        const keys = new Set<string>();
        for (const id of [...this.existing, ...this.created]) {
            if (id.startsWith(prefix)) {
                keys.add(id.slice(prefix.length).split('.')[0]);
            }
        }
        return [...keys];
    }

    /** Creates or updates a folder object. */
    public async folder(id: string, name: ioBroker.StringOrTranslated): Promise<void> {
        await this.ensure(id, { type: 'folder', common: { name }, native: {} });
    }

    /** Creates or updates a channel object. */
    public async channel(id: string, name: ioBroker.StringOrTranslated): Promise<void> {
        await this.ensure(id, { type: 'channel', common: { name }, native: {} });
    }

    /**
     * Creates a device. With `keepUserName` an existing device is left alone, so a name the user
     * gave it in the admin survives; otherwise the name follows the configuration.
     */
    public async device(
        id: string,
        name: ioBroker.StringOrTranslated,
        native: Record<string, unknown> = {},
        keepUserName = false,
    ): Promise<void> {
        if (keepUserName && !this.created.has(id) && !this.isUnloaded()) {
            await this.adapter.setObjectNotExistsAsync(id, { type: 'device', common: { name }, native });
            this.created.add(id);
            this.existing.add(id);
            return;
        }
        await this.ensure(id, { type: 'device', common: { name }, native });
    }

    /** Creates a state object. Booleans default to read-only indicators unless `write` is given. */
    public async defineState(id: string, spec: StateSpec): Promise<void> {
        const common: ioBroker.StateCommon = {
            read: true,
            write: false,
            ...spec,
        };
        if (common.def === undefined && common.role !== 'button') {
            common.def = defaultFor(common.type);
        }
        if (common.def === undefined) {
            delete common.def;
        }
        await this.ensure(id, { type: 'state', common, native: {} });
    }

    /** Creates the state if needed and writes `val` (ack) when it changed. Undefined = not reported: skipped. */
    public async state(id: string, spec: StateSpec, val: Val): Promise<void> {
        if (val === undefined || this.isUnloaded()) {
            return;
        }
        await this.defineState(id, spec);
        if (this.isUnloaded()) {
            return;
        }
        await this.adapter.setStateChangedAsync(id, { val, ack: true });
    }

    /** Deletes children of `parent` whose key is not in `keep` (an entity removed on the firewall). */
    public async removeStale(parent: string, keep: Iterable<string>): Promise<string[]> {
        const keepSet = new Set(keep);
        const removed: string[] = [];
        for (const key of this.childKeys(parent)) {
            if (keepSet.has(key) || this.isUnloaded()) {
                continue;
            }
            await this.remove(`${parent}.${key}`);
            removed.push(key);
        }
        return removed;
    }

    /** Deletes an object and all its children. */
    public async remove(id: string): Promise<void> {
        await this.adapter.delObjectAsync(id, { recursive: true });
        const prefix = `${id}.`;
        for (const set of [this.existing, this.created]) {
            for (const x of [...set]) {
                if (x === id || x.startsWith(prefix)) {
                    set.delete(x);
                }
            }
        }
    }

    private async ensure(id: string, obj: ioBroker.SettableObject): Promise<void> {
        if (this.created.has(id) || this.isUnloaded()) {
            return;
        }
        await this.adapter.extendObject(id, obj);
        this.created.add(id);
        this.existing.add(id);
    }
}

function defaultFor(type: ioBroker.CommonType | undefined): ioBroker.StateValue | undefined {
    switch (type) {
        case 'string':
            return '';
        case 'boolean':
            return false;
        default:
            // numbers get no default: 0 would read as a real measurement
            return undefined;
    }
}
