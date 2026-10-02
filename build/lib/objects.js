"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var objects_exports = {};
__export(objects_exports, {
  ObjectWriter: () => ObjectWriter
});
module.exports = __toCommonJS(objects_exports);
class ObjectWriter {
  /**
   * @param adapter - the adapter instance
   * @param isUnloaded - returns true once the adapter is stopping
   */
  constructor(adapter, isUnloaded) {
    this.adapter = adapter;
    this.isUnloaded = isUnloaded;
  }
  created = /* @__PURE__ */ new Set();
  /** Every own object id (relative) known to exist, loaded at start and kept current. */
  existing = /* @__PURE__ */ new Set();
  /** Loads the ids of all existing own objects; needed for stale-entity cleanup. */
  async load() {
    const objs = await this.adapter.getAdapterObjectsAsync();
    const prefix = `${this.adapter.namespace}.`;
    for (const full of Object.keys(objs)) {
      if (full.startsWith(prefix)) {
        this.existing.add(full.slice(prefix.length));
      }
    }
  }
  /** True when the object exists (from the start-up load or created in this run). */
  has(id) {
    return this.existing.has(id) || this.created.has(id);
  }
  /** Ids of existing objects that are direct children of `parent`. */
  childKeys(parent) {
    const prefix = `${parent}.`;
    const keys = /* @__PURE__ */ new Set();
    for (const id of [...this.existing, ...this.created]) {
      if (id.startsWith(prefix)) {
        keys.add(id.slice(prefix.length).split(".")[0]);
      }
    }
    return [...keys];
  }
  /** Creates or updates a folder object. */
  async folder(id, name) {
    await this.ensure(id, { type: "folder", common: { name }, native: {} });
  }
  /** Creates or updates a channel object. */
  async channel(id, name) {
    await this.ensure(id, { type: "channel", common: { name }, native: {} });
  }
  /**
   * Creates a device. With `keepUserName` an existing device is left alone, so a name the user
   * gave it in the admin survives; otherwise the name follows the configuration.
   */
  async device(id, name, native = {}, keepUserName = false) {
    if (keepUserName && !this.created.has(id) && !this.isUnloaded()) {
      await this.adapter.setObjectNotExistsAsync(id, { type: "device", common: { name }, native });
      this.created.add(id);
      this.existing.add(id);
      return;
    }
    await this.ensure(id, { type: "device", common: { name }, native });
  }
  /** Creates a state object. Booleans default to read-only indicators unless `write` is given. */
  async defineState(id, spec) {
    const common = {
      read: true,
      write: false,
      ...spec
    };
    if (common.def === void 0 && common.role !== "button") {
      common.def = defaultFor(common.type);
    }
    if (common.def === void 0) {
      delete common.def;
    }
    await this.ensure(id, { type: "state", common, native: {} });
  }
  /** Creates the state if needed and writes `val` (ack) when it changed. Undefined = not reported: skipped. */
  async state(id, spec, val) {
    if (val === void 0 || this.isUnloaded()) {
      return;
    }
    await this.defineState(id, spec);
    if (this.isUnloaded()) {
      return;
    }
    await this.adapter.setStateChangedAsync(id, { val, ack: true });
  }
  /** Deletes children of `parent` whose key is not in `keep` (an entity removed on the firewall). */
  async removeStale(parent, keep) {
    const keepSet = new Set(keep);
    const removed = [];
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
  async remove(id) {
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
  async ensure(id, obj) {
    if (this.created.has(id) || this.isUnloaded()) {
      return;
    }
    await this.adapter.extendObject(id, obj);
    this.created.add(id);
    this.existing.add(id);
  }
}
function defaultFor(type) {
  switch (type) {
    case "string":
      return "";
    case "boolean":
      return false;
    default:
      return void 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ObjectWriter
});
//# sourceMappingURL=objects.js.map
