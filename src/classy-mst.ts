// This file is part of classy-mst, copyright (c) 2017- BusFaster Ltd.
// Released under the MIT license, see LICENSE.

import { IObservableArray } from 'mobx';
import {
	IType,
	IModelType,
	IArrayType,
	IStateTreeNode,
	types,
	ModelProperties,
	ModelInstanceType,
	ModelCreationType2,
	ModelSnapshotType2
} from 'mobx-state-tree';

/** Interface with all IModelType static and dynamic members,
  * callable to construct a specialized instance. */

export interface ModelInterface<PROPS extends ModelProperties, OTHERS, CustomC, CustomS> {
	new(): IStateTreeNode & IModelType<PROPS, OTHERS, CustomC, CustomS> & ModelInstanceType<PROPS, OTHERS>;
}

export let typeTag: string | undefined = '$';

export function setTypeTag(tag?: string) {
	typeTag = tag;
}

function dummyGetter() {}

/** Force TypeScript to accept an MST model as a superclass.
  * @param model Model (MST tree node) */

export function shim<PROPS extends ModelProperties, OTHERS, CustomC, CustomS>(
	Model: IModelType<PROPS, OTHERS, CustomC, CustomS>,
	Parent?: any
): ModelInterface<PROPS, OTHERS, CustomC, CustomS> {
	function BaseClass() {}

	if(Parent && Parent.$proto) {
		BaseClass.prototype = Parent.$proto;
		BaseClass.prototype = new (BaseClass as any)();
		BaseClass.prototype.$parent = Parent;
		if(BaseClass.prototype.$actions) BaseClass.prototype.$actions = {};
	} else {
		BaseClass.prototype = {};
	}

	return(BaseClass as any);
}

/** Decorator for actions. By default the mst function treats methods as views. */

export function action(target: { [key: string]: any }, key: string) {
	(target.$actions || (target.$actions = {}))[key] = true;
}

interface MemberSpec<MemberType> {
	name: string;
	value: MemberType;
}

interface ClassyUnion<PROPS extends ModelProperties, OTHERS, CustomC, CustomS> extends IModelType<PROPS, OTHERS, CustomC, CustomS> {
	$proto: any;
	$typeList: (IModelType<any, any, any, any> | { dispatcher: ((snap: any) => IModelType<any, any, any, any>) })[];
	$typeTbl: { [name: string]: IModelType<any, any, any, any> };
}

const internalMembers: { [name: string]: boolean } = {
	constructor: true,
	$actions: true,
	$parent: true
};

export interface ClassyOptions {
	name?: string;
	sealed?: boolean;
}

function renameFunction(func: Function, name: string) {
	Object.defineProperty(func, 'name', { value: name, writable: false });
}

// Test if renaming functions works to avoid errors / useless attempts.

try {
	renameFunction(dummyGetter, 'dummy');
} catch(err) {}

const renamableFunctions = (dummyGetter.name == 'dummy');

/** Add methods from an ES6 class into an MST model.
  * @param code Class with methods to add as views (the default)
  *   and actions (if decorated).
  * @param data MST model with properties.
  * @param modelName Model name for debugging and polymorphic type tags in snapshots. */

export function mst<PROPS extends ModelProperties, OTHERS, CustomC, CustomS, TYPE>(
	Code: new() => TYPE,
	Data: IModelType<PROPS, OTHERS, CustomC, CustomS>,
	modelName?: string | ClassyOptions,
	options?: ClassyOptions
): IModelType<PROPS, TYPE, CustomC, CustomS> {
	const viewList: MemberSpec<Function>[] = [];
	const actionList: MemberSpec<Function>[] = [];
	const descList: MemberSpec<PropertyDescriptor>[] = [];

	const memberTbl = Code.prototype;
	const actionTbl = memberTbl.$actions;
	const volatileTbl: { [name: string]: any } = {};

	if(modelName && typeof(modelName) == 'object') {
		options = modelName;
		modelName = options.name;
	} else options = options || {};

	// Extract views, actions, getters and setters from the class prototype.

	for(let name of Object.getOwnPropertyNames(memberTbl)) {
		if(internalMembers[name]) continue;

		const desc = Object.getOwnPropertyDescriptor && Object.getOwnPropertyDescriptor(memberTbl, name);

		if(!desc || (desc.configurable && desc.writable && !desc.get && !desc.set)) {
			const value = memberTbl[name];
			const spec: MemberSpec<any> = { name, value };

			if(actionTbl && actionTbl[name]) actionList.push(spec);
			else viewList.push(spec);
		} else {
			descList.push({ name, value: desc });
		}
	}

	// Create a sample instance and extract volatile members
	// defined in the constructor.

	const instance: { [name: string]: any } = new Code();
	const volatileList = Object.getOwnPropertyNames(instance);

	for(let name of volatileList) {
		volatileTbl[name] = instance[name];
	}

	// Apply optional name given to the model.

	if(modelName) Data = Data.named(modelName);

	// Bind views, actions and volatile state to the model.

	let Model = Data;

	Model = options.sealed ? Model : Model.preProcessSnapshot(
		// Instantiating a union of models requires a snapshot.
		(snap: any) => snap || {}
	);

	Model = Model.postProcessSnapshot((snap: any) => {
		if(modelName && typeTag && Code.prototype.$parent) snap[typeTag] = modelName;
		return(snap);
	}).actions((self) => {
		const result: { [name: string]: Function } = {};

		for(let { name, value } of actionList) {
			const method = function() {
				return(value.apply(self, arguments));
			}

			if(renamableFunctions) {
				renameFunction(method, modelName + '.' + name);
			}

			result[name] = method;
		}

		return(result);
	});

	Model = !(viewList.length + descList.length) ? Model : Model.views((self) => {
		const result: { [name: string]: Function } = {};

		for(let { name, value } of viewList) {
			result[name] = function() {
				return(value.apply(self, arguments));
			}
		}

		for(let { name, value } of descList) {
			const desc: PropertyDescriptor = {};

			for(let key of Object.getOwnPropertyNames(value)) {
				(desc as any)[key] = (value as any)[key];
			}

			const { get, set } = desc;

			if(get) {
				desc.get = () => get.call(self);
			} else if(set) {
				// Properties with only setters still need a getter defined here,
				// or mobx-state-tree will ignore them.
				desc.get = dummyGetter;
			}

			if(set) desc.set = (value: any) => set.call(self, value);

			// Allow mobx-state-tree to see the property, or it gets ignored.
			desc.enumerable = true;

			Object.defineProperty(result, name, desc);
		}

		return(result);
	});

	Model = !volatileList.length ? Model : Model.volatile((self) => volatileTbl);

	return(options.sealed ? Model as any : polymorphic(Code, Model, modelName));
}

export function polymorphic<PROPS extends ModelProperties, OTHERS, CustomC, CustomS, TYPE>(
	Code: new() => TYPE,
	Model: IModelType<PROPS, OTHERS, CustomC, CustomS>,
	modelName?: string
): IModelType<PROPS, TYPE, CustomC, CustomS> {
	// Union of this class and all of its subclasses.
	// Late evaluation allows subclasses to add themselves to the type list
	// before any instances are created.
	const Union: ClassyUnion<PROPS, TYPE, CustomC, CustomS> = types.late(() => types.union.apply(types, Union.$typeList)) as any;

	// First item in the type list is a dispatcher function
	// for parsing type tags in snapshots.
	Union.$typeList = [ { dispatcher: (snap: any) =>
		(snap && typeTag && snap[typeTag] && Union.$typeTbl[snap[typeTag]]) || Model
	} ];

	Union.$typeTbl = {};
	Union.$proto = Code.prototype;

	// Copy methods from model object into returned union,
	// making it work like a regular model.

	for(let mixin: { [key: string]: any } = Model; mixin; mixin = Object.getPrototypeOf(mixin)) {
		for(let key of Object.getOwnPropertyNames(mixin)) {
			const desc = Object.getOwnPropertyDescriptor && Object.getOwnPropertyDescriptor(mixin, key);

			if(!desc || (desc.configurable && desc.writable && !desc.get && !desc.set)) {
				const value = !(key in Union) && mixin[key];

				if(typeof(value) == 'function') {
					(Union as { [key: string]: any })[key] = function() {
						return(value.apply(Model, arguments));
					};
				}
			}
		}
	}

	// Initialize union of allowed class substitutes with the class itself,
	// and augment unions of all parent classes with this subclass,
	// to allow polymorphism.

	for(let Class = Union; Class; Class = Class.$proto.$parent) {
		const typeList = Class.$typeList;
		const typeTbl = Class.$typeTbl;

		if(typeList) typeList.push(Model);
		if(typeTbl && modelName) typeTbl[modelName] = Model;
	}

	return(Union);
}

export type RecursiveType<PROPS> = PROPS & {
	children?: RecursiveType<PROPS>[] | null
}

export function mstWithChildren<PROPS extends ModelProperties, OTHERS, CustomC, CustomS, TYPE>(
	Code: new() => TYPE,
	Data: IModelType<PROPS, OTHERS, CustomC, CustomS>,
	name?: string
) {
	const Children = types.array(types.late((): any => Model));
	const Branch = (Data as any as IModelType<PROPS, TYPE, CustomC, CustomS>).props({
		children: types.maybe(
			Children as any as IArrayType<IModelType<
				RecursiveType<PROPS>,
				OTHERS,
				RecursiveType<ModelCreationType2<PROPS, CustomC>>,
				RecursiveType<ModelSnapshotType2<PROPS, CustomS>>
			>>
		)
	});

	const Model = mst(Code, Branch, 'Node') as typeof Branch;

	return({ Model, Children });
}
