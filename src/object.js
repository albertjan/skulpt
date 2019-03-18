import { typeName, setUpInheritance } from './abstract';
import { remapToJs } from './ffi';
import { pyCheckArgs } from './function';

/**
 * @constructor
 * Sk.builtin.object
 *
 * @description
 * Constructor for Python object. All Python classes (builtin and user-defined)
 * should inherit from this class.
 *
 * @return {Sk.builtin.object} Python object
 */
export class object {
    GenericGetAttr(name, canSuspend) {
        var res;
        var f;
        var descr;
        var tp;
        var dict;
        var getf;
        var pyName = new Sk.builtin.str(name);
        goog.asserts.assert(typeof name === "string");

        tp = this.ob$type;
        goog.asserts.assert(tp !== undefined, "object has no ob$type!");

        dict = this["$d"] || this.constructor["$d"];

        // todo; assert? force?
        if (dict) {
            if (dict.mp$lookup) {
                res = dict.mp$lookup(pyName);
            } else if (dict.mp$subscript) {
                res = _tryGetSubscript(dict, pyName);
            } else if (typeof dict === "object") {
                res = dict[name];
            }
            if (res !== undefined) {
                return res;
            }
        }

        descr = Sk.builtin.type.typeLookup(tp, name);

        // otherwise, look in the type for a descr
        if (descr !== undefined && descr !== null) {
            f = descr.tp$descr_get;
            // todo - data descriptors (ie those with tp$descr_set too) get a different lookup priority

            if (f) {
                // non-data descriptor
                return f.call(descr, this, this.ob$type, canSuspend);
            }
        }

        if (descr !== undefined) {
            return descr;
        }

        // OK, try __getattr__

        descr = Sk.builtin.type.typeLookup(tp, "__getattr__");
        if (descr !== undefined && descr !== null) {
            f = descr.tp$descr_get;
            if (f) {
                getf = f.call(descr, this, this.ob$type);
            } else {
                getf = descr;
            }

            res = Sk.misceval.tryCatch(function() {
                return Sk.misceval.callsimOrSuspend(getf, pyName);
            }, function(e) {
                if (e instanceof Sk.builtin.AttributeError) {
                    return undefined;
                } else {
                    throw e;
                }
            });
            return canSuspend ? res : Sk.misceval.retryOptionalSuspensionOrThrow(res);
        }


        return undefined;
    }

    GenericPythonGetAttr(self, name) {
        var r = this.GenericGetAttr.call(self, name.v, true);
        if (r === undefined) {
            throw new Sk.builtin.AttributeError(name);
        }
        return r;
    }

    /**
     * @param {string} name
     * @param {Object} value
     * @param {boolean=} canSuspend
     * @return {undefined}
     */
    GenericSetAttr(name, value, canSuspend) {
        var objname = typeName(this);
        var pyname;
        var dict;
        var tp = this.ob$type;
        var descr;
        var f;

        goog.asserts.assert(typeof name === "string");
        goog.asserts.assert(tp !== undefined, "object has no ob$type!");

        dict = this["$d"] || this.constructor["$d"];

        if (name == "__class__") {
            if (value.tp$mro === undefined || value.tp$name === undefined ||
                value.tp$name === undefined) {
                throw new Sk.builtin.TypeError(
                        "attempted to assign non-class to __class__");
            }
            this.ob$type = value;
            this.tp$name = value.tp$name;
            return;
        }

        descr = Sk.builtin.type.typeLookup(tp, name);

        // otherwise, look in the type for a descr
        if (descr !== undefined && descr !== null) {
            f = descr.tp$descr_set;
            // todo; is this the right lookup priority for data descriptors?
            if (f) {
                return f.call(descr, this, value, canSuspend);
            }
        }

        if (dict.mp$ass_subscript) {
            pyname = new Sk.builtin.str(name);

            if (this instanceof Sk.builtin.object && !(this.ob$type.sk$klass) &&
                dict.mp$lookup(pyname) === undefined) {
                // Cannot add new attributes to a builtin object
                throw new Sk.builtin.AttributeError("'" + objname + "' object has no attribute '" + Sk.unfixReserved(name) + "'");
            }
            dict.mp$ass_subscript(new Sk.builtin.str(name), value);
        } else if (typeof dict === "object") {
            dict[name] = value;
        }
    }

    GenericPythonSetAttr(self, name, value) {
        return this.GenericSetAttr.call(self, name.v, value, true);
    }

    HashNotImplemented() {
        throw new Sk.builtin.TypeError("unhashable type: '" + typeName(this) + "'");
    }

    tp$getattr = this.GenericGetAttr;
    tp$setattr = this.GenericSetAttr;

    // Although actual attribute-getting happens in pure Javascript via tp$getattr, classes
    // overriding __getattribute__ etc need to be able to call object.__getattribute__ etc from Python
    __getattribute__= this.GenericPythonGetAttr;
    __setattr__= this.GenericPythonSetAttr;

    /**
     * The name of this class.
     * @type {string}
     */
    tp$name = "object";

    /**
     * The type object of this class.
     * @type {Sk.builtin.type|Object}
     */
    ob$type = Sk.builtin.type.makeIntoTypeObj("object", Sk.builtin.object);

    tp$descr_set = undefined;   // Nonsense for closure compiler

    /** Default implementations of dunder methods found in all Python objects */
    /**
     * Default implementation of __new__ just calls the class constructor
     * @name  __new__
     * @memberOf Sk.builtin.object.prototype
     * @instance
     */
    __new__(cls) {
        pyCheckArgs("__new__", arguments, 1, 1, false, false);

        return new cls([], []);
    }

    /**
     * Python wrapper for `__repr__` method.
     * @name  __repr__
     * @memberOf Sk.builtin.object.prototype
     * @instance
     */
    __repr__(self) {
        pyCheckArgs("__repr__", arguments, 0, 0, false, true);

        return self["$r"]();
    }

    __format__(self, format_spec) {
        var formatstr;
        pyCheckArgs("__format__", arguments, 2, 2);

        if (!Sk.builtin.checkString(format_spec)) {
            if (Sk.__future__.exceptions) {
                throw new Sk.builtin.TypeError("format() argument 2 must be str, not " + typeName(format_spec));
            } else {
                throw new Sk.builtin.TypeError("format expects arg 2 to be string or unicode, not " + typeName(format_spec));
            }
        } else {
            formatstr = remapToJs(format_spec);
            if (formatstr !== "") {
                throw new Sk.builtin.NotImplementedError("format spec is not yet implemented");
            }
        }

        return new str(self);
    }

    // Wrap the following functions in Sk.builtin.func once that class is initialized
    /**
     * Array of all the Python functions which are methods of this class.
     * @type {Array}
     */
    static pythonFunctions = ["__repr__", "__str__", "__hash__",
        "__eq__", "__ne__", "__lt__", "__le__",
        "__gt__", "__ge__", "__getattribute__",
        "__setattr__", "__format__"];

    /**
     * Python wrapper for `__str__` method.
     * @name  __str__
     * @memberOf Sk.builtin.object.prototype
     * @instance
     */
    __str__(self) {
        pyCheckArgs("__str__", arguments, 0, 0, false, true);

        return self["$r"]();
    };

    /**
     * Python wrapper for `__hash__` method.
     * @name  __hash__
     * @memberOf Sk.builtin.object.prototype
     * @instance
     */
    __hash__(self) {
        pyCheckArgs("__hash__", arguments, 0, 0, false, true);

        return self.tp$hash();
    };

    /**
     * Python wrapper for `__eq__` method.
     * @name  __eq__
     * @memberOf Sk.builtin.object.prototype
     * @instance
     */
    __eq__(self, other) {
        pyCheckArgs("__eq__", arguments, 1, 1, false, true);

        return self.ob$eq(other);
    };

    /**
     * Python wrapper for `__ne__` method.
     * @name  __ne__
     * @memberOf Sk.builtin.object.prototype
     * @instance
     */
    __ne__(self, other) {
        pyCheckArgs("__ne__", arguments, 1, 1, false, true);

        return self.ob$ne(other);
    };

    /**
     * Python wrapper for `__lt__` method.
     * @name  __lt__
     * @memberOf Sk.builtin.object.prototype
     * @instance
     */
    __lt__(self, other) {
        pyCheckArgs("__lt__", arguments, 1, 1, false, true);

        return self.ob$lt(other);
    };

    /**
     * Python wrapper for `__le__` method.
     * @name  __le__
     * @memberOf Sk.builtin.object.prototype
     * @instance
     */
    __le__(self, other) {
        pyCheckArgs("__le__", arguments, 1, 1, false, true);

        return self.ob$le(other);
    };

    /**
     * Python wrapper for `__gt__` method.
     * @name  __gt__
     * @memberOf Sk.builtin.object.prototype
     * @instance
     */
    __gt__(self, other) {
        pyCheckArgs("__gt__", arguments, 1, 1, false, true);

        return self.ob$gt(other);
    };

    /**
     * Python wrapper for `__ge__` method.
     * @name  __ge__
     * @memberOf Sk.builtin.object.prototype
     * @instance
     */
    __ge__(self, other) {
        pyCheckArgs("__ge__", arguments, 1, 1, false, true);

        return self.ob$ge(other);
    };

    /** Default implementations of Javascript functions used in dunder methods */

    /**
     * Return the string representation of this instance.
     *
     * Javascript function, returns Python object.
     *
     * @name  $r
     * @memberOf Sk.builtin.object.prototype
     * @return {Sk.builtin.str} The Python string representation of this instance.
     */
    $r() {
        return new Sk.builtin.str("<object>");
    };


    /**
     * Return the hash value of this instance.
     *
     * Javascript function, returns Python object.
     *
     * @return {Sk.builtin.int_} The hash value
     */
    tp$hash() {
        if (!this.$savedHash_) {
            this.$savedHash_ = new Sk.builtin.int_(Sk.builtin.hashCount++);
        }

        return this.$savedHash_;
    };

    /**
     * Perform equality check between this instance and a Python object (i.e. this == other).
     *
     * Implements `__eq__` dunder method.
     *
     * Javascript function, returns Python object.
     *
     * @param  {Object} other The Python object to check for equality.
     * @return {(Sk.builtin.bool|Sk.builtin.NotImplemented)} true if equal, false otherwise
     */
    ob$eq(other) {
        if (this === other) {
            return Sk.builtin.bool.true$;
        }

        return Sk.builtin.NotImplemented.NotImplemented$;
    };

    /**
     * Perform non-equality check between this instance and a Python object (i.e. this != other).
     *
     * Implements `__ne__` dunder method.
     *
     * Javascript function, returns Python object.
     *
     * @param  {Object} other The Python object to check for non-equality.
     * @return {(Sk.builtin.bool|Sk.builtin.NotImplemented)} true if not equal, false otherwise
     */
    ob$ne(other) {
        if (this === other) {
            return Sk.builtin.bool.false$;
        }

        return Sk.builtin.NotImplemented.NotImplemented$;
    };

    /**
     * Determine if this instance is less than a Python object (i.e. this < other).
     *
     * Implements `__lt__` dunder method.
     *
     * Javascript function, returns Python object.
     *
     * @param  {Object} other The Python object to compare.
     * @return {(Sk.builtin.bool|Sk.builtin.NotImplemented)} true if this < other, false otherwise
     */
    ob$lt(other) {
        return Sk.builtin.NotImplemented.NotImplemented$;
    };

    /**
     * Determine if this instance is less than or equal to a Python object (i.e. this <= other).
     *
     * Implements `__le__` dunder method.
     *
     * Javascript function, returns Python object.
     *
     * @param  {Object} other The Python object to compare.
     * @return {(Sk.builtin.bool|Sk.builtin.NotImplemented)} true if this <= other, false otherwise
     */
    ob$le(other) {
        return Sk.builtin.NotImplemented.NotImplemented$;
    };

    /**
     * Determine if this instance is greater than a Python object (i.e. this > other).
     *
     * Implements `__gt__` dunder method.
     *
     * Javascript function, returns Python object.
     *
     * @param  {Object} other The Python object to compare.
     * @return {(Sk.builtin.bool|Sk.builtin.NotImplemented)} true if this > other, false otherwise
     */
    ob$gt(other) {
        return Sk.builtin.NotImplemented.NotImplemented$;
    };

    /**
     * Determine if this instance is greater than or equal to a Python object (i.e. this >= other).
     *
     * Implements `__ge__` dunder method.
     *
     * Javascript function, returns Python object.
     *
     * @param  {Object} other The Python object to compare.
     * @return {(Sk.builtin.bool|Sk.builtin.NotImplemented)} true if this >= other, false otherwise
     */
    ob$ge(other) {
        return Sk.builtin.NotImplemented.NotImplemented$;
    };
}

function _tryGetSubscript(dict, pyName) {
    try {
        return dict.mp$subscript(pyName);
    } catch (x) {
        return undefined;
    }
}

Sk.builtin.hashCount = 1;
Sk.builtin.idCount = 1;

export class none extends object {
    /**
     * @constructor
     * Sk.builtin.none
     *
     * @extends {object}
     */
    constructor() {
        this.v = null;
    }

    $r() { return new str("None"); }

    tp$hash() {
        return new int_(0);
    }

    /**
     * Python None constant.
     * @type {none}
     */
    static none$ = new none();
}

setUpInheritance("NoneType", none, object);

/**
 * @constructor
 * Sk.builtin.NotImplemented
 *
 * @extends {object}
 */
export class NotImplemented extends object {
    $r() { return new str("NotImplemented"); };

    /**
     * Python NotImplemented constant.
     * @type {Sk.builtin.NotImplemented}
     */
    static NotImplemented$ = new Sk.builtin.NotImplemented();
}

setUpInheritance("NotImplementedType", NotImplemented, object);

