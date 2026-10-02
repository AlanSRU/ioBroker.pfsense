// In-memory stand-in for the parts of the adapter API that ObjectWriter uses.
import type * as utils from '@iobroker/adapter-core';

export class FakeAdapter {
    public readonly namespace = 'pfsense.0';
    public readonly objects = new Map<string, ioBroker.SettableObject>();
    public readonly states = new Map<string, ioBroker.StateValue>();
    public writes = 0;

    public getAdapterObjectsAsync(): Promise<Record<string, ioBroker.SettableObject>> {
        const out: Record<string, ioBroker.SettableObject> = {};
        for (const [id, o] of this.objects) {
            out[`${this.namespace}.${id}`] = o;
        }
        return Promise.resolve(out);
    }

    public extendObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
        const prev = this.objects.get(id);
        this.objects.set(
            id,
            prev ? ({ ...prev, ...obj, common: { ...prev.common, ...obj.common } } as ioBroker.SettableObject) : obj,
        );
        return Promise.resolve();
    }

    public setObjectNotExistsAsync(id: string, obj: ioBroker.SettableObject): Promise<void> {
        if (!this.objects.has(id)) {
            this.objects.set(id, obj);
        }
        return Promise.resolve();
    }

    public setStateChangedAsync(id: string, state: { val: ioBroker.StateValue; ack: boolean }): Promise<void> {
        if (this.states.get(id) !== state.val) {
            this.states.set(id, state.val);
            this.writes++;
        }
        return Promise.resolve();
    }

    public delObjectAsync(id: string): Promise<void> {
        for (const key of [...this.objects.keys()]) {
            if (key === id || key.startsWith(`${id}.`)) {
                this.objects.delete(key);
                this.states.delete(key);
            }
        }
        return Promise.resolve();
    }

    public asAdapter(): utils.AdapterInstance {
        return this as unknown as utils.AdapterInstance;
    }
}
