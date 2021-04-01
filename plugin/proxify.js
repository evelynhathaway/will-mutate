// Create property paths that mostly match the limitations of dot notation
const propPath = function (path, property) {
	if (/^[$A-Z_a-z][\w$]*$/.test(property)) {
		return `${path}.${property}`;
	} else if (/^\d$/.test(property)) {
		return `${path}[${property}]`;
	} else {
		return `${path}["${property}"]`;
	}
};

// DO NOT CHANGE THE VARIABLE NAME WITHOUT UPDATING THE PLUGIN CODE
const _will_mutate_check_proxify = (target, options = {}) => {
	// Early return for non-objects
	if (!(target instanceof Object)) return target;

	// Options
	const {deep = false, prototype = false, _isSetter = false, _isGetter = false} = options;
	const isShallowSetter = _isSetter && !deep;

	// Naming properties for mutation tracing in errors
	const {
		name = (typeof target.name === "string" && target.name),
	} = options;
	const hasName = name !== undefined && name !== false;
	let pathIsName = false;
	let {path} = options;
	if (!path) {
		if (hasName) {
			path = name;
			pathIsName = true;
		} else {
			path = "target";
		}
	}
	if (hasName && !pathIsName) path = propPath(path, name);

	// Options for resursive function
	const recursiveOptions = {
		// Extend existing options
		...options,
		// Add new path
		path,
		// Reset temporary internal flags
		_isSetter: false,
		_isGetter: false,
	};

	// Proxy handler
	const handler = {};


	// Get traps for deep mutation assertions
	// Accessor edge case traps
	handler.getOwnPropertyDescriptor = function (dummyTarget, prop) {
		/*
			Early return for cached read-only properties, prevents the below invariant when adding read-only properties to the dummy:
			"The result of Object.getOwnPropertyDescriptor(target) can be applied to the target object using Object.defineProperty() and will not throw an exception."
		*/
		const dummyDescriptor = Reflect.getOwnPropertyDescriptor(...arguments);
		if (dummyDescriptor) return dummyDescriptor;

		// Reflect using the real target, not the dummy
		const reflectArguments = [...arguments];
		reflectArguments[0] = target;
		const descriptor = Reflect.getOwnPropertyDescriptor(...reflectArguments);

		// Early return for non-existing properties
		if (!descriptor) return;

		// If has a value instead of accessors
		const isValueDesc = "value" in descriptor;

		if (deep) {
			if (isValueDesc) {
				descriptor.value = _will_mutate_check_proxify(
					descriptor.value,
					{
						...recursiveOptions,
						name: false, // Hide name, use custom path logic instead
						path: `${propPath(path, prop)}.descriptor.value`,
					}
				);
			} else {
				descriptor.get = _will_mutate_check_proxify(
					descriptor.get,
					{
						...recursiveOptions,
						name: false, // Hide name, use custom path logic instead
						path: `${propPath(path, prop)}.descriptor.get`,
						_isGetter: true,
					}
				);
			}
		}
		if (!isValueDesc) {
			descriptor.set = _will_mutate_check_proxify(
				descriptor.set,
				{
					...recursiveOptions,
					name: false, // Hide name, use custom path logic instead
					path: `${propPath(path, prop)}.descriptor.set`,
					_isSetter: true,
				}
			);
		}

		/*
			Add read-only props to `dummyTarget` to meet the below invariant:
			"A property cannot be reported as existent, if it does not exists as an own property of the target object and the target object is not extensible."
		*/
		const isReadOnly = descriptor.writable === false || descriptor.configurable === false;
		if (isReadOnly) Object.defineProperty(dummyTarget, prop, descriptor);

		return descriptor;
	};

	const addGetTrap = (trap) => {
		handler[trap] = function (dummyTarget, prop) {
			// Reflect using the real target, not the dummy
			const reflectArguments = [...arguments];
			reflectArguments[0] = target;

			if (trap === "getPrototypeOf") prop = "__proto__";
			if (trap === "apply") {
				path += "()";
				prop = false; // Get apply trap doesn't need a prop
			}
			const real = Reflect[trap](...reflectArguments);
			return deep || _isGetter ? _will_mutate_check_proxify(real, {...recursiveOptions, path, name: prop}) : real; // Will revert to the actual target if not deep
		};
	};
	addGetTrap("get"); // Covered by getOwnPropertyDescriptor, but is more specific
	prototype && addGetTrap("getPrototypeOf");
	_isGetter && addGetTrap("apply");


	// Mutation traps for erroring
	const addSetTrap = (trap) => {
		handler[trap] = function (dummyTarget, prop) {
			// Naming properties for mutation tracing in errors
			// Keep path mutuations inside this scope, the `path` available in the closure will not reset if the exception is caught
			let internalPath = path;
			if (trap === "apply") {
				internalPath += "()";
				prop = false; // Set apply trap doesn't need a prop
			} else if (trap !== "preventExtensions") {
				if (trap === "setPrototypeOf") prop = "__proto__";
				internalPath = propPath(internalPath, prop);
			}

			throw new Error(`Mutation assertion failed. \`${trap}\` trap triggered on \`${internalPath}\`.`);
		};
	};
	if (!isShallowSetter) {
		addSetTrap("set"); // Covered by defineProperty, but is more specific
		addSetTrap("defineProperty");
		addSetTrap("deleteProperty");
		addSetTrap("preventExtensions");
		prototype && addSetTrap("setPrototypeOf");
	}
	_isSetter && addSetTrap("apply");


	// Reflect to the real target for unused traps
	// This is to avoid the navtive fallback to the `dummyTarget`
	const addNoopReflectUsingRealTargetTrap = (trap) => {
		// Early return for existing traps
		if (handler[trap]) return;

		handler[trap] = function () {
			// Reflect using the real target, not the dummy
			const reflectArguments = [...arguments];
			reflectArguments[0] = target;
			return Reflect[trap](...reflectArguments);
		};
	};
	addNoopReflectUsingRealTargetTrap("isExtensible");
	addNoopReflectUsingRealTargetTrap("has");
	addNoopReflectUsingRealTargetTrap("ownKeys");
	addNoopReflectUsingRealTargetTrap("apply");
	addNoopReflectUsingRealTargetTrap("construct");


	// Don't use the true `target` as the proxy target to avoid issues with read-only types
	// Create `dummyTarget` based on the `target`'s constructor
	const dummyTarget = new (Object.getPrototypeOf(target).constructor)();
	return new Proxy(dummyTarget, handler);
};


module.exports = _will_mutate_check_proxify;