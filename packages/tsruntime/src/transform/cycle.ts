function mapToObject(map: Map<any, any>) {
  return Array.from(map.entries()).reduce((acc, [key, value]) => {
    acc[key] = value instanceof Map
      ? mapToObject(value)
      : value instanceof Set
        ? Array.from(value).map(v => v instanceof Map ? mapToObject(v) : v)
        : value instanceof Array
          ? value.map(v => v instanceof Map ? mapToObject(v) : v)
          : value;
    return acc;
  }, {} as Record<string, any>);
}

export function decycle(object: Record<string, any>) {
  "use strict";

  const objects = new Map();
  return (function derez(value, path) {
    let old_path;
    let nu: Record<string, any> | any[];

    if (value instanceof SkipCycle) {
      return value.value;
    }

    if (value instanceof Map) {
      value = mapToObject(value);
    }

    if (
      typeof value === "object"
      && value !== null
      && !(value instanceof Boolean)
      && !(value instanceof Date)
      && !(value instanceof Number)
      && !(value instanceof RegExp)
      && !(value instanceof String)
    ) {
      old_path = objects.get(value);

      if (old_path !== undefined) {
        return {$ref: old_path};
      }

      objects.set(value, path);

      if (Array.isArray(value)) {
        nu = [];
        value.forEach(function (element, i) {
          (nu as Array<any>)[i] = derez(element, path + "[" + i + "]");
        });
      } else {
        nu = {};
        Object.keys(value).forEach(function (name) {
          (nu as Record<string, any>)[name] = derez(
            value[name],
            path + "[" + JSON.stringify(name) + "]"
          );
        });
      }
      return nu;
    }
    return value;
  }(object, "$"));
}

export function retrocycle($: any) {
  "use strict";

  const px = /^\$(?:\[(?:\d+|"(?:[^\\"\u0000-\u001f]|\\(?:[\\"\/bfnrt]|u[0-9a-zA-Z]{4}))*")\])*$/;

  (function rez(value) {
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        value.forEach(function (element, i) {
          if (typeof element === "object" && element !== null) {
            const path = element.$ref;
            if (typeof path === "string" && px.test(path)) {
              value[i] = eval(path);
            } else {
              rez(element);
            }
          }
        });
      } else {
        Object.keys(value).forEach(function (name) {
          const item = value[name];
          if (typeof item === "object" && item !== null) {
            const path = item.$ref;
            if (typeof path === "string" && px.test(path)) {
              value[name] = eval(path);
            } else {
              rez(item);
            }
          }
        });
      }
    }
  }($));
  return $;
}

export class SkipCycle {
  constructor(public readonly value: any) {}
}
