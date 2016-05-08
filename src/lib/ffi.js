var $builtinmodule = function (name) {
    var mod = {};
    mod["__name__"] = "ffi";
    mod.call_$rn$ = new Sk.builtin.func(function (path, args) {
      var js_args = Sk.ffi.remapToJs(args);
      var js_path = Sk.ffi.remapToJs(path).split('.');
      var get = function (path) {
        var res;
        for (var i in path) {
          res = window[path[i]];
        }
        return res;
      }

      debugger;

      var func = get(js_path);
      return Sk.ffi.remapToPy(func.apply(this, js_args));
    });

    return mod;
};
